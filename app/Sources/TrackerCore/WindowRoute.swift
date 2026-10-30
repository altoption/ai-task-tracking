import Foundation

/// How the app window reaches a route on the engine. A route is either a UI hash route (`#/issue/ATT-1`) or a path
/// the engine serves (`docs/`, the user docs).
public enum WindowRoute {
    /// The docs site the engine serves at /docs/ (Help in the menus).
    public static let docs = "docs/"

    /// True when the window must load `route` as a URL; false when setting `location.hash` on the page it shows is
    /// enough (a hash route while the window already shows the UI at the engine's root).
    public static func needsLoad(route: String?, loaded: Bool, current: URL?, base: URL) -> Bool {
        guard loaded else { return true }
        guard let route else { return false }
        guard route.hasPrefix("#"), let current else { return true }
        let sameOrigin = current.scheme == base.scheme && current.host == base.host && current.port == base.port
        return !(sameOrigin && (current.path.isEmpty || current.path == "/"))
    }
}
