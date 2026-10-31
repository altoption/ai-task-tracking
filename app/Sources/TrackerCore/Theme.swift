import Foundation

/// One theme as /api/health lists it (`theme.themes`): id, name, base (`dark`, `light`, or `system` for Match macOS)
/// and the background color (`bg`, none for `system`).
public struct ThemeEntry: Equatable {
    public let id: String
    public let name: String
    public let base: String
    public let bg: String?

    public init(id: String, name: String, base: String, bg: String? = nil) {
        self.id = id; self.name = name; self.base = base; self.bg = bg
    }

    public init?(json: [String: Any]) {
        guard let id = json["id"] as? String, let name = json["name"] as? String, let base = json["base"] as? String else { return nil }
        self.init(id: id, name: name, base: base, bg: json["bg"] as? String)
    }

    /// As stored in UserDefaults (`themeList`), so Settings and the window have the list before the engine answers.
    public var dictionary: [String: String] {
        var d = ["id": id, "name": name, "base": base]
        if let bg { d["bg"] = bg }
        return d
    }
}

/// `theme` in /api/health: the id in config.yml (`selected`), the theme actually shown (`effective`: an unknown id,
/// such as a deleted theme file, shows the default, Graphite) and the list.
public struct ThemeState: Equatable {
    public let selected: String
    public let effective: String
    public let themes: [ThemeEntry]

    public init(selected: String, effective: String? = nil, themes: [ThemeEntry]) {
        self.selected = selected; self.effective = effective ?? selected; self.themes = themes
    }

    public init?(json: [String: Any]) {
        guard let selected = json["selected"] as? String, let list = json["themes"] as? [[String: Any]] else { return nil }
        self.init(selected: selected, effective: json["effective"] as? String, themes: list.compactMap(ThemeEntry.init(json:)))
    }
}

/// An sRGB color, components 0...1.
public struct RGBA: Equatable {
    public let r, g, b, a: Double
    public init(r: Double, g: Double, b: Double, a: Double = 1) { self.r = r; self.g = g; self.b = b; self.a = a }

    /// `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; nil otherwise (theme backgrounds in rgb()/hsl() use the fallback).
    public init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("#") else { return nil }
        s.removeFirst()
        if s.count == 3 || s.count == 4 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
        let n = s.count == 6 ? (v << 8) | 0xff : v
        self.init(r: Double((n >> 24) & 0xff) / 255, g: Double((n >> 16) & 0xff) / 255,
                  b: Double((n >> 8) & 0xff) / 255, a: Double(n & 0xff) / 255)
    }
}

/// How the app window looks for a theme: its appearance (`dark`, `light`, or nil to follow macOS) and the background
/// it paints before the page does, per appearance (the same color twice unless it follows macOS).
public struct WindowLook: Equatable {
    public let appearance: String?
    public let darkBackground: RGBA
    public let lightBackground: RGBA

    /// Dark's and Light's backgrounds (Match macOS without a list), and Graphite's: the default theme's window before
    /// the app has heard of any theme (the `bg` token in src/engine/themes.ts).
    public static let darkBg = RGBA(hex: "#101012")!
    public static let lightBg = RGBA(hex: "#f4f4f6")!
    public static let graphiteBg = RGBA(hex: "#141619")!
    public static let graphite = WindowLook(appearance: "dark", darkBackground: graphiteBg, lightBackground: graphiteBg)

    public init(appearance: String?, darkBackground: RGBA, lightBackground: RGBA) {
        self.appearance = appearance; self.darkBackground = darkBackground; self.lightBackground = lightBackground
    }
}

/// The Theme setting. Unlike "Show CI status", the choice lives in the engine (`theme` in config.yml), because the
/// browser's ⌘K can change it too: the app mirrors the engine's choice and list into UserDefaults (so the window opens
/// in the right colors before the engine answers) and sends its own only when the user picks one in Settings.
public enum ThemeSetting {
    /// The engine's DEFAULT_THEME (src/engine/themes.ts): shown when config.yml has no `theme`.
    public static let defaultTheme = "graphite"

    /// The built-ins the Settings popup lists before the engine has sent its list.
    public static let fallbackList: [ThemeEntry] = [
        ThemeEntry(id: "graphite", name: "Graphite", base: "dark", bg: "#141619"),
        ThemeEntry(id: "dark", name: "Dark", base: "dark", bg: "#101012"),
        ThemeEntry(id: "light", name: "Light", base: "light", bg: "#f4f4f6"),
        ThemeEntry(id: "system", name: "Match macOS", base: "system"),
    ]

    /// The engine's list as last stored (`themeList`), else the built-ins every engine has.
    public static func storedList(_ defaults: UserDefaults) -> [ThemeEntry] {
        let list = (defaults.array(forKey: SettingKey.themeList) as? [[String: String]] ?? []).compactMap { ThemeEntry(json: $0) }
        return list.isEmpty ? fallbackList : list
    }

    /// A pick in Settings. `theme` is written before `themePending`: each write notifies UserDefaults observers
    /// synchronously, and the one that sends (ThemeSync.pushIfPending, on `themePending`) must read the new id.
    /// Picking what the engine already shows still sends it (config.yml may hold a deleted theme's id).
    public static func pick(_ id: String, defaults: UserDefaults) {
        defaults.set(id, forKey: SettingKey.theme)
        defaults.set(true, forKey: SettingKey.themePending)
    }

    /// The window look for `selected`. Match macOS follows the system with Dark's and Light's backgrounds; an
    /// unknown id looks like the default, Graphite.
    public static func look(selected: String, themes: [ThemeEntry]) -> WindowLook {
        let bg = { (id: String, fallback: RGBA) in themes.first { $0.id == id }?.bg.flatMap(RGBA.init(hex:)) ?? fallback }
        guard let t = themes.first(where: { $0.id == selected }) else { return .graphite }
        if t.base == "system" {
            return WindowLook(appearance: nil, darkBackground: bg("dark", WindowLook.darkBg), lightBackground: bg("light", WindowLook.lightBg))
        }
        let isLight = t.base == "light"
        let color = t.bg.flatMap(RGBA.init(hex:)) ?? (isLight ? WindowLook.lightBg : WindowLook.darkBg)
        return WindowLook(appearance: isLight ? "light" : "dark", darkBackground: color, lightBackground: color)
    }
}

/// Keeps the app's theme and the engine's in step (one per app; main thread).
/// - A pick in Settings is pending until the engine has it: `pushIfPending` sends one request at a time. A confirmed
///   (2xx) or refused (400: an id the engine doesn't know; sending it again can't help) reply clears pending only if
///   the theme is still the one it sent; a newer pick is sent next. Any other reply, or none, leaves it pending for
///   the next poll, also across app restarts (pending is in UserDefaults).
/// - A poll stores the engine's list and, with nothing pending, adopts the theme it shows, except from a probe that
///   started before the last pick was confirmed (it may still report the old theme). Probes are numbered
///   (`beginProbe`), so clock changes don't matter.
public final class ThemeSync {
    /// How the engine answered POST /api/theme.
    public enum Outcome: Equatable {
        case confirmed, refused, retry

        /// 2xx confirmed, 400 refused, anything else (5xx, 403, no reply: nil) retried later.
        public init(status: Int?) {
            switch status {
            case .some(200..<300): self = .confirmed
            case .some(400): self = .refused
            default: self = .retry
            }
        }
    }
    public typealias Send = (_ id: String, _ done: @escaping (Outcome) -> Void) -> Void

    private let defaults: UserDefaults
    private let send: Send
    /// The id being sent, while a request is out.
    public private(set) var inFlight: String?
    private var probes = 0
    private var confirmedAfterProbe = 0

    public init(defaults: UserDefaults, send: @escaping Send) {
        self.defaults = defaults; self.send = send
    }

    /// Call when a health probe starts; pass the number to `sync` with its reply.
    public func beginProbe() -> Int {
        probes += 1
        return probes
    }

    public func pushIfPending() {
        guard inFlight == nil, defaults.bool(forKey: SettingKey.themePending), let id = defaults.string(forKey: SettingKey.theme) else { return }
        inFlight = id
        send(id) { [weak self] outcome in
            guard let self else { return }
            self.inFlight = nil
            guard outcome != .retry else { return }
            if self.defaults.string(forKey: SettingKey.theme) == id {
                self.confirmedAfterProbe = self.probes
                self.defaults.set(false, forKey: SettingKey.themePending)
            } else {
                self.pushIfPending()
            }
        }
    }

    /// Apply a poll's theme state (nil: no engine, or one without themes) from probe number `probe`. Writes only
    /// what changed: each write wakes the app's UserDefaults observer.
    public func sync(_ state: ThemeState?, probe: Int) {
        guard let state else { return }
        let list = state.themes.map(\.dictionary)
        if (defaults.array(forKey: SettingKey.themeList) as? [[String: String]]) != list { defaults.set(list, forKey: SettingKey.themeList) }
        if defaults.bool(forKey: SettingKey.themePending) { return pushIfPending() }
        guard probe > confirmedAfterProbe, defaults.string(forKey: SettingKey.theme) != state.effective else { return }
        defaults.set(state.effective, forKey: SettingKey.theme)
    }
}
