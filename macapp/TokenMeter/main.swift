// 토큰 계량기 — 맥 메뉴바 앱
// 역할: 로컬 로그에서 내 토큰 사용량을 읽어 보여주고, 내 GitHub 공개 gist 에 숫자만 올린다(서버 없음).
// 수집·올리기는 번들된 collect.mjs(단일 진실 원천)를 node로 실행 — 파서 중복 없음. GitHub 호출은 그 안에서 gh CLI 가 한다.
// 순위판은 번들된 board.mjs(사이트와 같은 파일)가 members.json 과 각자의 gist 를 읽어 낸다.
// 돌고 있는 워크플로의 "늦어도 몇 시"는 번들된 eta.mjs 가 계산한다(로컬 전용, 올리지 않음).

import AppKit
import SwiftUI
import Combine
import ServiceManagement

// ── 설정 ────────────────────────────────────────────────────────────────
enum Config {
    static let defaultSite = "https://min-heee.github.io/token-meter/"
    /// 순위판 사이트(members.json 이 있는 GitHub Pages 폴더). 포크하거나 시험할 때만 바꾼다:
    /// defaults write dev.tokenmeter.mac siteURL https://<아이디>.github.io/token-meter/
    /// (TM_SITE_URL 환경 변수가 먼저 — 시험이 설정 파일을 건드리지 않고 가짜 사이트를 물린다)
    static var siteURL: String {
        let s = ProcessInfo.processInfo.environment["TM_SITE_URL"] ?? pref("siteURL", defaultSite)
        guard let u = URL(string: s), ["https", "http"].contains(u.scheme ?? "") else { return defaultSite }
        return s.hasSuffix("/") ? s : s + "/"
    }
    /// 자동 올리기 간격으로 고를 수 있는 값(분)
    static let submitIntervals = [10, 30, 60, 120, 360]
    static let defaultSubmitIntervalMin = 360
    /// 저장된 간격(목록에 없는 값이면 기본값)
    static var submitIntervalMin: Int {
        let v = UserDefaults.standard.integer(forKey: "submitIntervalMin")
        return submitIntervals.contains(v) ? v : defaultSubmitIntervalMin
    }
    static func intervalText(_ m: Int) -> String { m < 60 ? "\(m)분" : "\(m / 60)시간" }
    /// 자식 프로세스가 끝나지 않을 때 끊는 시각. 멈춘 수집기 하나가 busy 를 붙잡아 자동 올리기를 영영 막지 않게.
    /// 수집은 큰 기록(수백 MB)에서 몇 분 걸릴 수 있어 넉넉히. TM_TIMEOUT_SEC 는 시험용.
    static func timeout(_ normal: TimeInterval) -> TimeInterval {
        ProcessInfo.processInfo.environment["TM_TIMEOUT_SEC"].flatMap(Double.init) ?? normal
    }
    static var collectorTimeout: TimeInterval { timeout(600) }
    static var readerTimeout: TimeInterval { timeout(120) }    // board.mjs · eta.mjs · node 찾기
    /// 팝오버를 자주 열어도 순위판은 1분에 한 번만 읽는다 — gist 원본은 어차피 GitHub 가 5분쯤 캐시한다
    static let boardMinInterval: TimeInterval = 60
    static let etaInterval: TimeInterval = 30
    /// 게이지 채움 색. 기본은 파랑 — 시스템 강조색을 따르면 그래파이트에서 채움·눈금·바탕이 모두 회색이 된다.
    /// 바꾸려면: defaults write dev.tokenmeter.mac gaugeTint system   (blue | teal | orange | system)
    static var gaugeTint: Color {
        switch ProcessInfo.processInfo.environment["TM_GAUGE_TINT"] ?? pref("gaugeTint", "blue") {
        case "system": return .accentColor
        case "teal": return Color(nsColor: .systemTeal)
        case "orange": return Color(nsColor: .systemOrange)
        default: return Color(nsColor: .systemBlue)
        }
    }
    /// 워크플로 목록이 차지할 수 있는 최대 높이 — 화면 높이에서 나머지 상자들이 실제로 쓰는 높이(others)와
    /// 팝오버 테두리·화살표 몫(40)을 뺀 값. 참가하기·실패 알림 같은 상자는 생겼다 없어졌다 해서 고정값으로 빼면
    /// 상자가 많을 때 팝오버가 화면을 넘어 아래 버튼이 잘린다 — 그래서 재서 뺀다.
    static func runListCap(others: CGFloat) -> CGFloat {
        if let v = ProcessInfo.processInfo.environment["TM_LIST_CAP"].flatMap(Double.init) { return CGFloat(v) }
        return max(160, (NSScreen.main?.visibleFrame.height ?? 800) - others - 40)
    }
}

func pref(_ key: String, _ fallback: String) -> String {
    let v = UserDefaults.standard.string(forKey: key)
    return (v?.isEmpty == false) ? v! : fallback
}

// ── 수치 표기 ───────────────────────────────────────────────────────────
func tok(_ n: Double) -> String {
    if n >= 1e8 { return String(format: n >= 1e9 ? "%.1f억" : "%.2f억", n / 1e8) }
    if n >= 1e4 { return String(format: n >= 1e6 ? "%.0f만" : "%.1f만", n / 1e4) }
    return String(format: "%.0f", n)
}

/// 오늘이면 시:분, 날이 넘어가면 날짜까지
func clock(_ d: Date) -> String {
    let f = DateFormatter()
    f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "M/d HH:mm"
    return f.string(from: d)
}

func span(_ sec: Double) -> String {
    let m = Int((sec / 60).rounded())
    return m < 60 ? "\(m)분" : m % 60 == 0 ? "\(m / 60)시간" : "\(m / 60)시간 \(m % 60)분"
}

/// "9/20 21:44 · 24일 전" — 얼마나 묵었는지가 핵심이라 시각과 경과를 같이
func ago(_ d: Date) -> String {
    let s = max(0, Date().timeIntervalSince(d))
    let rel = s < 3600 ? "\(max(1, Int(s / 60)))분 전" : s < 86400 ? "\(Int(s / 3600))시간 전" : "\(Int(s / 86400))일 전"
    return "\(clock(d)) · \(rel)"
}

/// 보는 사람 달력으로 며칠 전인지(오늘 = 0) — 사이트의 "N일 전 수집"과 같은 셈
func daysAgo(_ d: Date) -> Int {
    let cal = Calendar.current
    return max(0, cal.dateComponents([.day], from: cal.startOfDay(for: d), to: cal.startOfDay(for: Date())).day ?? 0)
}

let toolLabel: [String: String] = ["claude": "Claude Code", "codex": "Codex", "gemini": "Gemini"]
let toolShort: [String: String] = ["claude": "Claude", "codex": "Codex", "gemini": "Gemini"]

// ── JSON 읽기 ───────────────────────────────────────────────────────────
func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

/// 수집기·순위판이 내는 ISO 시각(소수점 초가 있을 수도 없을 수도)
func isoDate(_ v: Any?) -> Date? {
    guard let s = v as? String else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

/// 표준 출력의 결과 JSON. 수집기는 로그인 셸로 띄우는데, 셸 설정이 앞에 무언가를 찍어도
/// 결과는 마지막 줄이다 — 통째로 읽히지 않으면 끝에서부터 JSON 줄을 찾는다.
func lastJSON(_ text: String) -> Any? {
    if let d = text.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) { return o }
    for line in text.split(whereSeparator: \.isNewline).reversed() {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.first == "{" || t.first == "[", let d = t.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) else { continue }
        return o
    }
    return nil
}

/// 비어 있지 않은 마지막 줄 — 수집기를 띄우지도 못했을 때 이유로 보인다
func lastLine(_ s: String) -> String? {
    s.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty }.map(redactSecrets)
}

/// 화면·설정에 남기는 글에서 토큰처럼 생긴 것을 가린다. 수집기는 제 출력을 이미 가리지만,
/// 수집기를 띄우지도 못했을 때 보이는 것은 로그인 셸(.zprofile 등)의 표준 오류라 무엇이 섞일지 모른다.
func redactSecrets(_ s: String) -> String {
    s.replacingOccurrences(of: #"\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})"#, with: "***", options: .regularExpression)
        .replacingOccurrences(of: #"(?i)(authorization\s*[:=]\s*)(?:(?:bearer|token|basic)\s+)?[^\s"']+"#, with: "$1***", options: .regularExpression)
}

/// 터미널에 붙여 넣을 수 있게 작은따옴표로 감싼다(필요할 때만)
func shellQuote(_ s: String) -> String {
    s.range(of: #"^[A-Za-z0-9_./:=@+-]+$"#, options: .regularExpression) != nil ? s : "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

// ── 데이터 모델 ─────────────────────────────────────────────────────────
struct ToolStat: Identifiable {
    let id = UUID()
    let tool: String
    let total: Double
    let output: Double
    let cost: Double
    let today: Double
}

/// 순위판의 한 사람(도구를 합친 값). 값은 이번 주 총 토큰 — board.mjs --json 이 그 순으로 준다.
struct RankRow: Identifiable {
    var id: String { login.lowercased() }
    let rank: Int
    let login: String
    let tools: [String]
    let week: Double
    let all: Double
    let updatedAt: Date?     // 그 사람이 마지막으로 올린 시각(순위판이 읽은 gist 기준)
    let mine: Bool
}

/// 순위판이 gist 를 읽지 못한 참가자
struct FailedMember: Identifiable {
    var id: String { login.lowercased() }
    let login: String
    let reason: String

    var reasonText: String {
        switch reason {
        case "not_found": return "gist 없음"
        case "login_mismatch": return "계정이 다름"
        case "bad_schema", "bad_entries", "not_json": return "형식이 맞지 않음"
        case "too_large": return "너무 큼"
        default: return "읽기 실패"
        }
    }
}

/// 마지막 올리기가 실패한 이유. code 는 수집기(collect.mjs --publish --json)의 오류 코드,
/// 그리고 앱이 붙이는 둘: node_missing(수집기를 띄우지도 못함), timeout(끝나지 않아 끊음).
struct PublishProblem {
    let code: String
    let message: String      // 수집기가 준 한국어 문구 — 코드별 안내가 따로 없을 때 그대로 보인다

    /// 무엇을 하면 되는지: 설명 한 줄과 터미널에 칠 명령(있으면)
    var guidance: (text: String, command: String?) {
        switch code {
        case "gh_missing": return ("GitHub CLI(gh)가 설치돼 있지 않아요. 터미널에서 설치한 뒤 gh auth login 으로 로그인해 주세요", "brew install gh")
        case "gh_not_logged_in": return ("gh 에 로그인돼 있지 않아요. 터미널에서 GitHub 에 로그인해 주세요", "gh auth login")
        case "gh_no_gist_scope": return ("gh 로그인에 gist 권한이 없어요. 터미널에서 권한을 더해 주세요", "gh auth refresh -s gist")
        case "network": return ("GitHub 에 닿지 못했어요. 인터넷 연결을 확인한 뒤 다시 올려 주세요", nil)
        case "gist_too_large":
            // 수집기 문구의 '--since 로 줄여라'는 터미널용이다 — 앱에서는 크기만 받아 쓰고 할 일을 따로 적는다.
            // 명령은 앱 안의 수집기 경로로: 터미널의 지금 폴더에는 collect.mjs 가 없다. 기간은 최근 1년.
            let size = message.range(of: #"\d+KB"#, options: .regularExpression).map { "(\(message[$0]))" } ?? ""
            let script = Bundle.main.path(forResource: "collect", ofType: "mjs") ?? "collect.mjs"
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            let since = f.string(from: Calendar.current.date(byAdding: .day, value: -365, to: Date()) ?? Date())
            return ("올릴 기록\(size)이 gist 상한 256KB 를 넘어요. 터미널에서 기간을 줄여 한 번 올려 주세요",
                    "node \(shellQuote(script)) --publish --since \(since)")
        case "node_missing": return ("node 를 찾지 못했어요. 터미널에서 설치해 주세요", "brew install node")
        case "timeout": return ("올리기가 너무 오래 끝나지 않아 멈췄어요. 다음 간격에 다시 올려요", nil)
        default: return (message.isEmpty ? "이유를 알 수 없는 실패예요" : message, nil)
        }
    }
}

/// 다른 큐에서 읽은 바이트를 넘겨받는 상자 (group.wait() 뒤에만 읽는다)
final class Collected: @unchecked Sendable { var data = Data() }

/// 끝난 쪽(정상 종료 또는 시간 초과) 하나만 continuation 을 잇게 한다
final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<(Int32, String, String), Never>?
    init(_ c: CheckedContinuation<(Int32, String, String), Never>) { cont = c }
    var done: Bool { lock.lock(); defer { lock.unlock() }; return cont == nil }
    func resume(_ v: (Int32, String, String)) {
        lock.lock()
        let c = cont
        cont = nil
        lock.unlock()
        c?.resume(returning: v)
    }
}

/// 돌고 있는 워크플로 하나와 그 완료 상한
struct RunETA: Identifiable {
    let id: String
    let name: String
    let sessionTitle: String?  // 이 워크플로를 띄운 세션의 이름(없으면 nil)
    let startedAt: Date
    let elapsedSec: Double
    let phaseCur: Int
    let phaseTotal: Int?     // nil = 단계 수를 모름(자기 스크립트가 없는 실행)
    let done: Int
    let running: Int
    let latestBy: Date?      // 늦어도 이 시각 (nil = 상한을 못 냄)
    let typicalBy: Date?     // 보통은 이쯤 (nil = 그 시각이 이미 지남, 또는 상한 없음)
    let typicalAt: Date?     // 지났어도 남는 '보통' 시각 — 게이지에 자리를 표시하는 데 쓴다
    let locked: Bool         // false = 시작 2분 전의 잠정값
    let revised: Int         // 상한을 넘겨 다시 계산한 횟수
    let stalled: Bool        // 도는 에이전트 없이 오래 조용함 — 끝났거나 멈췄을 수 있다
    let quietSec: Double
    let have: Int            // 상한을 못 낼 때: 이만큼 오래 돈 과거 기록 수
    let need: Int
    let trackN: Int          // 이 상한을 정한 시점 기준의 적중 기록: N번 중
    let trackExceeded: Int   // M번 넘김

    /// 고정된 상한이 화면에 나와 있고, 그 상한의 적중 기록이 있다
    var hasTrack: Bool { latestBy != nil && locked && trackN > 0 }
}

@MainActor
final class Model: ObservableObject {
    @Published var stats: [ToolStat] = []
    @Published var runs: [RunETA] = []
    @Published var etaError: String? = nil   // 워크플로 상태를 읽지 못한 이유 (nil = 정상)
    private var etaFailures = 0
    private var nodePath: String? = nil
    @Published var busy = false
    @Published var status = "대기"

    // 마지막으로 성공한 올리기와 마지막 올리기가 실패한 이유 — 앱을 껐다 켜도 남긴다.
    // 자동 올리기는 조용히 돌아서, 실패를 여기 남기지 않으면 순위가 멈춘 걸 아무도 모른다(9/20~10/14 실제로 그랬다).
    // 옛 서버 제출의 키(lastSubmitOK·lastSubmitProblem)는 읽지 않는다 — 그 서버의 성공·실패는 gist 와 상관없다.
    @Published var lastPublish: Date? = UserDefaults.standard.object(forKey: "lastPublishOK") as? Date
    /// gist 를 실제로 고친(또는 만든) 마지막 시각. 바뀐 것이 없어 그대로 둔 올리기(unchanged)는 lastPublish 만 바꾼다 —
    /// 순위판이 읽는 내 기록의 시각(updatedAt)도 이때 것이라, '참가됐나' 짐작은 이것과 견준다.
    @Published var lastUpload: Date? = UserDefaults.standard.object(forKey: "lastUploadAt") as? Date
    /// 마지막 성공이 '바뀐 것 없음'이었나
    @Published var lastUnchanged: Bool = UserDefaults.standard.bool(forKey: "lastPublishUnchanged")
    /// 마지막으로 올리기를 시도한 시각(성공·실패 모두) — 자동 올리기 간격은 이것부터 잰다. 앱을 켤 때마다 비운다.
    private(set) var lastAttempt: Date? = nil
    @Published var publishProblem: PublishProblem? = UserDefaults.standard.string(forKey: "lastPublishCode")
        .map { PublishProblem(code: $0, message: UserDefaults.standard.string(forKey: "lastPublishProblem") ?? "") }
    @Published var login: String? = UserDefaults.standard.string(forKey: "ghLogin")        // GitHub 아이디(마지막으로 올린 계정)
    @Published var gistID: String? = UserDefaults.standard.string(forKey: "gistID")
    @Published var gistURL: String? = UserDefaults.standard.string(forKey: "gistURL")
    @Published var joinURL: String? = UserDefaults.standard.string(forKey: "joinURL")
    /// 순위판 명단에 이 gist 로 올라 있는가 (nil = 확인 못 함)
    @Published var member: Bool? = UserDefaults.standard.object(forKey: "member") as? Bool
    /// 사람이 처음 올리기 버튼(동의 상자)을 한 번이라도 눌렀는가. 공개 gist 는 수정 기록까지 영원히 남으니,
    /// 처음 만드는 일은 묻지 않고 하지 않는다 — 그 뒤로는 고른 간격마다 자동으로 올린다.
    @Published var consented: Bool = UserDefaults.standard.bool(forKey: "publishConsent")
        || UserDefaults.standard.object(forKey: "lastPublishOK") != nil

    @Published var ranks: [RankRow] = []
    @Published var boardFailed: [FailedMember] = []
    @Published var boardFetchedAt: Date? = nil    // 순위판을 마지막으로 읽은 시각
    @Published var boardError: String? = nil      // 마지막으로 읽지 못한 이유 (nil = 정상) — 그 전 순위는 그대로 둔다
    @Published var boardUpdatedAt: Date? = nil    // 순위판에 올라가 있는 내 기록의 시각
    private var boardTriedAt: Date? = nil
    private var boardLoading = false
    private var statsLoading = false
    /// false = 점검용 실행(--snapshot·--popover-test). 올리지 않고, 아무것도 저장하지 않는다 —
    /// 점검 실행도 같은 앱이라 진짜 앱과 같은 설정을 쓰고, 올린 gist 는 수정 기록까지 영원히 공개라서다.
    /// (10/14 --popover-test 도중 화면의 '지금 올리기'가 눌려 실제 공개 gist 가 생긴 일이 있었다.)
    private(set) var live = true

    private func save(_ value: Any?, _ key: String) {
        guard live else { return }
        if let value { UserDefaults.standard.set(value, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
    }

    /// 점검용: 이번 실행 동안은 올리지도 저장하지도 않는다
    func lockDown() { live = false }

    /// 화면 점검용: 저장돼 있던 상태를 화면에서 비우고 잠근다
    func forgetSaved() {
        lockDown()
        lastPublish = nil; lastUpload = nil; lastUnchanged = false; lastAttempt = nil
        publishProblem = nil; login = nil; gistID = nil; gistURL = nil; joinURL = nil
        member = nil; consented = false
    }

    /// 자동 올리기 스위치(기본 켬)
    var autoSubmitOn: Bool {
        UserDefaults.standard.object(forKey: "autoSubmit") == nil || UserDefaults.standard.bool(forKey: "autoSubmit")
    }

    /// 자동 올리기 때가 됐나: 스위치가 켜져 있고, 사람이 처음 한 번은 직접 올렸고(동의), 지금 올리는 중이 아니고,
    /// 마지막 시도(실패도 센다 — 1분마다 두드리지 않게)에서 고른 간격이 지났다. 이번 실행에서 시도한 적이 없으면 바로.
    func autoPublishDue(now: Date = Date()) -> Bool {
        guard autoSubmitOn, consented, !busy else { return false }
        guard let last = lastAttempt else { return true }
        return now.timeIntervalSince(last) >= Double(Config.submitIntervalMin) * 60
    }

    /// 자동 올리기가 켜져 있는데 순위판의 내 기록이 하루 넘게 묵었으면 그 시각(아니면 nil).
    /// 바뀐 것이 없어 그대로 둔 올리기는 gist 의 시각을 바꾸지 않는다 — 하루 안에 올리기(확인)에 성공했으면
    /// 순위의 기록은 지금 것과 같으니 묵었다고 하지 않는다.
    var boardLagSince: Date? {
        let day: TimeInterval = 24 * 3600
        guard autoSubmitOn, consented, let at = boardUpdatedAt, Date().timeIntervalSince(at) > day else { return nil }
        if let ok = lastPublish, Date().timeIntervalSince(ok) <= day { return nil }
        return at
    }

    /// '순위판에 참가하기'가 열 주소 — 올린 적이 있고, 명단에 이 gist 로 없다고 확인됐을 때만
    var joinLink: URL? { consented && member == false ? joinURL.flatMap(URL.init(string:)) : nil }

    /// 화면 점검용(--state-out): 지금 상태를 JSON 파일로 — 시험이 그림 대신 이것으로 확인한다
    func writeCheckState(to path: String, menuTitle: String) -> Bool {
        let iso = ISO8601DateFormatter()
        let at = { (d: Date?) -> Any in d.map { iso.string(from: $0) } ?? NSNull() }
        let opt = { (v: Any?) -> Any in v ?? NSNull() }
        let state: [String: Any] = [
            "live": live, "consented": consented, "status": status, "busy": busy, "menuTitle": menuTitle,
            "login": opt(login), "gistID": opt(gistID), "gistURL": opt(gistURL), "joinURL": opt(joinURL),
            "joinLink": opt(joinLink?.absoluteString), "member": opt(member), "lastPublish": at(lastPublish),
            "lastUpload": at(lastUpload), "lastUnchanged": lastUnchanged, "lastAttempt": at(lastAttempt),
            "autoDue": autoPublishDue(), "intervalMin": Config.submitIntervalMin, "boardLagSince": at(boardLagSince),
            "problem": publishProblem.map { p -> [String: Any] in
                let g = p.guidance
                return ["code": p.code, "message": p.message, "text": g.text, "command": opt(g.command)]
            } ?? NSNull(),
            "ranks": ranks.map { ["rank": $0.rank, "login": $0.login, "tools": $0.tools, "week": $0.week, "all": $0.all,
                                  "updatedAt": at($0.updatedAt), "mine": $0.mine] as [String: Any] },
            "boardFailed": boardFailed.map { ["login": $0.login, "reason": $0.reason, "text": $0.reasonText] },
            "boardError": opt(boardError), "boardFetchedAt": at(boardFetchedAt), "boardUpdatedAt": at(boardUpdatedAt),
            "stats": stats.map { ["tool": $0.tool, "total": $0.total, "output": $0.output, "cost": $0.cost, "today": $0.today] as [String: Any] },
            "runs": runs.map { ["id": $0.id, "name": $0.name, "sessionTitle": opt($0.sessionTitle)] as [String: Any] },
            "etaError": opt(etaError),
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]),
              (try? d.write(to: URL(fileURLWithPath: path))) != nil else {
            FileHandle.standardError.write("상태를 저장하지 못했습니다: \(path)\n".data(using: .utf8)!)
            return false
        }
        return true
    }

    /// run() 이 시간을 넘겨 끊었을 때의 종료 코드 (timeout(1) 과 같은 124)
    nonisolated static let timedOut: Int32 = 124

    /// 프로세스를 띄워 표준 출력·오류를 끝까지 읽는다. 두 파이프를 함께 비운다 —
    /// 한쪽(64KB)이 차면 자식은 쓰다 멈추고, 끝나기를 기다리는 이쪽도 같이 멈춘다.
    /// timeout 이 지나도 안 끝나면 끊고 (124, 읽은 데까지, 이유)로 돌아온다. 셸 설정이 띄운 백그라운드 일이
    /// 파이프를 쥐고 있으면 끊어도 읽기가 안 끝나므로, 읽기를 기다리지 않고 그 자리에서 돌아온다.
    nonisolated static func run(_ exe: String, _ args: [String], timeout: TimeInterval) async -> (Int32, String, String) {
        await withCheckedContinuation { cont in
            let once = ResumeOnce(cont)
            DispatchQueue.global().async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: exe)
                p.arguments = args
                let out = Pipe(), err = Pipe()
                p.standardOutput = out; p.standardError = err; p.standardInput = FileHandle.nullDevice
                do { try p.run() } catch {
                    once.resume((127, "", "\(exe) 를 실행하지 못했어요"))
                    return
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                    guard !once.done else { return }
                    if p.isRunning {
                        p.terminate()
                        // SIGTERM 을 무시하는 것(셸이 아직 뜨는 중 등)도 있다 — 조금 뒤에도 살아 있으면 SIGKILL.
                        // exec 는 pid 를 그대로 두므로, 그사이 셸이 node 로 바뀌었어도 같은 대상이다.
                        let pid = p.processIdentifier
                        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { if p.isRunning { kill(pid, SIGKILL) } }
                    }
                    once.resume((Model.timedOut, "", "\(Int(timeout))초 안에 끝나지 않아 멈췄어요"))
                }
                let errData = Collected()
                let group = DispatchGroup()
                DispatchQueue.global().async(group: group) { errData.data = err.fileHandleForReading.readDataToEndOfFile() }
                let o = out.fileHandleForReading.readDataToEndOfFile()
                group.wait()
                p.waitUntilExit()
                once.resume((p.terminationStatus, String(decoding: o, as: UTF8.self), String(decoding: errData.data, as: UTF8.self)))
            }
        }
    }

    /// 번들된 collect.mjs 를 로그인 셸로 실행 — Homebrew 의 gh 는 로그인 셸 PATH 에만 있다
    /// (launchd 가 띄운 앱의 PATH 는 /usr/bin:/bin 뿐). 결과는 표준 출력의 마지막 JSON 줄에서 읽는다.
    /// node 는 순위판·늦어도 몇 시와 같은 것(resolveNode)을 절대 경로로 넘긴다 — 로그인 셸에서 그냥 "node" 를 부르면
    /// .zshrc 에서만 PATH 에 넣는 설치(nvm·fnm·asdf, brew shellenv 를 .zshrc 에 둔 경우)에서는 못 찾아,
    /// 순위판은 읽히는데 올리기만 "node 를 설치하세요" 로 실패한다.
    private func runCollector(_ args: [String]) async -> (Int32, String, String) {
        guard let script = Bundle.main.path(forResource: "collect", ofType: "mjs") else { return (1, "", "앱 안에 collect.mjs 가 없어요") }
        let node = await resolveNode() ?? "node"   // 못 찾았으면 로그인 셸에 맡긴다(없으면 127 → node_missing)
        // exec: 셸이 node 로 바뀌게 한다 — 로그인 셸은 .zlogout 때문에 마지막 명령을 exec 하지 않아서, 시간이 넘어 끊을 때
        // 셸만 죽고 node 는 고아로 남는다. exec 하면 끊는 대상이 node 자신이다.
        let cmd = "exec " + ([node, script] + args).map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }.joined(separator: " ")
        let r = await Self.run("/bin/zsh", ["-lc", cmd], timeout: Config.collectorTimeout)
        if r.0 == 127 { nodePath = nil }   // 사라졌으면 다음에 다시 찾는다
        return r
    }

    /// node 절대 경로 — 30초마다 로그인 셸을 띄우지 않도록 한 번만 찾아 둔다
    private func resolveNode() async -> String? {
        if let p = nodePath { return p }
        var found: String? = nil
        // 로그인 셸 → 대화형 셸(.zshrc 에서만 PATH 에 넣는 nvm 같은 설치) → 흔한 설치 위치 순으로 찾는다
        for flags in ["-lc", "-ilc"] {
            let (_, o, _) = await Self.run("/bin/zsh", [flags, "command -v node"], timeout: Config.readerTimeout)
            let hit = o.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { $0.hasPrefix("/") }
            if let hit, FileManager.default.isExecutableFile(atPath: hit) { found = hit; break }
        }
        found = found ?? ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) }
        nodePath = found
        return found
    }

    /// 읽기에 실패하면 직전 화면을 잠깐 그대로 둔다(한 번의 실패로 깜빡이지 않게). 세 번 이어지면
    /// 낡은 "늦어도"가 메뉴바에 남지 않도록 비우고, 없는 것과 못 읽은 것을 구분해 보여준다.
    private func etaFailed(_ why: String) {
        etaFailures += 1
        if etaFailures >= 3 || runs.isEmpty { runs = []; etaError = why }
    }

    /// 돌고 있는 워크플로와 "늦어도 몇 시" 새로고침 (eta.mjs --json, 로컬 전용)
    func refreshETA() async {
        guard let script = Bundle.main.path(forResource: "eta", ofType: "mjs") else { etaFailed("앱 안에 eta.mjs 가 없어요"); return }
        guard let node = await resolveNode() else { etaFailed("node 를 찾지 못했어요 (brew install node)"); return }
        let (rc, out, _) = await Self.run(node, [script, "--json"], timeout: Config.readerTimeout)
        guard rc == 0, let data = out.data(using: .utf8), applyETA(data) else {
            if !FileManager.default.isExecutableFile(atPath: node) { nodePath = nil }   // 사라졌으면 다음에 다시 찾는다
            etaFailed("워크플로 상태를 읽지 못했어요")
            return
        }
    }

    /// `eta.mjs --json` 결과를 화면 상태로 옮긴다. 해석하지 못하면 false.
    @discardableResult
    func applyETA(_ data: Data) -> Bool {
        guard let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = d["running"] as? [[String: Any]] else { return false }
        let num = { (v: Any?) -> Double? in (v as? NSNumber)?.doubleValue }
        let date = { (v: Any?) -> Date? in num(v).map { Date(timeIntervalSince1970: $0 / 1000) } }
        runs = raw.compactMap { r in
            guard let id = r["runId"] as? String else { return nil }
            let phase = r["phase"] as? [String: Any] ?? [:]
            let agents = r["agents"] as? [String: Any] ?? [:]
            let reason = r["reason"] as? [String: Any] ?? [:]
            let track = r["track"] as? [String: Any] ?? [:]
            let elapsed = num(r["elapsedSec"]) ?? 0
            return RunETA(
                id: id, name: (r["name"] as? String) ?? id,
                sessionTitle: ((r["session"] as? [String: Any])?["title"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                startedAt: date(r["startedAt"]) ?? Date().addingTimeInterval(-elapsed), elapsedSec: elapsed,
                phaseCur: Int(num(phase["cur"]) ?? 1), phaseTotal: num(phase["total"]).map { Int($0) },
                done: Int(num(agents["done"]) ?? 0), running: Int(num(agents["running"]) ?? 0),
                latestBy: date(r["latestBy"]), typicalBy: date(r["typicalBy"]), typicalAt: date(r["typicalAt"]) ?? date(r["typicalBy"]),
                locked: (r["locked"] as? Bool) ?? false, revised: Int(num(r["revised"]) ?? 0),
                stalled: (r["stalled"] as? Bool) ?? false, quietSec: num(r["quietSec"]) ?? 0,
                have: Int(num(reason["have"]) ?? 0), need: Int(num(reason["need"]) ?? 0),
                trackN: Int(num(track["n"]) ?? 0), trackExceeded: Int(num(track["exceeded"]) ?? 0))
        }
        etaFailures = 0
        etaError = nil
        return true
    }

    /// 로컬 사용량 새로고침 (--json-only: 표준 출력만, 아무것도 올리지 않는다)
    func refreshStats() async {
        if statsLoading { return }   // 팝오버를 연달아 열어도 수집기는 하나만
        statsLoading = true
        defer { statsLoading = false }
        let (rc, out, err) = await runCollector(["--json-only"])
        if rc != 0 && lastJSON(out) == nil {
            status = rc == Self.timedOut ? "수집이 끝나지 않아 멈췄어요"
                : rc == 127 || err.contains("command not found") ? "node 를 찾지 못했어요" : lastLine(err) ?? "수집 실패"
            return
        }
        if !applyStats(out) { status = "수집 결과 해석 실패" }
    }

    /// `collect.mjs --json-only` 결과(기록 하나 또는 배열)를 화면 상태로. 해석하지 못하면 false.
    @discardableResult
    func applyStats(_ out: String) -> Bool {
        guard let parsed = lastJSON(out) else { return false }
        let entries: [[String: Any]] = (parsed as? [[String: Any]]) ?? (parsed as? [String: Any]).map { [$0] } ?? []
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        let today = df.string(from: Date())

        stats = entries.compactMap { e in
            guard let tool = e["tool"] as? String,
                  let totals = e["totals"] as? [String: Any] else { return nil }
            var todayTotal = 0.0
            if let byDay = e["byDay"] as? [String: Any], let v = byDay[today] {
                if let n = v as? NSNumber { todayTotal = n.doubleValue }
                else if let a = v as? [Any], let n = a.first as? NSNumber { todayTotal = n.doubleValue }
            }
            return ToolStat(tool: tool, total: num(totals["total"]) ?? 0, output: num(totals["output"]) ?? 0,
                            cost: num(totals["cost"]) ?? 0, today: todayTotal)
        }
        status = stats.isEmpty ? "로컬 기록 없음" : "로컬 \(stats.count)개 도구"
        return true
    }

    /// 순위판 새로고침 — 번들된 board.mjs --json (사이트와 같은 파일: members.json → 각자의 공개 gist).
    /// GitHub 계정이 필요 없는 읽기라 gh 를 거치지 않고, 로그인 셸 없이 node 로 바로 띄운다.
    func refreshBoard(force: Bool = false) async {
        if boardLoading { return }
        if !force, let t = boardTriedAt, Date().timeIntervalSince(t) < Config.boardMinInterval { return }
        boardLoading = true
        defer { boardLoading = false }
        boardTriedAt = Date()
        guard let script = Bundle.main.path(forResource: "board", ofType: "mjs") else { boardError = "앱 안에 board.mjs 가 없어요"; return }
        guard let node = await resolveNode() else { boardError = "node 를 찾지 못했어요 (brew install node)"; return }
        let (rc, out, _) = await Self.run(node, [script, "--json", "--base", Config.siteURL], timeout: Config.readerTimeout)
        if rc == 127 { nodePath = nil }   // 사라졌으면 다음에 다시 찾는다
        if rc == Self.timedOut { boardError = "순위판을 읽는 데 너무 오래 걸려 멈췄어요"; return }
        applyBoard(out)
    }

    /// `board.mjs --json` 결과를 화면 상태로 옮긴다. 읽지 못했으면 이유만 남기고 그 전 순위는 그대로 둔다
    /// (한 번 못 읽었다고 순위가 사라지면 깜빡인다 — '○시 기준'이 얼마나 묵었는지 알려 준다).
    func applyBoard(_ out: String) {
        guard let d = lastJSON(out) as? [String: Any] else { boardError = "순위판 결과를 해석하지 못했어요"; return }
        // 한 줄이 이상하다고 순위판 전체를 버리지 않는다 — 객체가 아닌 줄만 뺀다
        guard d["ok"] as? Bool != false, let people = (d["people"] as? [Any])?.compactMap({ $0 as? [String: Any] }) else {
            switch (d["error"] as? [String: Any])?["code"] as? String {
            case "members_missing": boardError = "순위판이 아직 열리지 않았어요"
            case "network", "timeout": boardError = "순위판에 닿지 못했어요. 인터넷 연결을 확인해 주세요"
            case "members_http", "members_invalid": boardError = "순위판 명단을 읽지 못했어요"
            default: boardError = "순위판을 읽지 못했어요"
            }
            return
        }
        let me = login?.lowercased()
        var seen = Set<String>()   // 같은 사람이 두 번 오면 앞의 것만 (화면 목록은 아이디로 줄을 구분한다)
        ranks = people.compactMap { p in
            guard let lg = p["login"] as? String, seen.insert(lg.lowercased()).inserted else { return nil }
            let total = p["total"] as? [String: Any] ?? [:]
            return RankRow(rank: Int(num(p["rank"]) ?? 0), login: lg, tools: p["tools"] as? [String] ?? [],
                           week: num(total["week"]) ?? 0, all: num(total["all"]) ?? 0,
                           updatedAt: isoDate(p["updatedAt"]), mine: lg.lowercased() == me)
        }
        boardFailed = (d["failed"] as? [[String: Any]] ?? []).compactMap { f in
            (f["login"] as? String).map { FailedMember(login: $0, reason: f["reason"] as? String ?? "unknown") }
        }
        boardFetchedAt = isoDate(d["fetchedAt"]) ?? Date()
        boardError = nil
        boardUpdatedAt = ranks.first(where: \.mine)?.updatedAt
        // 참가 신청을 낸 뒤: 순위판이 마지막으로 고친 내 gist 의 기록을 읽고 있으면 참가된 것이다.
        // 다음 올리기(최대 6시간 뒤)까지 '참가하기'가 남아 있지 않게 한다. 10분 여유 = 올리는 데 걸린 시간.
        // 견주는 시각은 lastUpload — 바뀐 것이 없어 그대로 둔 올리기는 gist 의 시각을 바꾸지 않는다.
        if member == false, let at = boardUpdatedAt, let last = lastUpload, at >= last.addingTimeInterval(-600) {
            member = true
            save(true, "member")
        }
    }

    /// 수집 + 내 공개 gist 에 숫자만 올리기 (collect.mjs --publish --json — GitHub 호출은 그 안에서 gh CLI 가 한다)
    func publish() async {
        guard live else { status = "점검 모드 — 올리지 않아요"; return }
        guard !busy else { return }   // 자동 올리기와 버튼이 겹치지 않게
        busy = true
        lastAttempt = Date()
        status = "수집·올리는 중…"
        let (rc, out, err) = await runCollector(["--publish", "--json", "--base", Config.siteURL])
        busy = false
        if applyPublish(rc: rc, out: out, err: err) { await refreshBoard(force: true) }
    }

    /// 사람이 동의 상자의 올리기(또는 실패 알림의 다시 올리기)를 눌렀다 — 그다음부터는 자동으로 올려도 된다
    func consent() {
        consented = true
        save(true, "publishConsent")
    }

    /// `collect.mjs --publish --json` 의 출력(JSON 한 줄 { ok, login, gist, url, member, joinUrl } — 바뀐 것이 없어
    /// gist 를 그대로 뒀으면 unchanged: true 가 붙는다 — 또는 { ok:false, error:{ code, message } })을 상태로 옮긴다.
    /// 올리기에 성공했으면(그대로 둔 것도 성공) true. at = 시도한 시각(점검용 고정 자료가 과거 시각을 넣는다).
    @discardableResult
    func applyPublish(rc: Int32, out: String, err: String, at: Date = Date()) -> Bool {
        consent()   // 올리기를 시도했다는 것 자체가 동의다(자동 올리기는 동의한 뒤에만 돈다)
        lastAttempt = max(lastAttempt ?? at, at)
        guard let r = lastJSON(out) as? [String: Any] else {
            // JSON 이 없다 = 수집기가 돌지도 못했거나 끝나지 않았다. zsh 는 명령을 못 찾으면 127 로 끝난다.
            let noNode = rc == 127 || err.contains("command not found")
            setProblem(rc == Self.timedOut ? PublishProblem(code: "timeout", message: "")
                       : noNode ? PublishProblem(code: "node_missing", message: "")
                       : PublishProblem(code: "unknown", message: lastLine(err) ?? "수집기 결과를 해석하지 못했어요"))
            return false
        }
        guard r["ok"] as? Bool == true, let lg = r["login"] as? String, let id = r["gist"] as? String else {
            let e = r["error"] as? [String: Any] ?? [:]
            setProblem(PublishProblem(code: e["code"] as? String ?? "unknown", message: redactSecrets(e["message"] as? String ?? "")))
            return false
        }
        let unchanged = r["unchanged"] as? Bool == true
        let sameGist = id == gistID
        login = lg
        gistID = id
        gistURL = (r["url"] as? String).flatMap { $0.hasPrefix("https://gist.github.com/") ? $0 : nil }
        joinURL = (r["joinUrl"] as? String).flatMap { $0.hasPrefix("https://github.com/") ? $0 : nil }
        // member 가 null(명단을 못 읽음)이면 같은 gist 에 대한 지난 답을 둔다 — gist 가 바뀌었으면 지난 답은 무효
        if let m = r["member"] as? Bool { member = m } else if !sameGist { member = nil }
        lastPublish = at
        if !unchanged { lastUpload = at }
        lastUnchanged = unchanged
        publishProblem = nil
        for (k, v) in [("ghLogin", login), ("gistID", gistID), ("gistURL", gistURL), ("joinURL", joinURL)] as [(String, String?)] { save(v, k) }
        save(member, "member")
        save(at, "lastPublishOK")
        save(lastUpload, "lastUploadAt")
        save(unchanged, "lastPublishUnchanged")
        save(nil, "lastPublishCode")
        save(nil, "lastPublishProblem")
        status = unchanged ? "바뀐 것 없음" : "올림 완료"
        return true
    }

    private func setProblem(_ p: PublishProblem) {
        publishProblem = p
        save(p.code, "lastPublishCode")
        save(p.message, "lastPublishProblem")
        status = "올리지 못함"
    }

    /// 화면 점검용: 고정 자료를 실제 출력 해석(applyPublish)으로 차례로 넣는다. 모양은 둘 중 하나:
    /// 수집기 JSON 객체 하나, 또는 [{ "stdout": "...", "stderr": "", "rc": 0, "at": "ISO" }] 단계 목록(앞 단계가 먼저 일어난 일)
    func applyPublishFixture(_ text: String) {
        guard let steps = lastJSON(text) as? [[String: Any]] else { applyPublish(rc: 0, out: text, err: ""); return }
        for s in steps {
            applyPublish(rc: Int32(num(s["rc"]) ?? 0), out: s["stdout"] as? String ?? "", err: s["stderr"] as? String ?? "",
                         at: isoDate(s["at"]) ?? Date())
        }
    }

    /// 화면 점검용: board.mjs --json 출력 하나, 또는 그런 출력의 배열(차례로 읽은 것 — 예: 읽었다가 다음엔 못 읽음)
    func applyBoardFixture(_ text: String) {
        guard let seq = lastJSON(text) as? [Any] else { applyBoard(text); return }
        for o in seq {
            if let d = try? JSONSerialization.data(withJSONObject: o) { applyBoard(String(decoding: d, as: UTF8.self)) }
        }
    }

    func refreshAll() async {
        async let a: () = refreshStats()
        async let b: () = refreshBoard()
        async let c: () = refreshETA()
        _ = await (a, b, c)
    }
}

// ── 화면 ────────────────────────────────────────────────────────────────
struct ContentView: View {
    @ObservedObject var model: Model
    var interactive = true   // false = 팝오버 위치 점검: 버튼·체크박스가 눌리지 않는다

    /// 적중 기록은 상한을 정한 시점마다 다르다(2분에 정한 것과 20분에 정한 것은 성적이 다르다).
    /// 앱이 켜져 있으면 대부분 2분에 정해 같으므로 가장 흔한 것을 상자 아래 한 줄로 보이고,
    /// 다른 시점에 정한 줄만 그 줄에 따로 적는다. 고정된 상한이 하나도 없으면 nil — 문장을 숨긴다.
    static func commonTrack(_ runs: [RunETA]) -> [Int]? {
        let pairs = runs.filter(\.hasTrack).map { [$0.trackN, $0.trackExceeded] }
        return Dictionary(grouping: pairs, by: { $0 }).max { ($0.value.count, $0.key[0]) < ($1.value.count, $1.key[0]) }?.key
    }
    @AppStorage("autoSubmit") private var autoSubmit = true
    @AppStorage("submitIntervalMin") private var submitIntervalMin = Config.defaultSubmitIntervalMin
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    /// 워크플로 목록 말고 나머지가 실제로 차지하는 높이 — 재서 고친다(처음 값은 상자가 가장 적을 때쯤)
    @State private var othersHeight: CGFloat = 340

    private func open(_ s: String?) {
        if let s, let u = URL(string: s) { NSWorkspace.shared.open(u) }
    }

    /// 저장된 간격(목록에 없는 값이면 기본값)
    private var interval: Int { Config.submitIntervals.contains(submitIntervalMin) ? submitIntervalMin : Config.defaultSubmitIntervalMin }

    private func publishNow() {
        model.consent()
        Task { await model.publish() }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("토큰 계량기").font(.system(size: 14, weight: .bold))
                Spacer()
                Text(model.status).font(.system(size: 10)).foregroundColor(.secondary)
            }

            // 자동 올리기는 조용히 돈다 — 실패하면 여기서 말하지 않으면 아무도 모른다
            if let problem = model.publishProblem {
                PublishProblemBanner(problem: problem, lastOnBoard: model.boardUpdatedAt ?? model.lastPublish,
                                     busy: model.busy, retry: publishNow)
            } else if autoSubmit, let at = model.boardLagSince {
                Text("순위에는 \(ago(at)) 기록이 올라가 있어요").font(.system(size: 10)).foregroundColor(.secondary)
            }

            if !model.consented {
                ConsentBox(every: autoSubmit ? Config.intervalText(interval) : nil, busy: model.busy, publish: publishNow, privacy: { open(Config.siteURL + "privacy.html") })
            } else if let join = model.joinLink {
                JoinBox(url: join)
            }

            GroupBox {
                if model.runs.isEmpty {
                    // 없는 것과 못 읽은 것은 다르다
                    Text(model.etaError ?? "지금 돌고 있는 워크플로가 없어요").font(.system(size: 11)).foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    let common = Self.commonTrack(model.runs)
                    VStack(alignment: .leading, spacing: 8) {
                        // 많이 돌 때 팝오버가 화면보다 길어지지 않게: 들어가면 그대로, 넘치면 스크롤
                        let rows = VStack(alignment: .leading, spacing: 10) {
                            ForEach(model.runs) { r in
                                RunRow(run: r, ownTrack: r.hasTrack && [r.trackN, r.trackExceeded] != common)
                            }
                        }
                        ViewThatFits(in: .vertical) {
                            rows
                            ScrollView { rows }
                        }
                        .frame(maxHeight: Config.runListCap(others: othersHeight))
                        .measure("list")
                        if let c = common {
                            // 게이지 아래 글자·단계 줄과 같은 10pt
                            Text("내 기록으로 재보면 \(c[0])번 중 \(c[1])번은 늦어도 시각을 넘겼어요")
                                .font(.system(size: 10)).foregroundColor(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            GroupBox {
                if model.stats.isEmpty {
                    Text("로컬 기록을 읽는 중…").font(.system(size: 11)).foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ForEach(model.stats) { s in
                        HStack {
                            Text(toolLabel[s.tool] ?? s.tool).font(.system(size: 11, weight: .semibold))
                                .frame(width: 84, alignment: .leading)
                            Text("총 " + tok(s.total)).font(.system(size: 11, design: .monospaced))
                            Spacer()
                            Text("오늘 " + tok(s.today)).font(.system(size: 11, design: .monospaced))
                                .foregroundColor(s.today > 0 ? .primary : .secondary)
                        }
                    }
                }
            } label: { Text("내 사용량").font(.system(size: 10)).foregroundColor(.secondary) }

            GroupBox {
                BoardList(model: model).frame(maxWidth: .infinity, alignment: .leading)
            } label: { Text("순위 — 이번 주 총 토큰").font(.system(size: 10)).foregroundColor(.secondary) }

            // 자동 올리기(간격은 직접 고름) | 로그인 시 자동 실행 — 한 줄에 양옆으로
            HStack(spacing: 6) {
                Toggle("올리기", isOn: $autoSubmit).toggleStyle(.checkbox)
                Picker("", selection: Binding(get: { interval }, set: { submitIntervalMin = $0 })) {
                    ForEach(Config.submitIntervals, id: \.self) { m in Text(Config.intervalText(m)).tag(m) }
                }
                .pickerStyle(.menu).labelsHidden().fixedSize().controlSize(.small)
                .disabled(!autoSubmit)
                .help("이 간격마다 내 공개 gist 에 숫자만 올려요. 바뀐 것이 없으면 올리지 않아요. 처음 한 번은 위의 버튼으로 직접 올려야 시작해요")
                Spacer()
                Toggle("로그인 시 자동 실행", isOn: $launchAtLogin).toggleStyle(.checkbox)
                    .onChange(of: launchAtLogin) { on in
                        do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
                        catch { launchAtLogin = SMAppService.mainApp.status == .enabled }
                    }
            }
            .font(.system(size: 10))

            HStack {
                Button("사이트 열기") { open(Config.siteURL) }
                if let g = model.gistURL {
                    Button("내 gist") { open(g) }.help("순위판이 읽는 내 공개 gist — 올라간 숫자를 그대로 볼 수 있어요")
                }
                Spacer()
                Button("종료") { NSApp.terminate(nil) }
            }
            .font(.system(size: 11))

            if let d = model.lastPublish {
                Text((model.lastUnchanged ? "마지막 확인 \(ago(d)), 바뀐 것 없음" : "마지막으로 올림 " + ago(d)) + (model.login.map { " · GitHub \($0)" } ?? ""))
                    .font(.system(size: 9)).foregroundColor(.secondary)
            }
        }
        .padding(14)
        .frame(width: 340)
        .disabled(!interactive)
        .allowsHitTesting(interactive)
        .measure("all")
        .onPreferenceChange(HeightKey.self) { h in
            // 전체 − 목록 = 나머지. 목록 높이는 상한을 따라 변해도 나머지는 그대로라 되먹임 없이 한 번에 자리 잡는다
            let others = (h["all"] ?? 0) - (h["list"] ?? 0)
            if others > 0, abs(others - othersHeight) > 1 { othersHeight = others }
        }
    }
}

/// 높이 재기 — 팝오버 전체("all")와 워크플로 목록("list")
struct HeightKey: PreferenceKey {
    static let defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) { value.merge(nextValue()) { $1 } }
}

extension View {
    func measure(_ key: String) -> some View {
        background(GeometryReader { g in Color.clear.preference(key: HeightKey.self, value: [key: g.size.height]) })
    }
}

/// 순위 상자 안: 위에서 6명, 내가 그 밖이면 '⋯' 다음에 내 줄. 맨 아래에 기준 시각과 읽지 못한 참가자.
struct BoardList: View {
    @ObservedObject var model: Model
    private let shown = 6

    /// 상자 아래 한 줄: 몇 시 기준인지, 새로 읽지 못했는지, 읽지 못한 참가자가 있는지
    private var footnote: String? {
        guard let at = model.boardFetchedAt else { return nil }
        var parts = ["\(clock(at)) 기준"]
        if model.boardError != nil { parts.append("새로 읽지 못했어요") }   // 이유는 마우스를 올리면
        let others = model.boardFailed.filter { $0.login.lowercased() != model.login?.lowercased() }
        if !others.isEmpty { parts.append("읽지 못한 참가자 \(others.count)명: " + others.map(\.login).joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if model.ranks.isEmpty {
                Text(model.boardError ?? (model.boardFetchedAt == nil ? "순위판을 읽는 중…" : "아직 순위판에 참가한 사람이 없어요"))
                    .font(.system(size: 11)).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(model.ranks.prefix(shown)) { RankLine(row: $0) }
                if let me = model.ranks.dropFirst(shown).first(where: \.mine) {
                    Text("⋯").font(.system(size: 10)).foregroundColor(.secondary).padding(.leading, 12)
                    RankLine(row: me)
                }
            }
            // 내 gist 를 순위판이 못 읽는 것은 내가 고쳐야 하는 일이라 따로, 눈에 띄게
            if let mine = model.boardFailed.first(where: { $0.login.lowercased() == model.login?.lowercased() }) {
                Text("순위판이 내 gist 를 읽지 못하고 있어요(\(mine.reasonText)). 다음에 올릴 때 다시 맞춰요")
                    .font(.system(size: 10)).foregroundColor(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let note = footnote, !(model.ranks.isEmpty && model.boardError != nil && model.boardFailed.isEmpty) {
                Text(note).font(.system(size: 9)).foregroundColor(.secondary)
                    .lineLimit(2).truncationMode(.tail)
                    .help(([model.boardError].compactMap { $0 } + model.boardFailed.map { "\($0.login): \($0.reasonText)" }).joined(separator: "\n"))
            }
        }
    }
}

/// 순위 한 줄: 순위 · 아이디 · 쓴 도구 · (하루 넘게 묵었으면) N일 전 · 이번 주 총 토큰
struct RankLine: View {
    let row: RankRow

    var body: some View {
        HStack(spacing: 6) {
            Text("\(row.rank)").font(.system(size: 11, weight: .bold, design: .monospaced))
                .frame(width: 18, alignment: .trailing)
                .foregroundColor(row.mine ? .accentColor : .secondary)
            Text(row.login).font(.system(size: 11, weight: row.mine ? .bold : .regular))
                .lineLimit(1).truncationMode(.middle).layoutPriority(1)
            Text(row.tools.map { toolShort[$0] ?? $0 }.joined(separator: "·")).font(.system(size: 9))
                .foregroundColor(.secondary).lineLimit(1)
            if let u = row.updatedAt, daysAgo(u) >= 1 {
                // 사이트와 같은 기준: 사흘 넘게 안 올렸으면 주황
                Text("\(daysAgo(u))일 전").font(.system(size: 9)).foregroundColor(daysAgo(u) > 3 ? .orange : .secondary).fixedSize()
            }
            Spacer(minLength: 4)
            Text(tok(row.week)).font(.system(size: 11, design: .monospaced)).fixedSize()
        }
        .help(row.updatedAt.map { "\(clock($0)) 기준 · 누적 \(tok(row.all))" } ?? "누적 \(tok(row.all))")
    }
}

/// 처음 한 번: 무엇이 어디에 올라가는지 알리고, 사람이 눌러야 올리기를 시작한다.
/// 첫 올리기는 공개 gist 를 새로 만든다(수정 기록까지 영원히 공개) — 그래서 버튼은 여기 하나뿐이고, 하는 일을 이름에 다 적는다.
struct ConsentBox: View {
    let every: String?       // 자동 올리기 간격("6시간") — 꺼져 있으면 nil
    let busy: Bool
    let publish: () -> Void
    let privacy: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("순위판에 참가하려면").font(.system(size: 11, weight: .semibold)).foregroundColor(.primary)
            Text("아래 버튼을 누르면 내 GitHub 계정에 공개 gist 를 만들어 토큰 숫자만 올려요. 이름·프로젝트·경로는 올라가지 않고, gist 의 수정 기록은 계속 공개로 남아요. 올린 뒤 나오는 ‘순위판에 참가하기’로 신청서를 한 번 내면 순위에 나와요."
                 + (every.map { " 그다음부터는 \($0)마다 자동으로 올려요(바뀐 것이 없으면 올리지 않아요)." } ?? ""))
                .fixedSize(horizontal: false, vertical: true)
            Text("터미널에서 gh auth login 으로 GitHub 에 로그인돼 있어야 해요.")
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button(action: publish) {
                    if busy { ProgressView().controlSize(.small) } else { Text("깃허브에 올리고 참가하기") }
                }
                .buttonStyle(.borderedProminent).tint(Config.gaugeTint).disabled(busy)
                Button("무엇이 올라가나요?", action: privacy).buttonStyle(.link).foregroundColor(Config.gaugeTint)   // 바깥 회색 글자색을 물려받지 않게
            }
            .font(.system(size: 11))
            .padding(.top, 2)
        }
        .font(.system(size: 10)).foregroundColor(.secondary)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Config.gaugeTint.opacity(0.10)))
    }
}

/// 올렸는데 순위판 명단에 없다(또는 예전 gist 로 올라 있다) — 참가 신청 이슈를 한 번 내면 된다
struct JoinBox: View {
    let url: URL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("아직 순위판에 없어요").font(.system(size: 11, weight: .semibold)).foregroundColor(.primary)
            Text("내 gist 에는 숫자가 올라갔어요. 참가 신청을 한 번 내면 몇 분 안에 순위에 나와요. GitHub 에서 신청서가 열리면 그대로 제출하면 돼요.")
                .fixedSize(horizontal: false, vertical: true)
            Button("순위판에 참가하기") { NSWorkspace.shared.open(url) }
                .buttonStyle(.borderedProminent).tint(Config.gaugeTint)
                .font(.system(size: 11))
                .padding(.top, 2)
        }
        .font(.system(size: 10)).foregroundColor(.secondary)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Config.gaugeTint.opacity(0.10)))
    }
}

/// 올리기 실패 알림 — 무엇이 문제인지, 무엇을 치면 되는지, 순위에는 언제 기록이 마지막으로 올라갔는지
struct PublishProblemBanner: View {
    let problem: PublishProblem
    let lastOnBoard: Date?
    let busy: Bool
    let retry: () -> Void    // 안내대로 고친 뒤 다음 간격을 기다리지 않고 바로 다시
    @State private var copied: String? = nil

    var body: some View {
        let g = problem.guidance
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.orange)
            VStack(alignment: .leading, spacing: 3) {
                Text("순위에 올리지 못했어요").font(.system(size: 11, weight: .semibold)).foregroundColor(.primary)
                Text(g.text).fixedSize(horizontal: false, vertical: true)
                if let cmd = g.command {
                    HStack(spacing: 6) {
                        Text(cmd).font(.system(size: 10, design: .monospaced)).foregroundColor(.primary)
                            .textSelection(.enabled)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 3).fill(Color.primary.opacity(0.08)))
                        Button(copied == cmd ? "복사했어요" : "복사") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(cmd, forType: .string)
                            copied = cmd
                        }
                        .buttonStyle(.link).foregroundColor(Config.gaugeTint)
                    }
                }
                HStack(spacing: 8) {
                    Text(lastOnBoard.map { "순위에 마지막으로 올라간 기록: \(ago($0))" } ?? "아직 한 번도 올리지 못했어요")
                    Spacer(minLength: 0)
                    Button(busy ? "올리는 중…" : "다시 올리기", action: retry).buttonStyle(.link).foregroundColor(Config.gaugeTint)
                        .disabled(busy).fixedSize()
                }
            }
            .font(.system(size: 10)).foregroundColor(.secondary)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.13)))
    }
}

struct RunRow: View {
    let run: RunETA
    var ownTrack = false     // 상자 아래 공통 문장과 다른 적중 기록이라 이 줄에 따로 적는다

    /// 이름 옆 한마디 — 시각을 그대로 믿기 전에 알아 둘 것이 있을 때만. 이름이 잘리지 않게 짧게.
    private var caveat: String? {
        if run.stalled { return nil }
        guard let end = run.latestBy else { return "끝나는 시각 모름" }
        if end <= Date() { return "곧 다시 계산해요" }          // 막 넘겼고 다음 새로고침(30초 안)에 다시 잡는다
        return run.locked ? nil : "아직 잠정이에요"
    }

    /// 게이지 왼쪽 끝 아래: 지금까지 돈 시간
    private var elapsed: String { run.elapsedSec < 30 ? "방금 시작" : "\(span(run.elapsedSec))째" }

    /// 단계와 에이전트. 단계 수를 모르는 실행은 에이전트만.
    private var facts: String {
        let agents = run.done + run.running == 0 ? "에이전트를 기다리는 중"
            : run.done == 0 ? "에이전트 \(run.running)개 도는 중"
            : run.running == 0 ? "에이전트 \(run.done)개 끝남" : "에이전트 \(run.done)개 끝나고 \(run.running)개 도는 중"
        return run.phaseTotal.map { "\($0)단계 중 \(run.phaseCur)단계, \(agents)" } ?? agents
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // 세션 이름을 먼저 — 여러 세션이 워크플로를 돌릴 때 어느 창 일인지가 먼저 궁금하다
                Text(run.sessionTitle ?? run.name).font(.system(size: 11, weight: .semibold)).foregroundColor(.primary)
                    .lineLimit(1).truncationMode(.middle).help(run.sessionTitle ?? run.name)
                Spacer(minLength: 0)
                if let c = caveat { Text(c).fixedSize() }
            }
            if run.sessionTitle != nil {
                Text(run.name).lineLimit(1).truncationMode(.middle).help(run.name)
            }
            if run.stalled {
                // 도는 에이전트 없이 오래 조용하다 — 기록 없이 끝났을 수 있으니 끝나는 시각을 내세우지 않는다
                Text("\(span(run.quietSec))째 소식이 없어요. 끝났거나 멈췄을 수 있어요")
            } else if let end = run.latestBy {
                // 게이지 한 줄 = 시작 → 늦어도. 지금과 '보통'이 그 위 어디쯤인지 비율로 놓는다
                let total = max(1, end.timeIntervalSince(run.startedAt))
                let at = { (d: Date) in CGFloat(min(1, max(0, d.timeIntervalSince(run.startedAt) / total))) }
                let now = at(Date()), typical = run.typicalAt.map(at)
                let passed = run.typicalBy == nil || (typical ?? 1) <= now
                RunGauge(now: now, typical: typical).opacity(run.locked ? 1 : 0.6)
                // 글자도 같은 자리 아래에: 지금까지 · 보통 · 늦어도
                AxisLabels(at: typical ?? 0) {
                    Text(passed ? "\(elapsed), 보통은 지났어요" : elapsed)
                    if !passed, let t = run.typicalBy { Text("보통 \(clock(t))쯤") }
                    if run.locked { Text("늦어도 \(clock(end))").font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundColor(.primary) }
                    else { Text("늦어도 \(clock(end))") }
                }
            } else {
                Text("\(elapsed), 이만큼 오래 돈 기록이 \(run.have)건뿐이라 끝나는 시각을 못 잡았어요")
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(facts)
            if run.revised > 0 && !run.stalled { Text("‘늦어도’를 \(run.revised)번 넘겨서 다시 잡았어요") }
            if ownTrack { Text("이 무렵에 잡은 시각은 \(run.trackN)번 중 \(run.trackExceeded)번 넘겼어요") }
        }
        .font(.system(size: 10).monospacedDigit()).foregroundColor(.secondary)
    }
}

/// 시작 → '늦어도'를 가로로 편 게이지. 채운 데까지가 지금, 세로 눈금이 '보통', 오른쪽 끝이 '늦어도'.
/// 상한은 넉넉하게 잡은 값이라 보통은 눈금 언저리에서 끝난다 — 눈금까지를 조금 더 짙게 깔아,
/// 덜 찬 채 끝나도 느린 것으로 읽히지 않게 한다. 보통을 지나면 눈금은 채움 안의 틈으로 남는다.
struct RunGauge: View {
    let now: CGFloat          // 0…1
    let typical: CGFloat?     // 0…1, 모르면 nil → 눈금 없음

    var body: some View {
        GeometryReader { g in
            let w = g.size.width
            let fill = max(4, w * now)
            let tick = typical.map { min(w - 2, max(0, w * $0 - 1)) }
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.10)).frame(height: 5)                                          // 늦어도까지
                if let t = typical { Capsule().fill(Color.primary.opacity(0.18)).frame(width: max(fill, w * t), height: 5) }   // 보통까지
                Capsule().fill(Config.gaugeTint).frame(width: fill, height: 5)
                    .overlay(alignment: .leading) {
                        // 지나온 '보통' 자리: 채움에 틈을 낸다
                        if let x = tick, x + 2 < fill - 2 { Rectangle().frame(width: 2).offset(x: x).blendMode(.destinationOut) }
                    }
                    .compositingGroup()
                if let x = tick, x + 2 >= fill - 2 {
                    RoundedRectangle(cornerRadius: 1).fill(Color.primary.opacity(0.7)).frame(width: 2, height: 9)
                        .offset(x: min(w - 2, max(fill + 2, x)))
                }
            }
            .frame(height: 9)
        }
        .frame(height: 9)
        .help("채운 데까지가 지금, 눈금이 보통 끝나는 때, 오른쪽 끝이 늦어도예요")
    }
}

/// 게이지 아래 글자 줄: 첫 글자는 왼쪽 끝, 마지막은 오른쪽 끝,
/// 가운데(있으면)는 `at`(0…1) 자리 아래에 두되 양옆 글자와 겹치지 않게 민다.
struct AxisLabels: Layout {
    var at: CGFloat
    private let gap: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let s = subviews.map { $0.sizeThatFits(.unspecified) }
        return CGSize(width: proposal.width ?? s.reduce(0) { $0 + $1.width + gap }, height: s.map(\.height).max() ?? 0)
    }

    func placeSubviews(in b: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count >= 2 else { return }
        let w = subviews.map { $0.sizeThatFits(.unspecified).width }
        let last = subviews.count - 1
        subviews[0].place(at: CGPoint(x: b.minX, y: b.minY), anchor: .topLeading, proposal: .unspecified)
        subviews[last].place(at: CGPoint(x: b.maxX, y: b.minY), anchor: .topTrailing, proposal: .unspecified)
        guard last == 2 else { return }
        let lo = b.minX + w[0] + gap + w[1] / 2, hi = b.maxX - w[2] - gap - w[1] / 2
        subviews[1].place(at: CGPoint(x: max(lo, min(hi, b.minX + b.width * at)), y: b.minY), anchor: .top, proposal: .unspecified)
    }
}

// ── 앱 뼈대 ─────────────────────────────────────────────────────────────
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let popover = NSPopover()
    let model = Model()
    var autoTimer: Timer?
    var etaTimer: Timer?
    var etaWatch: AnyCancellable?
    var problemWatch: AnyCancellable?

    /// 점검 실행에서만 쓰는 인자 — 값을 받는 것은 true
    static let checkFlags: [String: Bool] = [
        "--snapshot": true, "--appearance": true, "--fixture": true, "--publish-fixture": true, "--board-fixture": true,
        "--stats-fixture": true, "--state-out": true, "--board-live": false, "--stats-live": false,
        "--popover-test": false, "--steps": true, "--delay-ms": true, "--activate": false,
    ]

    /// 인자가 이상하면 그 이유(nil = 괜찮음). 일반 실행(로그인 시 자동 실행·Finder)은 '--' 인자 없이 뜬다 —
    /// '--' 인자가 하나라도 있으면 점검 실행으로 보고, 모르는 인자·빠진 값·빠진 점검 모드는 받지 않는다.
    /// 오타 하나(--snapshott, --snapshot 빠뜨림)로 일반 실행이 되면 30초 뒤 자동 올리기까지 한다.
    static func argumentProblem(_ args: [String]) -> String? {
        var i = 1, sawFlag = false
        while i < args.count {
            let a = args[i]
            i += 1
            guard a.hasPrefix("--") else { continue }   // macOS·Xcode 가 붙이는 -NS… 인자는 그대로 둔다
            sawFlag = true
            guard let takesValue = checkFlags[a] else { return "모르는 인자: \(a)" }
            if takesValue {
                guard i < args.count, !args[i].hasPrefix("--") else { return "\(a) 뒤에 값이 필요합니다" }
                i += 1
            }
        }
        if sawFlag && !args.contains("--snapshot") && !args.contains("--popover-test") {
            return "점검용 인자는 --snapshot 이나 --popover-test 와 함께만 씁니다"
        }
        return nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        if let why = Self.argumentProblem(args) {
            FileHandle.standardError.write("\(why) — 일반 실행(자동 올리기)으로 넘어가지 않고 끝냅니다\n".data(using: .utf8)!)
            exit(2)
        }
        NSApp.setActivationPolicy(.accessory)
        let value = { (flag: String) -> String? in
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }

        // 화면 점검용: `TokenMeter --snapshot <png> [--appearance light|dark] [--fixture <eta.json>]
        //   [--publish-fixture <p.json>] [--board-fixture <b.json>] [--stats-fixture <s.json>] [--board-live] [--stats-live]
        //   [--state-out <state.json>]`
        // 고정 자료를 실제 해석 경로(applyETA·applyPublish·applyBoard·applyStats)로 넣고 그림으로 저장한 뒤 끝낸다.
        // 올리기는 어떤 경우에도 하지 않는다. 사용량 수집·순위판 읽기도 고정 자료로만 — 단 --board-live 는
        // 순위판을 실제로 읽고(읽기 전용 GET), --stats-live 는 사용량을 실제로 수집한다(collect.mjs --json-only, 로컬 읽기만).
        // --fixture 가 없으면 지금 도는 워크플로를 읽는다(로컬). --state-out 은 화면 상태를 JSON 으로 남긴다(시험용).
        // 저장된 설정(마지막 올리기·로그인 등)은 그림에 섞이지 않게 비우고, 이번 실행은 아무것도 저장하지 않는다.
        if let out = value("--snapshot") {
            // 경로를 줬는데 못 읽으면 조용히 다른 것을 그리지 않고 멈춘다 — --fixture 를 잘못 주면
            // 지금 도는 진짜 워크플로(프로젝트 이름)가 그림에 들어간다
            var files: [String: Data] = [:]
            for flag in ["--fixture", "--publish-fixture", "--board-fixture", "--stats-fixture"] where args.contains(flag) {
                guard let path = value(flag), let d = FileManager.default.contents(atPath: path) else {
                    FileHandle.standardError.write("\(flag) 파일을 읽지 못했습니다\n".data(using: .utf8)!)
                    exit(2)
                }
                files[flag] = d
            }
            let text = { (flag: String) in files[flag].map { String(decoding: $0, as: UTF8.self) } }
            if let a = value("--appearance") { NSApp.appearance = NSAppearance(named: a == "light" ? .aqua : .darkAqua) }
            model.forgetSaved()
            Task {
                if let f = files["--fixture"] { if !model.applyETA(f) { model.etaError = "워크플로 상태를 읽지 못했어요" } }
                else { await model.refreshETA() }
                if let t = text("--stats-fixture") { if !model.applyStats(t) { model.status = "수집 결과 해석 실패" } }
                else if args.contains("--stats-live") { await model.refreshStats() }
                if let t = text("--publish-fixture") { model.applyPublishFixture(t) }   // 순위판보다 먼저: '내 줄'은 로그인으로 찾는다
                if let t = text("--board-fixture") { model.applyBoardFixture(t) }
                else if args.contains("--board-live") { await model.refreshBoard(force: true) }
                if let p = value("--state-out"), !model.writeCheckState(to: p, menuTitle: Self.menuTitle(model.runs)) { exit(1) }
                exit(snapshot(to: out) ? 0 : 1)
            }
            return
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "bolt.fill", accessibilityDescription: "토큰 계량기")
            button.imagePosition = .imageLeading
            button.action = #selector(togglePopover)
            button.target = self
        }

        // 돌고 있는 워크플로가 있으면 메뉴바에 "늦어도 몇 시"를 띄운다
        etaWatch = model.$runs.sink { [weak self] runs in self?.statusItem.button?.title = Self.menuTitle(runs) }
        // 올리기가 실패하고 있으면 번개에 경고 표시를 붙인다(팝오버를 열지 않아도 보이게)
        problemWatch = model.$publishProblem.sink { [weak self] problem in
            guard let button = self?.statusItem.button else { return }
            button.image = NSImage(systemSymbolName: problem == nil ? "bolt.fill" : "bolt.trianglebadge.exclamationmark.fill",
                                   accessibilityDescription: problem == nil ? "토큰 계량기" : "토큰 계량기 — 순위에 올리지 못했어요")
            button.toolTip = problem.map { "순위에 올리지 못했어요: " + $0.guidance.text }
        }

        // 팝오버 위치 점검은 진짜 메뉴바에 진짜 팝오버를 띄운다 — 그동안 누가 누르거나 쳐도 아무 일이 없게
        // 조작을 막고(체크박스도 실제 설정을 바꾼다) 올리기·저장을 잠근다
        let checking = args.contains("--popover-test")
        if checking { model.lockDown() }
        let host = NSHostingController(rootView: ContentView(model: model, interactive: !checking))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        popover.behavior = .transient

        // 팝오버 위치 점검용: `TokenMeter --popover-test --steps a.json,b.json [--delay-ms 800] [--activate]`
        // 빈 상태로 연 뒤 고정 자료를 차례로 넣어 내용을 늘리고, 창이 메뉴바 아래에 붙어 있는지 좌표로 확인한다.
        if args.contains("--popover-test") {
            let steps = (value("--steps") ?? "").split(separator: ",").map(String.init)
            let delay = UInt64(value("--delay-ms") ?? "800") ?? 800
            Task {
                guard let button = statusItem.button else { return }
                try? await Task.sleep(nanoseconds: 600_000_000)   // 상태 항목이 메뉴바에 자리 잡을 때까지
                let visible = NSScreen.main?.visibleFrame ?? .zero
                let frame = { self.popover.contentViewController?.view.window?.frame ?? .zero }
                var tops: [CGFloat] = []
                let line = { (tag: String) in
                    let f = frame()
                    tops.append(f.maxY)
                    print(String(format: "%@ top=%.0f bottom=%.0f h=%.0f %@", tag.padding(toLength: 22, withPad: " ", startingAt: 0), f.maxY, f.minY, f.height,
                                 f.minY >= visible.minY - 1 ? "" : "BELOW SCREEN"))
                }
                print(String(format: "button x=%.0f..%.0f | visible top=%.0f bottom=%.0f", button.window?.frame.minX ?? 0, button.window?.frame.maxX ?? 0, visible.maxY, visible.minY))
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                if args.contains("--activate") { NSApp.activate(ignoringOtherApps: true) }
                for step in steps {
                    try? await Task.sleep(nanoseconds: delay * 1_000_000)
                    line("before " + (step as NSString).lastPathComponent)
                    if let f = FileManager.default.contents(atPath: step) { model.applyETA(f) }
                }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                line("final")
                print(String(format: "top drift = %.0fpt (0 = 메뉴바 아래에 붙어 있음)", (tops.max() ?? 0) - (tops.min() ?? 0)))
                NSApp.terminate(nil)
            }
            return
        }

        etaTimer = Timer.scheduledTimer(withTimeInterval: Config.etaInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.model.refreshETA() }
        }

        Task { await model.refreshAll() }

        // 자동 올리기: 시작 30초 뒤 한 번, 그 뒤로는 고른 간격마다.
        // 1분마다 '때가 됐나'만 본다 — 간격을 바꾸면 바로 따르고, 잠자기에서 깨어나도 밀린 만큼 한 번만 올린다.
        // 처음 한 번은 사람이 동의 상자의 버튼을 눌러야 한다(model.consented) — 공개 gist 의 수정 기록은 영원히 남는다.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            self?.autoPublishIfDue()
        }
        autoTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.autoPublishIfDue() }
        }
    }

    private func autoPublishIfDue() {
        guard model.autoPublishDue() else { return }
        Task { await model.publish() }
    }

    /// 고정된 상한 가운데 가장 늦은 시각 — 그 실행들이 전부 끝나는 시각이다.
    /// 아직 잠정값이거나 상한을 못 낸 실행은 그 시각 안에 끝난다고 말할 수 없으므로 "+N" 으로만 알린다.
    /// (메뉴바가 좁으면 긴 제목은 카메라 자리 뒤로 밀려 안 보인다 — 짧게 유지한다.)
    static func menuTitle(_ runs: [RunETA]) -> String {
        let bounds = runs.filter { $0.locked }.compactMap(\.latestBy)
        let others = runs.count - bounds.count
        guard let latest = bounds.max() else { return "" }
        return " 늦어도 \(clock(latest))" + (others > 0 ? " +\(others)" : "")
    }

    private func snapshot(to file: String) -> Bool {
        let view = ContentView(model: model).background(Color(nsColor: .windowBackgroundColor))
            .environment(\.controlActiveState, .key)   // 열려 있는 팝오버처럼 강조색으로
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
        host.cacheDisplay(in: host.bounds, to: rep)
        print("menu title: [\(Self.menuTitle(model.runs))]")
        guard let png = rep.representation(using: .png, properties: [:]),
              (try? png.write(to: URL(fileURLWithPath: file))) != nil else {
            FileHandle.standardError.write("그림을 저장하지 못했습니다: \(file)\n".data(using: .utf8)!)
            return false
        }
        return true
    }

    @objc func togglePopover() {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = statusItem.button else { return }
        Task { await model.refreshAll() }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
    }
}

// 최상위 코드는 메인 스레드에서 돌지만 Swift 6 격리 표시가 없으므로 명시한다.
MainActor.assumeIsolated {
    let delegate = AppDelegate()
    let app = NSApplication.shared
    app.delegate = delegate                     // NSApplication.delegate 는 약한 참조
    withExtendedLifetime(delegate) { app.run() } // 앱 수명 동안 delegate 를 붙잡는다
}
