/**
 * **Behavioural tests for the press rules** — the branches this release added, driven as state, not
 * grepped out of the source (v2.0.0-beta.30).
 *
 * Run: `scripts/press-rules-test.sh`. It compiles `ios/App/App/NavilitePressRules.swift` — the same
 * file the app target compiles — together with this driver, and runs it. What is exercised is the
 * shipped function body, so a rule that changes without a test changing fails here.
 *
 * This is deliberately not a test of `NaviliteRemote.swift` (that file needs AVFoundation, Capacitor
 * and UIKit, and the invariants being tested are the ones that were moved *out* of it precisely so
 * they could be executed).
 */

import Foundation

@main
struct PressRulesTests {

    static var passed = 0
    static var failed = 0

    static func check(_ what: String, _ ok: Bool, _ detail: String = "") {
        if ok {
            passed += 1
            print("  ok    \(what)")
        } else {
            failed += 1
            print("  FAIL  \(what)\(detail.isEmpty ? "" : " — \(detail)")")
        }
    }

    /// `answer` is a refusal when non-nil; the expectation says which it has to be.
    static func isRefusal(_ what: String, _ answer: String?, expect: Bool) {
        check(what, (answer != nil) == expect, "the rule answered \(answer.map { _ in "a refusal" } ?? "nil")")
    }

    static func cleared(_ sweep: NavilitePressRules.Sweep) -> Bool { sweep == .clear }

    /// The release's own four answers, as booleans, so each case is asserted by name (beta.31).
    static func refuseAnswer(_ release: NavilitePressRules.Release) -> Bool {
        if case .refuse = release { return true }
        return false
    }

    static func abandonAnswer(_ release: NavilitePressRules.Release) -> Bool {
        if case .abandon = release { return true }
        return false
    }

    static func waitAnswer(_ release: NavilitePressRules.Release) -> Bool {
        if case .wait = release { return true }
        return false
    }

    /// Either the sound changes hands to a player that is already making it (`.take`) or the app's
    /// player is moved to the queue's position in the same turn (`.seekThenTake`) — the two answers
    /// that end a release with exactly one sounding player and nothing else to do.
    static func takesOrMoves(_ release: NavilitePressRules.Release) -> Bool {
        switch release {
        case .take, .seekThenTake: return true
        case .wait, .abandon, .refuse: return false
        }
    }

    static func main() {
        let t0 = Date(timeIntervalSince1970: 1792442577)
        let order = (0..<30).map { "track-\($0)" }
        let attached = ["a", "b", "c"]

        print("\n# one press, one decision — a repeat is refused before anything is resolved")

        isRefusal("a repeat of next while the boundary the first next started is still in flight",
                  NavilitePressRules.refusalForRepeat(move: "next", lastMove: "next",
                                                      lastAt: t0.addingTimeInterval(-5.6), now: t0,
                                                      soundingNow: "18", leftByLastPress: "18",
                                                      inFlightMove: "next"),
                  expect: true)
        isRefusal("the measured repeat: next → entry 18 at 05:20:57, next again 1.0 s later, sound unmoved",
                  NavilitePressRules.refusalForRepeat(move: "next", lastMove: "next",
                                                      lastAt: t0.addingTimeInterval(-1.0), now: t0,
                                                      soundingNow: "track-18", leftByLastPress: "track-18",
                                                      inFlightMove: ""),
                  expect: true)
        isRefusal("the same next 5.6 s later with no boundary in flight — a press of its own, not refused",
                  NavilitePressRules.refusalForRepeat(move: "next", lastMove: "next",
                                                      lastAt: t0.addingTimeInterval(-5.6), now: t0,
                                                      soundingNow: "track-18", leftByLastPress: "track-18",
                                                      inFlightMove: ""),
                  expect: false)
        isRefusal("the same next 0.4 s later but the sound has MOVED — a real second press, taken",
                  NavilitePressRules.refusalForRepeat(move: "next", lastMove: "next",
                                                      lastAt: t0.addingTimeInterval(-0.4), now: t0,
                                                      soundingNow: "track-19", leftByLastPress: "track-18",
                                                      inFlightMove: ""),
                  expect: false)
        isRefusal("a different move inside the window — the user correcting a press",
                  NavilitePressRules.refusalForRepeat(move: "previous", lastMove: "next",
                                                      lastAt: t0, now: t0,
                                                      soundingNow: "track-18", leftByLastPress: "track-18",
                                                      inFlightMove: "next"),
                  expect: false)
        isRefusal("the same move inside the window with nothing sounding — nothing to be a repeat of",
                  NavilitePressRules.refusalForRepeat(move: "next", lastMove: "next",
                                                      lastAt: t0.addingTimeInterval(-0.5), now: t0,
                                                      soundingNow: "", leftByLastPress: "",
                                                      inFlightMove: ""),
                  expect: false)
        isRefusal("no press has been answered yet",
                  NavilitePressRules.refusalForRepeat(move: "next", lastMove: "", lastAt: .distantPast,
                                                      now: t0, soundingNow: "track-1", leftByLastPress: "",
                                                      inFlightMove: ""),
                  expect: false)

        print("\n# a toggle is a move too — the 09:10:29/09:10:30 pair is one press")

        check("no toggle answered yet — taken",
              NavilitePressRules.refusalForRepeatedToggle(lastAt: nil, now: t0) == nil)
        check("a toggle 1.0 s after one answered — refused (the owner's 09:10:29/30 pair)",
              NavilitePressRules.refusalForRepeatedToggle(lastAt: t0.addingTimeInterval(-1.0), now: t0) != nil)
        check("a toggle 12 s later — a press of its own",
              NavilitePressRules.refusalForRepeatedToggle(lastAt: t0.addingTimeInterval(-12), now: t0) == nil)

        print("\n# the take's position is the same position — 886 ms of drift is not a handover")

        check("886 ms of drift (the owner's 09:05:36 take) is refused",
              NavilitePressRules.driftRefusal(driftMs: 886) != nil)
        check("-886 ms of drift is refused too",
              NavilitePressRules.driftRefusal(driftMs: -886) != nil)
        check("200 ms of drift is inside the 250 ms a take allows",
              NavilitePressRules.driftRefusal(driftMs: 200) == nil)
        check("a take at exactly 0 is the take", NavilitePressRules.driftRefusal(driftMs: 0) == nil)

        print("\n# the drift bound refuses when it is spent — exhaustion is not a permission")

        if let spent = NavilitePressRules.handoverDriftRefusal(driftMs: 2886, refusals: 2, maxRefusals: 2) {
            check("the third ask at 2886 ms is refused, not taken", true)
            check("and the refusal says the bound was reached", spent.exhausted)
        } else {
            check("the third ask at 2886 ms is refused, not taken", false,
                  "the rule answered nil on an exhausted count, so the take would have gone ahead at 2886 ms")
            check("and the refusal says the bound was reached", false)
        }
        check("the first ask at 886 ms is refused and counted",
              NavilitePressRules.handoverDriftRefusal(driftMs: 886, refusals: 0, maxRefusals: 2)?.exhausted == false)
        check("-2886 ms on the last allowed ask is refused too",
              NavilitePressRules.handoverDriftRefusal(driftMs: -2886, refusals: 1, maxRefusals: 2) != nil)
        check("a take inside 250 ms is still a take after the bound was spent",
              NavilitePressRules.handoverDriftRefusal(driftMs: 120, refusals: 5, maxRefusals: 2) == nil)

        print("\n# one identity, one decision — the id is minted at the button, whatever the move")

        let answered = [NavilitePressRules.PressIdentity(id: 41, at: t0.addingTimeInterval(-0.2))]
        let sameAgain = NavilitePressRules.refusalForAnsweredPress(id: 41, answered: answered)
        check("press #41 arriving again is refused", sameAgain != nil)
        check("and the refusal names the identity rule",
              sameAgain?.hasPrefix("press-already-answered") == true, sameAgain ?? "nil")
        check("the answer does not depend on the move — an id the app answered answers for every move",
              NavilitePressRules.refusalForAnsweredPress(id: 41, answered: answered) != nil)
        check("a new button press (#42) is a press of its own",
              NavilitePressRules.refusalForAnsweredPress(id: 42, answered: answered) == nil)
        /* The owner's sequence: press #41 accepted, the label moves 33 ms later — the press itself
         * wrote the card, so the epoch moved on to #42 — and the redelivery at :582679 (5.6 s) still
         * carries #41. The card is NOT the one that carried the press any more; the id is the fact. */
        check("the owner's 5.6 s redelivery (log-seg-9590 :577080 → :582679) is refused after the card was re-drawn",
              NavilitePressRules.refusalForAnsweredPress(id: 41, answered: answered) != nil)
        check("the same id 12 s later, after any number of re-draws, is still that button delivered again",
              NavilitePressRules.refusalForAnsweredPress(id: 41, answered: answered) != nil)
        check("a button that came back on the card that carries it (#42, answered #42) is refused",
              NavilitePressRules.refusalForAnsweredPress(
                  id: 42, answered: [NavilitePressRules.PressIdentity(id: 42, at: t0)]) != nil)
        check("a lock screen event id is answered by its own id like any other — a per-event id is unique, so it can only be that event again",
              NavilitePressRules.refusalForAnsweredPress(
                  id: -1, answered: [NavilitePressRules.PressIdentity(id: -1, at: t0)]) != nil)
        check("a lock screen event id this side has not answered is not refused here — the move rules decide it",
              NavilitePressRules.refusalForAnsweredPress(id: -1, answered: answered) == nil)
        check("no press has been answered yet",
              NavilitePressRules.refusalForAnsweredPress(id: 41, answered: []) == nil)

        print("\n# a command naming another move does not tear down the boundary a press owns")

        let cross = NavilitePressRules.refusalForCrossMove(move: "previous", inFlightMove: "next")
        check("a previous arriving while a next boundary is in flight is refused", cross != nil)
        check("and it is refused by name (press-cross-move)",
              cross?.hasPrefix("press-cross-move") == true, cross ?? "nil")
        check("the other direction is refused as well",
              NavilitePressRules.refusalForCrossMove(move: "next", inFlightMove: "previous")?
                  .hasPrefix("press-cross-move") == true)
        check("the same move is not a cross move — the repeat rule owns that case",
              NavilitePressRules.refusalForCrossMove(move: "next", inFlightMove: "next") == nil)
        check("a boundary no press owns (a natural end) may be answered by a command",
              NavilitePressRules.refusalForCrossMove(move: "previous", inFlightMove: "") == nil)

        print("\n# the take is proved, never assumed — an empty or unmappable answer does not pass")

        check("the queue's item IS the entry and the reading names it — the live position is taken",
              NavilitePressRules.handoverTake(soundingSongId: "0DHk", entrySongId: "0DHk",
                                              readingSongId: "0DHk", liveMs: 14158) == 14158)
        check("the queue's item cannot be mapped — no take (the old `?? \"\"` passed here)",
              NavilitePressRules.handoverTake(soundingSongId: nil, entrySongId: "0DHk",
                                              readingSongId: "0DHk", liveMs: 14158) == nil)
        check("the queue answers an empty songId — no take",
              NavilitePressRules.handoverTake(soundingSongId: "", entrySongId: "0DHk",
                                              readingSongId: "0DHk", liveMs: 14158) == nil)
        check("no reading was offered — no take",
              NavilitePressRules.handoverTake(soundingSongId: "0DHk", entrySongId: "0DHk",
                                              readingSongId: nil, liveMs: 14158) == nil)
        check("the queue is sounding the other track — no take (app stated 5, queue sounding 25)",
              NavilitePressRules.handoverTake(soundingSongId: "Yama", entrySongId: "0DHk",
                                              readingSongId: "0DHk", liveMs: 14158) == nil)
        check("the queue is at 0 — no position to adopt",
              NavilitePressRules.handoverTake(soundingSongId: "0DHk", entrySongId: "0DHk",
                                              readingSongId: "0DHk", liveMs: 0) == nil)

        print("\n# the reading's index is the sounding entry, not the statement")

        check("queue sounding entry 25 while the app stated 5 — the reading carries 25",
              NavilitePressRules.readingIndex(soundingSongId: "track-25", order: order, statementIndex: 5) == 25)
        check("an order this side can place answers that place",
              NavilitePressRules.readingIndex(soundingSongId: "track-7", order: order, statementIndex: 5) == 7)
        check("a songId the order does not contain answers the statement (and the take is still refused)",
              NavilitePressRules.readingIndex(soundingSongId: "not-in-the-order", order: order, statementIndex: 5) == 5)

        print("\n# the queue is read at the player: the item's identity is the whole precondition")

        check("item 2 is entry c at cursor 2",
              NavilitePressRules.attachedEntry(itemIndex: 2, attached: attached)?.songId == "c"
              && NavilitePressRules.attachedEntry(itemIndex: 2, attached: attached)?.cursor == 2)
        check("no current item answers nothing",
              NavilitePressRules.attachedEntry(itemIndex: nil, attached: attached) == nil)
        check("an item this side did not attach answers nothing",
              NavilitePressRules.attachedEntry(itemIndex: 7, attached: attached) == nil)

        print("\n# one owner: the start is refused, the sounding player keeps the sound")

        check("nothing sounding — clear",
              cleared(NavilitePressRules.queueSweep(queueSounding: false, queueSongId: "a", target: "slot-0",
                                                    awaySlot: "away", keepQueueSongId: nil,
                                                    action: "the app's start of b")))
        check("the queue itself is the target — clear",
              cleared(NavilitePressRules.queueSweep(queueSounding: true, queueSongId: "a", target: "away",
                                                    awaySlot: "away", keepQueueSongId: nil,
                                                    action: "the queue's own start")))
        isRefusal("the queue is sounding a and a start of b is issued over it",
                  NavilitePressRules.queueSweep(queueSounding: true, queueSongId: "a", target: "slot-0",
                                                awaySlot: "away", keepQueueSongId: nil,
                                                action: "the app's start of b").refusal,
                  expect: true)
        check("the take is clear only when the queue's own item IS the entry being taken",
              cleared(NavilitePressRules.queueSweep(queueSounding: true, queueSongId: "0DHk", target: "slot-0",
                                                    awaySlot: "away", keepQueueSongId: "0DHk",
                                                    action: "the take of 0DHk")))
        isRefusal("keepQueue is not a licence when the queue is on another entry",
                  NavilitePressRules.queueSweep(queueSounding: true, queueSongId: "Yama", target: "slot-0",
                                                awaySlot: "away", keepQueueSongId: "0DHk",
                                                action: "the take of 0DHk").refusal,
                  expect: true)
        isRefusal("keepQueue with an item nobody could map",
                  NavilitePressRules.queueSweep(queueSounding: true, queueSongId: nil, target: "slot-0",
                                                awaySlot: "away", keepQueueSongId: "0DHk",
                                                action: "the take of 0DHk").refusal,
                  expect: true)
        check("a plugin asset that was paused is gone — clear",
              cleared(NavilitePressRules.survivors([], target: "slot-0", awaySlot: "away")))
        check("the target itself is not a survivor",
              cleared(NavilitePressRules.survivors(["slot-0"], target: "slot-0", awaySlot: "away")))
        isRefusal("a slot still sounding after the sweep refuses the start",
                  NavilitePressRules.survivors(["slot-1"], target: "slot-0", awaySlot: "away").refusal,
                  expect: true)

        print("\n# the release: the take is the players' answer, and it never leaves two owners (beta.31)")

        /* The owner's build-83 case, in one call: the app's own start on the way back named the
         * entry (or named nothing at all), the queue was still sounding it, and the release had to
         * end with one player — not with a refusal that left the queue playing underneath. */
        check("the app's player is the reading's entry, sounding, at the queue's position — take",
              NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "0DHk", appSounding: true,
                                             queueSongId: "0DHk", appMs: 14158, queueMs: 14200)
              == .take(appMs: 14158, driftMs: 42))
        check("within the 250 ms the take allows, either direction",
              NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "0DHk", appSounding: true,
                                             queueSongId: "0DHk", appMs: 14400, queueMs: 14200)
              == .take(appMs: 14400, driftMs: -200))
        check("the app's start is behind the queue the whole load — the player is moved and the queue stops, never a refusal that keeps both",
              NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "0DHk", appSounding: true,
                                             queueSongId: "0DHk", appMs: 2000, queueMs: 14158)
              == .seekThenTake(appMs: 2000, driftMs: 12158))
        check("the queue's own item is not an entry this side attached — refuse, the queue keeps the sound",
              NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "0DHk", appSounding: true,
                                             queueSongId: nil, appMs: 14158, queueMs: 14158) != nil
              && refuseAnswer(NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "0DHk",
                                                             appSounding: true, queueSongId: nil,
                                                             appMs: 14158, queueMs: 14158)))
        check("the queue is sounding another entry than the reading — refuse, never a take",
              refuseAnswer(NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "0DHk",
                                                         appSounding: true, queueSongId: "Yama",
                                                         appMs: 14158, queueMs: 14158)))
        check("no reading — refuse",
              refuseAnswer(NavilitePressRules.releaseTake(readingSongId: "", appSongId: "0DHk",
                                                         appSounding: true, queueSongId: "0DHk",
                                                         appMs: 14158, queueMs: 14158)))
        check("the app's own player is on ANOTHER entry — the queue stops rather than sounding under it",
              abandonAnswer(NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "Yama",
                                                          appSounding: true, queueSongId: "0DHk",
                                                          appMs: 14158, queueMs: 14158)))
        check("the app named no entry and its player names none — wait, do not refuse and do not take",
              waitAnswer(NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "",
                                                       appSounding: true, queueSongId: "0DHk",
                                                       appMs: 14158, queueMs: 14158)))
        check("the app's start has not reached the speakers yet — wait (a 200 ms wait, not a second song)",
              waitAnswer(NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "0DHk",
                                                       appSounding: false, queueSongId: "0DHk",
                                                       appMs: 14158, queueMs: 14158)))
        check("the app's position could not be read — wait, not a refusal built on a missing number",
              waitAnswer(NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "0DHk",
                                                       appSounding: true, queueSongId: "0DHk",
                                                       appMs: nil, queueMs: 14158)))
        check("the ported bridge's release — no songId, an app player that IS the entry and is sounding — waits rather than refusing the take forever",
              waitAnswer(NavilitePressRules.releaseTake(readingSongId: "0DHk", appSongId: "",
                                                       appSounding: true, queueSongId: "0DHk",
                                                       appMs: nil, queueMs: 14158)))
        check("every verdict either takes, moves the app's player to the queue, abandons the queue, or keeps the queue sounding — none leaves two owners",
              takesOrMoves(NavilitePressRules.releaseTake(readingSongId: "a", appSongId: "a", appSounding: true,
                                                         queueSongId: "a", appMs: 1000, queueMs: 1000))
              && takesOrMoves(NavilitePressRules.releaseTake(readingSongId: "a", appSongId: "a", appSounding: true,
                                                            queueSongId: "a", appMs: 1, queueMs: 9000))
              && abandonAnswer(NavilitePressRules.releaseTake(readingSongId: "a", appSongId: "b", appSounding: true,
                                                             queueSongId: "a", appMs: 1, queueMs: 1000))
              && refuseAnswer(NavilitePressRules.releaseTake(readingSongId: "a", appSongId: "b", appSounding: true,
                                                            queueSongId: "c", appMs: 1, queueMs: 1000)))

        print("\n# the away queue is named from the player, so a return after an advance has a reading")

        func stopped(_ decision: NavilitePressRules.Return?) -> Bool {
            if case .stop = decision { return true }
            return false
        }
        func stopsTheQueue(_ answer: NavilitePressRules.Unreleased) -> Bool {
            if case .stopTheQueue = answer { return true }
            return false
        }
        func keepsTheQueue(_ answer: NavilitePressRules.Unreleased) -> Bool {
            if case .keepTheQueue = answer { return true }
            return false
        }

        let published: [NavilitePressRules.PublishedEntry] = [
            .init(songId: "a", url: "file:///a.m4a"),
            .init(songId: "b", url: "file:///b.m4a"),
            .init(songId: "c", url: "file:///c.m4a"),
            .init(songId: "d", url: "file:///d.m4a"),
        ]

        // After an away advance the player holds the entry it sounded and the two attached ahead.
        let identity = NavilitePressRules.nameQueue(
            items: [.init(attachedSongId: "b", url: "file:///b.m4a"),
                    .init(attachedSongId: "c", url: "file:///c.m4a"),
                    .init(attachedSongId: "d", url: "file:///d.m4a")],
            currentAt: 0, published: published)
        check("an item this side attached is named by identity, at the player's own index",
              identity.sounding?.songId == "b" && identity.sounding?.cursor == 0)
        check("every item is named — the bookkeeping may be re-derived from the player", identity.complete)

        // THE CARD: the app's own top-up added d and cancelled c between the advance and the return.
        // The player holds b (sounding) and d; identity places b, and d's own url places d.
        let toppedUp = NavilitePressRules.nameQueue(
            items: [.init(attachedSongId: "b", url: "file:///b.m4a"),
                    .init(attachedSongId: nil, url: "file:///d.m4a")],
            currentAt: 0, published: published)
        check("a top-up that added d and cancelled c does not break the name of the entry sounding",
              toppedUp.sounding?.songId == "b" && toppedUp.sounding?.cursor == 0)
        check("the entry the top-up appended is named by its own url",
              toppedUp.names.count == 2 && toppedUp.names[1] == "d")

        // The owner's log: awayItems longer than awayEntries, so the identity lookup names the sounding
        // item with an index the entry list does not have — and used to answer nothing at all.
        let drifted = NavilitePressRules.nameQueue(
            items: [.init(attachedSongId: nil, url: "file:///c.m4a"),
                    .init(attachedSongId: nil, url: "file:///d.m4a")],
            currentAt: 0, published: published)
        check("an item the bookkeeping lost is named from the player, not answered with nil",
              drifted.sounding?.songId == "c")
        check("...and the repaired list is complete, so the pairing can be rebuilt", drifted.complete)

        let twice = NavilitePressRules.nameQueue(
            items: [.init(attachedSongId: nil, url: "file:///a.m4a"),
                    .init(attachedSongId: nil, url: "file:///a.m4a")],
            currentAt: 1,
            published: [.init(songId: "a", url: "file:///a.m4a"),
                        .init(songId: "a-again", url: "file:///a.m4a")])
        check("a url the order holds twice is consumed once each, in the player's order",
              twice.names.count == 2 && twice.names[0] == "a" && twice.names[1] == "a-again")

        let unnameable = NavilitePressRules.nameQueue(
            items: [.init(attachedSongId: nil, url: "file:///a-stream.m3u8")],
            currentAt: 0, published: published)
        check("an item nothing this side knows cannot be named, and the list is not complete",
              unnameable.sounding == nil && !unnameable.complete)

        print("\n# a return ends in a reading or in a decision — never in neither")

        check("the queue's entry is named — offer it, with the queue's own index and position",
              NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: "b",
                                                soundingIndex: 1, positionMs: 3588)
              == .offer(songId: "b", index: 1, positionMs: 3588))
        check("the queue holds the sound and cannot be named — STOP it, never a second player",
              stopped(NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: nil,
                                                        soundingIndex: -1, positionMs: 3588)))
        check("an empty songId is not a name — the queue is stopped rather than offered nothing",
              stopped(NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: "",
                                                        soundingIndex: -1, positionMs: 3588)))
        check("a queue that is not the sound has nothing to decide (releaseHandover writes that line)",
              NavilitePressRules.returnDecision(queueOwnsSound: false, soundingSongId: nil,
                                                soundingIndex: -1, positionMs: 0) == nil)

        print("\n# an offer nobody released still ends in exactly one decision")

        check("the ladder re-asks on its four rungs and settles on the one after",
              NavilitePressRules.releaseReasks(attempt: 0) && NavilitePressRules.releaseReasks(attempt: 1)
              && NavilitePressRules.releaseReasks(attempt: 2) && NavilitePressRules.releaseReasks(attempt: 3)
              && !NavilitePressRules.releaseReasks(attempt: 4))

        // The owner's 15:39:40 return: three offers, `positionMs:3588`, `sounding:true`, and nothing
        // after them — the app's start never committed, so its release was never sent.
        let neverCommitted = NavilitePressRules.releaseTake(readingSongId: "b", appSongId: "b",
                                                            appSounding: false, queueSongId: "b",
                                                            appMs: 3588, queueMs: 3588)
        check("the app's start has not reached the speakers — the release waits, it does not decide",
              waitAnswer(neverCommitted))
        check("the rung that settles answers where the release never would: the queue keeps the sound",
              keepsTheQueue(NavilitePressRules.unreleasedOffer(appSounding: false)))
        check("and if the app's own player IS sounding, the queue stops rather than playing under it",
              stopsTheQueue(NavilitePressRules.unreleasedOffer(appSounding: true)))

        print("\n# the owner's choice takes the sound; a press already answered moves nothing")

        /* THE CARD: play a song, leave until it ends, come back — the return attaches (return #1).
         * The next return sits on `loading`, and the owner leaves to the playlist and picks another
         * track: the app refuses it because the queue is sounding, so he is stuck with a song he
         * cannot change and gets two players once he forces it. Two rules answer that: a source the
         * sweep has already been asked to stop cannot refuse his tap (`startDecision`), and a
         * statement naming an entry the app's own player is sounding is his choice, not a jump to
         * correct (`statementChoice`). */

        func silencedBy(_ answer: NavilitePressRules.Start) -> [String]? {
            if case .start(let silenced) = answer { return silenced }
            return nil
        }
        func startRefusal(_ answer: NavilitePressRules.Start) -> String? {
            if case .refuse(let why) = answer { return why }
            return nil
        }

        let repeatRefusal = NavilitePressRules.refusalForRepeat(
            move: "next", lastMove: "next", lastAt: t0.addingTimeInterval(-1.0), now: t0,
            soundingNow: "18", leftByLastPress: "18", inFlightMove: "")
        let crossRefusal = NavilitePressRules.refusalForCrossMove(move: "previous", inFlightMove: "next")

        check("a selection over a sounding queue SILENCES it first and starts — no refusal",
              silencedBy(NavilitePressRules.startDecision(intent: .selection, answered: nil,
                                                          target: "slot-0", sounding: ["away"],
                                                          silenced: ["away"])) == ["away"])
        check("...and a second source the sweep silenced does not refuse it either",
              silencedBy(NavilitePressRules.startDecision(intent: .selection, answered: nil,
                                                          target: "slot-0",
                                                          sounding: ["away", "slot-1"],
                                                          silenced: ["away", "slot-1"]))
              == ["away", "slot-1"])
        check("a selection with nothing else sounding starts without silencing anything",
              silencedBy(NavilitePressRules.startDecision(intent: .selection, answered: nil,
                                                          target: "slot-0", sounding: ["slot-0"],
                                                          silenced: [])) == [])
        isRefusal("a selection is still refused by a source the sweep could not reach",
                  startRefusal(NavilitePressRules.startDecision(intent: .selection, answered: nil,
                                                               target: "slot-0", sounding: ["away", "slot-1"],
                                                               silenced: ["away"])),
                  expect: true)
        isRefusal("an automatic start over a queue that is still sounding is refused, as before",
                  startRefusal(NavilitePressRules.startDecision(intent: .automatic, answered: nil,
                                                               target: "slot-0", sounding: ["away"],
                                                               silenced: ["away"])),
                  expect: true)
        check("an automatic start with nothing else sounding starts and silences nothing",
              silencedBy(NavilitePressRules.startDecision(intent: .automatic, answered: nil,
                                                          target: "slot-0", sounding: ["slot-0"],
                                                          silenced: [])) == [])

        check("a redelivered press is refused even when it would otherwise be a selection",
              startRefusal(NavilitePressRules.startDecision(intent: .selection, answered: repeatRefusal,
                                                            target: "slot-0", sounding: ["away"],
                                                            silenced: ["away"])) == repeatRefusal)
        check("a press that crossed a boundary in flight is refused, and the refusal is the press's own",
              startRefusal(NavilitePressRules.startDecision(intent: .selection, answered: crossRefusal,
                                                            target: "slot-0", sounding: [],
                                                            silenced: [])) == crossRefusal)
        check("a refused repeat silences nothing — nothing moves",
              startRefusal(NavilitePressRules.startDecision(intent: .automatic, answered: repeatRefusal,
                                                            target: "slot-0", sounding: ["away"],
                                                            silenced: ["away"])) != nil
              && silencedBy(NavilitePressRules.startDecision(intent: .automatic, answered: repeatRefusal,
                                                             target: "slot-0", sounding: ["away"],
                                                             silenced: ["away"])) == nil)

        print("\n# a statement that names another entry is a choice or a jump — decided by the app's player")

        func isSelection(_ answer: NavilitePressRules.Statement) -> Bool {
            if case .selection = answer { return true }
            return false
        }
        func keepsQueue(_ answer: NavilitePressRules.Statement) -> Bool {
            if case .keepQueue = answer { return true }
            return false
        }

        check("the app's own player is sounding the entry it stated — the owner chose it, the queue is silenced",
              isSelection(NavilitePressRules.statementChoice(statedSongId: "b", audibleSongId: "b",
                                                             appSounding: true, queueSongId: "a")))
        check("nothing of the app's is sounding yet — the queue is the authority and the statement is corrected",
              keepsQueue(NavilitePressRules.statementChoice(statedSongId: "b", audibleSongId: "",
                                                            appSounding: false, queueSongId: "a")))
        check("a player that is not sounding the stated entry is not a selection",
              keepsQueue(NavilitePressRules.statementChoice(statedSongId: "b", audibleSongId: "b",
                                                            appSounding: false, queueSongId: "a")))
        check("the app stated the entry the queue is sounding — nothing to decide",
              keepsQueue(NavilitePressRules.statementChoice(statedSongId: "a", audibleSongId: "a",
                                                            appSounding: true, queueSongId: "a")))

        print("\n# a return with something sounding answers with a POSITION — never a pending start")

        func adoptAnswer(_ decision: NavilitePressRules.Return?) -> (songId: String, index: Int, positionMs: Int)? {
            if case .adopt(let songId, let index, let positionMs)? = decision { return (songId, index, positionMs) }
            return nil
        }
        func offerAnswer(_ decision: NavilitePressRules.Return?) -> (songId: String, index: Int, positionMs: Int)? {
            if case .offer(let songId, let index, let positionMs)? = decision { return (songId, index, positionMs) }
            return nil
        }

        let queueSounding = NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: "b",
                                                              soundingIndex: 1, positionMs: 3588)
        check("the queue is sounding: the return yields the entry at the queue's own position",
              offerAnswer(queueSounding)?.songId == "b" && offerAnswer(queueSounding)?.index == 1
              && offerAnswer(queueSounding)?.positionMs == 3588)
        check("...and `loading` is not among the answers a return can give",
              offerAnswer(queueSounding) != nil || adoptAnswer(queueSounding) != nil || stopped(queueSounding))
        let appSounding = NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: "b",
                                                            soundingIndex: 1, positionMs: 3588,
                                                            appSoundingSongId: "b", appPositionMs: 3600)
        check("the app's own player is already sounding it: the return ADOPTS it at the app's position",
              adoptAnswer(appSounding)?.songId == "b" && adoptAnswer(appSounding)?.positionMs == 3600)
        check("...and the adoption is not an offer, so no start is waited on",
              offerAnswer(appSounding) == nil)
        /*
         * **THE CARD (F1): a start that has just begun does not beat a queue four minutes in.**
         *
         * The app's own player is sounding the queue's entry at 0:00 (its start this return issued,
         * or one that never got further) while the queue is at 240 s. "Sounding" alone used to be
         * the whole gate: the return answered `adopt` at 0:00 and `stopAwayQueue` followed, so the
         * listener's 4:00 became 0:00 and nothing could take it back. A take already refuses exactly
         * this (`releaseTake` → `.seekThenTake`), and the return now asks the same question.
         */
        let justStarted = NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: "b",
                                                            soundingIndex: 1, positionMs: 240_000,
                                                            appSoundingSongId: "b", appPositionMs: 0)
        check("(F1) a player sounding it at 0:00 against a queue at 240 s is NOT an adoption",
              adoptAnswer(justStarted) == nil)
        check("(F1) ...it is an offer, which is the seek route: the app starts it at the queue's 240 s",
              offerAnswer(justStarted)?.positionMs == 240_000
              && offerAnswer(justStarted)?.songId == "b" && offerAnswer(justStarted)?.index == 1)
        check("(F1) ...and the queue is not stopped by the return — the offer keeps it sounding",
              !stopped(justStarted))
        let barelyDrifted = NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: "b",
                                                              soundingIndex: 1, positionMs: 240_000,
                                                              appSoundingSongId: "b",
                                                              appPositionMs: 240_000
                                                                - NavilitePressRules.maxDriftMs)
        check("(F1) the bound is the take's own: at exactly maxDriftMs the adoption still holds",
              adoptAnswer(barelyDrifted)?.positionMs == 240_000 - NavilitePressRules.maxDriftMs)
        let unreadable = NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: "b",
                                                           soundingIndex: 1, positionMs: 240_000,
                                                           appSoundingSongId: "b", appPositionMs: nil)
        check("(F1) an entry with no readable position is not proof of where it is — offer, not adopt",
              adoptAnswer(unreadable) == nil && offerAnswer(unreadable)?.positionMs == 240_000)
        let elsewhere = NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: "b",
                                                         soundingIndex: 1, positionMs: 240_000,
                                                         appSoundingSongId: "c", appPositionMs: 5_000)
        check("(F1) a player sounding a DIFFERENT entry is still an adoption — one owner, the app's",
              adoptAnswer(elsewhere)?.songId == "c" && adoptAnswer(elsewhere)?.positionMs == 5_000)
        /*
         * **The adoption of another entry carries no index of the queue's (unreleased).**
         *
         * `soundingIndex` is the queue's entry index and belongs to a different entry here, so
         * handing it back published a number that named another track: `NaviliteRemote` takes it as
         * `publishedIndex`'s fallback, so this side's own `index` pointed at a stranger's entry until
         * `adoptNativeAdvance` corrected it, and the `return-adopted` line carried that number. The
         * index is withheld (`-1` — the same last-resort the published lookup answers), not borrowed.
         * Nothing is mis-started either way: the web layer guards on the `songId`.
         */
        check("(2) an adoption of ANOTHER entry publishes no index of the queue's — -1, not entry 1",
              adoptAnswer(elsewhere)?.index == -1, "answered index \(String(describing: adoptAnswer(elsewhere)?.index))")
        check("(2) ...so the foreign index cannot become the app's own cursor for that entry",
              adoptAnswer(elsewhere)?.index != 1)
        check("(2) the adoption of the QUEUE's own entry still carries the index it was asked for",
              adoptAnswer(appSounding)?.index == 1, "answered index \(String(describing: adoptAnswer(appSounding)?.index))")
        check("nothing sounding and nothing of the app's: no reading to give, nothing to wait for",
              NavilitePressRules.returnDecision(queueOwnsSound: false, soundingSongId: nil,
                                                soundingIndex: -1, positionMs: 0) == nil)
        check("a queue that holds the sound and cannot be named is stopped, never offered empty",
              stopped(NavilitePressRules.returnDecision(queueOwnsSound: true, soundingSongId: nil,
                                                        soundingIndex: -1, positionMs: 3588,
                                                        appSoundingSongId: "")))

        print("\n# a refusal that names the sound is an ANSWER — display it, ask nothing more")

        func displayOf(_ answer: NavilitePressRules.Reading)
            -> (songId: String, index: Int, positionMs: Int, why: String)? {
            if case .display(let songId, let index, let positionMs, let why) = answer {
                return (songId, index, positionMs, why)
            }
            return nil
        }
        func unnamed(_ answer: NavilitePressRules.Reading) -> Bool {
            if case .unnamed = answer { return true }
            return false
        }

        let refused = NavilitePressRules.refusedReading(soundingSongId: "0DHk", soundingIndex: 7,
                                                        positionMs: 17769, statedSongId: "0DHk",
                                                        statedIndex: 7)
        check("(a) a refusal naming the entry and the position yields a display, not a retry",
              displayOf(refused)?.songId == "0DHk" && displayOf(refused)?.index == 7
              && displayOf(refused)?.positionMs == 17769,
              "answered \(String(describing: displayOf(refused)))")
        check("(a) ...and the answer says the app asks nothing further",
              displayOf(refused)?.why.contains("asks nothing further") == true)
        check("(a) a refusal that names nothing renders nothing — it does not invent an entry",
              unnamed(NavilitePressRules.refusedReading(soundingSongId: nil, soundingIndex: -1,
                                                        positionMs: 0, statedSongId: "0jGX",
                                                        statedIndex: 5)))
        check("(a) an empty entry is not a name either",
              unnamed(NavilitePressRules.refusedReading(soundingSongId: "", soundingIndex: 7,
                                                        positionMs: 17769, statedSongId: "0jGX",
                                                        statedIndex: 5)))

        let stale = NavilitePressRules.refusedReading(soundingSongId: "0DHk", soundingIndex: 7,
                                                       positionMs: 30511, statedSongId: "0jGX",
                                                       statedIndex: 5)
        check("(c) a stale statement is overwritten by the reading — entry, index and position are the reading's",
              displayOf(stale)?.songId == "0DHk" && displayOf(stale)?.index == 7
              && displayOf(stale)?.positionMs == 30511)
        check("(c) ...and the line names the statement it overwrote",
              displayOf(stale)?.why.contains("0jGX") == true
              && displayOf(stale)?.why.contains("index 5") == true)

        print("\n# the answer's index is the PUBLISHED index, never AVPlayer's window (unreleased)")

        /*
         * The owner's log, as a state: the queue is on entry 8 of 269 (`index:7`) and answered it as
         * `index 0`. `nameQueue`'s cursor is the item's position inside `queuePlayer.items()` — the
         * attached window, 0..2 — so it can never be the index the app publishes, adopts by, or
         * compares a statement against. The published order is 269 entries and the sounding entry is
         * nowhere near the first window.
         */
        let publishedOrder: [String] = (0..<269).map { $0 == 7 ? "0DHkU6MZyX8NSQjaQTlhi5" : "entry-\($0)" }
        let publishedAt = NavilitePressRules.publishedIndex(order: publishedOrder, songId: "0DHkU6MZyX8NSQjaQTlhi5",
                                                           fallback: 0)
        check("(d) an entry outside the attached window answers its PUBLISHED index, not the window cursor",
              publishedAt == 7, "answered \(publishedAt)")
        check("(d) ...so the refusal names entry 8 of 269 as index 7 — the same entry, the same index",
              displayOf(NavilitePressRules.refusedReading(soundingSongId: "0DHkU6MZyX8NSQjaQTlhi5",
                                                          soundingIndex: publishedAt,
                                                          positionMs: 5974, statedSongId: "0jGX",
                                                          statedIndex: 5))?.index == 7,
              "answered \(String(describing: displayOf(NavilitePressRules.refusedReading(soundingSongId: "0DHkU6MZyX8NSQjaQTlhi5", soundingIndex: publishedAt, positionMs: 5974, statedSongId: "0jGX", statedIndex: 5))))")
        check("(d) an entry the published order cannot name keeps the caller's last-resort index",
              NavilitePressRules.publishedIndex(order: publishedOrder, songId: "not-in-the-order", fallback: 2) == 2)
        check("(d) an empty or missing entry is the fallback too — never a 0 by accident",
              NavilitePressRules.publishedIndex(order: publishedOrder, songId: "", fallback: -1) == -1
              && NavilitePressRules.publishedIndex(order: publishedOrder, songId: nil, fallback: -1) == -1)
        check("(d) an empty published order answers the fallback",
              NavilitePressRules.publishedIndex(order: [], songId: "0DHk", fallback: -1) == -1)

        check("(b) the same reading answered twice does not produce a second request",
              NavilitePressRules.answeredOffer(offeredSongId: "0DHk", offeredIndex: 7,
                                               answeredSongId: "0DHk", answeredIndex: 7) != nil)
        check("(b) a later offer of the same entry is the same question (the position moved, the entry did not)",
              NavilitePressRules.answeredOffer(offeredSongId: "0DHk", offeredIndex: 7,
                                               answeredSongId: "0DHk", answeredIndex: 7) != nil)
        check("(b) the queue advancing to another entry IS a new question",
              NavilitePressRules.answeredOffer(offeredSongId: "next", offeredIndex: 8,
                                               answeredSongId: "0DHk", answeredIndex: 7) == nil)
        check("(b) nothing answered yet: every offer is a new question",
              NavilitePressRules.answeredOffer(offeredSongId: "0DHk", offeredIndex: 7,
                                               answeredSongId: "", answeredIndex: -1) == nil)
        /*
         * **The answer's identity is the ENTRY, not the index (unreleased).**
         *
         * `answeredOffer` compared `(songId, index)` and the owner's log is still four offers of one
         * entry, three seconds apart, with `queue-handover-answered` nowhere in it. The index is the
         * number that drifts: `handOverAwayQueue` records the offer's `soundingIndex` over `queue` as
         * it stands at the offer, and the guard re-derives `soundingIndex` over `queue` again — but the
         * statement that asks a second time has already replaced `queue` from the web layer's own
         * published list (`NaviliteRemote.swift` — `self.queue = entries…`, at the top of the
         * statement, before the guard is reached). Two lookups over two arrays, and the app's order is
         * provably not index-compatible with this side's: the same log's `queue-handover-jump` puts
         * `0jGX…` at index 5 where the queue has `0DHk…` at 7. So the pair is only equal when the two
         * snapshots happen to agree, and the equality the guard demanded was never an invariant. A
         * request is one entry asked about; a statement that names that entry again is that same
         * request, whatever index it carries.
         */
        check("(b) the same entry stated with a DIFFERENT index is the same request — the index is not the identity",
              NavilitePressRules.answeredOffer(offeredSongId: "0DHk", offeredIndex: 7,
                                               answeredSongId: "0DHk", answeredIndex: 5) != nil)
        check("(b) ...in either direction, because the statement is what re-bases the index",
              NavilitePressRules.answeredOffer(offeredSongId: "0DHk", offeredIndex: 5,
                                               answeredSongId: "0DHk", answeredIndex: 7) != nil)
        check("(b) ...including the last-resort -1 an entry the published order cannot name",
              NavilitePressRules.answeredOffer(offeredSongId: "0DHk", offeredIndex: -1,
                                               answeredSongId: "0DHk", answeredIndex: 7) != nil)
        check("(b) a DIFFERENT entry at the SAME index is still a new question — the queue advanced",
              NavilitePressRules.answeredOffer(offeredSongId: "next", offeredIndex: 7,
                                               answeredSongId: "0DHk", answeredIndex: 7) == nil)

        print("\n# an answer is about one ask — a recurring entry is asked again (unreleased)")

        /*
         * **The walk from the review: X refused, the queue advances to Y, the queue comes back to X.**
         *
         * `answeredOffer` was cleared on abandon and on a fresh `handover()`, never on a *different*
         * entry being offered. So the answer about X outlived its ask: Y was offered with the answer
         * about X still standing, and when repeat-all (or the same song twice in the queue) brought X
         * back, X's statement was swallowed as `queue-handover-answered` — no offer, so no deadline —
         * while the queue was audibly playing X and the row held Y's reading. Driven here as the
         * state the remote keeps: the answer after each ask is `answerAfter`, and the question a
         * statement asks is `answeredOffer`.
         */
        var standing: (songId: String, index: Int)? = ("X", 7)          // X was refused
        let afterX = NavilitePressRules.answeredOffer(offeredSongId: "X", offeredIndex: 3,
                                                      answeredSongId: standing?.songId ?? "",
                                                      answeredIndex: standing?.index ?? -1)
        check("(1) the statement in reply to X's refusal is the same request — it does not re-ask",
              afterX != nil)
        standing = NavilitePressRules.answerAfter(offering: "Y",
                                                  answeredSongId: standing?.songId,
                                                  answeredIndex: standing?.index ?? -1)
        check("(1) offering a DIFFERENT entry expires the answer — X was not what was asked", standing == nil,
              "the answer that stood was \(String(describing: standing?.songId))")
        let backToX = NavilitePressRules.answeredOffer(offeredSongId: "X", offeredIndex: 3,
                                                       answeredSongId: standing?.songId ?? "",
                                                       answeredIndex: standing?.index ?? -1)
        check("(1) ...so the queue coming back to X is a NEW question, not `queue-handover-answered`",
              backToX == nil)
        check("(1) ...which is the offer path: an offer for X is made and `armOfferDeadline` runs with it",
              backToX == nil && NavilitePressRules.answerAfter(offering: "X",
                                                               answeredSongId: standing?.songId,
                                                               answeredIndex: standing?.index ?? -1) == nil)
        check("(1) the answer that IS about the entry asked about still stands — the index is re-based, the ask is not",
              NavilitePressRules.answerAfter(offering: "X", answeredSongId: "X", answeredIndex: 5)?.songId == "X"
              && NavilitePressRules.answerAfter(offering: "X", answeredSongId: "X", answeredIndex: 5)?.index == 5)
        check("(1) an answer that names no entry stands for nothing — never a blanket swallow",
              NavilitePressRules.answerAfter(offering: "X", answeredSongId: nil, answeredIndex: -1) == nil
              && NavilitePressRules.answerAfter(offering: "X", answeredSongId: "", answeredIndex: 7) == nil)
        check("(1) ...and it expires for the second occurrence of one song in the same queue too",
              NavilitePressRules.answerAfter(offering: "Y", answeredSongId: "X", answeredIndex: 7) == nil)

        print("\n# a statement is not a reading — an armed queue must not move the index (beta.25)")

        /*
         * **The owner's first-song report.** The away queue is armed while the app is on screen: it
         * holds the entry *after* the one playing, paused. A statement that arrives while the queue
         * is merely armed must be taken at the app's own index; reading the queue's `currentItem`
         * there moved the card and the next boundary onto the following track, so song 2 was never
         * played.
         */
        check("(1) an armed, silent queue does NOT move the statement — the app's index stands",
              NavilitePressRules.statementIndex(stated: 0, queueSounding: false, soundingIndex: 1) == 0)
        check("(1) ...even when the queue's own currentItem names the next entry",
              NavilitePressRules.statementIndex(stated: 4, queueSounding: false, soundingIndex: 5) == 4)
        check("(1) a queue that IS sounding corrects a statement that lags the boundary it took",
              NavilitePressRules.statementIndex(stated: 0, queueSounding: true, soundingIndex: 1) == 1)
        check("(1) a sounding queue that cannot name its entry changes nothing",
              NavilitePressRules.statementIndex(stated: 3, queueSounding: true, soundingIndex: nil) == 3)
        check("(1) ...and neither does a nonsense index",
              NavilitePressRules.statementIndex(stated: 3, queueSounding: true, soundingIndex: -1) == 3)

        print("\n\(passed) passed, \(failed) failed")
        exit(failed == 0 ? 0 : 1)
    }
}
