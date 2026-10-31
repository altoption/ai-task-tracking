import AppKit
import Carbon
import ServiceManagement
import TrackerCore
import WebKit

/// Menu bar shell for the AI Task Tracking engine: runs `Resources/aitt serve`, shows the *Needs you* count and git
/// trouble in the menu bar, and hosts the web UI in a window toggled by ⌥⌘I. Optional behaviors are settings
/// (the Settings page, through SettingsBridgeHandler; SettingsWindow without an engine); quitting first commits and backs up (SyncPanel); agent activity can notify (Notifier).
@main
@MainActor
enum TrackerMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        _ = delegate
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var engine: EngineSupervisor!
    private var window: TrackerWindow?
    private var hotKey: HotKey?
    private var captureHotKey: HotKey?
    private var hotKeyConfig = ""
    private var poll: Timer?
    private var healthy = false
    private var needsYou = 0
    /// Ids in Needs you only because they stalled, and which of them are new since the last poll (for notifications).
    private var stalledOnly: [String] = []
    private var stalledWatch = StalledWatch()
    private var gitProblem: String?
    private var git = GitState()
    private var notifier: Notifier?
    private var settings: SettingsWindow?
    /// Picks an older app never got to the engine (LegacySettings), sent once when it first answers.
    private var legacyPicks = LegacySettings.Pending()
    private var capture: QuickCapturePanel?
    /// Set while the data folder waits for `aitt setup` (the engine isn't started until it finishes).
    private var firstRun: FirstRunWindow?
    private var firstRunTimer: Timer?
    private let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private let backupLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Launch at Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
    private let openItem = NSMenuItem(title: "Open AI Task Tracking", action: #selector(openTracker), keyEquivalent: "")
    /// Needs-you rows at the top of the menu (refreshed when the menu opens, never by the 3 s poll).
    private var needsYouItems: [NSMenuItem] = []
    private var lastNeedsYou: [NeedsYouItem] = []
    /// "Back up now" result, shown instead of the computed backup line until it expires.
    private var backupOverride: (text: String, until: Date)?
    private var backingUp = false
    // Quit flow
    private var quitApproved = false
    private var syncPanel: SyncPanel?
    private var syncGeneration = 0
    /// Set from the first quit request until it is resolved (quit, cancelled, or the probe failed): a second quit
    /// while the health probe runs must not start another probe that could disagree and quit mid-dialog.
    private var quitInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        SettingDefaults.register()
        legacyPicks = LegacySettings.take(.standard)
        NSApp.mainMenu = Self.mainMenu()
        engine = EngineSupervisor(config: EngineConfig.load())
        engine.onChange = { [weak self] in self?.render() }
        notifier = Notifier(api: engine.api) { [weak self] route in self?.showWindow(route: route) }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = Self.menuBarIcon()
        statusItem.button?.imagePosition = .imageLeft
        statusItem.menu = buildMenu()

        applySettings()
        NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.applySettings() }
        }

        enableLoginItemIfRequested()
        if FirstRun.needsSetup(home: engine.config.home) { startFirstRun() } else { engine.ensureRunning() }
        poll = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        refresh()
        render()
    }

    /// Clicking the Dock icon with no window showing opens the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow(route: nil) }
        return true
    }

    /// The bundled MenuBarIcon (a monochrome template image, see app/build.sh) or, without one, an SF Symbol.
    private static func menuBarIcon() -> NSImage? {
        let icon = Bundle.main.image(forResource: "MenuBarIcon") ?? NSImage(systemSymbolName: "checklist", accessibilityDescription: nil)
        icon?.size = NSSize(width: 18, height: 18)
        icon?.isTemplate = true
        icon?.accessibilityDescription = "AI Task Tracking"
        return icon
    }

    /// aitt://issue/Q-1, aitt://project/<slug>, aitt://new (registered in Info.plist by app/build.sh).
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if DeepLink.isSettings(url) { showSettings() } else if let route = DeepLink.route(for: url) { showWindow(route: route) }
        }
    }

    /// Quit: when there is something to commit or push (and "Back up to GitHub before quitting" is on), cancel this
    /// terminate, sync with a visible SyncPanel, and terminate again once the user's choice allows it.
    /// Logout/restart/shutdown never wait on a dialog; the engine still commits on SIGTERM.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitApproved || Self.isSystemQuit() || !UserDefaults.standard.bool(forKey: SettingKey.backupBeforeQuit) {
            return stopEngineAndQuit()
        }
        if quitInFlight { syncPanel?.makeKeyAndOrderFront(nil); return .terminateCancel }
        quitInFlight = true
        engine.api.probe(home: engine.config.home, fresh: true) { [weak self] probe in
            guard let self, self.quitInFlight else { return }
            guard case .ours(let health) = probe else {
                // Not our engine answering (or none): nothing we can sync; the engine (if ours) commits on SIGTERM.
                self.quitInFlight = false
                return self.quitNow()
            }
            guard health.git.needsSyncBeforeQuit else { return self.quitNow() }
            EngineSupervisor.log("quit: syncing first (pending \(health.git.pending), \(health.git.ahead) unpushed)")
            self.startQuitSync(remote: health.git.remote)
        }
        return .terminateCancel
    }

    private func stopEngineAndQuit() -> NSApplication.TerminateReply {
        poll?.invalidate()
        statusLine.title = "Stopping engine…"
        engine.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    private func quitNow() {
        quitInFlight = false
        syncPanel?.orderOut(nil)
        syncPanel = nil
        quitApproved = true
        // Not from inside this (main-queue) block: terminate's .terminateLater waits in a nested run loop for
        // engine.stop's main-queue completion, which a still-running main-queue block would never let through.
        NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
    }

    private static func isSystemQuit() -> Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent,
              event.eventClass == kCoreEventClass, event.eventID == kAEQuitApplication else { return false }
        return event.attributeDescriptor(forKeyword: kAEQuitReason) != nil
    }

    private func cancelQuit() {
        EngineSupervisor.log("quit: cancelled")
        syncGeneration += 1 // results still in flight are ignored; the engine finishes its commit/push on its own
        quitInFlight = false
        syncPanel?.orderOut(nil)
        syncPanel = nil
        refresh()
    }

    /// Step 1: commit ("Saving changes…"); step 2, when there is a remote: push ("Backing up to GitHub…").
    private func startQuitSync(remote: Bool) {
        syncGeneration += 1
        let gen = syncGeneration
        let panel = syncPanel ?? SyncPanel()
        syncPanel = panel
        panel.showProgress("Saving changes…") { [weak self] in self?.cancelQuit() }
        engine.api.sync(push: false) { [weak self] r in
            guard let self, gen == self.syncGeneration else { return }
            if let err = r.requestError ?? r.commitError {
                EngineSupervisor.log("quit: commit failed: \(err)")
                return panel.showFailure("Couldn't save your changes", message: err, choices: [
                    .init(title: "Retry") { [weak self] in self?.startQuitSync(remote: remote) },
                    .init(title: "Quit anyway (changes stay on disk)", destructive: true) { [weak self] in self?.quitNow() },
                    .init(title: "Cancel", isCancel: true) { [weak self] in self?.cancelQuit() },
                ])
            }
            guard remote else { return self.quitNow() }
            self.pushBeforeQuit()
        }
    }

    private func pushBeforeQuit() {
        syncGeneration += 1
        let gen = syncGeneration
        guard let panel = syncPanel else { return }
        panel.showProgress("Backing up to GitHub…", extra: [.init(title: "Quit without backup") { [weak self] in
            EngineSupervisor.log("quit: without waiting for the backup")
            self?.quitNow()
        }]) { [weak self] in self?.cancelQuit() }
        engine.api.sync(push: true) { [weak self] r in
            guard let self, gen == self.syncGeneration else { return }
            if let err = r.commitError {
                return panel.showFailure("Couldn't save your changes", message: err, choices: [
                    .init(title: "Retry") { [weak self] in self?.startQuitSync(remote: true) },
                    .init(title: "Quit anyway (changes stay on disk)", destructive: true) { [weak self] in self?.quitNow() },
                    .init(title: "Cancel", isCancel: true) { [weak self] in self?.cancelQuit() },
                ])
            }
            if let err = r.pushError ?? r.requestError {
                EngineSupervisor.log("quit: backup failed: \(err)")
                return panel.showFailure("Couldn't back up to GitHub", message: err, choices: [
                    .init(title: "Retry") { [weak self] in self?.pushBeforeQuit() },
                    .init(title: "Quit without backup") { [weak self] in self?.quitNow() },
                    .init(title: "Cancel", isCancel: true) { [weak self] in self?.cancelQuit() },
                ])
            }
            self.quitNow()
        }
    }

    // MARK: settings

    /// The window's appearance and background follow the theme (no light flash in a dark theme, and the reverse).
    private func applyThemeLook() {
        window?.apply(currentThemeLook)
    }

    private var currentThemeLook: WindowLook {
        let d = UserDefaults.standard
        return ThemeSetting.look(selected: d.string(forKey: SettingKey.theme) ?? ThemeSetting.defaultTheme, themes: ThemeSetting.storedList(d))
    }

    /// Re-applied on every UserDefaults change (cheap and idempotent): hotkeys, notifications, the theme.
    private func applySettings() {
        let d = UserDefaults.standard
        applyThemeLook()
        // Dock icon (and app switcher) or menu bar only; the Info.plist starts as LSUIElement so login launches with
        // the setting off never flash a Dock icon.
        let policy: NSApplication.ActivationPolicy = d.bool(forKey: SettingKey.showInDock) ? .regular : .accessory
        if NSApp.activationPolicy() != policy { NSApp.setActivationPolicy(policy) }
        let open = HotKeyPreset.find(d.string(forKey: SettingKey.openWindowHotKeyPreset), in: HotKeyPreset.openWindow)
        let cap = HotKeyPreset.find(d.string(forKey: SettingKey.quickCaptureHotKeyPreset), in: HotKeyPreset.quickCapture)
        let openOn = d.bool(forKey: SettingKey.openWindowHotKey), capOn = d.bool(forKey: SettingKey.quickCaptureHotKey)
        let config = "\(openOn):\(open.id) \(capOn):\(cap.id)"
        if config != hotKeyConfig {
            hotKeyConfig = config
            hotKey = nil
            captureHotKey = nil
            if openOn {
                hotKey = HotKey(id: 1, keyCode: open.keyCode, modifiers: open.modifiers) { [weak self] in self?.toggleWindow() }
                if hotKey == nil { EngineSupervisor.log("could not register \(open.label) (taken by another app?)") }
            }
            if capOn {
                captureHotKey = HotKey(id: 2, keyCode: cap.keyCode, modifiers: cap.modifiers) { [weak self] in self?.quickCapture() }
                if captureHotKey == nil { EngineSupervisor.log("could not register \(cap.label) (taken by another app?)") }
            }
            openItem.keyEquivalent = openOn ? open.key : ""
            openItem.keyEquivalentModifierMask = open.menuModifiers
        }
        notifier?.apply()
    }

    /// ⌘,, the menu and `aitt://settings`: the page when the engine answers now, else the small native window.
    @objc fileprivate func showSettings() {
        engine.api.probe(home: engine.config.home) { [weak self] probe in
            guard let self else { return }
            var reachable = false
            if case .ours = probe { reachable = true }
            switch SettingsDestination.choose(engineReachable: reachable, inFirstRun: self.firstRun != nil) {
            case .page:
                self.settings?.orderOut(nil)
                self.showWindow(route: WindowRoute.settings)
            case .fallback:
                let w = self.settings ?? SettingsWindow(retry: { [weak self] in
                    guard let self, SettingsDestination.fallbackMayStartEngine(inFirstRun: self.firstRun != nil) else { return }
                    self.engine.ensureRunning()
                }, loginChanged: { [weak self] in self?.window?.settingsChanged() })
                self.settings = w
                w.setEngineHelpShown(SettingsDestination.fallbackMayStartEngine(inFirstRun: self.firstRun != nil))
                self.render()
                w.present()
            }
        }
    }

    @objc private func quickCapture() {
        let p = capture ?? QuickCapturePanel(api: engine.api) { [weak self] route in self?.showWindow(route: route) }
        capture = p
        p.present()
    }

    // MARK: polling

    private func refresh() {
        engine.api.probe(home: engine.config.home) { [weak self] probe in
            guard let self else { return }
            var h: Health?
            if case .ours(let health) = probe { h = health }
            self.healthy = h != nil
            self.gitProblem = h?.gitProblem
            self.needsYou = h?.needsYou ?? 0
            self.stalledOnly = h?.stalled ?? []
            if let h { self.git = h.git; self.noteNewlyStalled(h) }
            if let rules = h?.rules { self.notifier?.rules = rules }
            let showCI = UserDefaults.standard.bool(forKey: SettingKey.showCIStatus)
            if CIStatusSetting.needsSync(engine: h?.ciSetting, wanted: showCI) { self.engine.api.setCIStatus(showCI) }
            if h != nil { self.sendLegacyPicks() }
            ThemeSetting.adopt(h?.theme, defaults: .standard)
            self.applyThemeLook()
            if h == nil { self.engine.engineUnreachable() }
            self.render()
            // The engine came back while the fallback window was up: the real Settings can open now.
            if let w = self.settings, SettingsDestination.fallbackSwitchesToPage(fallbackVisible: w.isVisible, engineReachable: h != nil, inFirstRun: self.firstRun != nil) {
                w.orderOut(nil)
                self.showWindow(route: WindowRoute.settings)
            }
        }
    }

    private func sendLegacyPicks() {
        if let theme = legacyPicks.theme { engine.api.setTheme(theme) }
        for (slug, hidden) in legacyPicks.hidden { engine.api.setProjectHidden(slug, hidden: hidden) }
        legacyPicks = LegacySettings.Pending()
    }

    /// Notify about issues that stalled since the last poll, once per stalled episode (titles from /api/needs-you).
    /// The watch is updated even when the setting is off, so turning it on doesn't announce everything that stalled meanwhile.
    private func noteNewlyStalled(_ h: Health) {
        let fresh = stalledWatch.update(stalledOnly: h.stalled, stalledAll: h.stalledAll)
        guard !fresh.isEmpty, UserDefaults.standard.bool(forKey: SettingKey.showStalledInNeedsYou), let notifier else { return }
        engine.api.needsYou { items in
            let byId = Dictionary((items ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            notifier.noteStalled(fresh.map { id in
                let i = byId[id]
                return AgentNote(kind: .stalled, id: id, title: [i?.title, i?.stalled].compactMap { $0 }.joined(separator: " — "), workspace: nil)
            })
        }
    }

    /// The menu-bar number: Needs you, without stalled-only issues when "Show stalled work in Needs you" is off.
    private var shownNeedsYou: Int {
        StalledFilter.count(needsYou: needsYou, stalledOnly: stalledOnly.count,
                            showStalled: UserDefaults.standard.bool(forKey: SettingKey.showStalledInNeedsYou))
    }

    private func render() {
        guard let button = statusItem?.button else { return }
        let needsYou = shownNeedsYou
        let title = NSMutableAttributedString()
        let font = NSFont.menuBarFont(ofSize: 0)
        if healthy && needsYou > 0 {
            title.append(NSAttributedString(string: " \(needsYou)", attributes: [.font: font]))
        }
        if gitProblem != nil {
            title.append(NSAttributedString(string: " ●", attributes: [.font: font, .foregroundColor: NSColor.systemOrange]))
        }
        button.attributedTitle = title
        button.appearsDisabled = !healthy
        let where_ = "\(engine.config.home) · port \(engine.config.port)"
        let state: String
        switch engine.state {
        case .attached: state = healthy ? "Engine running (attached)" : "Engine not answering"
        case .running: state = healthy ? "Engine running" : "Engine starting…"
        case .starting: state = firstRun != nil ? "Waiting for setup (aitt setup)" : "Engine starting…"
        case .restarting: state = "Engine stopped; restarting…"
        case .portBusy: state = "Another engine is using port \(engine.config.port)"
        case .stopped: state = "Engine stopped"
        }
        statusLine.title = gitProblem.map { "\(state) — git \($0)" } ?? state
        statusLine.toolTip = where_
        settings?.setStatus(statusLine.title)
        if let o = backupOverride, o.until > Date() { backupLine.title = o.text } else {
            backupOverride = nil
            backupLine.title = backingUp ? "Backing up…" : healthy ? BackupText.line(git) : "Backup status unavailable"
        }
        backupLine.toolTip = git.pushError
        var tip = "AI Task Tracking — \(needsYou) need you\n\(where_)"
        if let gitProblem { tip += "\nGit: \(gitProblem)" }
        button.toolTip = tip
    }

    // MARK: menu

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(openItem)
        menu.addItem(NSMenuItem(title: "New Issue", action: #selector(newIssue), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Quick Capture…", action: #selector(quickCapture), keyEquivalent: ""))
        menu.addItem(.separator())
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        backupLine.isEnabled = false
        menu.addItem(backupLine)
        menu.addItem(NSMenuItem(title: "Back Up Now", action: #selector(backUpNow), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "Help", action: #selector(showHelp), keyEquivalent: ""))
        menu.addItem(loginItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit AI Task Tracking", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for item in menu.items where item.action != #selector(NSApplication.terminate(_:)) { item.target = self }
        return menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        render() // relative "Last backed up … ago"
    }

    /// Needs-you rows: the last known list at once, then the fresh one (the menu updates while open).
    func menuWillOpen(_ menu: NSMenu) {
        guard UserDefaults.standard.bool(forKey: SettingKey.showNeedsYouInMenu) else { return setNeedsYouItems(nil, in: menu) }
        setNeedsYouItems(lastNeedsYou, in: menu)
        engine.api.needsYou(stalled: UserDefaults.standard.bool(forKey: SettingKey.showStalledInNeedsYou)) { [weak self] items in
            guard let self, let items else { return }
            self.lastNeedsYou = items
            self.setNeedsYouItems(items, in: menu)
        }
    }

    private func setNeedsYouItems(_ items: [NeedsYouItem]?, in menu: NSMenu) {
        needsYouItems.forEach(menu.removeItem)
        needsYouItems = []
        guard let items, !items.isEmpty else { return }
        let head = NSMenuItem(title: "Needs you", action: nil, keyEquivalent: "")
        head.isEnabled = false
        var rows = [head]
        for i in items.prefix(10) {
            let row = NSMenuItem(title: MenuText.needsYouItem(id: i.id, title: i.title, why: MenuText.needsYouWhy(why: i.why, stalled: i.stalled)),
                                 action: #selector(openNeedsYou(_:)), keyEquivalent: "")
            row.target = self
            row.representedObject = i.id
            row.toolTip = i.title
            rows.append(row)
        }
        let all = NSMenuItem(title: items.count > 10 ? "Show all \(items.count) on Home" : "Show all on Home",
                             action: #selector(openHome), keyEquivalent: "")
        all.target = self
        rows.append(all)
        rows.append(.separator())
        for (n, row) in rows.enumerated() { menu.insertItem(row, at: n) }
        needsYouItems = rows
    }

    @objc private func openNeedsYou(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { showWindow(route: "#/issue/\(id)") }
    }

    @objc private func openHome() { showWindow(route: "#/") }

    @objc private func backUpNow() { runBackup { _ in } }

    /// Back Up Now in the menu and on the Settings page; `done` gets the line the menu shows afterwards.
    private func runBackup(_ done: @escaping (String) -> Void) {
        guard !backingUp else { return done("Already backing up") }
        backingUp = true
        backupOverride = nil
        render()
        engine.api.sync(push: true) { [weak self] r in
            guard let self else { return }
            self.backingUp = false
            let text: String
            if let e = r.requestError ?? r.commitError ?? r.pushError { text = "Backup error: \(e.prefix(60))" }
            else if r.pushed { text = "Backed up just now" }
            else { text = self.git.remote ? "Backed up (nothing new)" : "Saved (no GitHub remote)" }
            self.backupOverride = (text, Date().addingTimeInterval(15))
            self.refresh()
            self.render()
            done(text)
        }
    }

    @objc private func openTracker() { showWindow(route: nil) }
    /// The user docs the engine serves at /docs/, in the app window.
    @objc private func showHelp() { showWindow(route: WindowRoute.docs) }
    @objc private func newIssue() { showWindow(route: "#/new") }

    @objc private func toggleLaunchAtLogin() {
        LaunchAtLogin.set(!LaunchAtLogin.isOn)
        window?.settingsChanged()
    }

    /// The installers set this on a first install (scripts/install.sh unless SKIP_LOGIN_ITEM=1); the app must register itself.
    /// Idempotent: nothing to do when launch at login is already on.
    private func enableLoginItemIfRequested() {
        let d = UserDefaults.standard
        guard d.bool(forKey: "enableLoginItemOnLaunch") else { return }
        d.removeObject(forKey: "enableLoginItemOnLaunch")
        guard SMAppService.mainApp.status != .enabled else { return }
        do { try SMAppService.mainApp.register() } catch { EngineSupervisor.log("launch at login: \(error.localizedDescription)") }
    }

    // MARK: window

    private func toggleWindow() {
        if let window, window.isVisible, NSApp.isActive, window.isKeyWindow { window.orderOut(nil) } else { showWindow(route: nil) }
    }

    // MARK: first run

    private func startFirstRun() {
        let home = engine.config.home
        let defaultHome = AppEnv.defaultHome(userHome: NSHomeDirectory())
        let binary = Bundle.main.resourcePath! + "/" + AppEnv.binaryName
        EngineSupervisor.log("first run: \(home) is not set up; waiting for aitt setup")
        let w = FirstRunWindow(command: FirstRun.setupCommand(binary: binary, home: home, defaultHome: defaultHome), home: home) { [weak self] in
            EngineSupervisor.log("first run: starting without setup")
            self?.finishFirstRun()
        }
        firstRun = w
        w.show()
        firstRunTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !FirstRun.needsSetup(home: self.engine.config.home) else { return }
                EngineSupervisor.log("first run: setup finished")
                self.finishFirstRun()
            }
        }
    }

    private func finishFirstRun() {
        firstRunTimer?.invalidate()
        firstRunTimer = nil
        firstRun?.orderOut(nil)
        firstRun = nil
        settings?.setEngineHelpShown(true)
        engine.ensureRunning()
    }

    private func showWindow(route: String?) {
        if let firstRun { return firstRun.show() }
        let w = window ?? TrackerWindow(base: engine.api.base, backup: { [weak self] done in self?.runBackup(done) },
                                        themeChanged: { [weak self] in self?.refresh() })
        window = w
        w.apply(currentThemeLook)
        w.show(route: route)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// LSUIElement apps still route key equivalents through the main menu while active: ⌘C/⌘V/⌘A/⌘Z in the web view.
    private static func mainMenu() -> NSMenu {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            holder.submenu = m
            main.addItem(holder)
        }
        func item(_ t: String, _ a: Selector, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
            i.keyEquivalentModifierMask = mods
            return i
        }
        let settingsItem = item("Settings…", #selector(AppDelegate.showSettings), ",")
        settingsItem.target = NSApp.delegate
        sub("AI Task Tracking", [settingsItem, .separator(),
                        item("Hide AI Task Tracking Window", #selector(NSWindow.performClose(_:)), "h"),
                        item("Quit AI Task Tracking", #selector(NSApplication.terminate(_:)), "q")])
        sub("Edit", [item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "z", [.command, .shift]),
                     .separator(),
                     item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"),
                     item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a")])
        sub("View", [item("Toggle Sidebar", #selector(TrackerWindow.toggleSidebar(_:)), "\\"), .separator(),
                     item("Reload", #selector(WKWebView.reload(_:)), "r")])
        sub("Go", [item("Back", #selector(TrackerWindow.goBack(_:)), "["), item("Forward", #selector(TrackerWindow.goForward(_:)), "]")])
        sub("Window", [item("Close", #selector(NSWindow.performClose(_:)), "w"),
                       item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")])
        let helpItem = item("AI Task Tracking Help", #selector(AppDelegate.showHelp), "?")
        helpItem.target = NSApp.delegate
        sub("Help", [helpItem])
        NSApp.helpMenu = main.items.last?.submenu
        return main
    }
}

/// The UI window: a WKWebView on the engine. Closing hides it; the frame is remembered across launches.
/// Back/forward: Go menu (⌘[ ⌘]), mouse side buttons, two-finger swipe.
@MainActor
final class TrackerWindow: NSWindow, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private let web: WKWebView
    private let base: URL
    private var loaded = false
    private var mouseMonitor: Any?
    private var look: WindowLook?
    private let settingsBridge: SettingsBridgeHandler

    init(base: URL, backup: @escaping (@escaping (String) -> Void) -> Void, themeChanged: @escaping () -> Void) {
        self.base = base
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "TrackerApp/1" // the web UI hides its "Open in AI Task Tracking" link
        settingsBridge = SettingsBridgeHandler(engine: base, backup: backup, themeChanged: themeChanged)
        config.userContentController.addScriptMessageHandler(settingsBridge, contentWorld: .page, name: SettingsBridge.handlerName)
        web = WKWebView(frame: .zero, configuration: config)
        settingsBridge.web = web
        web.allowsBackForwardNavigationGestures = true
        super.init(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                   styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        title = "AI Task Tracking"
        isReleasedWhenClosed = false
        minSize = NSSize(width: 640, height: 400)
        contentView = web
        // The window's background (the theme's, see apply) shows until the page paints, instead of the web view's own
        // (white, or #1e1e1e in dark mode). A private key, on purpose: the public underPageBackgroundColor (macOS 12+)
        // doesn't change what the view paints before the first page; checked 2026-10-30 by rendering a fresh web view's
        // layer on macOS 26: same gray with it set, transparent only with drawsBackground off.
        // Guarded: a WebKit without the key costs a gray first paint, not an NSUnknownKeyException.
        if web.responds(to: NSSelectorFromString("_setDrawsBackground:")) { web.setValue(false, forKey: "drawsBackground") }
        web.navigationDelegate = self
        web.uiDelegate = self
        delegate = self
        center()
        setFrameAutosaveName("TrackerMainWindow")
        // Mouse side buttons (3 = back, 4 = forward), only over this window.
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: .otherMouseDown) { [weak self] e in
            guard let self, e.window === self else { return e }
            switch e.buttonNumber {
            case 3: self.web.goBack(); return nil
            case 4: self.web.goForward(); return nil
            default: return e
            }
        }
    }

    /// Appearance (title bar, scroll bars) and background from the theme; Match macOS follows the system.
    func apply(_ look: WindowLook) {
        guard look != self.look else { return }
        self.look = look
        appearance = look.appearance.flatMap { NSAppearance(named: $0 == "light" ? .aqua : .darkAqua) }
        let dark = look.darkBackground, light = look.lightBackground
        backgroundColor = NSColor(name: nil) { a in
            let c = a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: c.a)
        }
    }

    /// Launch at login changed outside the page: tell it. (UserDefaults changes reach the bridge by themselves.)
    func settingsChanged() { settingsBridge.push() }

    @objc func goBack(_ sender: Any?) { web.goBack() }
    @objc func goForward(_ sender: Any?) { web.goForward() }
    /// The page collapses or expands its sidebar (ui/sidebarState.ts TOGGLE_EVENT).
    @objc func toggleSidebar(_ sender: Any?) { web.evaluateJavaScript("dispatchEvent(new Event('aitt:toggle-sidebar'))") }

    override func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(goBack(_:)): return web.canGoBack
        case #selector(goForward(_:)): return web.canGoForward
        case #selector(toggleSidebar(_:)): return !(web.url?.path.hasPrefix("/docs") ?? false) // the docs have no sidebar to toggle
        default: return super.validateMenuItem(item)
        }
    }

    func show(route: String?) {
        if WindowRoute.needsLoad(route: route, loaded: loaded, current: web.url, base: base) {
            load(route: route)
        } else if let route {
            web.evaluateJavaScript("location.hash = \(Self.jsString(route))")
        }
        makeKeyAndOrderFront(nil)
    }

    private func load(route: String?) {
        loaded = true
        let url = URL(string: route ?? "", relativeTo: base) ?? base
        web.load(URLRequest(url: url))
    }

    private static func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(arr.dropFirst().dropLast())
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        orderOut(nil)
        return false
    }

    // Engine not up yet (first launch, restart): retry while it can't be reached; other failures
    // (a cancelled navigation, a policy refusal) are not retried.
    private static let retryable: Set<Int> = [NSURLErrorCannotConnectToHost, NSURLErrorTimedOut,
                                               NSURLErrorNetworkConnectionLost, NSURLErrorCannotFindHost]

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        guard e.domain == NSURLErrorDomain, Self.retryable.contains(e.code) else { return }
        let failed = e.userInfo[NSURLErrorFailingURLErrorKey] as? URL
        let target = failed.flatMap { isEngine($0) ? $0 : nil } ?? base
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.web.load(URLRequest(url: target))
        }
    }

    /// Same origin as the engine: http://127.0.0.1:<port>.
    private func isEngine(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == base.host && url.port == base.port
    }

    private static func openExternally(_ url: URL) {
        if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
    }

    // The web view only ever shows the engine. Any other navigation, in any frame, is cancelled; a link click
    // to an http/https/mailto target opens in the default handler, aitt://settings opens Settings, other schemes are
    // ignored.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if isEngine(url) || ["about", "blob"].contains(url.scheme?.lowercased() ?? "") { return decisionHandler(.allow) }
        if action.navigationType == .linkActivated {
            if DeepLink.isSettings(url) { (NSApp.delegate as? AppDelegate)?.showSettings() } else { Self.openExternally(url) }
        }
        decisionHandler(.cancel)
    }

    // window.open / target=_blank: never a second web view; hand http/https/mailto to the system.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { Self.openExternally(url) }
        return nil
    }
}
