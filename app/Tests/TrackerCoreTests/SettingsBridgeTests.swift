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

    private func accepts(scheme: String? = "http", host: String? = "127.0.0.1", port: Int? = 7477, main: Bool = true, path: String? = "/") -> Bool {
        SettingsBridge.acceptsSender(scheme: scheme, host: host, port: port, isMainFrame: main, path: path, engine: engine)
    }

    func testTheEnginesPageIsAccepted() {
        XCTAssertTrue(accepts())
        XCTAssertTrue(accepts(path: ""))
        XCTAssertTrue(accepts(path: nil))
    }

    func testAnyOtherOriginIsRefused() {
        XCTAssertFalse(accepts(scheme: "https"))
        XCTAssertFalse(accepts(host: "example.com"))
        XCTAssertFalse(accepts(host: "localhost"))
        XCTAssertFalse(accepts(port: 7499))
        XCTAssertFalse(accepts(port: nil))
        // A sandboxed attachment under /files/: the engine's CSP makes its origin opaque.
        XCTAssertFalse(accepts(scheme: "", host: "", port: 0, path: "/files/x/y.svg"))
    }

    func testAFrameOrAnotherPageOfTheEngineIsRefused() {
        XCTAssertFalse(accepts(main: false))
        XCTAssertFalse(accepts(path: "/docs/"))
        XCTAssertFalse(accepts(path: "/files/p/a.svg"))
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
}
