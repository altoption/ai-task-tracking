import XCTest
@testable import TrackerCore

final class HiddenProjectsTests: XCTestCase {
    private func scratchDefaults() -> UserDefaults {
        let name = "tracker-core-hidden-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        SettingDefaults.register(in: d)
        return d
    }
    private let list = [ProjectEntry(slug: "alpha", name: "Alpha"), ProjectEntry(slug: "beta", name: "Beta"),
                        ProjectEntry(slug: "_none", name: "No project")]

    /// The app's wiring against a real UserDefaults suite: an engine fake that records each send and answers when told,
    /// a HiddenProjectsSync, and an observer that calls pushIfPending on every UserDefaults change (applySettings).
    private final class Harness {
        let d: UserDefaults
        var sent: [String] = []
        var answers: [(HiddenProjectsSync.Outcome) -> Void] = []
        var sync: HiddenProjectsSync!
        private var observer: NSObjectProtocol?

        init(_ d: UserDefaults) {
            self.d = d
            sync = HiddenProjectsSync(defaults: d) { [unowned self] slug, hidden, done in
                self.sent.append("\(hidden ? "+" : "-")\(slug)"); self.answers.append(done)
            }
            observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: d, queue: nil) { [unowned self] _ in
                self.sync.pushIfPending()
            }
        }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

        func answer(_ outcome: HiddenProjectsSync.Outcome = .confirmed) { answers.removeFirst()(outcome) }
        var hidden: Set<String> { HiddenProjectsSetting.hidden(d) }
        var pending: [String: Bool] { HiddenProjectsSetting.pending(d) }
        func tick() -> Int { sync.beginProbe() }
        func poll(_ selected: [String], projects: [ProjectEntry], probe: Int? = nil) {
            sync.sync(HiddenProjectsState(selected: selected, projects: projects), probe: probe ?? tick())
        }
    }

    func testPollsAdoptTheEnginesListAndHiddenSlugs() {
        let h = Harness(scratchDefaults())
        XCTAssertEqual(HiddenProjectsSetting.storedList(h.d), [])
        XCTAssertEqual(h.hidden, [])
        h.poll(["beta"], projects: list) // hidden from a project page in the browser
        XCTAssertEqual(HiddenProjectsSetting.storedList(h.d), list)
        XCTAssertEqual(h.hidden, ["beta"])
        h.poll([], projects: list) // unhidden there
        XCTAssertEqual(h.hidden, [])
        h.sync.sync(nil, probe: h.tick()) // no engine: nothing changes
        XCTAssertEqual(HiddenProjectsSetting.storedList(h.d), list)
        XCTAssertEqual(h.sent, []) // polls never send anything
    }

    func testATickIsSentOnceAndSticks() {
        let h = Harness(scratchDefaults())
        h.poll([], projects: list)
        HiddenProjectsSetting.set("alpha", hidden: true, defaults: h.d)
        XCTAssertEqual(h.sent, ["+alpha"])
        XCTAssertEqual(h.hidden, ["alpha"])
        // A poll answered before the engine has it keeps the tick.
        h.poll([], projects: list)
        XCTAssertEqual(h.hidden, ["alpha"])
        XCTAssertEqual(h.sent, ["+alpha"]) // one request at a time
        let beforeConfirm = h.tick()
        h.answer()
        XCTAssertEqual(h.pending, [:])
        // A probe that started before the confirmation may still report the old list: ignored.
        h.poll([], projects: list, probe: beforeConfirm)
        XCTAssertEqual(h.hidden, ["alpha"])
        h.poll(["alpha"], projects: list)
        XCTAssertEqual(h.hidden, ["alpha"])
        XCTAssertEqual(h.sent, ["+alpha"])
    }

    func testTicksOnDifferentProjectsAreSentOneByOneAndOnlyTheirOwn() {
        let h = Harness(scratchDefaults())
        h.poll(["beta"], projects: list)
        HiddenProjectsSetting.set("alpha", hidden: true, defaults: h.d)
        HiddenProjectsSetting.set("_none", hidden: true, defaults: h.d)
        XCTAssertEqual(h.sent, ["+alpha"])
        XCTAssertEqual(h.hidden, ["alpha", "beta", "_none"])
        h.answer()
        XCTAssertEqual(h.sent, ["+alpha", "+_none"])
        // Meanwhile the browser unhid beta: adopted, while the app's own tick stays applied.
        h.poll(["alpha"], projects: list)
        XCTAssertEqual(h.hidden, ["alpha", "_none"])
        h.answer()
        XCTAssertEqual(h.pending, [:])
        XCTAssertFalse(h.sent.contains("-beta")) // never sends what the user didn't touch
    }

    func testRetickWhileARequestIsOutEndsOnTheLastValue() {
        let h = Harness(scratchDefaults())
        HiddenProjectsSetting.set("alpha", hidden: true, defaults: h.d)
        HiddenProjectsSetting.set("alpha", hidden: false, defaults: h.d)
        XCTAssertEqual(h.sent, ["+alpha"])
        h.answer() // +alpha answered, but the user now wants it shown: send that
        XCTAssertEqual(h.sent, ["+alpha", "-alpha"])
        XCTAssertEqual(h.pending, ["alpha": false])
        h.answer()
        XCTAssertEqual(h.pending, [:])
        XCTAssertEqual(h.hidden, [])
    }

    func testRetryKeepsPendingForTheNextPollAndRefusedLetsTheEngineWin() {
        let h = Harness(scratchDefaults())
        HiddenProjectsSetting.set("gone", hidden: true, defaults: h.d)
        h.answer(.retry) // no engine
        XCTAssertEqual(h.pending, ["gone": true])
        h.poll([], projects: list) // back: sent again
        XCTAssertEqual(h.sent, ["+gone", "+gone"])
        h.answer(HiddenProjectsSync.Outcome(status: 400)) // refused: no such project
        XCTAssertEqual(h.pending, [:])
        h.poll([], projects: list)
        XCTAssertEqual(h.hidden, []) // the engine's list wins
        XCTAssertEqual(h.sent, ["+gone", "+gone"])
    }

    func testHealthJSON() {
        let s = HiddenProjectsState(json: ["selected": ["beta"], "projects": [["slug": "beta", "name": "Beta"], ["slug": "x"], ["bad": 1]]])
        XCTAssertEqual(s, HiddenProjectsState(selected: ["beta"], projects: [ProjectEntry(slug: "beta", name: "Beta"), ProjectEntry(slug: "x", name: "x")]))
        XCTAssertNil(HiddenProjectsState(json: ["projects": []])) // an engine without hidden projects
    }
}
