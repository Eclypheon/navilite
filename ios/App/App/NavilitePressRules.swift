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

    /* ------------------------------------- which entry the away queue is on (v2.0.0-beta.19) */

    /// One item the away queue holds, as the two facts that can name it.
    ///
    /// `attachedSongId` is what this side's bookkeeping says the item was attached for, found by
    /// **object identity** in the attached-items array; `url` is what the item's own asset was built
    /// from. Either can be missing, and each covers the other's failure: the identity lookup dies the
    /// moment the item array and the entry array stop describing the same list, and the url is the
    /// fact the player itself keeps stating after that.
    struct QueueItem: Equatable {
        var attachedSongId: String?
        var url: String
    }

    /// One entry of the published order, for naming an item whose identity was lost, by its url.
    struct PublishedEntry: Equatable {
        var songId: String
        var url: String
    }

    /// The player's own item list, named.
    struct QueueNaming: Equatable {
        /// One name per item the player holds, in the player's own order; `nil` where nothing this
        /// side knows names it.
        var names: [String?]
        /// Where the player's `currentItem` sits in `names`, or -1 when it holds none.
        var cursor: Int
        /// Every item the player holds is named, so the bookkeeping can be re-derived from the player.
        var complete: Bool { !names.isEmpty && names.allSatisfy { $0 != nil } }
        /// The entry the queue is on, when it can be named.
        var sounding: (songId: String, cursor: Int)? {
            guard cursor >= 0, cursor < names.count, let songId = names[cursor] else { return nil }
            return (songId, cursor)
        }
    }

    /// **Name the queue's own items (v2.0.0-beta.19).**
    ///
    /// The identity lookup that used to be the only way to name the sounding entry
    /// (`awayItems.firstIndex { $0 === item }`) answers nothing the moment the item array and the
    /// entry array stop describing one list — a rebuild that cleared one and not the other, a prune
    /// that took an item out twice, a top-up appended to the names and not to the items. Every return
    /// then logged `queue-handover-unmapped` and offered **no reading at all**, and the app started
    /// its own player over a queue that was still sounding (the owner's 15:20:21 → 15:26:12 burst:
    /// thirty lines, one per return, none of them a reading).
    ///
    /// The player still states the fact: its item's asset carries the url it was built from. So each
    /// item is named by identity first, then by its url against the published order — consumed once
    /// each, in the player's own order, so a url the order legitimately holds twice (repeat all) is
    /// not handed to both.
    static func nameQueue(items: [QueueItem], currentAt: Int?, published: [PublishedEntry]) -> QueueNaming {
        var claimed: [Int] = []
        var names: [String?] = []
        for item in items {
            if let attached = item.attachedSongId, !attached.isEmpty {
                names.append(attached)
                continue
            }
            var named: (songId: String, at: Int)?
            if !item.url.isEmpty {
                for (at, entry) in published.enumerated() where !claimed.contains(at) && entry.url == item.url {
                    named = (entry.songId, at)
                    break
                }
            }
            if let named {
                claimed.append(named.at)
                names.append(named.songId)
            } else {
                names.append(nil)
            }
        }
        let cursor = currentAt.map { $0 >= 0 && $0 < names.count ? $0 : -1 } ?? -1
        return QueueNaming(names: names, cursor: cursor)
    }

    /// **Where an entry sits in the published order — never where it sits in the player's window
    /// (unreleased).**
    ///
    /// `nameQueue`'s `cursor` is the index of `currentItem` **inside `queuePlayer.items()`**, and
    /// AVPlayer holds only the items it was handed around the current one: that number is 0..2 and
    /// never a queue index. The published order is what the app publishes, adopts by, and compares a
    /// statement against, so any index handed to the web layer has to be looked up in it. Both the
    /// adopt and the offer path already did this lookup; the refusal path copied the cursor instead
    /// and stated entry 8 of 269 as `index 0` (`handover-refused index:7` → `handover-displayed
    /// index:0`), which is the pair the app then adopts by.
    ///
    /// `fallback` is the last resort, kept only for an entry the order cannot name: the caller's own
    /// cursor or statement index, which is at least a number the caller already had.
    static func publishedIndex(order: [String], songId: String?, fallback: Int) -> Int {
        guard let songId, !songId.isEmpty, let at = order.firstIndex(of: songId) else { return fallback }
        return at
    }

    /// What a return does with the queue's reading (v2.0.0-beta.19).
    enum Return: Equatable {
        /// The queue's entry is named: offer it, at the position the queue is at.
        case offer(songId: String, index: Int, positionMs: Int)
        /// **The app's own player is already sounding an entry: adopt it, at its position**
        /// (unreleased). Nothing is started and nothing is waited for — the screen renders the sound
        /// that exists. This is the answer the return had no case for: with the app's own player
        /// sounding, the return built an offer, the offer could be refused or settle as "unreleased",
        /// and the row sat on `loading` over a song that was audible the whole time.
        case adopt(songId: String, index: Int, positionMs: Int)
        /// The queue holds the sound and nothing here can name it: **stop the queue**. Never "offer
        /// nothing, and let the app start a second player over it".
        case stop(String)
    }

    /// **A return ends in a reading or in a decision — never in neither (v2.0.0-beta.19).**
    ///
    /// `nil` is the one case with nothing to decide: the queue is not a sound of this side's, so
    /// `releaseHandover` writes the "nothing was offered" line instead.
    ///
    /// **And never in a wait** (unreleased): when a player is sounding, the answer carries its entry
    /// *and a position*, so the row has something to render. `appSoundingSongId` is the entry the
    /// app's own player is making a sound with, read from the player — when it names one, the return
    /// has something to answer with; there is no path here that leaves the screen waiting on a start
    /// while the sound is already there.
    ///
    /// **Being "sounding" is not proof of where** (unreleased, F1). This branch used to adopt on the
    /// entry alone and stop the queue in the same turn: a start that had just begun at 0:00 was
    /// taken as the sound the return was for, against a queue four minutes in, and the jump was
    /// unrecoverable. The proof an adoption needs is the proof a take already needs
    /// (`releaseTake`): **the same entry, a readable position, and no drift beyond `maxDriftMs`**.
    /// When the app's own player is on the queue's entry at some other position, the queue's
    /// position is the truth and the return is an **offer** — the app starts that entry at the
    /// queue's position and the release takes it there (`seekThenTake`), so the queue keeps the
    /// sound instead of being stopped under a row that would then read 0:00. A player sounding a
    /// *different* entry is still an adoption: the app took the sound somewhere else, and the queue
    /// stops rather than playing under it (`releaseTake`'s `.abandon`, in the same words).
    static func returnDecision(queueOwnsSound: Bool, soundingSongId: String?, soundingIndex: Int,
                               positionMs: Int, appSoundingSongId: String? = nil,
                               appPositionMs: Int? = nil,
                               maxDrift: Int = maxDriftMs) -> Return? {
        if let appSongId = appSoundingSongId, !appSongId.isEmpty {
            let queueSongId = soundingSongId ?? ""
            if queueSongId.isEmpty || queueSongId != appSongId {
                /*
                 * **The adoption of ANOTHER entry carries no index of the queue's (unreleased).**
                 *
                 * `soundingIndex` is the *queue's* entry index, and on this branch the app's player
                 * is sounding a different entry than that index names — so passing it published a
                 * number that points at another track, and `NaviliteRemote` uses it as
                 * `publishedIndex`'s fallback, so this side's own `index` was that foreign number
                 * until `adoptNativeAdvance` corrected it. Nothing was mis-started (the web layer
                 * guards on `songId`), but the `return-adopted` line carried a wrong index and the
                 * cursor sat on a stranger's entry in between. `-1` is the existing last-resort
                 * answer for "no index of this side's names it", so the number is withheld rather
                 * than borrowed.
                 */
                return .adopt(songId: appSongId, index: -1,
                              positionMs: max(0, appPositionMs ?? 0))
            }
            /* Same entry — now the position has to prove it, exactly as a take does. */
            if let appMs = appPositionMs, appMs >= 0, abs(positionMs - appMs) <= maxDrift {
                return .adopt(songId: appSongId, index: soundingIndex, positionMs: appMs)
            }
            /* Same entry at another position (or no position read): the queue keeps the sound and
             * the offer below is the seek route. Falling out of this branch is the fix, not a gap. */
        }
        if let songId = soundingSongId, !songId.isEmpty {
            return .offer(songId: songId, index: soundingIndex, positionMs: positionMs)
        }
        guard queueOwnsSound else { return nil }
        return .stop("the away queue holds the sound and its current item is not an entry this side attached, so the queue is stopped rather than left sounding under the app's own player — no reading is built from another player's songId")
    }

    /* ------------------------------------------- an offer nobody released (v2.0.0-beta.19) */

    /// How many times a release is re-asked when the app's own start has not reached the speakers yet.
    static let releaseAttempts = 4
    /// How long an offer stands with no release at all before it is settled here. The app's own
    /// `releaseHandover` only arrives when its start **commits**; a start that never commits used to
    /// leave the return silent — three `queue-handover` offers at 15:39:40, nothing after them, the UI
    /// on the row in its loading state while the queue was audible.
    static let offerSettle: TimeInterval = 3.0

    /// Whether an attempt still has a rung to ask on, or is the one that must settle.
    static func releaseReasks(attempt: Int) -> Bool { attempt < releaseAttempts }

    /// The one answer an offer that was never released gets, stated once so the deadline and the
    /// spent wait cannot disagree.
    enum Unreleased: Equatable {
        /// The app's own player is sounding: the queue stops rather than playing under it.
        case stopTheQueue(String)
        /// Nothing of the app's is sounding: the queue keeps the sound, and the web layer is told
        /// which entry is sounding so its row can leave the loading state.
        case keepTheQueue(String)
    }

    static func unreleasedOffer(appSounding: Bool) -> Unreleased {
        if appSounding {
            return .stopTheQueue("the offer was never released and the app's own player is sounding, so the queue stops rather than sounding under it")
        }
        return .keepTheQueue("the offer was never released and nothing of the app's is sounding, so the queue keeps the sound and the app is told which entry is sounding rather than sitting on a row that says loading")
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

    /* --------------------------------- the owner's choice takes the sound (unreleased) */

    /// **Who asked for a start.**
    ///
    /// The two presses this side answers are not the same request, and treating them as one is what
    /// left the owner with a song he could not change:
    ///
    ///  - `.selection` — the owner tapped a track. The other owner (the away queue, or a plugin asset)
    ///    is silenced **first**, and then the track he asked for starts. One owner at the end, and it
    ///    is the one he asked for.
    ///  - `.automatic` — a boundary, a seam, a resume. Nothing is chosen here, so a source that is
    ///    still sounding after the sweep is a start that would be a second player, and it is refused.
    enum Intent: Equatable {
        case selection
        case automatic
    }

    /// What the start may do: issue it (with what had to be silenced first), or refuse it.
    enum Start: Equatable {
        case start(silenced: [String])
        case refuse(String)
    }

    /// **A deliberate selection silences the other owner and starts; a repeat is refused**
    /// (unreleased).
    ///
    /// `answered` is the repeat/crossed-press sentence (`refusalForRepeat`, `refusalForCrossMove`,
    /// `refusalForAnsweredPress`): a press this side has already answered is refused **whatever the
    /// intent**, because a redelivery of a button is not a choice. That is the whole difference
    /// between the two defects the owner reported — the duplicate press must move nothing, and the
    /// tap on a track must move everything.
    ///
    /// `sounding` is every source making a sound now (the away queue under its own slot name, each
    /// plugin asset), `silenced` is what this sweep has already asked to stop. A refusal is made only
    /// from a source the sweep did **not** silence: `pause()` is a request, so a queue it just asked
    /// to stop can still be reporting a sound in the same turn — and refusing the owner's own tap for
    /// that is what left the row on `loading` with two players once he forced it.
    static func startDecision(intent: Intent, answered: String?, target: String?,
                              sounding: [String], silenced: [String]) -> Start {
        if let answered { return .refuse(answered) }
        let others = sounding.filter { $0 != target }
        let unreached = others.filter { !silenced.contains($0) }
        switch intent {
        case .selection:
            guard unreached.isEmpty else {
                return .refuse("\(unreached.joined(separator: ",")) is sounding and this sweep could not reach it, so the start the listener asked for would be a second player at this instant")
            }
            return .start(silenced: others)
        case .automatic:
            guard others.isEmpty else {
                return .refuse("\(others.joined(separator: ",")) is still sounding after the sweep, so a start that is nobody's choice would be a second player at this instant and is refused")
            }
            return .start(silenced: [])
        }
    }

    /* ------------------------ a statement that names another entry (unreleased) */

    /// **What a statement the app makes while the queue is sounding means.**
    ///
    /// The web layer states its queue after every start, so a statement naming an entry the queue is
    /// not sounding is one of two things, and they are decided by the app's own player:
    ///
    ///  - the **plain return** — nothing of the app's has started yet, so the queue is the authority
    ///    and the statement is corrected to the entry the queue is really on (a watch that never
    ///    tracked the queue's advance comes back naming the track it left);
    ///  - a **selection** — the app's own player is *already sounding* the entry the statement names,
    ///    so the owner chose it. Obeying the queue here is what refused him: he taps a track, the
    ///    statement is corrected back to the queue's entry, the queue keeps the sound and he ends up
    ///    with two players once he forces the app.
    enum Statement: Equatable {
        case keepQueue(String)
        case selection(String)
    }

    static func statementChoice(statedSongId: String, audibleSongId: String, appSounding: Bool,
                               queueSongId: String) -> Statement {
        guard !statedSongId.isEmpty else {
            return .keepQueue("the app named no entry, so there is nothing of its own to obey and the queue keeps the sound")
        }
        guard !queueSongId.isEmpty else {
            return .keepQueue("the queue's entry cannot be named, so there is no entry to correct the statement to")
        }
        guard statedSongId != queueSongId else {
            return .keepQueue("the app stated the entry the queue is sounding, so there is nothing to decide")
        }
        if appSounding, !audibleSongId.isEmpty, audibleSongId == statedSongId {
            return .selection("the app's own player is already sounding \(statedSongId) while the queue sounds \(queueSongId), so the statement is the owner's choice: the queue is silenced and \(statedSongId) starts")
        }
        return .keepQueue("nothing of the app's is sounding \(statedSongId) yet, so the queue is the authority on the way back and the statement is corrected to \(queueSongId)")
    }

    /* ------------------- a refusal that names the sound is an ANSWER (unreleased) */

    /// **What the app renders when a refusal names the entry the queue is sounding (unreleased).**
    ///
    /// The owner's log is four `handover-refused` lines three seconds apart, each one carrying the
    /// entry the queue is sounding and where it is (`q 17769`, `20810`, `23853`, `26890`) — and a
    /// spinner on the row until he picked a track himself. A refusal that names the entry is not a
    /// "no": it is the answer to *what is sounding*. So the app displays it, keeps its own player
    /// silent, and asks nothing more. The three-second poll **is** the spinner.
    enum Reading: Equatable {
        /// The row is written from this reading: the entry, its index in the published order, and
        /// the position the queue is at. Nothing is started and nothing is waited for.
        case display(songId: String, index: Int, positionMs: Int, why: String)
        /// The refusal names nothing this side can render: the queue keeps the sound, and the app
        /// is told no more than that.
        case unnamed(String)
    }

    /// **The label is written from the reading, never from the app's own statement (unreleased).**
    ///
    /// `queue-handover-jump` corrected the same pair three times (`statedIdx 5 / 0jGX` against
    /// `queueIdx 7 / 0DHk`) and the app stated the stale entry again. That is the shape of the
    /// defect: the statement is generated *before* the question is asked, so it cannot be the
    /// answer. This answers the reading's own facts, and says which statement it overwrote.
    static func refusedReading(soundingSongId: String?, soundingIndex: Int, positionMs: Int,
                               statedSongId: String, statedIndex: Int) -> Reading {
        guard let songId = soundingSongId, !songId.isEmpty else {
            return .unnamed("the refusal names no entry this side could read, so there is nothing to render and the queue is the only sound")
        }
        let at = positionMs > 0 ? positionMs : 0
        if !statedSongId.isEmpty, statedSongId != songId {
            return .display(songId: songId, index: soundingIndex, positionMs: at,
                            why: "the app had stated \(statedSongId) at index \(statedIndex) before it asked, and the answer names \(songId) at index \(soundingIndex) and \(at) ms — the statement is overwritten by the reading, because a statement made before the question cannot be its answer")
        }
        return .display(songId: songId, index: soundingIndex, positionMs: at,
                        why: "the refusal names \(songId) at index \(soundingIndex) and \(at) ms, so the row is written from the reading and the app asks nothing further")
    }

    /// **One return, one answer — and the answer's identity is the ENTRY (unreleased).**
    ///
    /// The owner's log is four offers of one entry, one every three seconds: each refusal carried
    /// the answer, the web layer stated its queue in reply, and the statement offered the same
    /// entry again — a refusal that is re-asked is indistinguishable from a spinner.
    ///
    /// This used to call the identity "**the entry and its index**", and that is the defect the poll
    /// survived on: the index is the number that drifts. `handOverAwayQueue` records the offer's
    /// `soundingIndex` looked up in `queue` as it stands at the offer, and the guard re-derives
    /// `soundingIndex` with a second lookup in `queue` — but the statement that asks a second time
    /// has already replaced `queue` with the web layer's own published list (`self.queue = entries…`,
    /// at the top of the statement, before the guard is reached). Two lookups over two arrays is not
    /// an invariant, and the app's order is not index-compatible with this side's: the same log's
    /// `queue-handover-jump` puts `0jGX…` at index 5 where the queue has `0DHk…` at 7. So a statement
    /// that named exactly the entry the refusal had just answered, at an index the statement itself
    /// re-based, came out as a *new* question and started another three-second deadline — the loop.
    ///
    /// The identity is therefore the entry alone. The position moves on while the queue plays and the
    /// index is re-based by the statement, so neither is the request. A different entry (the queue
    /// advanced, or the owner picked a track) is a new question, and the app asking on a new return is
    /// `handover()`'s own path, which clears the answer before it asks.
    static func answeredOffer(offeredSongId: String, offeredIndex: Int,
                              answeredSongId: String, answeredIndex: Int) -> String? {
        guard !answeredSongId.isEmpty, answeredSongId == offeredSongId else { return nil }
        guard answeredIndex != offeredIndex else {
            return "\(offeredSongId) at index \(offeredIndex) was already offered and answered, so this statement does not ask again — one return, one answer, and the app has the entry and the position to render"
        }
        return "\(offeredSongId) was already offered at index \(offeredIndex) and answered at index \(answeredIndex), so this statement does not ask again — the entry is the request, and the index is the number the statement re-bases"
    }

    /// **An answer is about one ask, not one song for the session (unreleased).**
    ///
    /// This is the other half of `answeredOffer`: that one says a statement for the entry just
    /// answered does not ask again, and this one says which answer still stands when a *different*
    /// entry is asked about. The remote kept `answeredOffer` from the refusal until an abandon or a
    /// fresh `handover()`, so an entry refused once stayed answered for the rest of the session — and
    /// when the queue came back to it (repeat-all wrapping, or the same song twice in the queue) its
    /// statement was swallowed as `queue-handover-answered` with no offer and no deadline, while the
    /// queue was audibly playing it and the row held the reading of the entry in between. Any ask
    /// about another entry expires the answer; the answer that stands is the one about the entry
    /// being asked about now.
    static func answerAfter(offering offeredSongId: String, answeredSongId: String?,
                            answeredIndex: Int) -> (songId: String, index: Int)? {
        guard let answeredSongId, !answeredSongId.isEmpty, answeredSongId == offeredSongId else {
            return nil
        }
        return (answeredSongId, answeredIndex)
    }

    /* --------------------------------------- a statement is not a reading (v2.0.0-beta.25) */

    /**
     * **Which entry a statement is taken at.**
     *
     * The queue's own entry corrects a statement that lags a boundary it took — but only while the
     * queue is *making a sound*. A queue that is merely **armed** (paused on the entry after the one
     * playing, waiting to take the boundary) is not a reading about what is playing: its
     * `currentItem` is the next track. Taking that as the index moved this side's cursor, the
     * lock-screen card and the next boundary's target onto the entry **after** the one playing, which
     * is the owner's report — background the first song and the card advances to song 2, then the
     * real end advances to song 3 and song 2 is never played.
     *
     * So: the queue corrects the statement only when the queue is sounding. Otherwise the statement
     * (the app's cursor) is the truth, and the armed tail stays where it is.
     */
    static func statementIndex(stated: Int, queueSounding: Bool, soundingIndex: Int?) -> Int {
        guard queueSounding, let soundingIndex, soundingIndex >= 0 else { return stated }
        return soundingIndex
    }

}
