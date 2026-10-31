import AppKit
import ServiceManagement
import TrackerCore
import WebKit

/// The app's macOS login item (Launch at login on the Settings page, in the fallback window and in the menu).
@MainActor
enum LaunchAtLogin {
    static var isOn: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) {
        guard on != isOn else { return }
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            EngineSupervisor.log("launch at login: \(error.localizedDescription)")
        }
    }
}

/// The Settings page's way to the app's own settings. Only the engine's page may ask, and only for what
/// SettingsBridge (TrackerCore) accepts. A change is a plain UserDefaults write, so it takes effect as any other does:
/// AppDelegate.applySettings re-applies the Dock and hotkeys and the notifier, the poll tells the engine about CI status,
/// and the rest are read when used.
@MainActor
final class SettingsBridgeHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var web: WKWebView?
    private let engine: URL
    private let backup: (@escaping (String) -> Void) -> Void
    private let defaults = UserDefaults.standard
    private var observer: NSObjectProtocol?
    private var lastPushed: Data?

    private static let presets: [String: [SettingsBridge.Preset]] = [
        SettingKey.openWindowHotKeyPreset: HotKeyPreset.openWindow.map { .init(id: $0.id, label: $0.label) },
        SettingKey.quickCaptureHotKeyPreset: HotKeyPreset.quickCapture.map { .init(id: $0.id, label: $0.label) },
    ]

    init(engine: URL, backup: @escaping (@escaping (String) -> Void) -> Void) {
        self.engine = engine
        self.backup = backup
        super.init()
        observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.push() }
        }
    }

    private var state: [String: Any] { SettingsBridge.state(defaults, login: LaunchAtLogin.isOn, presets: Self.presets) }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        let frame = message.frameInfo, origin = frame.securityOrigin
        guard SettingsBridge.acceptsSender(scheme: origin.protocol, host: origin.host, port: origin.port, isMainFrame: frame.isMainFrame,
                                           path: frame.request.url?.path, engine: engine) else {
            EngineSupervisor.log("settings bridge: refused a message from \(origin.protocol)://\(origin.host):\(origin.port)")
            return replyHandler(nil, "not allowed")
        }
        guard let request = SettingsBridge.parse(message.body, presets: Self.presets) else {
            return replyHandler(nil, "unknown setting or invalid value")
        }
        switch request {
        case .get: break
        case .setBool(let key, let value): defaults.set(value, forKey: key)
        case .setPreset(let key, let id): defaults.set(id, forKey: key)
        case .setLogin(let on): LaunchAtLogin.set(on)
        case .backupNow:
            return backup { text in MainActor.assumeIsolated { replyHandler(["text": text], nil) } }
        }
        replyHandler(state, nil)
    }

    /// Tell the page, if the settings differ from what it last heard (every UserDefaults write lands here, the poll's too).
    func push() {
        guard let web, let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), data != lastPushed,
              let json = String(data: data, encoding: .utf8) else { return }
        lastPushed = data
        web.evaluateJavaScript("dispatchEvent(new CustomEvent('\(SettingsBridge.changeEvent)', { detail: \(json) }))")
    }
}
