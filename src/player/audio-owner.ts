/**
 * **The label names the sound** — the one rule in this file that the app itself runs.
 *
 * The native "exactly one player is sounding" enforcement lives in `NaviliteRemote.swift`
 * (`queueIsSounding`, `pluginSoundingSlots()`, `silenceOthers(except:why:)`); this module keeps only
 * the press/readback rule that the web layer decides, and `test/label-follows-player.test.ts` drives
 * it. (The unused TS mirror of the Swift sweep was deleted in v2.0-beta.24.)
 */

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
  /** Whether the label moved. `false` is a press that was refused, not one that was taken. */
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
 *  - the player is on the intended entry → the press was taken, the label moves with the sound;
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
        : `the player is still on ${seen.sounding} and not on ${seen.intended}, so the label stays where the sound is — the press was refused, not taken`,
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
