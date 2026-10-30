import Foundation

/// Environment names shared with the engine (src/shared/env.ts): AITT_<NAME>.
public enum AppEnv {
    /// The app bundle's binary that runs the engine and the MCP proxy (Contents/Resources/aitt).
    public static let binaryName = "aitt"

    public static func value(_ name: String, in env: [String: String]) -> String? {
        if let v = env["AITT_\(name)"], !v.isEmpty { return v }
        return nil
    }

    /// Homebrew's bin folders (Apple Silicon, Intel), appended to the engine's PATH when missing.
    public static let toolDirs = ["/opt/homebrew/bin", "/usr/local/bin"]

    /// The engine child's environment: AITT_HOME, the lifeline, and AITT_PORT only when the app overrides
    /// the port. Any AITT_* setting inherited from the app's own environment is dropped.
    /// PATH gains Homebrew's bin folders: started as a login item, the app has launchd's PATH, where `gh` isn't.
    public static func engineEnvironment(base: [String: String], home: String, port: Int?) -> [String: String] {
        var env = base.filter { !$0.key.hasPrefix("AITT_") }
        var path = (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        for dir in toolDirs where !path.contains(dir) { path.append(dir) }
        env["PATH"] = path.joined(separator: ":")
        env["AITT_HOME"] = home
        env["AITT_PARENT_LIFELINE"] = "1"
        if let port { env["AITT_PORT"] = String(port) }
        return env
    }

    /// Data folder for a new install.
    public static func defaultHome(userHome: String) -> String {
        (userHome as NSString).appendingPathComponent("AITaskTracking")
    }
}
