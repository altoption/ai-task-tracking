import Foundation

/// Every optional app behavior is a setting in UserDefaults (io.github.altoption.ai-task-tracking), read when it is used.
public enum SettingKey {
    // General
    public static let showNeedsYouInMenu = "showNeedsYouInMenu"
    public static let showStalledInNeedsYou = "showStalledInNeedsYou"
    public static let showCIStatus = "showCIStatus"
    public static let showInDock = "showInDock"
    // Notifications
    public static let notifications = "notifications"
    public static let notifyNeedsYou = "notifyNeedsYou"
    public static let notifyDone = "notifyDone"
    public static let notifyNew = "notifyNew"
    // Shortcuts
    public static let openWindowHotKey = "openWindowHotKey"
    public static let openWindowHotKeyPreset = "openWindowHotKeyPreset"
    public static let quickCaptureHotKey = "quickCaptureHotKey"
    public static let quickCaptureHotKeyPreset = "quickCaptureHotKeyPreset"
    // Appearance: the theme id; the engine owns it (`theme` in config.yml), the app mirrors it (ThemeSetting)
    public static let theme = "theme"
    // Hidden projects: the hidden slugs as Settings shows them; the engine owns them (`hiddenProjects` in config.yml),
    // the app mirrors them (HiddenProjectsSetting)
    public static let hiddenProjects = "hiddenProjects"
    // Backup
    public static let backupBeforeQuit = "backupBeforeQuit"
    // Quick capture state (not shown in Settings)
    public static let lastCaptureProject = "lastCaptureProject"
    // Theme sync state (not shown in Settings): a choice made in Settings not yet sent, and the engine's theme list
    public static let themePending = "themePending"
    public static let themeList = "themeList"
    // Hidden projects sync state (not shown in Settings): ticks not yet sent (slug -> hidden), the engine's projects
    public static let hiddenProjectsPending = "hiddenProjectsPending"
    public static let hiddenProjectsList = "hiddenProjectsList"
}

public enum SettingDefaults {
    public static let values: [String: Any] = [
        SettingKey.showNeedsYouInMenu: true,
        SettingKey.showStalledInNeedsYou: true,
        SettingKey.showCIStatus: true,
        SettingKey.showInDock: true,
        SettingKey.notifications: true,
        SettingKey.notifyNeedsYou: true,
        SettingKey.notifyDone: true,
        SettingKey.notifyNew: false,
        SettingKey.openWindowHotKey: true,
        SettingKey.openWindowHotKeyPreset: "optCmdI",
        SettingKey.quickCaptureHotKey: true,
        SettingKey.quickCaptureHotKeyPreset: "optCmdN",
        SettingKey.theme: "graphite",
        SettingKey.backupBeforeQuit: true,
    ]

    /// Defaults that apply until the user changes them (never written to disk).
    public static func register(in defaults: UserDefaults = .standard) {
        defaults.register(defaults: values)
    }
}
