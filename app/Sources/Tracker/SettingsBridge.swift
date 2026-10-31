import AppKit
import ServiceManagement
import TrackerCore
import WebKit

/// The app's macOS login item (Launch at login on the Settings page, in the fallback window and in the menu).
@MainActor
enum LaunchAtLogin {
    private static var lastError: String?

    static var isOn: Bool { SMAppService.mainApp.status == .enabled }

    /// Why it isn't what was asked for, to show on the Settings page.
    static var problem: String? {
        lastError ?? (SMAppService.mainApp.status == .requiresApproval ? "Waiting for your approval in System Settings ▸ General ▸ Login Items." : nil)
    }

    static func set(_ on: Bool) {
        lastError = nil
        guard on != isOn || (!on && SMAppService.mainApp.status == .requiresApproval) else { return }
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            lastError = error.localizedDescription
            EngineSupervisor.log("launch at login: \(error.localizedDescription)")
        }
    }
}

/// The Settings page's way to the app's own settings. SettingsBridgeSession (TrackerCore) decides everything; this passes
/// the web view's messages in and its scripts out. A write lands in AppDelegate.applySettings like any other: the Dock,
/// hotkeys and the notifier re-apply, the poll tells the engine about CI status, the rest are read when used.
@MainActor
final class SettingsBridgeHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var web: WKWebView?
    private let session: SettingsBridgeSession
    private var observer: NSObjectProtocol?

    private static let presets: [String: [SettingsBridge.Preset]] = [
        SettingKey.openWindowHotKeyPreset: HotKeyPreset.openWindow.map { .init(id: $0.id, label: $0.label) },
        SettingKey.quickCaptureHotKeyPreset: HotKeyPreset.quickCapture.map { .init(id: $0.id, label: $0.label) },
    ]

    init(engine: URL, backup: @escaping (@escaping (String) -> Void) -> Void, themeChanged: @escaping () -> Void) {
        session = SettingsBridgeSession(
            engine: engine, defaults: .standard, presets: Self.presets,
            login: .init(isOn: { MainActor.assumeIsolated { LaunchAtLogin.isOn } }, problem: { MainActor.assumeIsolated { LaunchAtLogin.problem } },
                         set: { on in MainActor.assumeIsolated { LaunchAtLogin.set(on) } }),
            backup: backup, themeChanged: themeChanged)
        super.init()
        observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.push() }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        let frame = message.frameInfo, origin = frame.securityOrigin
        let sender = SettingsBridgeSession.Sender(scheme: origin.protocol, host: origin.host, port: origin.port,
                                                  isMainFrame: frame.isMainFrame, url: frame.request.url)
        session.handle(message.body, from: sender) { value, error in
            MainActor.assumeIsolated { replyHandler(value, error) }
        }
    }

    /// Tell the page, if the settings differ from what it last heard (every UserDefaults write lands here, the poll's too).
    func push() {
        guard let web, let script = session.pushScript(current: web.url) else { return }
        web.evaluateJavaScript(script)
    }
}
