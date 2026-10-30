import Foundation

/// Something an agent did that the owner may want to hear about.
public struct AgentNote: Equatable {
    /// `.stalled` comes from /api/health (the engine's stalled rules), not from an event: work stalls by time passing.
    public enum Kind: String, Equatable, CaseIterable { case needsYou, stalled, done, new }
    public let kind: Kind
    public let id: String
    public let title: String
    public let workspace: String?

    public init(kind: Kind, id: String, title: String, workspace: String?) {
        self.kind = kind; self.id = id; self.title = title; self.workspace = workspace
    }

    /// Classify one `/api/events` payload. Only agent writes count; issue events carry the summary before and after,
    /// so status and label moves are visible without fetching the issue. A new issue that already needs the owner
    /// is `.needsYou`, not `.new`.
    public static func from(event e: [String: Any], rules: NoteRules) -> AgentNote? {
        guard e["kind"] as? String == "issue", let issue = e["issue"] as? [String: Any],
              let actor = e["actor"] as? [String: Any], actor["actor"] as? String == "agent",
              let id = issue["id"] as? String else { return nil }
        let title = issue["title"] as? String ?? ""
        let ws = actor["workspace"] as? String
        let status = issue["status"] as? String ?? ""
        let labels = Set(issue["labels"] as? [String] ?? [])
        let needsLabels = labels.intersection(rules.needsYouLabels)
        guard let prev = e["prev"] as? [String: Any] else {
            let needs = rules.needsYouStatuses.contains(status) || !needsLabels.isEmpty
            return AgentNote(kind: needs ? .needsYou : .new, id: id, title: title, workspace: ws)
        }
        let was = prev["status"] as? String ?? ""
        let hadLabels = Set(prev["labels"] as? [String] ?? [])
        let newNeedsLabel = !needsLabels.subtracting(hadLabels).isEmpty
        if (rules.needsYouStatuses.contains(status) && was != status) || newNeedsLabel {
            return AgentNote(kind: .needsYou, id: id, title: title, workspace: ws)
        }
        if rules.doneStatuses.contains(status) && !rules.doneStatuses.contains(was) {
            return AgentNote(kind: .done, id: id, title: title, workspace: ws)
        }
        return nil
    }
}

/// The engine's rules (`rules` in /api/health): config.needsYou and the statuses of type `completed`.
public struct NoteRules: Equatable {
    public var needsYouStatuses: Set<String>
    public var needsYouLabels: Set<String>
    public var doneStatuses: Set<String>

    public init(needsYouStatuses: Set<String> = [], needsYouLabels: Set<String> = [], doneStatuses: Set<String> = []) {
        self.needsYouStatuses = needsYouStatuses; self.needsYouLabels = needsYouLabels; self.doneStatuses = doneStatuses
    }

    public init(json r: [String: Any]) {
        self.init(needsYouStatuses: Set(r["needsYouStatuses"] as? [String] ?? []),
                  needsYouLabels: Set(r["needsYouLabels"] as? [String] ?? []),
                  doneStatuses: Set(r["doneStatuses"] as? [String] ?? []))
    }
}

/// Stalled work from the engine's /api/health: `stalled` (ids in Needs you only because they stalled) and
/// `stalledAll` (every stalled id). One notification per issue per stalled episode: an id is remembered from its
/// notification until it is no longer stalled at all (Done, or new activity), so a round trip through Waiting, which
/// only takes it off the stalled-only list, never notifies twice. The first answer is the baseline (already stalled
/// at launch: no notification).
public struct StalledWatch: Equatable {
    private var notified: Set<String>?

    public init() {}

    /// The ids to notify about now.
    public mutating func update(stalledOnly: [String], stalledAll: [String]) -> [String] {
        let stalled = Set(stalledAll).union(stalledOnly)
        guard var seen = notified else { notified = stalled; return [] }
        seen.formIntersection(stalled) // an episode ends when the issue stops being stalled
        let fresh = stalledOnly.filter { !seen.contains($0) }
        seen.formUnion(fresh)
        notified = seen
        return fresh
    }
}

/// "Show CI status": the engine owns CI status (it runs `gh`), so the app hands it the setting. /api/health says which
/// setting the engine last heard (`ci.setting`); the app sends its own whenever they differ, which also covers an
/// engine restart. An engine without CI status (nil) is left alone.
public enum CIStatusSetting {
    public static func needsSync(engine: Bool?, wanted: Bool) -> Bool {
        guard let engine else { return false }
        return engine != wanted
    }
}

/// The Needs-you number and rows with the "Show stalled work in Needs you" setting applied.
public enum StalledFilter {
    /// The engine's count includes stalled-only issues; without the setting they don't count.
    public static func count(needsYou: Int, stalledOnly: Int, showStalled: Bool) -> Int {
        showStalled ? needsYou : max(0, needsYou - stalledOnly)
    }

    /// The menu's Needs-you request. Without stalled work the engine drops stalled-only rows before its 50-row cut.
    public static func needsYouPath(showStalled: Bool) -> String {
        showStalled ? "api/needs-you" : "api/needs-you?stalled=0"
    }
}

/// What to show for a burst of notes.
public struct NoteBanner: Equatable {
    public let title: String
    public let body: String
    /// Hash route the click opens.
    public let route: String
}

public enum NoteCoalescer {
    /// One banner per kind: a single issue gets its own banner, several become a summary ("10 new issues from web-app").
    /// The same issue twice in a kind counts once (latest title wins).
    public static func banners(_ notes: [AgentNote]) -> [NoteBanner] {
        AgentNote.Kind.allCases.compactMap { kind in
            var byId: [String: AgentNote] = [:], order: [String] = []
            for n in notes where n.kind == kind {
                if byId[n.id] == nil { order.append(n.id) }
                byId[n.id] = n
            }
            let list = order.compactMap { byId[$0] }
            guard let first = list.first else { return nil }
            if list.count == 1 {
                let head: String
                switch kind { case .needsYou: head = "Needs you"; case .stalled: head = "Stalled"; case .done: head = "Done"; case .new: head = "New" }
                let body = [first.title, first.workspace].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " — ")
                return NoteBanner(title: "\(head): \(first.id)", body: body, route: "#/issue/\(first.id)")
            }
            let workspaces = Set(list.compactMap(\.workspace))
            let from = workspaces.count == 1 ? " from \(workspaces.first!)" : workspaces.count > 1 ? " from \(workspaces.count) workspaces" : ""
            let n = list.count
            let title: String
            switch kind {
            case .needsYou: title = "\(n) issues need you\(from)"
            case .stalled: title = "\(n) issues stalled\(from)"
            case .done: title = "\(n) issues done\(from)"
            case .new: title = "\(n) new issues\(from)"
            }
            let ids = list.prefix(5).map(\.id).joined(separator: ", ") + (n > 5 ? " +\(n - 5) more" : "")
            return NoteBanner(title: title, body: ids, route: "#/")
        }
    }
}
