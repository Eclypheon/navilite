/**
 * **One audio owner, enforced** — the written model of the rule `NaviliteRemote.swift` now enforces
 * at both of the places a sound can begin (v2.0.0-beta.20).
 *
 * The owner's report was *"when i fast forward a song, it plays over the top of the current song
 * rather than stopping current song then going to the next, resulting in two songs concurrently
 * playing at once."* Two audible streams at one instant means two players were sounding, and in this
 * tree that can only be:
 *
 *   1. the away `AVQueuePlayer` started while the audio plugin's own asset was still playing the
 *      track on screen — `awayStart` called `queuePlayer.play()` and stopped nothing;
 *   2. the plugin's asset started while the queue was still sounding — the `playSlot` half of the
 *      same omission, reached when `awayOwnsAudible` was stale;
 *   3. the plugin's asset started while *another plugin asset* was still playing — the plugin's
 *      `play(assetId:)` starts the asset it is given and touches no other (`Plugin.swift`), so two
 *      assets playing at once is exactly what two plays produce.
 *
 * The model below is the invariant, and it is stated as a function of what the *players* are doing
 * rather than of the flags that were meant to describe them: before any play, every source that is
 * sounding and is not the target is stopped, so after the play exactly one source exists.
 *
 * The implementation is `NaviliteRemote.swift` — `queueIsSounding` (read from the player), the sweep
 * in `pluginSoundingSlots()`, and `silenceOthers(except:why:)` called from `awayStart` before the
 * queue's `play()` and from `playSlot` before the plugin's `play`.
 */

/** The name the away queue's own sound is published under — no plugin asset answers to it. */
export const AWAY_SLOT = 'navilite-away-queue';

/** What is making a sound at this instant, read from the players. */
export interface Sounding {
  /** The away `AVQueuePlayer` is playing. */
  queue: boolean;
  /** The plugin assets that are playing, by the assetId the plugin knows them by. */
  plugins: readonly string[];
}

/** What is about to start. */
export type PlayTarget = { kind: 'queue' } | { kind: 'plugin'; assetId: string };

/**
 * Every source that is sounding and is not the target, in the order it should be stopped. An empty
 * list means nothing else is playing and the target may start.
 *
 * The target is never stopped: a restart of the track that is already sounding is a seek on the one
 * player that owns it, not a new source.
 */
export function silenceBeforePlay(sounding: Sounding, target: PlayTarget): string[] {
  const stopped: string[] = [];
  if (target.kind !== 'queue' && sounding.queue) stopped.push(AWAY_SLOT);
  for (const assetId of sounding.plugins) {
    if (target.kind === 'plugin' && target.assetId === assetId) continue;
    stopped.push(assetId);
  }
  return stopped;
}

/** The sources sounding after `stopped` were stopped and `target` was started. */
export function soundingAfter(sounding: Sounding, target: PlayTarget, stopped: readonly string[]): Sounding {
  const left = sounding.plugins.filter((assetId) => !stopped.includes(assetId));
  const queue = sounding.queue && !stopped.includes(AWAY_SLOT);
  if (target.kind === 'queue') return { queue: true, plugins: left };
  return { queue, plugins: [...left, target.assetId] };
}

/** The names of everything making a sound — the list that must always have exactly one entry. */
export function audioOwners(sounding: Sounding): string[] {
  const owners: string[] = sounding.queue ? [AWAY_SLOT] : [];
  return [...owners, ...sounding.plugins];
}

/** Whether exactly one source is sounding. The invariant, as a question. */
export function hasOneOwner(sounding: Sounding): boolean {
  return audioOwners(sounding).length === 1;
}

/* ---------------------------------- the label names the sound (v2.0.0-beta.29) */

/**
 * One transport press, as the **players** answered it.
 *
 * The owner's beta.24 report is not two players sounding to begin with: it is a press that moved the
 * label — the island and the app bar both render the app's state, so their agreement proves nothing —
 * while the phone went on sounding the entry that was already playing, and then a foreground start
 * that began the entry the label named, at the *other* track's position, over a queue that was still
 * playing it.
 */
export interface PressLabel {
  /** The entry the label named before the press. */
  before: string | null;
  /** The entry the press asked the label to move to. */
  intended: string;
  /**
   * The entry a player is **actually** on after the press, read at the player — `currentItem`, never
   * the cursor the press moved. `null` means nothing this side can name is sounding.
   */
  sounding: string | null;
  /** Whether any player is making a sound after the press. */
  running: boolean;
}

export interface PressLabelResult {
  /** The entry the label must name now. Always the one that is sounding. */
  label: string | null;
  /** Whether the label moved. `false` is a press that was refused, not one that was applied. */
  moved: boolean;
  /** The sentence the press line carries, so the next report is decidable from the log alone. */
  why: string;
}

/**
 * Where the label belongs after a press: **on the entry that is sounding**, never on the entry the
 * press intended and never on a cursor.
 *
 * Two outcomes, and the difference is the whole defect:
 *
 *  - the player is on the intended entry → the press was applied, the label moves with the sound;
 *  - the player is on anything else (the queue did not move, or moved somewhere the press did not
 *    ask for) → the press was **refused**: the label stays with the sound and the log says why.
 *    Moving it anyway is how a label ends up naming a track nothing is playing, and how the next
 *    foreground start begins that track over the one that is.
 *
 * Nothing sounding is not a reason to move the label either: a label on an entry that never played
 * is a lie the listener reads before the sound arrives.
 */
export function labelAfterPress(seen: PressLabel): PressLabelResult {
  if (seen.running && seen.sounding !== null) {
    const moved = seen.sounding !== seen.before;
    return {
      label: seen.sounding,
      moved,
      why: moved
        ? `the player is on ${seen.sounding}, so the label names it`
        : `the player is still on ${seen.sounding} and not on ${seen.intended}, so the label stays where the sound is — the press was refused, not applied`,
    };
  }
  return {
    label: seen.before,
    moved: false,
    why:
      seen.sounding === null
        ? `nothing sounding can be named after the press, so the label is not moved onto ${seen.intended}, which never played`
        : `no player is running, so the label stays on ${seen.before ?? 'no entry'}`,
  };
}
