import Foundation

public enum DeepLink {
    /// `aitt://settings` opens Settings: the page, or the fallback window without an engine (SettingsDestination).
    public static func isSettings(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "aitt" && url.host?.lowercased() == "settings"
    }

    /// `aitt://issue/Q-123` → `#/issue/Q-123`, `aitt://project/<slug>` → `#/project/<slug>`, `aitt://new` → `#/new`;
    /// any other aitt:// URL opens Home. nil for other schemes.
    public static func route(for url: URL) -> String? {
        guard url.scheme?.lowercased() == "aitt" else { return nil }
        let host = url.host?.lowercased() ?? ""
        let arg = url.pathComponents.filter { $0 != "/" }.first
        let enc = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? s }
        switch host {
        case "issue": if let arg, !arg.isEmpty { return "#/issue/\(enc(arg.uppercased()))" }
        case "project": if let arg, !arg.isEmpty { return "#/project/\(enc(arg))" }
        case "new": return "#/new"
        default: break
        }
        return "#/"
    }
}
