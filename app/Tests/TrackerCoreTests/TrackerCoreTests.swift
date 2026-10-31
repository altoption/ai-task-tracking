import XCTest
@testable import TrackerCore

final class BackupTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testRelative() {
        XCTAssertEqual(BackupText.relative(now.addingTimeInterval(-20), now: now), "just now")
        XCTAssertEqual(BackupText.relative(now.addingTimeInterval(-180), now: now), "3 min ago")
        XCTAssertEqual(BackupText.relative(now.addingTimeInterval(-7300), now: now), "2 h ago")
        XCTAssertEqual(BackupText.relative(now.addingTimeInterval(-90_000), now: now), "yesterday")
        XCTAssertEqual(BackupText.relative(now.addingTimeInterval(-4 * 86_400), now: now), "4 days ago")
        XCTAssertEqual(BackupText.relative(now.addingTimeInterval(30), now: now), "just now")
    }

    func testLine() {
        XCTAssertEqual(BackupText.line(GitState(lastPush: now.addingTimeInterval(-180), remote: true), now: now), "Last backed up 3 min ago")
        XCTAssertEqual(BackupText.line(GitState(lastPush: now, pushError: "denied", remote: true), now: now), "Backup error")
        XCTAssertEqual(BackupText.line(GitState(ahead: 3, remote: true), now: now), "Not backed up yet")
        XCTAssertEqual(BackupText.line(GitState(ahead: 0, remote: true), now: now), "Backed up")
        XCTAssertEqual(BackupText.line(GitState(), now: now), "No GitHub backup (no remote)")
    }

    func testNeedsSyncBeforeQuit() {
        XCTAssertFalse(GitState().needsSyncBeforeQuit)
        XCTAssertFalse(GitState(ahead: 4, remote: false).needsSyncBeforeQuit)
        XCTAssertTrue(GitState(ahead: 1, remote: true).needsSyncBeforeQuit)
        XCTAssertTrue(GitState(pending: true).needsSyncBeforeQuit)
    }

    func testParsesHealthGit() {
        let g = GitState(json: ["lastPush": "2026-10-28T12:00:00.123Z", "pending": true, "ahead": 2, "remote": true, "pushError": "x"])
        XCTAssertNotNil(g.lastPush)
        XCTAssertEqual(g.ahead, 2)
        XCTAssertTrue(g.pending && g.remote)
        XCTAssertEqual(g.pushError, "x")
        XCTAssertEqual(GitState(json: [:]), GitState())
    }
}

final class DeepLinkTests: XCTestCase {
    func testRoutes() {
        XCTAssertEqual(DeepLink.route(for: URL(string: "aitt://issue/Q-123")!), "#/issue/Q-123")
        XCTAssertEqual(DeepLink.route(for: URL(string: "aitt://issue/q-7")!), "#/issue/Q-7")
        XCTAssertEqual(DeepLink.route(for: URL(string: "aitt://project/web-app")!), "#/project/web-app")
        XCTAssertEqual(DeepLink.route(for: URL(string: "aitt://new")!), "#/new")
        XCTAssertEqual(DeepLink.route(for: URL(string: "aitt://home")!), "#/")
        XCTAssertEqual(DeepLink.route(for: URL(string: "aitt://issue")!), "#/")
        XCTAssertNil(DeepLink.route(for: URL(string: "https://example.com/issue/Q-1")!))
    }

    func testEncodesOddSegments() {
        XCTAssertEqual(DeepLink.route(for: URL(string: "aitt://project/a%3Fb")!), "#/project/a%3Fb")
    }
}

final class SSETests: XCTestCase {
    func testParsesDataEventsAndSkipsHeartbeats() {
        var p = SSEParser()
        XCTAssertNil(p.feed(line: ": connected"))
        XCTAssertNil(p.feed(line: ""))
        XCTAssertNil(p.feed(line: "data: {\"a\":1}"))
        XCTAssertEqual(p.feed(line: ""), "{\"a\":1}")
        XCTAssertNil(p.feed(line: "data:x\r"))
        XCTAssertNil(p.feed(line: "data: y"))
        XCTAssertEqual(p.feed(line: "\r"), "x\ny")
    }
}

final class AgentNoteTests: XCTestCase {
    func ev(_ issue: [String: Any], prev: [String: Any]? = nil, actor: String = "agent", ws: String? = "web-app") -> [String: Any] {
        var a: [String: Any] = ["actor": actor]
        if let ws { a["workspace"] = ws }
        var e: [String: Any] = ["kind": "issue", "issue": issue, "actor": a]
        if let prev { e["prev"] = prev }
        return e
    }
    let base: [String: Any] = ["id": "Q-1", "title": "Fan table", "status": "In Progress", "labels": ["Task"]]
    func with(_ k: String, _ v: Any) -> [String: Any] { var d = base; d[k] = v; return d }

    let rules = NoteRules(json: ["needsYouStatuses": ["Waiting", "In Review"], "needsYouLabels": ["Needs decision", "Needs review"],
                                 "doneStatuses": ["Done", "Shipped"]])
    func from(_ e: [String: Any]) -> AgentNote? { AgentNote.from(event: e, rules: rules) }

    func testNewIssueThatAlreadyNeedsYouIsNeedsYou() {
        XCTAssertEqual(from(ev(with("status", "Waiting")))?.kind, .needsYou)
        XCTAssertEqual(from(ev(with("labels", ["Needs decision"])))?.kind, .needsYou)
        XCTAssertEqual(from(ev(base))?.kind, .new)
    }

    func testRulesComeFromTheEngine() {
        XCTAssertEqual(from(ev(with("status", "In Review"), prev: base))?.kind, .needsYou)
        XCTAssertEqual(from(ev(with("status", "Shipped"), prev: base))?.kind, .done)
        XCTAssertNil(from(ev(with("status", "Done"), prev: with("status", "Shipped"))))
        XCTAssertNil(AgentNote.from(event: ev(with("status", "Waiting"), prev: base), rules: NoteRules()))
    }

    func testClassifies() {
        XCTAssertEqual(from(ev(base))?.kind, .new)
        XCTAssertEqual(from(ev(with("status", "Waiting"), prev: base))?.kind, .needsYou)
        XCTAssertEqual(from(ev(with("labels", ["Task", "Needs review"]), prev: base))?.kind, .needsYou)
        XCTAssertEqual(from(ev(with("status", "Done"), prev: base))?.kind, .done)
        XCTAssertNil(from(ev(with("status", "Waiting"), prev: with("status", "Waiting"))))
        XCTAssertNil(from(ev(with("labels", ["Needs review"]), prev: with("labels", ["Needs review"]))))
        XCTAssertNil(from(ev(with("status", "Done"), prev: base, actor: "you")))
        XCTAssertNil(from(["kind": "feed", "event": [:]]))
        let n = from(ev(base))!
        XCTAssertEqual(n, AgentNote(kind: .new, id: "Q-1", title: "Fan table", workspace: "web-app"))
    }

    func testSingleBanners() {
        let b = NoteCoalescer.banners([AgentNote(kind: .needsYou, id: "Q-123", title: "Pick a fan", workspace: "web-app")])
        XCTAssertEqual(b, [NoteBanner(title: "Needs you: Q-123", body: "Pick a fan — web-app", route: "#/issue/Q-123")])
        XCTAssertEqual(NoteCoalescer.banners([AgentNote(kind: .done, id: "Q-9", title: "T", workspace: nil)]),
                       [NoteBanner(title: "Done: Q-9", body: "T", route: "#/issue/Q-9")])
    }

    func testCoalescesBursts() {
        let news = (1...10).map { AgentNote(kind: .new, id: "Q-\($0)", title: "t\($0)", workspace: "web-app") }
        let done = AgentNote(kind: .done, id: "Q-50", title: "x", workspace: "cdp")
        let b = NoteCoalescer.banners(news + [done, news[0]])
        XCTAssertEqual(b.count, 2)
        XCTAssertEqual(b[0].title, "Done: Q-50")
        XCTAssertEqual(b[1].title, "10 new issues from web-app")
        XCTAssertEqual(b[1].body, "Q-1, Q-2, Q-3, Q-4, Q-5 +5 more")
        XCTAssertEqual(b[1].route, "#/")
        let mixed = NoteCoalescer.banners([AgentNote(kind: .needsYou, id: "Q-1", title: "", workspace: "a"),
                                           AgentNote(kind: .needsYou, id: "Q-2", title: "", workspace: "b")])
        XCTAssertEqual(mixed.first?.title, "2 issues need you from 2 workspaces")
    }
}

final class StalledTests: XCTestCase {
    func testWatchReportsOnlyNewlyStalledAfterTheBaseline() {
        var w = StalledWatch()
        XCTAssertEqual(w.update(stalledOnly: ["Q-1"], stalledAll: ["Q-1", "Q-2"]), []) // already stalled at launch
        XCTAssertEqual(w.update(stalledOnly: ["Q-1", "Q-3"], stalledAll: ["Q-1", "Q-2", "Q-3"]), ["Q-3"])
        XCTAssertEqual(w.update(stalledOnly: ["Q-1", "Q-2", "Q-3"], stalledAll: ["Q-1", "Q-2", "Q-3"]), []) // Q-2: same episode
    }

    func testOneNotificationAcrossAWaitingRoundTrip() {
        var w = StalledWatch()
        XCTAssertEqual(w.update(stalledOnly: [], stalledAll: []), [])
        XCTAssertEqual(w.update(stalledOnly: ["Q-1"], stalledAll: ["Q-1"]), ["Q-1"]) // stalls: one notification
        XCTAssertEqual(w.update(stalledOnly: [], stalledAll: ["Q-1"]), []) // to Waiting, still stalled (churn)
        XCTAssertEqual(w.update(stalledOnly: ["Q-1"], stalledAll: ["Q-1"]), []) // back to In Progress: same episode
        XCTAssertEqual(w.update(stalledOnly: [], stalledAll: []), []) // Done (or new activity): the episode ends
        XCTAssertEqual(w.update(stalledOnly: ["Q-1"], stalledAll: ["Q-1"]), ["Q-1"]) // a new episode notifies again
    }

    func testFilterFollowsTheSetting() {
        XCTAssertEqual(StalledFilter.count(needsYou: 5, stalledOnly: 2, showStalled: true), 5)
        XCTAssertEqual(StalledFilter.count(needsYou: 5, stalledOnly: 2, showStalled: false), 3)
        XCTAssertEqual(StalledFilter.count(needsYou: 1, stalledOnly: 2, showStalled: false), 0)
        // The engine leaves stalled-only rows out before its 50-row cut, so the menu never loses real ones.
        XCTAssertEqual(StalledFilter.needsYouPath(showStalled: true), "api/needs-you")
        XCTAssertEqual(StalledFilter.needsYouPath(showStalled: false), "api/needs-you?stalled=0")
    }

    func testCIStatusSettingIsSentOnlyWhenTheEngineDiffers() {
        XCTAssertTrue(CIStatusSetting.needsSync(engine: true, wanted: false))
        XCTAssertTrue(CIStatusSetting.needsSync(engine: false, wanted: true)) // e.g. after the engine restarted
        XCTAssertFalse(CIStatusSetting.needsSync(engine: true, wanted: true))
        XCTAssertFalse(CIStatusSetting.needsSync(engine: nil, wanted: false)) // an engine without CI status
        XCTAssertEqual(SettingDefaults.values[SettingKey.showCIStatus] as? Bool, true)
    }

    func testStalledBanners() {
        XCTAssertEqual(NoteCoalescer.banners([AgentNote(kind: .stalled, id: "Q-7", title: "Importer — idle 31 h in In Progress", workspace: nil)]),
                       [NoteBanner(title: "Stalled: Q-7", body: "Importer — idle 31 h in In Progress", route: "#/issue/Q-7")])
        let two = NoteCoalescer.banners([AgentNote(kind: .stalled, id: "Q-1", title: "", workspace: nil),
                                         AgentNote(kind: .stalled, id: "Q-2", title: "", workspace: nil)])
        XCTAssertEqual(two.map(\.title), ["2 issues stalled"])
    }

    func testRulesStillParseWithStalledThresholds() {
        let r = NoteRules(json: ["needsYouStatuses": ["Waiting"], "needsYouLabels": [], "doneStatuses": ["Done"],
                                 "stalled": ["idleHours": 24, "windowDays": 7, "reopens": 2, "sessions": 3]])
        XCTAssertEqual(r, NoteRules(needsYouStatuses: ["Waiting"], doneStatuses: ["Done"]))
    }
}

final class MenuTextTests: XCTestCase {
    func testNeedsYouItem() {
        XCTAssertEqual(MenuText.needsYouItem(id: "Q-1", title: "Short", why: "Waiting"), "Q-1  Short  — Waiting")
        let long = String(repeating: "a", count: 60)
        XCTAssertEqual(MenuText.needsYouItem(id: "Q-1", title: long, why: "Needs review", max: 10), "Q-1  aaaaaaaaa…  — Needs review")
    }

    func testNeedsYouWhyWithStalled() {
        XCTAssertEqual(MenuText.needsYouWhy(why: "Waiting", stalled: nil), "Waiting")
        XCTAssertEqual(MenuText.needsYouWhy(why: "stalled", stalled: "idle 31 h in In Progress"), "stalled: idle 31 h in In Progress")
        XCTAssertEqual(MenuText.needsYouWhy(why: "Waiting", stalled: "reopened 2× in 7 days"), "Waiting · stalled: reopened 2× in 7 days")
    }

    func testLabels() {
        XCTAssertEqual(MenuText.labels(" Task, Bug ,, x "), ["Task", "Bug", "x"])
        XCTAssertEqual(MenuText.labels(""), [])
    }

    func testDefaults() {
        let d = UserDefaults(suiteName: "tracker-core-tests")!
        SettingDefaults.register(in: d)
        XCTAssertTrue(d.bool(forKey: SettingKey.notifyNeedsYou))
        XCTAssertTrue(d.bool(forKey: SettingKey.notifyDone))
        XCTAssertFalse(d.bool(forKey: SettingKey.notifyNew))
        XCTAssertTrue(d.bool(forKey: SettingKey.backupBeforeQuit))
        XCTAssertTrue(d.bool(forKey: SettingKey.showNeedsYouInMenu))
        XCTAssertTrue(d.bool(forKey: SettingKey.showStalledInNeedsYou))
        XCTAssertTrue(d.bool(forKey: SettingKey.showInDock))
        XCTAssertEqual(d.string(forKey: SettingKey.quickCaptureHotKeyPreset), "optCmdN")
    }
}

final class FirstRunTests: XCTestCase {
    func testNeedsSetupWithoutConfigOrWhileSetupRuns() {
        let files = { (set: Set<String>) in { (p: String) in set.contains(p) } }
        XCTAssertTrue(FirstRun.needsSetup(home: "/d", exists: files([])))
        XCTAssertFalse(FirstRun.needsSetup(home: "/d", exists: files(["/d/config.yml"])))
        XCTAssertTrue(FirstRun.needsSetup(home: "/d", exists: files(["/d/config.yml", "/d/.tracker/setup.lock"])))
        XCTAssertFalse(FirstRun.needsSetup(home: "/d/", exists: files(["/d/config.yml"])))
    }

    func testSetupCommandQuotesThePath() {
        XCTAssertEqual(FirstRun.setupCommand(binary: "/Applications/AI Task Tracking.app/Contents/Resources/aitt", home: "/home/a/AITaskTracking", defaultHome: "/home/a/AITaskTracking"),
                       "'/Applications/AI Task Tracking.app/Contents/Resources/aitt' setup")
        XCTAssertEqual(FirstRun.setupCommand(binary: "/x/it's/aitt", home: "/data/T", defaultHome: "/home/a/AITaskTracking"),
                       "'/x/it'\\''s/aitt' setup --home '/data/T'")
    }
}

final class AppEnvTests: XCTestCase {
    func testAittValue() {
        XCTAssertEqual(AppEnv.value("HOME", in: ["AITT_HOME": "/a"]), "/a")
        XCTAssertNil(AppEnv.value("HOME", in: ["AITT_HOME": ""]))
        XCTAssertNil(AppEnv.value("HOME", in: [:]))
    }

    func testEngineEnvironmentSetsAittAndDropsInheritedOnes() {
        let env = AppEnv.engineEnvironment(base: ["PATH": "/bin", "AITT_HOME": "/old", "AITT_PORT": "2"], home: "/d", port: nil)
        XCTAssertEqual(env, ["PATH": "/bin:/opt/homebrew/bin:/usr/local/bin", "AITT_HOME": "/d", "AITT_PARENT_LIFELINE": "1"])
        XCTAssertEqual(AppEnv.engineEnvironment(base: [:], home: "/d", port: 7600)["AITT_PORT"], "7600")
    }

    func testEnginePathFindsHomebrewToolsFromALoginItem() {
        // A login item starts with launchd's PATH: gh (Homebrew) isn't on it.
        let login = AppEnv.engineEnvironment(base: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"], home: "/d", port: nil)
        XCTAssertEqual(login["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
        // Already there: unchanged, in the user's order.
        let shell = AppEnv.engineEnvironment(base: ["PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin"], home: "/d", port: nil)
        XCTAssertEqual(shell["PATH"], "/usr/local/bin:/opt/homebrew/bin:/usr/bin")
        XCTAssertEqual(AppEnv.engineEnvironment(base: [:], home: "/d", port: nil)["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
    }

    func testDefaultHome() {
        XCTAssertEqual(AppEnv.defaultHome(userHome: "/home/a"), "/home/a/AITaskTracking")
    }
}

final class WindowRouteTests: XCTestCase {
    let base = URL(string: "http://127.0.0.1:7477/")!

    func testFirstShowLoads() {
        XCTAssertTrue(WindowRoute.needsLoad(route: nil, loaded: false, current: nil, base: base))
    }

    func testHashRouteOnTheUIOnlySetsTheHash() {
        let ui = URL(string: "http://127.0.0.1:7477/#/")!
        XCTAssertFalse(WindowRoute.needsLoad(route: "#/issue/ATT-1", loaded: true, current: ui, base: base))
        XCTAssertFalse(WindowRoute.needsLoad(route: nil, loaded: true, current: ui, base: base))
    }

    func testDocsAlwaysLoad() {
        let ui = URL(string: "http://127.0.0.1:7477/#/")!
        XCTAssertTrue(WindowRoute.needsLoad(route: WindowRoute.docs, loaded: true, current: ui, base: base))
    }

    func testHashRouteFromTheDocsLoadsTheUI() {
        let docs = URL(string: "http://127.0.0.1:7477/docs/use/daily-use/")!
        XCTAssertTrue(WindowRoute.needsLoad(route: "#/issue/ATT-1", loaded: true, current: docs, base: base))
        XCTAssertTrue(WindowRoute.needsLoad(route: "#/", loaded: true, current: nil, base: base))
        // Showing the window without a route keeps whatever page it is on.
        XCTAssertFalse(WindowRoute.needsLoad(route: nil, loaded: true, current: docs, base: base))
    }
}

final class ThemeSettingTests: XCTestCase {
    private func scratchDefaults() -> UserDefaults {
        let name = "tracker-core-theme-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        SettingDefaults.register(in: d)
        return d
    }
    private let list = [ThemeEntry(id: "dark", name: "Dark", base: "dark", bg: "#101012"),
                        ThemeEntry(id: "light", name: "Light", base: "light", bg: "#f4f4f6"),
                        ThemeEntry(id: "system", name: "Match macOS", base: "system"),
                        ThemeEntry(id: "ocean", name: "Ocean", base: "light", bg: "rgb(1, 2, 3)")]

    /// The app's wiring, against a real UserDefaults suite: an engine fake that records each send and answers when
    /// told, a ThemeSync, and an observer that calls pushIfPending on every UserDefaults change (applySettings).
    private final class Harness {
        let d: UserDefaults
        var sent: [String] = []
        var answers: [(ThemeSync.Outcome) -> Void] = []
        var sync: ThemeSync!
        private var observer: NSObjectProtocol?

        init(_ d: UserDefaults) {
            self.d = d
            sync = ThemeSync(defaults: d) { [unowned self] id, done in
                self.sent.append(id); self.answers.append(done)
            }
            // didChangeNotification is posted synchronously after each write, as in the app.
            observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: d, queue: nil) { [unowned self] _ in
                self.sync.pushIfPending()
            }
        }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

        /// The engine answers the oldest request still open.
        func answer(_ outcome: ThemeSync.Outcome = .confirmed) { answers.removeFirst()(outcome) }
        var theme: String? { d.string(forKey: SettingKey.theme) }
        var pending: Bool { d.bool(forKey: SettingKey.themePending) }
        func tick() -> Int { sync.beginProbe() }
    }

    func testAPickInSettingsIsSentWithTheNewIdAndSticks() {
        let h = Harness(scratchDefaults())
        h.sync.sync(ThemeState(selected: "dark", themes: list), probe: h.tick())
        ThemeSetting.pick("light", defaults: h.d)
        XCTAssertEqual(h.sent, ["light"]) // never the old id (the bug: pending was written before the theme)
        XCTAssertTrue(h.pending)
        // A poll answered before the engine has it doesn't adopt the old theme while pending.
        h.sync.sync(ThemeState(selected: "dark", themes: list), probe: h.tick())
        XCTAssertEqual(h.theme, "light")
        XCTAssertEqual(h.sent, ["light"]) // one request at a time
        let beforeConfirm = h.tick()
        h.answer()
        XCTAssertFalse(h.pending)
        // A probe that started before the confirmation may still report the old theme: ignored.
        h.sync.sync(ThemeState(selected: "dark", themes: list), probe: beforeConfirm)
        XCTAssertEqual(h.theme, "light")
        h.sync.sync(ThemeState(selected: "light", themes: list), probe: h.tick())
        XCTAssertEqual(h.theme, "light")
        XCTAssertEqual(h.sent, ["light"])
        // Later changes in the engine (⌘K) are adopted again.
        h.sync.sync(ThemeState(selected: "paper", themes: list), probe: h.tick())
        XCTAssertEqual(h.theme, "paper")
    }

    func testPicksWhileARequestIsOutEndOnTheLastOne() {
        let h = Harness(scratchDefaults())
        ThemeSetting.pick("light", defaults: h.d)
        ThemeSetting.pick("paper", defaults: h.d)
        ThemeSetting.pick("ocean", defaults: h.d)
        XCTAssertEqual(h.sent, ["light"])
        h.answer() // light answered, but the theme is now ocean: send that, still pending
        XCTAssertEqual(h.sent, ["light", "ocean"])
        XCTAssertTrue(h.pending)
        h.answer()
        XCTAssertFalse(h.pending)
        XCTAssertEqual(h.theme, "ocean")
    }

    func testAnUnreachableEngineLeavesThePickPendingForTheNextPoll() {
        let h = Harness(scratchDefaults())
        ThemeSetting.pick("paper", defaults: h.d)
        h.answer(.retry)
        XCTAssertTrue(h.pending)
        h.sync.sync(nil, probe: h.tick()) // still no engine
        XCTAssertEqual(h.sent, ["paper"])
        h.sync.sync(ThemeState(selected: "dark", themes: list), probe: h.tick()) // back: sent again
        XCTAssertEqual(h.sent, ["paper", "paper"])
        h.answer()
        XCTAssertFalse(h.pending)
        XCTAssertEqual(h.theme, "paper")
    }

    func testReplies2xxConfirm400RefusesOtherwiseRetry() {
        XCTAssertEqual(ThemeSync.Outcome(status: 200), .confirmed)
        XCTAssertEqual(ThemeSync.Outcome(status: 204), .confirmed)
        XCTAssertEqual(ThemeSync.Outcome(status: 400), .refused)
        for status in [403, 404, 500, 503] { XCTAssertEqual(ThemeSync.Outcome(status: status), .retry) }
        XCTAssertEqual(ThemeSync.Outcome(status: nil), .retry)

        let h = Harness(scratchDefaults())
        ThemeSetting.pick("paper", defaults: h.d)
        h.answer(ThemeSync.Outcome(status: 500)) // the engine failed: still pending, sent again on the next poll
        XCTAssertTrue(h.pending)
        h.sync.sync(ThemeState(selected: "dark", themes: list), probe: h.tick())
        XCTAssertEqual(h.sent, ["paper", "paper"])
        h.answer(ThemeSync.Outcome(status: 400)) // refused (unknown id): sending it again can't help
        XCTAssertFalse(h.pending)
        h.sync.sync(ThemeState(selected: "dark", themes: list), probe: h.tick())
        XCTAssertEqual(h.theme, "dark") // the engine's theme wins
        XCTAssertEqual(h.sent, ["paper", "paper"])
    }

    func testPollsAdoptTheEnginesThemeAndStoreItsList() {
        let h = Harness(scratchDefaults())
        XCTAssertEqual(h.theme, "graphite") // the default until the engine says otherwise
        XCTAssertEqual(ThemeSetting.fallbackList.first?.id, ThemeSetting.defaultTheme)
        XCTAssertEqual(ThemeSetting.storedList(h.d), ThemeSetting.fallbackList)
        h.sync.sync(ThemeState(selected: "ocean", themes: list), probe: h.tick()) // ⌘K in the browser
        XCTAssertEqual(h.theme, "ocean")
        XCTAssertEqual(ThemeSetting.storedList(h.d), list)
        // config.yml holds a deleted theme's id: the app shows what the engine shows (Dark)...
        h.sync.sync(ThemeState(selected: "gone", effective: "dark", themes: list), probe: h.tick())
        XCTAssertEqual(h.theme, "dark")
        // ...and picking Dark still sends it, so config.yml is fixed.
        ThemeSetting.pick("dark", defaults: h.d)
        XCTAssertEqual(h.sent, ["dark"])
        XCTAssertTrue(h.sent.allSatisfy { $0 != "gone" })
    }

    func testHealthJSON() {
        let s = ThemeState(json: ["selected": "system", "themes": [["id": "system", "name": "Match macOS", "base": "system"], ["bad": 1]]])
        XCTAssertEqual(s, ThemeState(selected: "system", themes: [ThemeEntry(id: "system", name: "Match macOS", base: "system")]))
        XCTAssertEqual(s?.effective, "system") // an engine without `effective`
        XCTAssertEqual(ThemeState(json: ["selected": "gone", "effective": "dark", "themes": []])?.effective, "dark")
        XCTAssertNil(ThemeState(json: ["themes": []]))
    }

    func testWindowLook() {
        let dark = RGBA(hex: "#101012")!, light = RGBA(hex: "#f4f4f6")!
        XCTAssertEqual(ThemeSetting.look(selected: "dark", themes: list), WindowLook(appearance: "dark", darkBackground: dark, lightBackground: dark))
        XCTAssertEqual(ThemeSetting.look(selected: "light", themes: list), WindowLook(appearance: "light", darkBackground: light, lightBackground: light))
        XCTAssertEqual(ThemeSetting.look(selected: "system", themes: list), WindowLook(appearance: nil, darkBackground: dark, lightBackground: light))
        // A background the app can't parse (rgb()) takes its base's; an unknown id looks like the default, Graphite.
        XCTAssertEqual(ThemeSetting.look(selected: "ocean", themes: list).lightBackground, WindowLook.lightBg)
        XCTAssertEqual(ThemeSetting.look(selected: "gone", themes: list), WindowLook.graphite)
        XCTAssertEqual(WindowLook.graphite.darkBackground, RGBA(hex: "#141619"))
        // Before the engine answers: the default's window, and a saved Dark keeps Dark's.
        XCTAssertEqual(ThemeSetting.look(selected: ThemeSetting.defaultTheme, themes: ThemeSetting.fallbackList), WindowLook.graphite)
        XCTAssertEqual(ThemeSetting.look(selected: "dark", themes: ThemeSetting.fallbackList).darkBackground, dark)
    }

    func testHex() {
        XCTAssertEqual(RGBA(hex: "#fff"), RGBA(r: 1, g: 1, b: 1))
        XCTAssertEqual(RGBA(hex: "#00000080")?.a ?? 0, 128.0 / 255, accuracy: 0.0001)
        XCTAssertEqual(RGBA(hex: "#ff0000"), RGBA(r: 1, g: 0, b: 0))
        XCTAssertNil(RGBA(hex: "red"))
        XCTAssertNil(RGBA(hex: "#12345"))
    }
}
