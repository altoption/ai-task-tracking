import Foundation

/// The engine owns which projects are hidden (`hiddenProjects` in config.yml; the Settings page and a project's page
/// change it). Quick capture is the one place in the app that asks, so it doesn't offer them.
public enum HiddenProjects {
    /// The hidden slugs from an /api/health reply; nil from a reply that doesn't say.
    public static func slugs(health: [String: Any]) -> Set<String>? {
        ((health["hiddenProjects"] as? [String: Any])?["selected"] as? [String]).map(Set.init)
    }

    /// Quick capture can't tell which projects are hidden and has nothing to show yet: that's an engine not answering,
    /// not an empty list. (With projects already showing, they stay.)
    public static func captureHasNoAnswer(hidden: Set<String>?, shown: Int) -> Bool { hidden == nil && shown == 0 }
}
