import AppKit
import TrackerCore

/// Settings when the engine can't be reached. Everything else lives on the Settings page, which the engine serves; this
/// keeps what still works without it and says how to get it back. AppDelegate closes it when the engine answers again
/// and opens the page instead.
@MainActor
final class SettingsWindow: NSWindow {
    private let loginCheck = NSButton(checkboxWithTitle: "Launch at login", target: nil, action: nil)
    private let statusLabel = NSTextField(labelWithString: "")
    private let retry: () -> Void

    init(retry: @escaping () -> Void) {
        self.retry = retry
        super.init(contentRect: NSRect(x: 0, y: 0, width: 420, height: 100), styleMask: [.titled, .closable],
                   backing: .buffered, defer: false)
        title = "AI Task Tracking Settings"
        isReleasedWhenClosed = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)

        statusLabel.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
        stack.addArrangedSubview(statusLabel)
        stack.addArrangedSubview(note("Settings is a page in the main window, and the engine serves it. It opens here by itself once the engine answers."))
        let button = NSButton(title: "Try Starting the Engine", target: self, action: #selector(tryAgain))
        stack.addArrangedSubview(button)
        stack.addArrangedSubview(note("Still stopped? Quit AI Task Tracking and open it again. The log is in ~/Library/Logs/AI Task Tracking/engine.log."))
        stack.setCustomSpacing(18, after: stack.arrangedSubviews.last!)
        loginCheck.target = self
        loginCheck.action = #selector(toggleLogin(_:))
        stack.addArrangedSubview(loginCheck)

        contentView = stack
        setContentSize(stack.fittingSize)
        center()
    }

    func present() {
        loginCheck.state = LaunchAtLogin.isOn ? .on : .off
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The menu's engine line ("Engine stopped; restarting…").
    func setStatus(_ text: String) { statusLabel.stringValue = text }

    private func note(_ text: String) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: text)
        l.textColor = .secondaryLabelColor
        l.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        l.preferredMaxLayoutWidth = 372
        return l
    }

    @objc private func tryAgain() { retry() }

    @objc private func toggleLogin(_ sender: NSButton) {
        LaunchAtLogin.set(sender.state == .on)
        sender.state = LaunchAtLogin.isOn ? .on : .off
    }
}
