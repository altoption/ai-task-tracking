import AppKit
import TrackerCore

/// Shown at launch when the data folder isn't set up (FirstRun.needsSetup): asks the user to run `aitt setup`
/// in Terminal, with Copy and Open Terminal buttons. The app starts the engine by itself once setup finishes;
/// "Start Without Setup" starts it right away on a default folder.
@MainActor
final class FirstRunWindow: NSWindow {
    private let command: String
    private let copyButton = NSButton(title: "Copy Command", target: nil, action: nil)
    private let onSkip: () -> Void

    init(command: String, home: String, onSkip: @escaping () -> Void) {
        self.command = command
        self.onSkip = onSkip
        super.init(contentRect: NSRect(x: 0, y: 0, width: 520, height: 100), styleMask: [.titled, .closable],
                   backing: .buffered, defer: false)
        title = "Set Up AI Task Tracking"
        isReleasedWhenClosed = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)

        let heading = NSTextField(labelWithString: "Welcome to AI Task Tracking")
        heading.font = .boldSystemFont(ofSize: 15)
        stack.addArrangedSubview(heading)
        stack.addArrangedSubview(wrapping(
            "One-time setup creates your data folder (\(home)) and first project, and can add a private GitHub "
            + "backup and connect Claude Code. Run this in Terminal:"))

        let cmd = NSTextField(labelWithString: command)
        cmd.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        cmd.isSelectable = true
        cmd.lineBreakMode = .byCharWrapping
        cmd.maximumNumberOfLines = 0
        cmd.preferredMaxLayoutWidth = 472
        stack.addArrangedSubview(cmd)
        stack.addArrangedSubview(wrapping("AI Task Tracking starts by itself when setup finishes."))

        copyButton.target = self
        copyButton.action = #selector(copyCommand)
        copyButton.keyEquivalent = "\r"
        let terminal = NSButton(title: "Open Terminal", target: self, action: #selector(openTerminal))
        let skip = NSButton(title: "Start Without Setup", target: self, action: #selector(skip))
        let buttons = NSStackView(views: [copyButton, terminal, skip])
        buttons.spacing = 8
        stack.addArrangedSubview(buttons)

        contentView = stack
        setContentSize(stack.fittingSize)
        center()
    }

    func show() {
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func wrapping(_ text: String) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: text)
        f.preferredMaxLayoutWidth = 472
        return f
    }

    @objc private func copyCommand() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        copyButton.title = "Copied"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.copyButton.title = "Copy Command" }
    }

    @objc private func openTerminal() {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    @objc private func skip() { onSkip() }
}
