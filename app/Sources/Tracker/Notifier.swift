import AppKit
import TrackerCore
import UserNotifications

/// Listens to the engine's /api/events stream and posts a notification when an agent needs the owner, finishes an
/// issue, or creates one (each a setting). Bursts are coalesced: a batch of 10 new issues is one notification.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private let api: EngineAPI
    private let open: (String) -> Void
    private var task: Task<Void, Never>?
    private var buffer: [AgentNote] = []
    private var flushTimer: Timer?
    private var askedForPermission = false
    /// From /api/health (the engine's config); until the first poll answers, only `.new` can be recognised.
    var rules = NoteRules()
    private static let burstWindow: TimeInterval = 1.5

    /// `open` shows the window at a hash route (a notification click).
    init(api: EngineAPI, open: @escaping (String) -> Void) {
        self.api = api
        self.open = open
        super.init()
        if Self.available { UNUserNotificationCenter.current().delegate = self }
    }

    /// UNUserNotificationCenter needs a real app bundle (not a bare `swift run` binary).
    private static var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app") }

    private var enabled: Bool { UserDefaults.standard.bool(forKey: SettingKey.notifications) }

    /// Start or stop listening to match the master setting; asks for permission the first time it is on.
    func apply() {
        guard Self.available else { return }
        if enabled {
            if !askedForPermission {
                askedForPermission = true
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
                    if let error { EngineSupervisor.log("notifications: \(error.localizedDescription)") }
                    else if !granted { EngineSupervisor.log("notifications: permission not granted") }
                }
            }
            if task == nil { task = Task { [weak self] in await self?.listen() } }
        } else {
            task?.cancel()
            task = nil
            buffer.removeAll()
        }
    }

    // MARK: stream

    /// Reads the SSE stream; reconnects with backoff (1 s doubling to 30 s) while enabled.
    private func listen() async {
        var backoff: UInt64 = 1
        while !Task.isCancelled {
            var req = URLRequest(url: api.base.appendingPathComponent("api/events"), cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: 60) // heartbeats every 15 s keep it alive
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: req)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                backoff = 1
                var parser = SSEParser()
                var line = [UInt8]()
                // Byte-wise: AsyncBytes.lines drops the blank lines that end SSE events.
                for try await b in bytes {
                    if b != 10 { line.append(b); continue }
                    let text = String(decoding: line, as: UTF8.self)
                    line.removeAll(keepingCapacity: true)
                    if let payload = parser.feed(line: text) { handle(payload) }
                }
            } catch {
                if Task.isCancelled { return }
            }
            try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
            backoff = min(backoff * 2, 30)
        }
    }

    /// Issues that just stalled (from the health poll); they share the burst window with event notes.
    func noteStalled(_ notes: [AgentNote]) {
        guard enabled, !notes.isEmpty else { return }
        buffer.append(contentsOf: notes)
        scheduleFlush()
    }

    private func scheduleFlush() {
        if flushTimer == nil {
            flushTimer = Timer.scheduledTimer(withTimeInterval: Self.burstWindow, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.flush() }
            }
        }
    }

    private func handle(_ payload: String) {
        guard let data = payload.data(using: .utf8),
              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let note = AgentNote.from(event: event, rules: rules) else { return }
        buffer.append(note)
        scheduleFlush()
    }

    private func flush() {
        flushTimer = nil
        let d = UserDefaults.standard
        guard enabled else { buffer.removeAll(); return }
        let wanted = buffer.filter {
            switch $0.kind {
            case .needsYou: return d.bool(forKey: SettingKey.notifyNeedsYou)
            case .stalled: return d.bool(forKey: SettingKey.notifyNeedsYou) && d.bool(forKey: SettingKey.showStalledInNeedsYou)
            case .done: return d.bool(forKey: SettingKey.notifyDone)
            case .new: return d.bool(forKey: SettingKey.notifyNew)
            }
        }
        buffer.removeAll()
        for banner in NoteCoalescer.banners(wanted) { post(banner) }
    }

    private func post(_ b: NoteBanner) {
        let content = UNMutableNotificationContent()
        content.title = b.title
        content.body = b.body
        content.sound = .default
        content.userInfo = ["route": b.route]
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req) { error in
            if let error { EngineSupervisor.log("notification: \(error.localizedDescription)") }
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let route = response.notification.request.content.userInfo["route"] as? String ?? "#/"
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.open(route) }
        }
        completionHandler()
    }
}
