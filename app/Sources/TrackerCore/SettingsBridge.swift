import Foundation

/// What the Settings page may ask the app (SettingsBridgeHandler in the app hands it the web view's messages).
/// Pure, so the rules are tested without a web view. The page's rows (ui/settingsModel.ts) use the same keys; a test
/// in tests/ui/settings.test.ts keeps them equal.
public enum SettingsBridge {
    /// The message handler's name in the page (`window.webkit.messageHandlers.<name>`; ui/appSettings.ts).
    public static let handlerName = "aittSettings"
    /// The event that tells the page a setting changed elsewhere (ui/appSettings.ts CHANGE_EVENT).
    public static let changeEvent = "aitt:app-settings"
    /// Launch at login: a macOS login item, not a UserDefaults key.
    public static let loginKey = "launchAtLogin"

    /// Switches. Nothing else in UserDefaults can be written from the page: not the data folder, nor the engine mirrors.
    public static let boolKeys: [String] = [SettingKey.showInDock, SettingKey.showNeedsYouInMenu, SettingKey.showStalledInNeedsYou, SettingKey.showCIStatus, SettingKey.notifications, SettingKey.notifyNeedsYou, SettingKey.notifyDone, SettingKey.notifyNew, SettingKey.openWindowHotKey, SettingKey.quickCaptureHotKey, SettingKey.backupBeforeQuit]
    /// Shortcut menus: the value must be one of that key's preset ids.
    public static let presetKeys: [String] = [SettingKey.openWindowHotKeyPreset, SettingKey.quickCaptureHotKeyPreset]

    public enum Request: Equatable {
        case get
        case setBool(key: String, value: Bool)
        case setPreset(key: String, id: String)
        case setLogin(Bool)
        case backupNow
        /// The page saw the engine's theme change: the window's colors follow without waiting for the next poll.
        case themeChanged
    }

    /// One shortcut choice as the page lists it.
    public struct Preset: Equatable {
        public let id: String
        public let label: String
        public init(id: String, label: String) { self.id = id; self.label = label }
    }

    /// Only the page itself: the engine's origin, its top frame, at its root. Not an iframe, not the docs (same origin,
    /// but not this page), and not an attachment under /files/ (sandboxed by the engine, so its origin is opaque).
    /// A same-origin blob: page has the engine's origin too, so the frame's URL must also be the engine's root; a real
    /// web view reports that page as `http://127.0.0.1:<port>/#/…` (path "/"), and a blob's path as "". No URL: refused.
    public static func acceptsSender(scheme: String?, host: String?, port: Int?, isMainFrame: Bool, url: URL?, engine: URL) -> Bool {
        guard isMainFrame, scheme == engine.scheme, host == engine.host, port == engine.port else { return false }
        return isEnginePage(url, engine: engine)
    }

    /// `url` is the page at the engine's root, whatever its hash route.
    public static func isEnginePage(_ url: URL?, engine: URL) -> Bool {
        guard let url else { return false }
        return url.scheme == engine.scheme && url.host == engine.host && url.port == engine.port && url.path == "/"
    }

    /// A message as a request; nil for anything but a known operation with a known key and a valid value.
    public static func parse(_ body: Any, presets: [String: [Preset]]) -> Request? {
        guard let m = body as? [String: Any], let op = m["op"] as? String else { return nil }
        switch op {
        case "get": return .get
        case "backupNow": return .backupNow
        case "themeChanged": return .themeChanged
        case "set":
            guard let key = m["key"] as? String, let value = m["value"] else { return nil }
            if key == loginKey { return strictBool(value).map(Request.setLogin) }
            if boolKeys.contains(key) { return strictBool(value).map { .setBool(key: key, value: $0) } }
            if presetKeys.contains(key), let id = value as? String, presets[key]?.contains(where: { $0.id == id }) == true {
                return .setPreset(key: key, id: id)
            }
            return nil
        default: return nil
        }
    }

    /// A real boolean. `as? Bool` alone would also take the numbers 0 and 1, which reach here as NSNumber too.
    private static func strictBool(_ value: Any) -> Bool? {
        guard CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() else { return nil }
        return value as? Bool
    }

    /// What the page shows (`AppSettingsState` in ui/appSettings.ts).
    /// `loginProblem`: why Launch at login isn't what was asked for, shown on its row.
    public static func state(_ defaults: UserDefaults, login: Bool, loginProblem: String? = nil, presets: [String: [Preset]]) -> [String: Any] {
        var values: [String: Any] = [loginKey: login]
        for key in boolKeys { values[key] = defaults.bool(forKey: key) }
        for key in presetKeys {
            let list = presets[key] ?? []
            let stored = defaults.string(forKey: key)
            values[key] = list.first { $0.id == stored }?.id ?? list.first?.id ?? ""
        }
        return ["values": values, "presets": presets.mapValues { $0.map { ["id": $0.id, "label": $0.label] } },
                "problems": loginProblem.map { [loginKey: $0] } ?? [String: String]()]
    }
}

/// What the bridge does with a message and when it tells the page, without a web view. SettingsBridgeHandler in the app
/// only passes messages in and scripts out. Changes are plain UserDefaults writes, so they take effect as any other does.
public final class SettingsBridgeSession {
    public struct Sender {
        public let scheme: String?, host: String?, port: Int?, isMainFrame: Bool, url: URL?
        public init(scheme: String?, host: String?, port: Int?, isMainFrame: Bool, url: URL?) {
            self.scheme = scheme; self.host = host; self.port = port; self.isMainFrame = isMainFrame; self.url = url
        }
    }
    /// The macOS login item.
    public struct Login {
        public let isOn: () -> Bool, problem: () -> String?, set: (Bool) -> Void
        public init(isOn: @escaping () -> Bool, problem: @escaping () -> String?, set: @escaping (Bool) -> Void) {
            self.isOn = isOn; self.problem = problem; self.set = set
        }
    }

    private let engine: URL, defaults: UserDefaults, presets: [String: [SettingsBridge.Preset]], login: Login
    private let backup: (@escaping (String) -> Void) -> Void
    private let themeChanged: () -> Void
    /// The state the page last heard, by a reply or a push: a push repeats nothing, and misses nothing.
    private var lastSent: Data?

    public init(engine: URL, defaults: UserDefaults, presets: [String: [SettingsBridge.Preset]], login: Login,
                backup: @escaping (@escaping (String) -> Void) -> Void, themeChanged: @escaping () -> Void) {
        self.engine = engine; self.defaults = defaults; self.presets = presets; self.login = login
        self.backup = backup; self.themeChanged = themeChanged
    }

    private var state: [String: Any] {
        SettingsBridge.state(defaults, login: login.isOn(), loginProblem: login.problem(), presets: presets)
    }
    private func serialized(_ s: [String: Any]) -> Data? { try? JSONSerialization.data(withJSONObject: s, options: [.sortedKeys]) }

    /// Answers every message exactly once: the state, a backup's line, or an error for a refused sender or request.
    public func handle(_ body: Any, from s: Sender, reply: @escaping (Any?, String?) -> Void) {
        guard SettingsBridge.acceptsSender(scheme: s.scheme, host: s.host, port: s.port, isMainFrame: s.isMainFrame, url: s.url, engine: engine) else {
            return reply(nil, "not allowed")
        }
        guard let request = SettingsBridge.parse(body, presets: presets) else { return reply(nil, "unknown setting or invalid value") }
        switch request {
        case .get: break
        case .setBool(let key, let value): defaults.set(value, forKey: key)
        case .setPreset(let key, let id): defaults.set(id, forKey: key)
        case .setLogin(let on): login.set(on)
        case .themeChanged: themeChanged()
        case .backupNow: return backup { text in reply(["text": text], nil) }
        }
        let now = state
        lastSent = serialized(now)
        reply(now, nil)
    }

    /// The script that tells the page of a change: nil when it already knows, or when the frame shows something else.
    public func pushScript(current url: URL?) -> String? {
        guard SettingsBridge.isEnginePage(url, engine: engine), let data = serialized(state), data != lastSent,
              let json = String(data: data, encoding: .utf8) else { return nil }
        lastSent = data
        return "dispatchEvent(new CustomEvent('\(SettingsBridge.changeEvent)', { detail: \(json) }))"
    }
}

/// Keys of an older app, which kept picks in Settings until the engine had them. Removed once at launch.
public enum LegacySettings {
    public struct Pending: Equatable {
        public var theme: String?
        public var hidden: [String: Bool]
        public init(theme: String? = nil, hidden: [String: Bool] = [:]) { self.theme = theme; self.hidden = hidden }
    }

    /// Remove the old keys, and hand back the picks the engine never got.
    public static func take(_ defaults: UserDefaults) -> Pending {
        let pending = Pending(theme: defaults.bool(forKey: "themePending") ? defaults.string(forKey: SettingKey.theme) : nil,
                              hidden: defaults.dictionary(forKey: "hiddenProjectsPending") as? [String: Bool] ?? [:])
        for key in ["themePending", "hiddenProjectsPending", "hiddenProjectsList", "hiddenProjects"] where defaults.object(forKey: key) != nil {
            defaults.removeObject(forKey: key)
        }
        return pending
    }
}

/// Which Settings ⌘, the menu and `aitt://settings` open.
public enum SettingsDestination: Equatable {
    /// The page in the main window (`WindowRoute.settings`).
    case page
    /// The small native window: there's no engine to serve the page, or the setup window is up.
    case fallback

    public static func choose(engineReachable: Bool, inFirstRun: Bool) -> SettingsDestination {
        engineReachable && !inFirstRun ? .page : .fallback
    }

    /// The fallback window is up and the page can open now: the poll swaps them.
    public static func fallbackSwitchesToPage(fallbackVisible: Bool, engineReachable: Bool, inFirstRun: Bool) -> Bool {
        fallbackVisible && choose(engineReachable: engineReachable, inFirstRun: inFirstRun) == .page
    }

    /// During first run the engine waits for `aitt setup`: starting it would create config.yml in the unset folder,
    /// which ends first run without setup.
    public static func fallbackMayStartEngine(inFirstRun: Bool) -> Bool { !inFirstRun }
}
