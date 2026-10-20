/**
 * The away boundary as AVFoundation's own advance — the written model of what the native side does.
 *
 * The owner's boundary log (beta.16, build 64) settled the previous route for good: while the app was
 * away every `ahead-issued` line was followed by `reload` with `buffered:0` and a bumping generation,
 * the slot never came to hold an item, and every seam then paid a cold fetch it could not complete
 * (`fetchMs:0`, `playMs:-1`, five failed boundaries, `end`→`boundary` ≈ 19.7 s). Priming a *plugin*
 * slot from native code does not produce a playable item in that state.
 *
 * So the seam stops needing app code: the entries after the one playing are attached to an
 * `AVQueuePlayer` **while the app is awake**, and a track ending with the app away is the platform
 * advancing to an item it already holds — no preload, no readiness poll, no network call. The
 * implementation is `NaviliteRemote.swift` (`awayPlan`/`armAwayQueue`/`awayStart`/`commitQueue`); the
 * rules below are the same rules stated where they can be driven without a phone, and the native
 * boundary line records which one ran (`path: "queue"` or `path: "fetch"`).
 *
 * Three facts these functions exist to keep true:
 *
 *   1. a boundary the queue can take issues **no** fetch;
 *   2. a queue whose next item will not load falls back to the fetch path, with a reason;
 *   3. an entry the app cancels is not left attached to the queue.
 */

/** One entry of the published order, as the native side receives it in `setQueue`. */
export interface AwayEntry {
  songId: string;
  url: string;
}

/** The play order the app has stated: the entries, the one playing, and the repeat mode. */
export interface AwayStatement {
  list: readonly AwayEntry[];
  index: number;
  repeat: 'off' | 'all' | 'one';
}

/** What the queue is holding and how far it has played. */
export interface AwaySeamState {
  /** songIds attached to the queue, in play order. Attachment only appends. */
  attached: readonly string[];
  /** How many of them the queue has sounded; `-1` before it has been started. */
  cursor: number;
  /** Whether the queue, rather than a plugin slot, is making the sound. */
  owned: boolean;
  /** Entries the seam had to load itself — the list that must stay empty on the queue path. */
  fetches: readonly string[];
}

/** How many entries are attached ahead of the one playing. */
export const AWAY_AHEAD = 2;

/** The entry a boundary read from `index` would go to, or `-1` when there is none. */
export function nextTarget(statement: AwayStatement): number {
  const { list, index, repeat } = statement;
  if (index < 0 || index >= list.length) return -1;
  const target = index + 1;
  if (target < list.length) return target;
  // The queue's own wrap, and the same rule the app's `next` has always had.
  if (repeat === 'all') return 0;
  if (repeat === 'one') return index;
  return -1;
}

/**
 * The entries that should be attached: the next `ahead` of the published order, wrapping only when
 * repeat is on. This is what `armAwayQueue` inserts, so it is also the answer to "what must the queue
 * hold for the next boundary to be an advance".
 */
export function awayPlan(statement: AwayStatement, ahead: number = AWAY_AHEAD): AwayEntry[] {
  const { list, index, repeat } = statement;
  if (index < 0 || index >= list.length) return [];
  const plan: AwayEntry[] = [];
  for (let step = 1; plan.length < ahead && step <= list.length; step += 1) {
    let target = index + step;
    if (target >= list.length) {
      if (repeat !== 'all') break;
      target -= list.length;
    }
    if (target === index) break;
    const entry = list[target];
    if (!plan.some((held) => held.songId === entry.songId)) plan.push(entry);
  }
  return plan;
}

/**
 * The queue's contents for a statement. A statement REPLACES the attached list rather than extending
 * it: an entry the app cancelled — a warm track it no longer holds, or one it took out of the order —
 * must not stay attached to a player that would still sound it later, which is what "did not leave it
 * attached" means on the device.
 */
export function attachedFor(statement: AwayStatement, ahead: number = AWAY_AHEAD): string[] {
  return awayPlan(statement, ahead).map((entry) => entry.songId);
}

/** Which route a boundary takes, and why when it is not the queue. */
export type AwayDecision =
  | { kind: 'queue'; songId: string; target: number }
  | { kind: 'fetch'; songId: string; target: number; why: string };

/**
 * The seam's single question, asked before any slot and before any fetch: does the queue already hold
 * the entry this boundary needs?
 *
 * `failed` is the one reading the model cannot take for itself — on the device it is the attached
 * item's own `status == .failed`, or `AVPlayerItemFailedToPlayToEndTime` arriving for it.
 *
 * **It is asked BEFORE ownership (v2.0-beta.17 rework).** Answering `queue` as soon as `owned` made the
 * failure branch unreachable in exactly the state the device needs it: once the queue owns the sound
 * the failure is what the phone is in when a 404 sits inside the queue, and a queue that stops on a
 * dead item is silence, not an advance.
 */
export function decideAwaySeam(input: {
  statement: AwayStatement;
  state: AwaySeamState;
  failed?: ReadonlySet<string>;
}): AwayDecision {
  const { statement, state, failed } = input;
  const target = nextTarget(statement);
  if (target < 0) {
    return { kind: 'fetch', target, songId: '', why: 'the published order has no entry after the one playing' };
  }
  const entry = statement.list[target];
  if (failed?.has(entry.songId)) {
    return {
      kind: 'fetch',
      songId: entry.songId,
      target,
      why: `the away queue's item for ${entry.songId} would not load, so it is being fetched again here`,
    };
  }
  /*
   * Once the queue owns the sound, the advance has already happened inside AVFoundation — the item
   * after the one that ended is the player's own `currentItem`. That is only a boundary while the
   * queue still HELD that entry: a drained queue (nothing attached after the one that ended, a top-up
   * that added nothing, or repeat-all at the last entry where the wrapped entry was never attached)
   * stops there, so it is a fetch here rather than a stop that says `playing`.
   */
  if (state.owned && state.cursor >= 0) {
    if (state.attached.includes(entry.songId)) {
      return { kind: 'queue', songId: entry.songId, target };
    }
    return {
      kind: 'fetch',
      songId: entry.songId,
      target,
      why: `the away queue had no item left for ${entry.songId} (it drained at the boundary), so it is being fetched here`,
    };
  }
  if (state.attached[0] !== entry.songId) {
    return {
      kind: 'fetch',
      songId: entry.songId,
      target,
      why: `the queue does not hold ${entry.songId}, so the boundary is being fetched here`,
    };
  }
  return { kind: 'queue', songId: entry.songId, target };
}

/**
 * Whether the queue already holds an entry **ahead of the one sounding**, and therefore whether a
 * look-ahead fetch for it would be a second decode of the same track (v2.0-beta.17 rework). While the
 * app is away the two decodes compete for the same connection, and the one that wins is the one the
 * boundary needs.
 */
export function queueHolds(state: AwaySeamState, songId: string): boolean {
  const from = Math.max(state.cursor + 1, 0);
  if (state.cursor < 0) return state.attached.includes(songId);
  return state.attached.slice(from).includes(songId);
}

/**
 * One away boundary, driven the way the native side drives it: the entry is attached, the queue plays
 * it, and the fact that the seam never fetched is the assertion.
 */
export function crossAwayBoundary(
  input: { statement: AwayStatement; state: AwaySeamState; failed?: ReadonlySet<string> }
): { state: AwaySeamState; path: 'queue' | 'fetch'; decision: AwayDecision } {
  const decision = decideAwaySeam(input);
  const { statement, state } = input;
  if (decision.kind === 'fetch') {
    return {
      decision,
      path: 'fetch',
      state: { ...state, owned: false, cursor: -1, fetches: [...state.fetches, decision.songId] },
    };
  }
  // The item the queue sounds is the next entry; the tail it still holds is re-derived from the new
  // position, which is the top-up `commitQueue` does.
  const after: AwayStatement = { ...statement, index: decision.target };
  const sounded = state.cursor + 1;
  const tail = awayPlan(after).map((entry) => entry.songId).filter((id) => !state.attached.includes(id));
  return {
    decision,
    path: 'queue',
    state: { attached: [...state.attached, ...tail], cursor: sounded, owned: true, fetches: state.fetches },
  };
}

/* ------------------------------------------- the return's two verdicts (v2.0.0-beta.22) */

/**
 * How far the app's own player may be from the queue before the take is refused. The same number as
 * `NavilitePressRules.maxDriftMs` in `ios/App/App/NavilitePressRules.swift`, stated here so the rule
 * can be driven without a phone.
 *
 * It was 400 ms, and that is the number the owner heard: a take at `driftMs:363` (`09:10:32`) was
 * inside it and was applied, and 363 ms of two players under one track is audible. 250 ms is the
 * tolerance this release states — a real switch is one position, and the app seeks and asks again
 * when it is not.
 */
export const RETURN_DRIFT_MS = 250;



/* ------------------------------------ a press that names an entry (v2.0.0-beta.32) */

/**
 * **Does `queueTransport('play')` for `songId` have to rebuild the queue? (v2.0.0-beta.32)**
 *
 * An `AVQueuePlayer` cannot jump, so a press that names an entry is served by rebuilding the item
 * list from that entry — `startQueue(at:)` in `NaviliteRemote.swift`. The rebuild is only skippable
 * when the queue is *stopped at its own front*, because that is the one state where
 * `queuePlayer.currentItem` is `awayItems[0]`: the entry the press names is attached, and it is
 * first. A queue that has sounded is not that state.
 *
 * `cursor` is how many entries the queue has sounded. **It rises inside AVFoundation's own advance**
 * (`NaviliteRemote.swift`, the `AVPlayerItemDidPlayToEndTime` boundary sets `awayCursor = next`) while
 * nothing trims the front of `attached`, so after one native advance the front of the list is an
 * entry the player no longer holds. Reading only the front (`cursor < 0 || attached[0] !== songId`)
 * therefore answers "no rebuild" for an entry that is gone: `startQueue` reaches its attach guard
 * with `currentItem !== awayItems[0]`, logs `could not attach X, so it was not started`, and the
 * owner's press starts nothing. That is the send-back on t_44c5a1d4; the cursor is what makes the
 * front stale, so the cursor has to be part of the question.
 */
export function startNeedsRebuild(input: {
  /** songIds attached to the queue, in play order — the front is never trimmed. */
  attached: readonly string[];
  /** How many entries the queue has sounded; `-1` before it has been started. */
  cursor: number;
  /** The entry the press names. */
  songId: string;
}): boolean {
  const { attached, cursor, songId } = input;
  if (cursor !== 0 || attached[0] !== songId) return true;
  return false;
}

/**
 * **Is a re-arm a no-op? (v2.0.0-beta.22)**
 *
 * The owner's beta.21 log arms the queue fourteen times inside two seconds — generations 6, 7, 8, 10,
 * 11, 12, 14, 15, 16, 18, 19, 20, 21, 22 — with identical `entries` every time. Each rebuild removes
 * and re-creates the item list, and the statement that lands between two rebuilds is what can describe
 * a queue that is no longer there. A plan equal to what the queue already holds is therefore not a
 * rebuild: nothing is removed, nothing is re-created, and no `queue-armed` line is written.
 *
 * Only the not-yet-sounding state can be a no-op. A queue that owns the sound is topped up instead
 * (which compares its own unplayed tail), and a queue that has sounded cannot be rebuilt underneath
 * the track that is playing.
 */
export function armIsNoOp(input: {
  /** songIds the queue is holding now. */
  attached: readonly string[];
  /** songIds `awayPlan()` says it should hold. */
  plan: readonly string[];
  /** How many entries the queue has sounded; `-1` before it has been started. */
  cursor: number;
  /** Whether the queue, rather than a plugin slot, is making the sound. */
  owned: boolean;
  /** Whether a queue player exists at all. */
  armed: boolean;
}): boolean {
  const { attached, plan, cursor, owned, armed } = input;
  if (!armed || owned || cursor >= 0) return false;
  if (attached.length !== plan.length) return false;
  return attached.every((songId, at) => songId === plan[at]);
}
