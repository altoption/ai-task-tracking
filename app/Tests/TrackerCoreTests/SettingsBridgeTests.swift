import XCTest
@testable import TrackerCore

final class SettingsBridgeTests: XCTestCase {
    private let engine = URL(string: "http://127.0.0.1:7477")!
    private let presets: [String: [SettingsBridge.Preset]] = [
        SettingKey.openWindowHotKeyPreset: [.init(id: "optCmdI", label: "⌥⌘I"), .init(id: "optCmdT", label: "⌥⌘T")],
        SettingKey.quickCaptureHotKeyPreset: [.init(id: "optCmdN", label: "⌥⌘N")],
    ]
    private func set(_ key: Any, _ value: Any) -> [String: Any] { ["op": "set", "key": key, "value": value] }
    private func parse(_ body: Any) -> SettingsBridge.Request? { SettingsBridge.parse(body, presets: presets) }
    private func scratchDefaults() -> UserDefaults {
        let name = "tracker-core-bridge-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        SettingDefaults.register(in: d)
        return d
    }

    // MARK: who may ask

    private func accepts(scheme: String? = "http", host: String? = "127.0.0.1", port: Int? = 7477, main: Bool = true,
                         url: String? = "http://127.0.0.1:7477/#/settings") -> Bool {
        SettingsBridge.acceptsSender(scheme: scheme, host: host, port: port, isMainFrame: main, url: url.flatMap(URL.init(string:)), engine: engine)
    }

    func testTheEnginesPageIsAccepted() {
        XCTAssertTrue(accepts())
        XCTAssertTrue(accepts(url: "http://127.0.0.1:7477/"))
        XCTAssertTrue(accepts(url: "http://127.0.0.1:7477/#/settings/backup"))
    }

    /// As a real WKWebView reports it: the engine's origin, the main frame, and this URL (path "").
    func testASameOriginBlobPageIsRefused() {
        XCTAssertFalse(accepts(url: "blob:http://127.0.0.1:7477/649a2cf3-ab68-4c89-9c20-b45536e0f867"))
        XCTAssertFalse(accepts(url: nil))
        XCTAssertFalse(accepts(url: "http://127.0.0.1:7477"), "path \"\"")
    }

    func testAnyOtherOriginIsRefused() {
        XCTAssertFalse(accepts(scheme: "https"))
        XCTAssertFalse(accepts(host: "example.com"))
        XCTAssertFalse(accepts(host: "localhost"))
        XCTAssertFalse(accepts(port: 7499))
        XCTAssertFalse(accepts(port: nil))
        // A sandboxed attachment under /files/: the engine's CSP makes its origin opaque.
        XCTAssertFalse(accepts(scheme: "", host: "", port: 0, url: "http://127.0.0.1:7477/files/x/y.svg"))
    }

    func testAFrameOrAnotherPageOfTheEngineIsRefused() {
        XCTAssertFalse(accepts(main: false))
        XCTAssertFalse(accepts(url: "http://127.0.0.1:7477/docs/"))
        XCTAssertFalse(accepts(url: "http://127.0.0.1:7477/files/p/a.svg"))
        XCTAssertFalse(accepts(url: "http://127.0.0.1:7499/"), "another engine's page, whatever the origin says")
    }

    // MARK: what it may ask

    func testOperations() {
        XCTAssertEqual(parse(["op": "get"]), .get)
        XCTAssertEqual(parse(["op": "backupNow"]), .backupNow)
        XCTAssertNil(parse(["op": "quit"]))
        XCTAssertNil(parse(["key": SettingKey.showInDock, "value": true]))
        XCTAssertNil(parse("get"))
        XCTAssertNil(parse(["get"]))
    }

    func testEveryKnownSwitchIsAccepted() {
        for key in SettingsBridge.boolKeys {
            XCTAssertEqual(parse(set(key, true)), .setBool(key: key, value: true), key)
            XCTAssertEqual(parse(set(key, false)), .setBool(key: key, value: false), key)
        }
        XCTAssertEqual(parse(set(SettingsBridge.loginKey, true)), .setLogin(true))
    }

    func testUnknownKeysAreRefused() {
        // Real UserDefaults keys the page has no business writing, among them the data folder and the mirrors.
        for key in ["home", "AITT_HOME", "enableLoginItemOnLaunch", SettingKey.theme, SettingKey.themeList, SettingKey.lastCaptureProject, "", "showInDock "] {
            XCTAssertNil(parse(set(key, true)), key)
            XCTAssertNil(parse(set(key, "optCmdI")), key)
        }
        XCTAssertNil(parse(set(42, true)))
    }

    func testAStoreOnlyAcceptsItsOwnType() {
        XCTAssertNil(parse(set(SettingKey.showInDock, "true")))
        XCTAssertNil(parse(set(SettingKey.showInDock, NSNumber(value: 1))), "the number 1 is not a boolean")
        XCTAssertNil(parse(set(SettingKey.showInDock, NSNumber(value: 0))))
        XCTAssertNil(parse(set(SettingKey.showInDock, NSNull())))
        XCTAssertNil(parse(set(SettingKey.showInDock, [true])))
        XCTAssertNil(parse(["op": "set", "key": SettingKey.showInDock]))
        XCTAssertNil(parse(set(SettingsBridge.loginKey, "yes")))
        XCTAssertNil(parse(set(SettingsBridge.loginKey, NSNumber(value: 1))))
    }

    func testShortcutsMustBeOneOfThatKeysPresets() {
        XCTAssertEqual(parse(set(SettingKey.openWindowHotKeyPreset, "optCmdT")), .setPreset(key: SettingKey.openWindowHotKeyPreset, id: "optCmdT"))
        XCTAssertNil(parse(set(SettingKey.openWindowHotKeyPreset, "optCmdN")), "another key's preset")
        XCTAssertNil(parse(set(SettingKey.openWindowHotKeyPreset, "nope")))
        XCTAssertNil(parse(set(SettingKey.openWindowHotKeyPreset, true)))
    }

    // MARK: what it sees

    func testStateReportsEverySettingAndThePresets() throws {
        let d = scratchDefaults()
        d.set(false, forKey: SettingKey.showInDock)
        d.set("optCmdT", forKey: SettingKey.openWindowHotKeyPreset)
        let s = SettingsBridge.state(d, login: true, presets: presets)
        let values = try XCTUnwrap(s["values"] as? [String: Any])
        XCTAssertEqual(values[SettingsBridge.loginKey] as? Bool, true)
        XCTAssertEqual(values[SettingKey.showInDock] as? Bool, false)
        XCTAssertEqual(values[SettingKey.notifyNew] as? Bool, false, "its default")
        XCTAssertEqual(values[SettingKey.notifyDone] as? Bool, true, "its default")
        XCTAssertEqual(values[SettingKey.openWindowHotKeyPreset] as? String, "optCmdT")
        XCTAssertEqual(Set(values.keys), Set(SettingsBridge.boolKeys + SettingsBridge.presetKeys + [SettingsBridge.loginKey]), "nothing else leaks to the page")
        let lists = try XCTUnwrap(s["presets"] as? [String: [[String: String]]])
        XCTAssertEqual(lists[SettingKey.quickCaptureHotKeyPreset], [["id": "optCmdN", "label": "⌥⌘N"]])
        XCTAssertTrue(JSONSerialization.isValidJSONObject(s), "it goes to the page as JSON")
    }

    func testAStoredPresetThatNoLongerExistsShowsTheFirst() throws {
        let d = scratchDefaults()
        d.set("gone", forKey: SettingKey.openWindowHotKeyPreset)
        let values = try XCTUnwrap(SettingsBridge.state(d, login: false, presets: presets)["values"] as? [String: Any])
        XCTAssertEqual(values[SettingKey.openWindowHotKeyPreset] as? String, "optCmdI")
    }

    // MARK: hidden projects, for quick capture

    func testHiddenSlugsFromHealth() {
        XCTAssertEqual(HiddenProjects.slugs(health: ["hiddenProjects": ["selected": ["a", "_none"], "projects": []]]), ["a", "_none"])
        XCTAssertEqual(HiddenProjects.slugs(health: ["hiddenProjects": ["selected": [String]()]]), [])
        XCTAssertNil(HiddenProjects.slugs(health: ["ok": true]))
    }

    // MARK: which Settings opens

    func testThePageOpensWhenTheEngineAnswers() {
        XCTAssertEqual(SettingsDestination.choose(engineReachable: true, inFirstRun: false), .page)
        XCTAssertEqual(SettingsDestination.choose(engineReachable: false, inFirstRun: false), .fallback)
        XCTAssertEqual(SettingsDestination.choose(engineReachable: true, inFirstRun: true), .fallback)
    }

    func testTheFallbackSwitchesToThePageOnlyWhenThePageWouldOpen() {
        let rule = SettingsDestination.fallbackSwitchesToPage
        XCTAssertTrue(rule(true, true, false))
        XCTAssertFalse(rule(false, true, false), "the window isn't up")
        XCTAssertFalse(rule(true, false, false), "no engine")
        XCTAssertFalse(rule(true, true, true), "first run: setup comes first")
    }

    func testFirstRunNeverStartsTheEngineFromTheFallback() {
        XCTAssertFalse(SettingsDestination.fallbackMayStartEngine(inFirstRun: true))
        XCTAssertTrue(SettingsDestination.fallbackMayStartEngine(inFirstRun: false))
    }

    func testQuickCaptureSaysSoWhenItCantTellWhatIsHidden() {
        XCTAssertTrue(HiddenProjects.captureHasNoAnswer(hidden: nil, shown: 0))
        XCTAssertFalse(HiddenProjects.captureHasNoAnswer(hidden: nil, shown: 2), "what it showed stays")
        XCTAssertFalse(HiddenProjects.captureHasNoAnswer(hidden: [], shown: 0))
    }

    // MARK: the session: replies, pushes, effects

    private final class Harness {
        let d: UserDefaults
        var loginOn = false, loginProblem: String?, loginAsked: [Bool] = [], backups = 0, themeChanges = 0
        var replies: [(value: Any?, error: String?)] = []
        var finishBackup: ((String) -> Void)?
        var session: SettingsBridgeSession!
        let page = SettingsBridgeSession.Sender(scheme: "http", host: "127.0.0.1", port: 7477, isMainFrame: true, url: URL(string: "http://127.0.0.1:7477/#/settings"))
        let root = URL(string: "http://127.0.0.1:7477/#/settings")

        init(_ d: UserDefaults, engine: URL, presets: [String: [SettingsBridge.Preset]]) {
            self.d = d
            session = SettingsBridgeSession(engine: engine, defaults: d, presets: presets,
                login: .init(isOn: { [unowned self] in self.loginOn }, problem: { [unowned self] in self.loginProblem },
                             set: { [unowned self] in self.loginAsked.append($0) }),
                backup: { [unowned self] done in self.backups += 1; self.finishBackup = done },
                themeChanged: { [unowned self] in self.themeChanges += 1 })
        }
        func send(_ body: Any, from sender: SettingsBridgeSession.Sender? = nil) {
            session.handle(body, from: sender ?? page) { [unowned self] v, e in self.replies.append((v, e)) }
        }
        var lastValues: [String: Any]? { (replies.last?.value as? [String: Any])?["values"] as? [String: Any] }
    }
    private func harness() -> Harness { Harness(scratchDefaults(), engine: engine, presets: presets) }

    func testARefusedSenderChangesNothingAndHearsWhy() {
        let h = harness()
        let blob = SettingsBridgeSession.Sender(scheme: "http", host: "127.0.0.1", port: 7477, isMainFrame: true, url: URL(string: "blob:http://127.0.0.1:7477/x"))
        h.send(set(SettingKey.showInDock, false), from: blob)
        XCTAssertEqual(h.replies.last?.error, "not allowed")
        XCTAssertTrue(h.d.bool(forKey: SettingKey.showInDock))
    }

    func testAnInvalidRequestChangesNothingAndHearsWhy() {
        let h = harness()
        h.send(set("home", "/tmp"))
        XCTAssertEqual(h.replies.last?.error, "unknown setting or invalid value")
        XCTAssertNil(h.d.object(forKey: "home"))
    }

    func testASetWritesUserDefaultsAndAnswersTheNewState() {
        let h = harness()
        h.send(set(SettingKey.showInDock, false))
        XCTAssertFalse(h.d.bool(forKey: SettingKey.showInDock))
        XCTAssertEqual(h.lastValues?[SettingKey.showInDock] as? Bool, false)
        h.send(set(SettingKey.openWindowHotKeyPreset, "optCmdT"))
        XCTAssertEqual(h.d.string(forKey: SettingKey.openWindowHotKeyPreset), "optCmdT")
    }

    /// The review's bug: a reply didn't count as telling the page, so a later change back to the last pushed state was
    /// taken for "nothing new" and the page stayed wrong.
    func testAChangeAfterAReplyStillReachesThePage() throws {
        let h = harness()
        h.loginOn = false
        _ = h.session.pushScript(current: h.root) // the page heard "off"
        h.send(set(SettingsBridge.loginKey, true))
        h.loginOn = true
        h.send(["op": "get"]) // the page hears "on" by reply
        h.loginOn = false // the menu turns it off
        XCTAssertNotNil(h.session.pushScript(current: h.root), "the page thinks it's on")
    }

    func testAPushRepeatsNothing() {
        let h = harness()
        h.send(["op": "get"])
        XCTAssertNil(h.session.pushScript(current: h.root), "the reply told it")
        h.d.set(false, forKey: SettingKey.showInDock)
        let script = h.session.pushScript(current: h.root)
        XCTAssertTrue(script?.contains("aitt:app-settings") == true)
        XCTAssertNil(h.session.pushScript(current: h.root))
    }

    func testAPushGoesOnlyToTheEnginesPage() {
        let h = harness()
        for other in ["http://127.0.0.1:7477/docs/", "blob:http://127.0.0.1:7477/x", "about:blank", "https://example.com/"] {
            XCTAssertNil(h.session.pushScript(current: URL(string: other)), other)
        }
        XCTAssertNil(h.session.pushScript(current: nil))
        XCTAssertNotNil(h.session.pushScript(current: h.root), "and nothing was marked as told meanwhile")
    }

    func testAFailedLaunchAtLoginSaysWhy() throws {
        let h = harness()
        h.loginProblem = "Operation not permitted"
        h.send(set(SettingsBridge.loginKey, true))
        XCTAssertEqual(h.loginAsked, [true])
        XCTAssertEqual(h.lastValues?[SettingsBridge.loginKey] as? Bool, false, "the switch tells the truth")
        let reply = try XCTUnwrap(h.replies.last?.value as? [String: Any])
        XCTAssertEqual((reply["problems"] as? [String: String])?[SettingsBridge.loginKey], "Operation not permitted")
        h.loginProblem = nil
        h.send(["op": "get"])
        XCTAssertEqual((h.replies.last?.value as? [String: Any])?["problems"] as? [String: String], [:])
    }

    func testBackupAnswersWithItsLineWhenDone() {
        let h = harness()
        h.send(["op": "backupNow"])
        XCTAssertEqual(h.backups, 1)
        XCTAssertTrue(h.replies.isEmpty, "not before it finishes")
        h.finishBackup?("Backed up just now")
        XCTAssertEqual((h.replies.last?.value as? [String: String])?["text"], "Backed up just now")
        XCTAssertEqual(h.replies.count, 1)
    }

    func testAThemeChangeReachesTheApp() {
        let h = harness()
        h.send(["op": "themeChanged"])
        XCTAssertEqual(h.themeChanges, 1)
        h.send(["op": "themeChanged"], from: .init(scheme: "http", host: "127.0.0.1", port: 7477, isMainFrame: false, url: h.root))
        XCTAssertEqual(h.themeChanges, 1, "not from a frame")
    }

    // MARK: an older app's keys

    func testOldKeysAreRemovedAndUnsentPicksHandedBack() {
        let d = scratchDefaults()
        d.set("paper", forKey: SettingKey.theme)
        d.set(true, forKey: "themePending")
        d.set(["alpha": true], forKey: "hiddenProjectsPending")
        d.set(["alpha"], forKey: "hiddenProjects")
        d.set([["slug": "alpha", "name": "Alpha"]], forKey: "hiddenProjectsList")
        XCTAssertEqual(LegacySettings.take(d), LegacySettings.Pending(theme: "paper", hidden: ["alpha": true]))
        for key in ["themePending", "hiddenProjectsPending", "hiddenProjects", "hiddenProjectsList"] { XCTAssertNil(d.object(forKey: key), key) }
        XCTAssertEqual(d.string(forKey: SettingKey.theme), "paper", "the mirror stays")
        XCTAssertEqual(LegacySettings.take(d), LegacySettings.Pending(), "only once")
    }

    func testAThemeThatWasntPendingIsNotSent() {
        let d = scratchDefaults()
        d.set("paper", forKey: SettingKey.theme)
        XCTAssertNil(LegacySettings.take(d).theme)
    }
}
