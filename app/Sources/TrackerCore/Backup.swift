import Foundation

/// The engine's git state as /api/health reports it.
public struct GitState: Equatable {
    public var lastPush: Date?
    public var pushError: String?
    public var commitError: String?
    public var pending: Bool
    public var ahead: Int
    public var remote: Bool

    public init(lastPush: Date? = nil, pushError: String? = nil, commitError: String? = nil, pending: Bool = false, ahead: Int = 0, remote: Bool = false) {
        self.lastPush = lastPush; self.pushError = pushError; self.commitError = commitError
        self.pending = pending; self.ahead = ahead; self.remote = remote
    }

    /// From the `git` object of /api/health.
    public init(json git: [String: Any]) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        let push = git["lastPush"] as? String
        self.init(lastPush: push.flatMap { iso.date(from: $0) ?? plain.date(from: $0) },
                  pushError: git["pushError"] as? String, commitError: git["commitError"] as? String,
                  pending: git["pending"] as? Bool ?? false, ahead: (git["ahead"] as? NSNumber)?.intValue ?? 0,
                  remote: git["remote"] as? Bool ?? false)
    }

    /// Quit can go straight ahead: nothing uncommitted and nothing waiting to be pushed (or nowhere to push).
    public var needsSyncBeforeQuit: Bool { pending || (remote && ahead > 0) }
}

public enum BackupText {
    /// "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago".
    public static func relative(_ date: Date, now: Date = Date()) -> String {
        let s = max(0, now.timeIntervalSince(date))
        switch s {
        case ..<60: return "just now"
        case ..<3600: return "\(Int(s / 60)) min ago"
        case ..<86_400: return "\(Int(s / 3600)) h ago"
        case ..<172_800: return "yesterday"
        default: return "\(Int(s / 86_400)) days ago"
        }
    }

    /// The menu's backup line.
    public static func line(_ g: GitState, now: Date = Date()) -> String {
        if g.pushError != nil { return "Backup error" }
        if !g.remote { return "No GitHub backup (no remote)" }
        if let p = g.lastPush { return "Last backed up \(relative(p, now: now))" }
        if g.ahead == 0 && !g.pending { return "Backed up" }
        return "Not backed up yet"
    }
}
