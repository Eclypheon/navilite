import Foundation

/**
 * **The four decisions the press path must not take from a flag (v2.0.0-beta.30).**
 *
 * Every fix in this release is the same mistake in a different place: a *description* of the
 * players (a cursor, a flag, a reading's own index) standing where the player's own report belongs,
 * and a fallback that passes when the report is missing. `NaviliteRemote.swift` is where the players
 * are read; this file is the small pure part of that — the part that can be **executed** on its own,
 * so the branches are proved by a test that drives them rather than by a grep of the source.
 *
 * Nothing here touches AVFoundation, Capacitor or UIKit: it takes the facts the remote has already
 * read and answers one question each, which is exactly what makes it testable
 * (`scripts/press-rules-test.sh`).
 */
enum NavilitePressRules {

    /* --------------------------------------------------------------- one press, one decision */

    /// How long after a press that moved the sound a repeat of the same `move` is still that press
    /// delivered again.
    ///
    /// Stated, not implied: a card's button and the lock screen's own command are two doors into one
    /// `takeTransport`, and the system may deliver both for one tap. The owner's
    /// newest log repeats a press 1.0 s apart at its fastest (`05:20:57 next` → entry 18,
    /// `05:20:58 next` → entry 19), so this covers it. A slower arrival is **not** claimed to be a
    /// repeat: this side genuinely cannot tell one from a deliberate second press.
    static let repeatWindow: TimeInterval = 1.5

    /// Why this press is a repeat of the previous one, or `nil` when it is a press of its own.
    ///
    /// Three facts, and the third is the one that keeps a real second press working:
    ///
    ///  - **the same move** — a press that corrects a press is the user talking, and the seam's own
    ///    rules (one sounding source, a take only over the entry it names) decide it;
    ///  - **and either the boundary the earlier press started is still in flight**, or it arrived
    ///    inside `window`;
    ///  - **and the sound has not moved since** — the player is still on the entry that press left
    ///    sounding. That is what makes this a *repeat* rather than a second decision: if the sound
    ///    moved, the earlier press has been answered and this one is the next thing the listener
    ///    asked for, however soon it came.
    ///
    /// `leftByLastPress` is stamped only by a press that actually started or stopped something, so a
    /// press the queue refused can be pressed again at once.
    static func refusalForRepeat(move: String, lastMove: String, lastAt: Date, now: Date,
                                 soundingNow: String, leftByLastPress: String,
                                 inFlightMove: String, window: TimeInterval = repeatWindow) -> String? {
        guard !lastMove.isEmpty, lastMove == move else { return nil }
        if inFlightMove == move {
            return "a repeat of the same \(move) arrived while the boundary the first one started is still in flight, so it is refused before anything is resolved — one press, one decision"
        }
        let age = now.timeIntervalSince(lastAt)
        guard age >= 0, age < window else { return nil }
        guard !soundingNow.isEmpty, soundingNow == leftByLastPress else { return nil }
        return "the same \(move) was answered \(Int((age * 1000).rounded())) ms ago and the player is still on \(soundingNow), where that press left it, so this is that press delivered again and nothing was issued"
    }

    /// **One button press, and when this side answered it (v2.0.0-beta.30).**
    ///
    /// The id is minted **where the button is**: the live activity's content state carries it and the
    /// intent instance carries it into `perform()` — so a redelivery of that button arrives with the
    /// same identity, and a card that is re-drawn arrives with a new one.
    struct PressIdentity: Equatable {
        let id: Int
        let at: Date
    }

    /// Why a command carrying an id this side has **already answered** is refused, or `nil`.
    ///
    /// One identity, one decision, **whatever the move**. The delivered-twice press used to be told
    /// apart by (same move, inside the window, sound unmoved), which cannot see a delivery that named
    /// `previous` after the first named `next` — and that pair rebuilt the queue and tore down the
    /// boundary the real press owned. The id is what the two deliveries share, so it is what refuses
    /// the second one.
    ///
    /// **There is no time bound and no card condition: an answered id is answered for good.**
    /// A time bound did the opposite — it turned the owner's 5.6 s redelivery into a new decision,
    /// ran `awayNext`, moved the label and started a second player: one tap, two tracks, with the
    /// 12 s fetch removed. A card condition (the arrival's id against an epoch read at arrival)
    /// failed for the same reason in a subtler way: a press that moves the label **is** a card
    /// write, so the press rotates the epoch itself and its own redelivery, carrying the id it was
    /// built with, arrives against a card whose epoch has already moved on — the gate switched
    /// itself off exactly when it was needed. An epoch that only ever increments means ids are
    /// never reused: an arrival whose id is already in `answered` can only be that button delivered
    /// again, at any age, after any number of re-draws. A genuine second press on the re-drawn card
    /// carries the new id and is a press of its own.
    ///
    /// A command whose id was minted elsewhere (the lock screen's own commands, which carry a
    /// per-event id and never land in `answered` for a real press — `MPRemoteCommandCenter` does not
    /// redeliver) is never refused here: the move rules decide it.
    static func refusalForAnsweredPress(id: Int, answered: [PressIdentity]) -> String? {
        guard answered.contains(where: { $0.id == id }) else { return nil }
        return "press-already-answered: press #\(id) was answered already, so this is that button delivered again and nothing is issued"
    }

    /// Why a move that is **not** the one the boundary in flight belongs to is refused, or `nil`.
    ///
    /// `refusalForRepeat` requires the same move, so a `previous` arriving while a `next` boundary was
    /// in flight was caught by nothing: it ran `stopAwayQueue`, rebuilt the queue and started again,
    /// which called `beginBoundary`/`closeBoundary` and cancelled the boundary the real press left
    /// open — the listener's one press answered by a backwards track they did not ask for. It is
    /// refused **by name** rather than recorded as an intent, because the boundary's own move is the
    /// decision in progress and this command must neither close that boundary nor rebuild the queue.
    /// A boundary with no press's name on it (`inFlightMove` empty) is automatic, and a command may
    /// answer it.
    static func refusalForCrossMove(move: String, inFlightMove: String) -> String? {
        guard !inFlightMove.isEmpty, inFlightMove != move else { return nil }
        return "press-cross-move: a \(move) arrived while the boundary a \(inFlightMove) press owns is still in flight, so it is refused by name and that boundary is left to the press that started it — nothing is stopped, nothing is rebuilt and the label does not move"
    }

    /// How long after a toggle the same move is a redelivery, in seconds.
    ///
    /// A toggle is the one move whose press **changes** the audio state, so "the sound has not moved
    /// since" cannot identify its repeat: a repeat of a toggle is precisely the thing that moves it.
    /// For this move the window alone decides, and it is the same stated window.
    static let toggleWindow: TimeInterval = repeatWindow

    /// Why this `playPause` is the previous one delivered again, or `nil` when it is a press of its
    /// own. The owner's newest segment has five toggles in 34 s — two of them one second apart.
    static func refusalForRepeatedToggle(lastAt: Date?, now: Date,
                                         window: TimeInterval = toggleWindow) -> String? {
        guard let lastAt else { return nil }
        let age = now.timeIntervalSince(lastAt)
        guard age >= 0, age < window else { return nil }
        return "a playPause was answered \(Int((age * 1000).rounded())) ms ago, inside the \(Int((window * 1000).rounded())) ms window, so this is that press delivered again and the audio state is not toggled a second time"
    }

    /// How far the app's own player may be from the queue before a take is refused, in ms.
    ///
    /// The take hands the sound from a player that is making it to one that is already making it at
    /// the same place, so the two positions have to *be* the same place. The owner's log takes one at
    /// `appPositionMs:2000` against `queuePositionMs:2886` — `driftMs:886` — which is not a handover,
    /// it is a second player starting late. The refusal makes the app seek and ask again, bounded by
    /// `handoverMaxRefusals`.
    static let maxDriftMs = 250

    /// Why a take at this drift is refused, or `nil` when the two players really are at one position.
    static func driftRefusal(driftMs: Int, maxDrift: Int = maxDriftMs) -> String? {
        let drift = abs(driftMs)
        guard drift > maxDrift else { return nil }
        return "the app's own player is \(drift) ms from the queue, beyond the \(maxDrift) ms a take allows, so the queue keeps the sound and the app moves its player there"
    }

    /// **The drift gate, including the case where it used to fail open (v2.0.0-beta.30).**
    ///
    /// `handoverRefusals < handoverMaxRefusals` used to be the guard *on the refusal itself*, so on the
    /// third ask the block was skipped, nothing refused the take, and it went ahead at any drift — the
    /// 886 ms and the 2886 ms the bound exists to refuse. The count says how many times the app is
    /// told to seek and ask again; when it is spent, **the answer is a refusal, not a permission**. A
    /// refusal that leaves the queue sounding is the correct outcome; a take that rewinds 2.9 s is not.
    /// `exhausted` says the bound was reached, so the caller says so on the log and stops counting.
    static func handoverDriftRefusal(driftMs: Int, refusals: Int,
                                     maxRefusals: Int) -> (why: String, exhausted: Bool)? {
        guard let why = driftRefusal(driftMs: driftMs) else { return nil }
        guard refusals >= maxRefusals else { return (why, false) }
        return (why + " — and the app has been refused \(refusals) times already (\(maxRefusals) allowed), so the bound is spent and the queue keeps the sound rather than taking this handover", true)
    }

    /* ---------------------------------------------------- the take is proved, never assumed */

    /// The position a handover may be taken at — and `nil` unless the take is **proved**.
    ///
    /// The old guard failed open: `queueSoundingEntry()?.songId ?? ""` then
    /// `guard soundingSongId.isEmpty || soundingSongId == reading.songId`. An item the side could not
    /// map answered `""`, the empty string passed the guard, and the start went ahead with the queue
    /// deliberately left sounding (`keepQueue: true`) and paused four lines later — two players, two
    /// tracks, for as long as the plugin took to start.
    ///
    /// So: the queue's own `currentItem` must map to the entry being started, **strictly**, and the
    /// reading must name that same entry. Missing, unmappable and different are all refusals, and a
    /// queue at 0 has no position to adopt.
    static func handoverTake(soundingSongId: String?, entrySongId: String, readingSongId: String?,
                             liveMs: Int) -> Int? {
        guard let soundingSongId, !soundingSongId.isEmpty,
              let readingSongId, !readingSongId.isEmpty else { return nil }
        guard soundingSongId == entrySongId, readingSongId == entrySongId else { return nil }
        return liveMs > 0 ? liveMs : nil
    }

    /* ------------------------------- the release: the take is the players' own answer (beta.31) */

    /// **What a release must do, decided from the two players (v2.0.0-beta.31).**
    ///
    /// The return was leaving two players sounding on build 83, and the reason was this decision:
    /// the app's own start on the way back does not pass through `playSlot` — it is the audio
    /// plugin's `play(assetId:time:)`, issued by the web layer — so the *release* is the only place
    /// the queue can learn that the sound has changed hands, and the release was refusing whenever
    /// the app stated no position (`appPositionMs:-1` → "no position reported", the queue keeps
    /// sounding) while nothing ever asked again. One song from the app, one from the queue, and the
    /// queue is the one no control reaches — the owner's report exactly.
    ///
    /// So the release no longer refuses for want of a number: the app's own player is **read**
    /// (`AudibleBridgePlayer.find`, the plugin's own `currentlyPlayingAssetId`) and its live
    /// position is what the take is proved on. Four answers, and none of them leaves two owners:
    ///
    ///  - `.take` — the app's player is the reading's entry, sounding, within `maxDriftMs`: take;
    ///  - `.seekThenTake` — same entry and sounding, but at another position: the app's player is
    ///    **moved** to the queue's live position and the queue stops in the same turn. Refusing here
    ///    is what left the double standing, and a refusal that keeps two sounds up is worse than a
    ///    seek of the one that survives;
    ///  - `.wait` — the app's player is not sounding yet (its start is still crossing to the
    ///    speakers): ask again in a moment, bounded — a 200 ms wait is better than a second song;
    ///  - `.abandon` — the app is sounding a **different** entry: the queue stops rather than
    ///    playing under it (one owner, and the reader hears the app's decision either way);
    ///  - `.refuse` — nothing here can prove the app is playing the queue's entry: the queue keeps
    ///    the sound, which is still exactly one owner.
    enum Release: Equatable {
        case take(appMs: Int, driftMs: Int)
        case seekThenTake(appMs: Int, driftMs: Int)
        case wait(String)
        case abandon(String)
        case refuse(String)
    }

    /// The release decision (v2.0.0-beta.31) — see `Release`. `appSongId` is the entry the app says
    /// it started (empty when it said nothing), `appMs` its own player's live position (`nil` when
    /// the player could not be read), `queueSongId` the queue's own `currentItem` mapped to an
    /// attached entry (`nil` when it cannot be mapped).
    static func releaseTake(readingSongId: String, appSongId: String, appSounding: Bool,
                            queueSongId: String?, appMs: Int?, queueMs: Int,
                            maxDrift: Int = maxDriftMs) -> Release {
        guard !readingSongId.isEmpty else {
            return .refuse("the reading names no entry, so there is nothing to hand over")
        }
        guard let queueSongId, !queueSongId.isEmpty else {
            return .refuse("the queue's own item is not an entry this side attached, so nothing here can prove the app is playing the same track and the queue keeps the sound")
        }
        guard queueSongId == readingSongId else {
            return .refuse("the queue is sounding \(queueSongId) while the reading names \(readingSongId), so the reading is the stale one and the queue keeps the sound")
        }
        guard !appSongId.isEmpty else {
            return .wait("the app has not named the entry its own player is starting, so there is nothing yet to prove the take against")
        }
        guard appSongId == readingSongId else {
            return .abandon("the app's own player is on \(appSongId) while the queue sounds \(readingSongId) — the app took the sound somewhere else, so the queue stops rather than sounding under it")
        }
        guard appSounding else {
            return .wait("the app's own player is on \(readingSongId) but is not sounding yet, so the queue keeps the sound until it is")
        }
        guard let appMs, appMs >= 0 else {
            return .wait("the app's own player named \(readingSongId) but no position could be read from it, so the take is not proved yet")
        }
        let drift = queueMs - appMs
        if abs(drift) <= maxDrift { return .take(appMs: appMs, driftMs: drift) }
        return .seekThenTake(appMs: appMs, driftMs: drift)
    }

    /* --------------------------------------------- the reading names the sound, not the statement */

    /// The index a reading must carry: the entry the queue is **sounding**, looked up in the published
    /// order — never the app's own statement (`index`), which is the number that drifts.
    ///
    /// `queue-handover-jump` (the app stated 5 while the queue was sounding 25) is this number taken
    /// from the wrong place: the app adopts by index, so the reading sent it to a track nothing was
    /// playing. A songId this side cannot find in the order answers the statement's index, which is
    /// the one case where no better answer exists — and `handoverTake` above still refuses the take.
    static func readingIndex(soundingSongId: String, order: [String], statementIndex: Int) -> Int {
        if let at = order.firstIndex(of: soundingSongId) { return at }
        return statementIndex
    }

    /// The entry an attached item is, by the **item's identity** — the queue object is the whole
    /// precondition, and no flag is consulted.
    ///
    /// `queueSoundingEntry()` used to start `guard awayOwnsAudible`: when the flag had drifted false
    /// while the queue was playing, every reading returned nil and fell back to `audible?.songId` —
    /// the same two-sources-of-truth lie, one layer down. The reading is the fact; the flag is
    /// corrected from it by the caller.
    static func attachedEntry(itemIndex: Int?, attached: [String]) -> (songId: String, cursor: Int)? {
        guard let itemIndex, itemIndex >= 0, itemIndex < attached.count else { return nil }
        return (attached[itemIndex], itemIndex)
    }

    /* -------------------------------------------- one owner: refuse the start, do not describe it */

    /// What the sweep found, and whether the start it was sweeping for may be issued at all.
    enum Sweep: Equatable {
        /// Nothing that is not the entry being started is sounding.
        case clear
        /// A source is still sounding that is not the entry being started: **the start is refused**
        /// and that source keeps the sound.
        case refused(String)

        var refusal: String? {
            if case .refused(let why) = self { return why }
            return nil
        }
    }

    /// May a start be issued while `queueSounding` is true?
    ///
    /// This is the rule `silenceOthers` used to *write down* after the fact (`one-owner-violated`) and
    /// let the caller play anyway, and that `spendHandover` named after the overlap had begun
    /// (`queue-still-sounding`). The queue is the one source that cannot be stopped in the turn a
    /// start is issued — `pause()` is a request, the sound is already on the wire — so a queue still
    /// sounding after the sweep is a refusal, not a note.
    ///
    /// One exception, and it is proved rather than declared: `keepQueueSongId` is the entry a take is
    /// starting, and the queue's own item must **be** that entry. Passing any other id, or none, is a
    /// refusal — so `keepQueue` can no longer be reached without the identity being proved.
    static func queueSweep(queueSounding: Bool, queueSongId: String?, target: String?, awaySlot: String,
                           keepQueueSongId: String?, action: String) -> Sweep {
        guard queueSounding, target != awaySlot else { return .clear }
        if let keepQueueSongId, let queueSongId, queueSongId == keepQueueSongId { return .clear }
        let on = queueSongId ?? "an item this side did not attach"
        return .refused("the away queue is sounding \(on) and \(action) is a start of something else, so the start is refused and the queue keeps the sound")
    }

    /// The same question for the plugin's own assets, read **after** they were paused: a slot the
    /// plugin still reports playing is a source the start would overlap, so the start is refused.
    static func survivors(_ slots: [String], target: String?, awaySlot: String) -> Sweep {
        let left = slots.filter { $0 != target && $0 != awaySlot }
        guard !left.isEmpty else { return .clear }
        return .refused("\(left.joined(separator: ",")) is still sounding after the sweep, so the start that follows it would be a second player at this instant and is refused")
    }
}
