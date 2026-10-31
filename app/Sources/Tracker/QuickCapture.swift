import AppKit
import TrackerCore

/// Floating quick-capture panel: title, project (last used), labels (default "Task"). Enter creates the issue as the
/// owner through save_issue; Esc closes. After a create it shows the new id, and ⌘O opens it in the window.
@MainActor
final class QuickCapturePanel: NSPanel, NSTextFieldDelegate {
    private let api: EngineAPI
    private let open: (String) -> Void
    private let titleField = NSTextField()
    private let projectPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let labelsField = NSTextField()
    private let status = NSTextField(labelWithString: "")
    private var projects: [(slug: String, name: String)] = []
    private var created: String?
    private var busy = false
    private var hideTimer: Timer?

    /// `open` shows the main window at a hash route.
    init(api: EngineAPI, open: @escaping (String) -> Void) {
        self.api = api
        self.open = open
        super.init(contentRect: NSRect(x: 0, y: 0, width: 460, height: 150), styleMask: [.titled, .closable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = "Quick capture"
        titlebarAppearsTransparent = true
        isReleasedWhenClosed = false
        level = .floating
        hidesOnDeactivate = false

        titleField.placeholderString = "Issue title"
        titleField.font = .systemFont(ofSize: 16)
        titleField.delegate = self
        titleField.target = self
        titleField.action = #selector(submit)
        labelsField.placeholderString = "Labels, comma-separated"
        labelsField.stringValue = "Task"
        labelsField.delegate = self
        labelsField.target = self
        labelsField.action = #selector(submit)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingTail

        let row = NSStackView(views: [projectPopup, labelsField])
        row.spacing = 8
        projectPopup.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        let stack = NSStackView(views: [titleField, row, status])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 30, left: 20, bottom: 16, right: 20)
        titleField.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
        row.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
        stack.widthAnchor.constraint(equalToConstant: 460).isActive = true
        contentView = stack
    }

    override var canBecomeKey: Bool { true }

    func present() {
        hideTimer?.invalidate()
        created = nil
        status.stringValue = "Enter to create · Esc to close"
        status.textColor = .secondaryLabelColor
        loadProjects()
        setContentSize(contentView!.fittingSize)
        center()
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        makeFirstResponder(titleField)
    }

    private func loadProjects() {
        api.tool("list_projects", args: [:]) { [weak self] r in
            guard let self else { return }
            guard case .success(let o) = r, let list = o["projects"] as? [[String: Any]] else {
                if self.projects.isEmpty { self.show("The AI Task Tracking engine is not answering", error: true) }
                return
            }
            // Keep the current choice by its slug in the new list (projects may have been added or renamed since).
            let keep = self.projects.indices.contains(self.projectPopup.indexOfSelectedItem)
                ? self.projects[self.projectPopup.indexOfSelectedItem].slug : nil
            // Hidden projects (Settings ▸ Hidden projects) aren't offered, like everywhere else in the app.
            let hidden = HiddenProjectsSetting.hidden(.standard)
            self.projects = list.compactMap { p in (p["slug"] as? String).map { ($0, p["name"] as? String ?? $0) } }
                .filter { !hidden.contains($0.slug) }
            self.projectPopup.removeAllItems()
            self.projectPopup.addItems(withTitles: self.projects.map(\.name))
            let want = keep ?? UserDefaults.standard.string(forKey: SettingKey.lastCaptureProject)
            if let i = self.projects.firstIndex(where: { $0.slug == want }) { self.projectPopup.selectItem(at: i) }
        }
    }

    @objc private func submit() {
        let title = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, !title.isEmpty else { return }
        guard projects.indices.contains(projectPopup.indexOfSelectedItem) else { return show("Pick a project first", error: true) }
        let project = projects[projectPopup.indexOfSelectedItem].slug
        UserDefaults.standard.set(project, forKey: SettingKey.lastCaptureProject)
        busy = true
        show("Creating…", error: false)
        api.tool("save_issue", args: ["title": title, "project": project, "labels": MenuText.labels(labelsField.stringValue)]) { [weak self] r in
            guard let self else { return }
            self.busy = false
            switch r {
            case .success(let o):
                let id = o["id"] as? String ?? "?"
                self.created = id
                self.titleField.stringValue = ""
                self.show("Created \(id) — ⌘O to open", error: false)
                self.hideTimer?.invalidate()
                self.hideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, self.titleField.stringValue.isEmpty else { return }
                        self.orderOut(nil)
                    }
                }
            case .failure(let e):
                self.show(e.message, error: true)
            }
        }
    }

    private func show(_ text: String, error: Bool) {
        status.stringValue = text
        status.toolTip = text
        status.textColor = error ? .systemRed : .secondaryLabelColor
    }

    func controlTextDidChange(_ obj: Notification) { hideTimer?.invalidate() }

    /// Esc in a field with text would otherwise be eaten by the field editor (it cancels completion, not the panel).
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
        orderOut(nil)
        return true
    }

    override func cancelOperation(_ sender: Any?) { orderOut(nil) }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           event.charactersIgnoringModifiers == "o", let created {
            orderOut(nil)
            open("#/issue/\(created)")
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}
