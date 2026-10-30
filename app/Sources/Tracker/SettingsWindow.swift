import AppKit
import ServiceManagement
import TrackerCore

/// One Settings window (⌘, and "Settings…" in the menu-bar menu). Every control writes UserDefaults straight away;
/// the app reads the values when it uses them (hotkeys and notifications re-apply on UserDefaults changes).
@MainActor
final class SettingsWindow: NSWindow {
    private let defaults = UserDefaults.standard
    private var checks: [String: NSButton] = [:]
    private var popups: [String: (NSPopUpButton, [HotKeyPreset])] = [:]
    private let loginCheck = NSButton(checkboxWithTitle: "Launch at login", target: nil, action: nil)
    private var perKindNotifications: [NSButton] = []

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 420, height: 100), styleMask: [.titled, .closable],
                   backing: .buffered, defer: false)
        title = "AI Task Tracking Settings"
        isReleasedWhenClosed = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)

        section(stack, "General")
        loginCheck.target = self
        loginCheck.action = #selector(toggleLogin(_:))
        stack.addArrangedSubview(loginCheck)
        stack.addArrangedSubview(check(SettingKey.showInDock, "Show in the Dock"))
        stack.addArrangedSubview(check(SettingKey.showNeedsYouInMenu, "Show Needs-you issues in the menu"))
        stack.addArrangedSubview(check(SettingKey.showStalledInNeedsYou, "Show stalled work in Needs you"))
        stack.addArrangedSubview(note("Stalled: idle in In Progress, or reopened again and again (config.yml stalled:). "
            + "When off, the menu-bar number, the menu and notifications leave it out; Home still marks it."))
        stack.addArrangedSubview(check(SettingKey.showCIStatus, "Show CI status"))
        stack.addArrangedSubview(note("Checks of linked GitHub PRs, fetched in the background with your gh. "
            + "When off, the engine stops running gh: no badges, and failing checks don't join Needs you."))

        section(stack, "Notifications")
        stack.addArrangedSubview(check(SettingKey.notifications, "Notify me about agent activity"))
        for (key, title) in [(SettingKey.notifyNeedsYou, "An agent needs me (Waiting, Needs decision/review, stalled)"),
                             (SettingKey.notifyDone, "An agent finished an issue (Done)"),
                             (SettingKey.notifyNew, "An agent created an issue")] {
            let c = check(key, title)
            perKindNotifications.append(c)
            stack.addArrangedSubview(indented(c))
        }

        section(stack, "Shortcuts")
        stack.addArrangedSubview(row(check(SettingKey.openWindowHotKey, "Open AI Task Tracking window"),
                                     popup(SettingKey.openWindowHotKeyPreset, HotKeyPreset.openWindow)))
        stack.addArrangedSubview(row(check(SettingKey.quickCaptureHotKey, "Quick capture"),
                                     popup(SettingKey.quickCaptureHotKeyPreset, HotKeyPreset.quickCapture)))
        stack.addArrangedSubview(note("In the window: Back ⌘[ · Forward ⌘] · mouse side buttons · two-finger swipe."))

        section(stack, "Backup")
        stack.addArrangedSubview(check(SettingKey.backupBeforeQuit, "Back up to GitHub before quitting"))
        stack.addArrangedSubview(note("When off, quitting still commits your changes; it just doesn't wait for the push."))

        contentView = stack
        setContentSize(stack.fittingSize)
        center()
    }

    func present() {
        refresh()
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func refresh() {
        for (key, c) in checks { c.state = defaults.bool(forKey: key) ? .on : .off }
        for (key, (p, presets)) in popups {
            p.selectItem(at: presets.firstIndex { $0.id == defaults.string(forKey: key) } ?? 0)
        }
        loginCheck.state = SMAppService.mainApp.status == .enabled ? .on : .off
        let notificationsOn = defaults.bool(forKey: SettingKey.notifications)
        perKindNotifications.forEach { $0.isEnabled = notificationsOn }
    }

    // MARK: building blocks

    private func section(_ stack: NSStackView, _ title: String) {
        let label = NSTextField(labelWithString: title)
        label.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
        if !stack.arrangedSubviews.isEmpty { stack.setCustomSpacing(18, after: stack.arrangedSubviews.last!) }
        stack.addArrangedSubview(label)
    }

    private func check(_ key: String, _ title: String) -> NSButton {
        let c = NSButton(checkboxWithTitle: title, target: self, action: #selector(toggled(_:)))
        c.identifier = NSUserInterfaceItemIdentifier(key)
        checks[key] = c
        return c
    }

    private func popup(_ key: String, _ presets: [HotKeyPreset]) -> NSPopUpButton {
        let p = NSPopUpButton(frame: .zero, pullsDown: false)
        p.addItems(withTitles: presets.map(\.label))
        p.identifier = NSUserInterfaceItemIdentifier(key)
        p.target = self
        p.action = #selector(picked(_:))
        popups[key] = (p, presets)
        return p
    }

    private func row(_ views: NSView...) -> NSStackView {
        let r = NSStackView(views: views)
        r.orientation = .horizontal
        r.spacing = 12
        return r
    }

    private func indented(_ v: NSView) -> NSView {
        let r = NSStackView(views: [v])
        r.edgeInsets = NSEdgeInsets(top: 0, left: 20, bottom: 0, right: 0)
        return r
    }

    private func note(_ text: String) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: text)
        l.textColor = .secondaryLabelColor
        l.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        l.preferredMaxLayoutWidth = 372
        return l
    }

    // MARK: actions

    @objc private func toggled(_ sender: NSButton) {
        guard let key = sender.identifier?.rawValue else { return }
        defaults.set(sender.state == .on, forKey: key)
        refresh()
    }

    @objc private func picked(_ sender: NSPopUpButton) {
        guard let key = sender.identifier?.rawValue, let (_, presets) = popups[key],
              presets.indices.contains(sender.indexOfSelectedItem) else { return }
        defaults.set(presets[sender.indexOfSelectedItem].id, forKey: key)
    }

    @objc private func toggleLogin(_ sender: NSButton) {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch {
            EngineSupervisor.log("launch at login: \(error.localizedDescription)")
        }
        refresh()
    }
}
