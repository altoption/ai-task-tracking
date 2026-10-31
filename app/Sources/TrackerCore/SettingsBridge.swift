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
    }

    /// One shortcut choice as the page lists it.
    public struct Preset: Equatable {
        public let id: String
        public let label: String
        public init(id: String, label: String) { self.id = id; self.label = label }
    }

    /// Only the page itself: the engine's origin, its top frame, at its root. Not an iframe, not the docs (same origin,
    /// but not this page), and not an attachment under /files/ (sandboxed by the engine, so its origin is opaque).
    public static func acceptsSender(scheme: String?, host: String?, port: Int?, isMainFrame: Bool, path: String?, engine: URL) -> Bool {
        guard isMainFrame, scheme == engine.scheme, host == engine.host, port == engine.port else { return false }
        return path == nil || path == "" || path == "/"
    }

    /// A message as a request; nil for anything but a known operation with a known key and a valid value.
    public static func parse(_ body: Any, presets: [String: [Preset]]) -> Request? {
        guard let m = body as? [String: Any], let op = m["op"] as? String else { return nil }
        switch op {
        case "get": return .get
        case "backupNow": return .backupNow
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
    public static func state(_ defaults: UserDefaults, login: Bool, presets: [String: [Preset]]) -> [String: Any] {
        var values: [String: Any] = [loginKey: login]
        for key in boolKeys { values[key] = defaults.bool(forKey: key) }
        for key in presetKeys {
            let list = presets[key] ?? []
            let stored = defaults.string(forKey: key)
            values[key] = list.first { $0.id == stored }?.id ?? list.first?.id ?? ""
        }
        return ["values": values, "presets": presets.mapValues { $0.map { ["id": $0.id, "label": $0.label] } }]
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
}
