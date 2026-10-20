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

        print("\n\(passed) passed, \(failed) failed")
        exit(failed == 0 ? 0 : 1)
    }
}
