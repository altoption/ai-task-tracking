import Foundation

/// First launch: the data folder has no config.yml yet (or `aitt setup` is still writing it), so the app
/// asks the user to run `aitt setup` instead of starting the engine on an empty folder.
public enum FirstRun {
    /// Written by `aitt setup` while it fills a new folder (src/setup/setup.ts SETUP_LOCK).
    public static let lockPath = ".tracker/setup.lock"

    public static func needsSetup(home: String, exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> Bool {
        let base = home.hasSuffix("/") ? String(home.dropLast()) : home
        return !exists(base + "/config.yml") || exists(base + "/" + lockPath)
    }

    /// The Terminal command to copy: the bundled binary by full path (works before `aitt` is on PATH),
    /// with `--home` when the app uses a folder other than the default.
    public static func setupCommand(binary: String, home: String, defaultHome: String) -> String {
        var cmd = "\(shellQuote(binary)) setup"
        if home != defaultHome { cmd += " --home \(shellQuote(home))" }
        return cmd
    }

    static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
