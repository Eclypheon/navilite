/**
 * The copy metadata a `Song` can be missing, and the one rule for filling it in (v1.9.23).
 *
 * Why this is a module of its own: **two** of the app's own objects hold a copy of the same song,
 * and both of them can be holding a blank one. The store's rows are filled by the repair
 * (`OfflineStore.repairMetadata`, which fills its own row shape), and the two things the owner can
 * *see* through are a `Song`:
 *
 *   - the row a view drew, whose title/sub-line/time were written once at build
 *     (`src/ui/app.ts`, `songRow`);
 *   - the queue's own copy, which is the object the view handed it at the tap and which the player
 *     bar prints (`currentSong`, `src/state/queue.ts`).
 *
 * One rule, stated once, so the store and the screen cannot disagree about what "repaired" means:
 * **only empty fields are written.** A `Song` the library answered with is complete, so this is a
 * no-op for it and no server row can be overwritten by a row from the phone. A song nobody can name
 * yet keeps the blank it has — never its own id in the title slot, never a `0` duration drawn as if
 * it were a length (the standing rule of the whole offline design).
 */
import type { Song } from '../api/types.ts';

/**
 * Copy what `target` is missing from `from` — the same song, better known — and nothing else.
 * Mutates `target` in place (the row and the queue hold the *same object*, so filling it here is
 * what reaches both) and returns how many fields it filled, so a caller can tell a repair that
 * changed something from one that changed nothing and stay quiet in that case.
 */
export function fillSong(target: Song, from: Song): number {
  let filled = 0;
  if ((target.title ?? '') === '' && (from.title ?? '') !== '') {
    target.title = from.title;
    filled += 1;
  }
  if ((target.artist ?? '') === '' && (from.artist ?? '') !== '') {
    target.artist = from.artist;
    filled += 1;
  }
  if ((target.album ?? '') === '' && (from.album ?? '') !== '') {
    target.album = from.album;
    filled += 1;
  }
  if ((target.duration ?? 0) <= 0 && (from.duration ?? 0) > 0) {
    target.duration = from.duration;
    filled += 1;
  }
  if ((target.coverArt ?? '') === '' && (from.coverArt ?? '') !== '') {
    target.coverArt = from.coverArt;
    filled += 1;
  }
  return filled;
}
