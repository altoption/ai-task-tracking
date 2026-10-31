import Foundation

/// One project as /api/health lists it for Settings (`hiddenProjects.projects`): slug and name. `_none` is "No project",
/// the folder of issues without a project.
public struct ProjectEntry: Equatable {
    public let slug: String
    public let name: String

    public init(slug: String, name: String) { self.slug = slug; self.name = name }

    public init?(json: [String: Any]) {
        guard let slug = json["slug"] as? String else { return nil }
        self.init(slug: slug, name: json["name"] as? String ?? slug)
    }

    /// As stored in UserDefaults (`hiddenProjectsList`), so Settings has the list before the engine answers.
    public var dictionary: [String: String] { ["slug": slug, "name": name] }
}

/// `hiddenProjects` in /api/health: the hidden slugs as config.yml has them (`selected`) and every project.
public struct HiddenProjectsState: Equatable {
    public let selected: [String]
    public let projects: [ProjectEntry]

    public init(selected: [String], projects: [ProjectEntry]) { self.selected = selected; self.projects = projects }

    public init?(json: [String: Any]) {
        guard let selected = json["selected"] as? [String], let list = json["projects"] as? [[String: Any]] else { return nil }
        self.init(selected: selected, projects: list.compactMap(ProjectEntry.init(json:)))
    }
}

/// The Hidden projects setting. Like the theme, the engine owns it (`hiddenProjects` in config.yml), because the
/// browser's project page can hide and unhide too. The app mirrors the engine's list and choice into UserDefaults and
/// sends only what the user ticks in Settings, one project at a time: `hiddenProjectsPending` maps a slug to the state
/// the user chose, until the engine has it.
public enum HiddenProjectsSetting {
    /// The engine's projects as last stored (`hiddenProjectsList`); empty before the first answer.
    public static func storedList(_ defaults: UserDefaults) -> [ProjectEntry] {
        (defaults.array(forKey: SettingKey.hiddenProjectsList) as? [[String: String]] ?? []).compactMap { ProjectEntry(json: $0) }
    }

    /// The hidden slugs Settings shows: the engine's, with choices not yet sent applied.
    public static func hidden(_ defaults: UserDefaults) -> Set<String> {
        Set(defaults.stringArray(forKey: SettingKey.hiddenProjects) ?? [])
    }

    /// Choices made in Settings that the engine doesn't have yet: slug → hidden.
    public static func pending(_ defaults: UserDefaults) -> [String: Bool] {
        defaults.dictionary(forKey: SettingKey.hiddenProjectsPending) as? [String: Bool] ?? [:]
    }

    /// A tick in Settings. The shown list is written before the pending change: each write notifies UserDefaults
    /// observers synchronously, and the one that sends (HiddenProjectsSync.pushIfPending) reads the pending map.
    public static func set(_ slug: String, hidden: Bool, defaults: UserDefaults) {
        var shown = Self.hidden(defaults)
        if hidden { shown.insert(slug) } else { shown.remove(slug) }
        defaults.set(shown.sorted(), forKey: SettingKey.hiddenProjects)
        var p = pending(defaults)
        p[slug] = hidden
        defaults.set(p, forKey: SettingKey.hiddenProjectsPending)
    }
}

/// Keeps the app's Hidden projects and the engine's in step (one per app; main thread), the way ThemeSync does:
/// - Ticks in Settings are pending until the engine has them: `pushIfPending` sends one change at a time (slugs in
///   order). A confirmed (2xx) or refused (400: a project that doesn't exist) reply drops that slug from pending if
///   it still holds the value sent; a newer tick is sent next. Any other reply, or none, leaves it pending for the
///   next poll, also across app restarts (pending is in UserDefaults).
/// - A poll stores the engine's project list and adopts its hidden slugs with pending ticks applied on top, except
///   from a probe that started before the last confirmation (it may still report the old list).
public final class HiddenProjectsSync {
    public typealias Outcome = ThemeSync.Outcome
    public typealias Send = (_ slug: String, _ hidden: Bool, _ done: @escaping (Outcome) -> Void) -> Void

    private let defaults: UserDefaults
    private let send: Send
    /// The change being sent, while a request is out.
    public private(set) var inFlight: (slug: String, hidden: Bool)?
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
        guard inFlight == nil else { return }
        let pending = HiddenProjectsSetting.pending(defaults)
        guard let slug = pending.keys.sorted().first, let hidden = pending[slug] else { return }
        inFlight = (slug, hidden)
        send(slug, hidden) { [weak self] outcome in
            guard let self else { return }
            self.inFlight = nil
            guard outcome != .retry else { return }
            var now = HiddenProjectsSetting.pending(self.defaults)
            if now[slug] == hidden {
                now.removeValue(forKey: slug)
                self.confirmedAfterProbe = self.probes
                self.defaults.set(now, forKey: SettingKey.hiddenProjectsPending)
            }
            self.pushIfPending()
        }
    }

    /// Apply a poll's state (nil: no engine, or one without hidden projects) from probe number `probe`. Writes only
    /// what changed: each write wakes the app's UserDefaults observer.
    public func sync(_ state: HiddenProjectsState?, probe: Int) {
        guard let state else { return }
        let list = state.projects.map(\.dictionary)
        if (defaults.array(forKey: SettingKey.hiddenProjectsList) as? [[String: String]]) != list {
            defaults.set(list, forKey: SettingKey.hiddenProjectsList)
        }
        let pending = HiddenProjectsSetting.pending(defaults)
        if !pending.isEmpty { pushIfPending() }
        guard probe > confirmedAfterProbe else { return }
        var shown = Set(state.selected)
        for (slug, hidden) in pending { if hidden { shown.insert(slug) } else { shown.remove(slug) } }
        if HiddenProjectsSetting.hidden(defaults) != shown { defaults.set(shown.sorted(), forKey: SettingKey.hiddenProjects) }
    }
}
