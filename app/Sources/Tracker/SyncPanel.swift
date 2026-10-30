import AppKit

/// The small "Syncing before quit…" window: a live step line and a Cancel button while working; on a failure,
/// the engine's (redacted) message and a caller-chosen set of buttons.
@MainActor
final class SyncPanel: NSPanel {
    struct Choice {
        let title: String
        var destructive = false
        var isDefault = false
        var isCancel = false
        let action: () -> Void
    }

    private let heading = NSTextField(labelWithString: "Syncing before quit…")
    private let step = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let buttons = NSStackView()
    private var choices: [Choice] = []

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 380, height: 120), styleMask: [.titled],
                   backing: .buffered, defer: false)
        title = "AI Task Tracking"
        isReleasedWhenClosed = false
        level = .floating
        heading.font = .boldSystemFont(ofSize: NSFont.systemFontSize + 1)
        step.preferredMaxLayoutWidth = 332
        step.textColor = .secondaryLabelColor
        step.isSelectable = true
        spinner.style = .spinning
        spinner.controlSize = .small
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let headRow = NSStackView(views: [spinner, heading])
        headRow.spacing = 8
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttonRow = NSStackView(views: [spacer, buttons])
        buttonRow.orientation = .horizontal
        let stack = NSStackView(views: [headRow, step, buttonRow])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 24, bottom: 18, right: 24)
        buttonRow.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true
        stack.widthAnchor.constraint(equalToConstant: 380).isActive = true
        contentView = stack
    }

    /// Working: spinner, step text, any `extra` buttons, and Cancel.
    func showProgress(_ text: String, extra: [Choice] = [], cancel: @escaping () -> Void) {
        heading.stringValue = "Syncing before quit…"
        spinner.isHidden = false
        spinner.startAnimation(nil)
        step.textColor = .secondaryLabelColor
        step.stringValue = text
        setChoices(extra + [Choice(title: "Cancel", isCancel: true, action: cancel)])
        present()
    }

    /// Stopped on an error: the message and the given buttons.
    func showFailure(_ title: String, message: String, choices: [Choice]) {
        heading.stringValue = title
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        step.textColor = .labelColor
        step.stringValue = message
        setChoices(choices)
        present()
    }

    private func present() {
        setContentSize(contentView!.fittingSize)
        if !isVisible { center() }
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setChoices(_ list: [Choice]) {
        choices = list
        buttons.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, c) in list.enumerated() {
            let b = NSButton(title: c.title, target: self, action: #selector(chose(_:)))
            b.tag = i
            b.bezelStyle = .rounded
            if c.destructive { b.hasDestructiveAction = true; b.contentTintColor = .systemRed }
            if c.isDefault { b.keyEquivalent = "\r" }
            if c.isCancel { b.keyEquivalent = "\u{1b}" }
            buttons.addArrangedSubview(b)
        }
    }

    @objc private func chose(_ sender: NSButton) {
        guard choices.indices.contains(sender.tag) else { return }
        choices[sender.tag].action()
    }
}
