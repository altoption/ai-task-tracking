import Foundation
import TrackerCore

/// Where the engine lives: data folder and port. AITT_HOME from the environment wins and is remembered
/// (scripts/install.sh writes the same default), otherwise the remembered folder, otherwise ~/AITaskTracking.
struct EngineConfig {
    let home: String
    /// Set only when the user configured a port for the app; otherwise the engine reads config.yml itself.
    let portOverride: Int?
    let port: Int

    static func load(defaults: UserDefaults = .standard, env: [String: String] = ProcessInfo.processInfo.environment) -> EngineConfig {
        if let fromEnv = AppEnv.value("HOME", in: env) { defaults.set(fromEnv, forKey: "trackerHome") }
        let home = defaults.string(forKey: "trackerHome") ?? AppEnv.defaultHome(userHome: NSHomeDirectory())
        let configured = defaults.integer(forKey: "port")
        let override = configured > 0 ? configured : nil
        return EngineConfig(home: home, portOverride: override, port: override ?? configPort(home: home) ?? 7477)
    }

    /// `port: 1234` at the top level of `<home>/config.yml`, if any.
    static func configPort(home: String) -> Int? {
        guard let text = try? String(contentsOfFile: home + "/config.yml", encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n") where line.hasPrefix("port:") {
            return Int(line.dropFirst(5).trimmingCharacters(in: .whitespaces))
        }
        return nil
    }
}

struct Health {
    let gitProblem: String?
    /// Count of the home Needs-you bucket, carried by /api/health so the poll never fetches /api/home. Includes stalled work.
    let needsYou: Int
    /// Ids in Needs you only because they stalled (the engine's stalled rules); empty from an older engine.
    let stalled: [String]
    /// Every stalled id, including ones that need the owner anyway (for one notification per stalled episode).
    let stalledAll: [String]
    /// Backup state: pending/ahead/remote/lastPush.
    let git: GitState
    /// What counts as Needs-you / done (config.needsYou, `completed` statuses); nil from an older engine.
    let rules: NoteRules?
    /// The "Show CI status" setting as the engine last heard it (`ci.setting`); nil from an engine without CI status.
    let ciSetting: Bool?
}

/// One row of GET /api/needs-you.
struct NeedsYouItem {
    let id: String
    let title: String
    /// The Needs-you status or label, or "stalled" when stalling is the only reason.
    let why: String
    /// The stalled reason ("idle 31 h in In Progress"), when it stalled.
    let stalled: String?
}

/// POST /api/sync's answer, or why there was none.
struct SyncOutcome {
    var ok = false
    var committed = false
    var pushed = false
    var commitError: String?
    var pushError: String?
    /// The engine didn't answer (or answered with an error status).
    var requestError: String?
}

/// What answers on the port: our engine (same data folder), some other server, or nothing.
enum Probe {
    case ours(Health)
    case foreign
    case none
}

/// Same folder, ignoring symlinks (/tmp vs /private/tmp) and trailing slashes.
func samePath(_ a: String, _ b: String) -> Bool {
    URL(fileURLWithPath: a).resolvingSymlinksInPath().standardizedFileURL.path
        == URL(fileURLWithPath: b).resolvingSymlinksInPath().standardizedFileURL.path
}

struct EngineError: Error {
    let message: String
}

/// Talks to the engine's JSON API. URLSession sends `Host: 127.0.0.1:<port>`, which the engine requires.
struct EngineAPI {
    let port: Int
    var base: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    private func get(_ path: String, timeout: TimeInterval = 2, completion: @escaping ([String: Any]?, Bool) -> Void) {
        let url = URL(string: path, relativeTo: base) ?? base.appendingPathComponent(path)
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let answered = response != nil
            let object = (response as? HTTPURLResponse)?.statusCode == 200
                ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } : nil
            DispatchQueue.main.async { completion(object, answered) }
        }.resume()
    }

    /// POST with the owner header; JSON object back, or the engine's `{ error }` / the transport error as text.
    private func post(_ path: String, body: [String: Any], timeout: TimeInterval,
                      completion: @escaping (Result<[String: Any], EngineError>) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent(path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "X-Tracker")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let result: Result<[String: Any], EngineError>
            if status == 200, let object { result = .success(object) }
            else if let message = object?["error"] as? String { result = .failure(EngineError(message: message)) }
            else { result = .failure(EngineError(message: error?.localizedDescription ?? "The AI Task Tracking engine is not answering")) }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    /// Commit now, then push to origin unless `push` is false. A push can take up to a minute.
    func sync(push: Bool, _ completion: @escaping (SyncOutcome) -> Void) {
        post("api/sync", body: ["push": push], timeout: 150) { r in
            switch r {
            case .success(let o):
                completion(SyncOutcome(ok: o["ok"] as? Bool ?? false, committed: o["committed"] as? Bool ?? false,
                                       pushed: o["pushed"] as? Bool ?? false, commitError: o["commitError"] as? String,
                                       pushError: o["pushError"] as? String))
            case .failure(let e): completion(SyncOutcome(requestError: e.message))
            }
        }
    }

    /// Run a tool as the owner.
    func tool(_ name: String, args: [String: Any], _ completion: @escaping (Result<[String: Any], EngineError>) -> Void) {
        post("api/tool/\(name)", body: ["args": args], timeout: 10, completion: completion)
    }

    /// POST /api/ci: the "Show CI status" setting (off: the engine stops running gh and shows no CI status).
    func setCIStatus(_ on: Bool) {
        post("api/ci", body: ["enabled": on], timeout: 2) { _ in }
    }

    /// GET /api/needs-you (light: id, title, why); without `stalled`, stalled-only rows are left out by the engine.
    func needsYou(stalled: Bool = true, _ completion: @escaping ([NeedsYouItem]?) -> Void) {
        let url = URL(string: StalledFilter.needsYouPath(showStalled: stalled), relativeTo: base) ?? base
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let rows = (response as? HTTPURLResponse)?.statusCode == 200
                ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } : nil
            let items = rows?.compactMap { r -> NeedsYouItem? in
                guard let id = r["id"] as? String else { return nil }
                return NeedsYouItem(id: id, title: r["title"] as? String ?? "", why: r["why"] as? String ?? "", stalled: r["stalled"] as? String)
            }
            DispatchQueue.main.async { completion(items) }
        }.resume()
    }

    /// Ours only if it is our engine (`ok`, `version`, a `git` object) serving `home`. `fresh` (the quit check)
    /// makes the engine re-read ahead/pending from git first, so a hand-made commit or edit is not missed.
    func probe(home: String, fresh: Bool = false, _ completion: @escaping (Probe) -> Void) {
        get(fresh ? "api/health?fresh=1" : "api/health", timeout: fresh ? 10 : 2) { o, answered in
            guard let o else { return completion(answered ? .foreign : .none) }
            guard o["ok"] as? Bool == true, o["version"] is String, let git = o["git"] as? [String: Any],
                  let theirs = o["home"] as? String, samePath(theirs, home) else { return completion(.foreign) }
            let problem = (git["commitError"] as? String).map { "commit failed: \($0)" }
                ?? (git["pushError"] as? String).map { "push failed: \($0)" }
            completion(.ours(Health(gitProblem: problem, needsYou: (o["needsYou"] as? NSNumber)?.intValue ?? 0,
                                    stalled: o["stalled"] as? [String] ?? [], stalledAll: o["stalledAll"] as? [String] ?? [],
                                    git: GitState(json: git),
                                    rules: (o["rules"] as? [String: Any]).map(NoteRules.init(json:)),
                                    ciSetting: (o["ci"] as? [String: Any])?["setting"] as? Bool)))
        }
    }
}

/// Runs `Resources/aitt serve` as a child process, restarts it with backoff when it dies, and stops it
/// with SIGTERM on quit. If a healthy engine already answers on the port (a dev run), it attaches instead.
final class EngineSupervisor {
    enum State: Equatable { case starting, running, attached, restarting, portBusy, stopped }

    let config: EngineConfig
    let api: EngineAPI
    private(set) var state: State = .starting
    private var child: Process?
    /// The child's stdin. We never write to it; when this app dies the pipe closes and the engine shuts down
    /// (AITT_PARENT_LIFELINE=1), so a force-quit app never leaves an orphaned engine holding the port.
    private var lifeline: Pipe?
    private var logFile: FileHandle?
    private var startedAt = Date()
    private var backoff: TimeInterval = 1
    private var restartPending = false
    private var quitting = false
    var onChange: (() -> Void)?

    init(config: EngineConfig) {
        self.config = config
        self.api = EngineAPI(port: config.port)
        Self.trimLog()
    }

    private var binary: String { Bundle.main.resourcePath! + "/" + AppEnv.binaryName }

    /// Attach to our engine already on the port, start our own if the port is free, or report it busy.
    func ensureRunning() {
        guard !quitting, child == nil, !restartPending else { return }
        restartPending = true
        api.probe(home: config.home) { [weak self] probe in
            guard let self else { return }
            self.restartPending = false
            guard !self.quitting, self.child == nil else { return }
            switch probe {
            case .ours: self.set(.attached)
            case .foreign: self.set(.portBusy)
            case .none: self.spawn()
            }
        }
    }

    /// Called by the 3 s poll when our engine isn't the one answering.
    func engineUnreachable() {
        switch state {
        case .attached: set(.restarting); ensureRunning()
        case .portBusy: ensureRunning()
        default: break
        }
    }

    private func spawn() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binary)
        p.arguments = ["serve"]
        p.environment = AppEnv.engineEnvironment(base: ProcessInfo.processInfo.environment, home: config.home, port: config.portOverride)
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let log = Self.logHandle()
        let lifeline = Pipe()
        p.standardInput = lifeline
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.childExited(proc) }
        }
        do {
            try p.run()
            child = p
            self.lifeline = lifeline
            self.logFile = log
            startedAt = Date()
            set(.running)
        } catch {
            try? log.close()
            Self.log("could not start \(binary): \(error.localizedDescription)")
            scheduleRestart()
        }
    }

    private func childExited(_ proc: Process) {
        guard proc === child else { return }
        child = nil
        lifeline = nil
        try? logFile?.close()
        logFile = nil
        if quitting { set(.stopped); return }
        Self.log("engine exited (status \(proc.terminationStatus)); restarting")
        if Date().timeIntervalSince(startedAt) > 30 { backoff = 1 }
        scheduleRestart()
    }

    private func scheduleRestart() {
        set(.restarting)
        let delay = backoff
        backoff = min(backoff * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.ensureRunning() }
    }

    /// SIGTERM our child (never an attached engine) and wait for it to commit and exit. The engine's shutdown
    /// bounds server drain and the final git commit at 5 s each; past `timeout` it gets SIGKILL.
    func stop(timeout: TimeInterval = 11, completion: @escaping () -> Void) {
        quitting = true
        guard let p = child, p.isRunning else { completion(); return }
        p.terminate()
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(timeout)
            while p.isRunning && Date() < deadline { usleep(50_000) }
            if p.isRunning {
                Self.log("engine did not exit within \(Int(timeout)) s; killing pid \(p.processIdentifier)")
                kill(p.processIdentifier, SIGKILL)
            }
            DispatchQueue.main.async(execute: completion)
        }
    }

    private func set(_ s: State) {
        state = s
        onChange?()
    }

    // MARK: log (~/Library/Logs/AI Task Tracking/engine.log)

    private static let logPath = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Logs/AI Task Tracking/engine.log")

    private static func logHandle() -> FileHandle {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: (logPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logPath) { fm.createFile(atPath: logPath, contents: nil) }
        guard let h = FileHandle(forWritingAtPath: logPath) else { return FileHandle.nullDevice }
        h.seekToEndOfFile()
        return h
    }

    /// Start over when the log passes 5 MB (checked once per launch).
    private static func trimLog() {
        let size = (try? FileManager.default.attributesOfItem(atPath: logPath)[.size] as? Int) ?? 0
        if size > 5_000_000 { try? Data().write(to: URL(fileURLWithPath: logPath)) }
    }

    static func log(_ message: String) {
        let h = logHandle()
        h.write(Data("[app \(ISO8601DateFormatter().string(from: Date()))] \(message)\n".utf8))
        try? h.close()
    }
}
