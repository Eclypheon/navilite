/*
 * v2.0-beta slice A5 — the now screen, out of `app.ts`.
 *
 * These are the app-side half of the pager (whose other half is `src/ui/pager.ts`): the
 * pane/route correspondence (`settlePane`, `paneOfRoute`), the overlay show/hide pair, the
 * Spectrum/Lyrics mode, and the seek bar's own gesture maths (`bindSeek`).
 *
 * The seam is the same one the code already had — a `Shell`, the `NowMode` the route names,
 * and the queue read through a getter — it is now a module edge instead of a file position.
 * The module reads `app.ts`'s mutable refs (`queueRef`, `queueRefRef`, `refreshSeekLabels`)
 * live: one writer for each (the router, `boot`), so the reads here are the same reads the
 * functions made when they lived in that file. Nothing in this file is evaluated at import
 * time except `SEEK_INTERVAL_MS`.
 */
import { DEFAULT_ROUTE, LYRICS_ROUTE, NOW_ROUTE, PANE_LYRICS, PANE_PLAYLIST, PANE_SPECTRUM, queueRef, queueRefRef, refreshSeekLabels } from './app.ts';
import { PlaybackQueue } from '../state/queue.ts';
import type { NowMode, Shell } from './context.ts';
import { formatTime } from './dom.ts';

/* -------------------------------------------------------------- the pager */

/**
 * The pager came to rest on a pane: say so in the route.
 *
 * The URL is the pager's state (see `renderRoute`), and writing it here is what makes the browser's
 * back and forward buttons walk the panes — the owner's optional nice-to-have, and free once the
 * route and the pane are the same fact.
 */
export function settlePane(position: number): void {
  const shell = queueRefRef;
  if (!shell) return;
  const target =
    position === PANE_PLAYLIST
      ? shell.lastBrowseRoute || DEFAULT_ROUTE
      : position === PANE_LYRICS
        ? LYRICS_ROUTE
        : NOW_ROUTE;
  if (location.hash !== target) {
    location.hash = target;
    return;
  }
  // The route did not move — a drag that came back to where it started — so nothing will re-render
  // for us: put the screen back by hand, or the overlay would stay over the list.
  if (position === PANE_PLAYLIST) hideNowScreen(shell);
}

/**
 * A drag has just been read as horizontal, heading for `target`: make that pane exist before it
 * arrives. The overlay may still be hidden (a drag that starts on the playlist) and the lyrics are
 * fetched on first need, so both are readied here rather than assumed.
 */
export function preparePane(target: number): void {
  const shell = queueRefRef;
  if (!shell) return;
  if (target === PANE_PLAYLIST) return;
  shell.nowOverlay.classList.remove('hidden');
  shell.playerBar.classList.add('hidden');
  applyNowMode(target === PANE_LYRICS ? 'lyrics' : 'spectrum');
}

/** The now screen is showing on `pane`. */
export function showNowScreen(shell: Shell, pane: number): void {
  shell.nowOverlay.classList.remove('hidden');
  shell.playerBar.classList.add('hidden');
  applyNowMode(pane === PANE_LYRICS ? 'lyrics' : 'spectrum');
  shell.pager.show(pane);
}

/** The now screen is gone: the playlist is the screen, and the transport is back. */
export function hideNowScreen(shell: Shell): void {
  shell.pager.hide();
  shell.nowOverlay.classList.add('hidden');
  shell.playerBar.classList.toggle('hidden', queueRef?.currentSong == null);
}

/** Which pane a route means. Anything that is not the now screen is the playlist. */
export function paneOfRoute(head: string, id: string | undefined): number {
  if (head !== 'now') return PANE_PLAYLIST;
  return id === 'lyrics' ? PANE_LYRICS : PANE_SPECTRUM;
}

/**
 * Apply a mode to the screen — the pill, the class the dense text layout hangs off, and the lyrics
 * themselves. It does not move the pager: `setNowMode` does that by writing the route, and the
 * router animates.
 */
function applyNowMode(mode: NowMode): void {
  const shell = queueRefRef;
  shell.nowMode = mode;
  const lyrics = mode === 'lyrics';
  shell.pillSpectrum.classList.toggle('active', !lyrics);
  shell.pillLyrics.classList.toggle('active', lyrics);
  shell.pillSpectrum.setAttribute('aria-selected', String(!lyrics));
  shell.pillLyrics.setAttribute('aria-selected', String(lyrics));
  // v1.2/v1.5: the class the dense lyrics metrics hang off. The panes themselves are laid out side
  // by side now, so nothing is hidden here — the pager decides what is on screen.
  shell.nowOverlay.classList.toggle('lyrics-mode', lyrics);
  // Load on first view rather than on every track change: fewer requests, same result.
  if (lyrics) shell.lyrics.show(queueRef?.currentSong ?? null);
}

/**
 * The spectrum/lyrics pill. Both options are the *same pager* the finger drives — the route is what
 * moves, so the switch slides the strip instead of cutting to the other pane.
 */
export function setNowMode(mode: NowMode): void {
  const target = mode === 'lyrics' ? LYRICS_ROUTE : NOW_ROUTE;
  if (location.hash === target) return;
  // A hashchange does not fire when the only difference is the trailing pane on the same screen and
  // the app is already there, so apply the mode directly as well; the pager follows the route.
  applyNowMode(mode);
  queueRefRef.pager.goTo(mode === 'lyrics' ? PANE_LYRICS : PANE_SPECTRUM);
  location.hash = target;
}

/**
 * The seek bar, and the drag that seeks with it.
 *
 * v1.7.1 — three things, all of them the owner's report that *"i can't drag the seek bar because it
 * registers as im trying to swipe to a different pane"*:
 *
 *   1. **The gesture belongs to the bar.** The row carries `data-pager="off"` and the pager asks by
 *      hit-test as well as by element, so a drag that starts here can never turn a page
 *      (`src/ui/pager.ts`, `ownsGesture`). The CSS gives the control its own `touch-action`, so the
 *      platform does not read the horizontal movement as a pan either.
 *   2. **The drag seeks, continuously.** v1.7 sought only on `change` — that is, on release — so
 *      nothing happened while the thumb was being dragged. Every move now seeks, throttled to one
 *      round trip per `SEEK_INTERVAL_MS`, with the last position always committed and the value on
 *      release seeking exactly where the finger left it.
 *   3. **The thumb is not pulled out from under the finger.** `scrubbing` is set on the way down (on
 *      `pointerdown` and on `touchstart`, because audio controls are reached by touch) and cleared
 *      when the gesture ends however it ends, so the engine's own position updates stop writing the
 *      input's value while a finger is on it.
 *
 * v1.7.2 — *"can you make it so the timing changes dynamically as i drag the seek bar so i know to
 * what time im seeking to if i release it?"*: the **label** follows the thumb now, not just the
 * thumb's position. v1.7.1 sought continuously, but the clock beside the bar was still written from
 * the player's own position and only when no finger was down, so the number under his thumb never
 * moved — the seek was happening, and the screen said nothing about it. `shell.scrubMs` is the
 * destination: written on every move, by whichever of the two bars is being dragged, and cleared on
 * release (which commits it) or on cancel (which does not, and puts the real position back).
 *
 * v1.7.4 — *"seek bar doesn't work on drag nothing happens but tapping does let me seek"*, and v1.7.3
 * shipped a bar whose drag was still the *platform's*. Everything v1.7.1 did made the gesture reach
 * the control (the pager refuses it by name and by hit-test, `touch-action: none` keeps the platform
 * from reading it as a pan) — and then the control's own slider behaviour was the only thing that
 * could turn the movement into a value. In the installed app it evidently never ran: nothing was
 * written, so nothing was seeked, while a tap still jumped the thumb because that is a `click` the
 * control answers on its own. That is exactly the shape of his report, and a tap-vs-drag difference
 * cannot be seen from a test that only taps.
 *
 * So the bar drives itself now. `pointerdown` on it captures the pointer and takes the value from
 * the finger's own x over the bar's own box (`msAtX`), one write per `pointermove`, committing
 * through the same throttle as before; `dragging` silences the `input` listener for the length of
 * the gesture, so the platform's slider — if it also runs — cannot write a second, relative answer
 * under us. Nothing that used to work is lost: with no pointer events at all, `dragging` never goes
 * true and the `input`/`change` path below is still the whole implementation.
 */
const SEEK_INTERVAL_MS = 120;

export function bindSeek(input: HTMLInputElement, shell: Shell, getQueue: () => PlaybackQueue | null): void {
  let lastSeekAt = 0;
  let pendingMs: number | null = null;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  /** True from the moment a finger lands on the bar until the gesture ends: we are the writer. */
  let dragging = false;
  let pointerId: number | null = null;
  /**
   * Which channel owns the gesture that is running.
   *
   * v1.8.0 — this is the fix. The two input channels are not interchangeable on iOS: a native
   * `<input type=range>` is driven by WebKit's own recogniser, and the pointer stream that belongs
   * to the touch it claims is *cancelled* as soon as that recogniser takes over, while the touch
   * stream is delivered either way. v1.7.4 wrote the position from `pointermove` alone, so the only
   * writer of the value was an event the platform stops sending — which is why the drag worked in
   * the Chrome harness (whose synthetic touch feeds Chrome's input pipeline, which *does* synthesize
   * pointer events) and did nothing at all on the phone, while a tap still worked, because a tap
   * needs no move at all.
   */
  let owner: 'pointer' | 'touch' | null = null;

  const durationOf = (): number => queueDurationMs(getQueue());
  const valueMs = (): number => (Number(input.value) / 1000) * durationOf();

  const commit = (ms: number): void => {
    const queue = getQueue();
    if (!queue || ms < 0) return;
    void queue.seek(ms);
  };

  /**
   * Where a finger at this x is, in ms: the bar's own box, measured where the finger is.
   *
   * Absolute, not relative to the grab point, because the thumb on a seek bar is a position and not
   * a knob to push — the same reading a tap has always had, which is the one thing on this control
   * that was already working.
   */
  const msAtX = (clientX: number): number => {
    const duration = durationOf();
    if (duration <= 0) return 0;
    const rect = input.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return fraction * duration;
  };

  /** The label, written from the finger: both bars show the same destination, wherever it was dragged. */
  const showDestination = (ms: number): void => {
    shell.scrubMs = ms;
    const text = formatTime(ms / 1000);
    shell.barPosition.textContent = text;
    shell.nowPosition.textContent = text;
    shell.barProgress.value = input.value;
    shell.nowProgress.value = input.value;
  };

  const begin = (): void => {
    shell.scrubbing = true;
  };

  /** Whatever ends the gesture: stop hiding the thumb, and seek to where the finger left it. */
  const finish = (): void => {
    const wasScrubbing = shell.scrubbing;
    shell.scrubbing = false;
    shell.scrubMs = null;
    if (trailing !== null) clearTimeout(trailing);
    trailing = null;
    pendingMs = null;
    if (!wasScrubbing) return;
    if (durationOf() > 0) commit(valueMs());
    // The bar goes back to the player's own clock — which is now the position that was just asked
    // for, so the label stays where the finger left it rather than snapping back.
    refreshSeekLabels();
  };

  /**
   * A cancelled gesture commits nothing and puts the real position back.
   *
   * The thumb was dragged away by the platform (a call, a system gesture, the screen locking), so
   * the track never went anywhere and the label must not keep claiming it did.
   */
  const cancel = (): void => {
    if (!shell.scrubbing) return;
    shell.scrubbing = false;
    shell.scrubMs = null;
    pendingMs = null;
    if (trailing !== null) clearTimeout(trailing);
    trailing = null;
    refreshSeekLabels();
  };

  /** The label and the seek, from one number — whichever of the two paths produced it. */
  const applyMs = (ms: number): void => {
    input.setAttribute('aria-valuetext', formatTime(ms / 1000));
    // The number under the thumb moves on every frame of the drag, whether or not a seek is sent.
    showDestination(ms);
    const now = performance.now();
    if (now - lastSeekAt >= SEEK_INTERVAL_MS) {
      lastSeekAt = now;
      pendingMs = null;
      commit(ms);
      return;
    }
    // Between round trips the finger keeps moving; the last position is what gets sent, so the
    // seek lands where the finger stopped rather than where it was 120 ms ago.
    pendingMs = ms;
    if (trailing !== null) return;
    trailing = setTimeout(() => {
      trailing = null;
      lastSeekAt = performance.now();
      const queued = pendingMs;
      pendingMs = null;
      if (queued !== null) commit(queued);
    }, SEEK_INTERVAL_MS);
  };

  /** The finger's own reading of the bar: write the position, then show it and commit it. */
  const write = (clientX: number): void => {
    const duration = durationOf();
    if (duration <= 0) return;
    const ms = msAtX(clientX);
    input.value = String(Math.round((ms / duration) * 1000));
    applyMs(ms);
  };

  const release = (id: number | null): void => {
    if (id !== null && typeof input.releasePointerCapture === 'function') {
      try {
        input.releasePointerCapture(id);
      } catch {
        // The capture is already gone (the platform took the gesture back). Nothing to release.
      }
    }
    dragging = false;
    pointerId = null;
    owner = null;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A gesture the touch channel has already claimed is not this channel's to write (v1.8.0).
    if (owner === 'touch') return;
    /*
     * The gesture is the bar's from here, and it is the bar that will write the value.
     *
     * Capture, so every move of this finger reaches the bar even after it travels off the bar's own
     * box (a drag that leaves the control must keep seeking, not silently stop), and `preventDefault`
     * so the platform's own slider does not begin a second, relative drag underneath ours. Both
     * writers running is precisely the "nothing happens" this is fixing.
     */
    owner = 'pointer';
    dragging = true;
    pointerId = event.pointerId;
    begin();
    if (typeof input.setPointerCapture === 'function') {
      try {
        input.setPointerCapture(event.pointerId);
      } catch {
        // No capture available: moves inside the box still arrive, and the `input` path below is
        // still armed for the ones that do not.
      }
    }
    if (event.cancelable) event.preventDefault();
    write(event.clientX);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (owner !== 'pointer' || !dragging || (pointerId !== null && event.pointerId !== pointerId)) return;
    if (event.cancelable) event.preventDefault();
    write(event.clientX);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (owner !== 'pointer' || !dragging || (pointerId !== null && event.pointerId !== pointerId)) return;
    release(pointerId);
    finish();
  };

  const onPointerCancel = (): void => {
    if (owner !== 'pointer' || !dragging) return;
    release(pointerId);
    cancel();
  };

  /**
   * The touch channel: the finger's own events, and the ones this control now owns the drag on.
   *
   * v1.8.0 — everything the owner reported as "i can only tap to seek" comes from the missing writer
   * here. A real finger on a native `<input type=range>` produces no usable `pointermove` in WebKit
   * (the control's own recogniser claims the touch and the pointer stream is cancelled), so the bar
   * has to take the movement from `touchmove`, which iOS delivers for this control as for any other
   * element. Two separate things are needed and neither is optional:
   *
   *   - `write(touches[0].clientX)` on the move — the value comes from where the finger *is*, over
   *     the bar's own box, exactly the reading the tap already used;
   *   - `preventDefault()` on a **non-passive** `touchmove` — `touch-action: none` stops the page
   *     scrolling, it does not stop the range control's own drag, and letting both run is the
   *     "nothing happens" of two writers again. A passive listener cannot call `preventDefault`, so
   *     the option is part of the fix rather than a detail of it.
   *
   * The `touchstart` listener is deliberately passive and writes nothing but the value: it must not
   * prevent the default there, because the browser needs it to see this as a touch sequence at all.
   */
  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    // A second finger is a pinch or a scroll, not a seek: give the gesture up rather than fight it.
    if (event.touches.length > 1) {
      if (owner === 'touch') {
        owner = null;
        dragging = false;
        cancel();
      }
      return;
    }
    if (!touch) return;
    owner = 'touch';
    dragging = true;
    begin();
    write(touch.clientX);
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (owner !== 'touch' || !dragging) return;
    const touch = event.touches[0];
    if (!touch) return;
    if (event.cancelable) event.preventDefault();
    write(touch.clientX);
  };

  const onTouchEnd = (): void => {
    if (owner !== 'touch') return;
    owner = null;
    dragging = false;
    finish();
  };

  const onTouchCancel = (): void => {
    if (owner !== 'touch') return;
    owner = null;
    dragging = false;
    cancel();
  };

  input.addEventListener('pointerdown', onPointerDown);
  input.addEventListener('pointermove', onPointerMove);
  input.addEventListener('pointerup', onPointerUp);
  input.addEventListener('pointercancel', onPointerCancel);
  input.addEventListener('touchstart', onTouchStart, { passive: true });
  // Non-passive by necessity: this listener's `preventDefault` is what keeps the native control
  // from taking the movement the bar is measuring (see the note on `onTouchStart`).
  input.addEventListener('touchmove', onTouchMove, { passive: false });
  input.addEventListener('input', () => {
    // Our own drag is the writer for the length of the gesture; a second writer is the bug.
    if (dragging) return;
    if (durationOf() <= 0) return;
    applyMs(valueMs());
  });
  input.addEventListener('change', () => {
    if (!dragging) finish();
  });
  input.addEventListener('touchend', onTouchEnd, { passive: true });
  input.addEventListener('touchcancel', onTouchCancel, { passive: true });
}

function queueDurationMs(queue: PlaybackQueue | null): number {
  if (!queue) return 0;
  const song = queue.currentSong;
  return (song?.duration ?? 0) * 1000;
}
