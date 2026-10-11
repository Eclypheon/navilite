/**
 * The swipe pager behind the now-playing screen — the app's three screens on one strip.
 *
 * The owner's words were *"swiping left or right should transition the screens smoothly and appear
 * like it is pulling in the screen from the side rather than a sudden change in the screen after
 * the scroll"*, with the order **playlist | spectrum | lyrics**.
 *
 * ## What moves
 *
 * Only two things are ever transformed, and never by a post-hoc animation — the transform is
 * written on every `touchmove`, from the finger's own position, so the incoming pane is dragged in
 * under the finger and released with its velocity:
 *
 *   - the list (`.view-scroll`), which is pane 0 and lives in the shell, and
 *   - the now-playing overlay (`.now`), which is a window over a two-pane strip
 *     (`.now-pages` → spectrum | lyrics).
 *
 * When the drag crosses between the playlist and the now screen the list and the window move
 * together, in opposite directions, by the same distance: their edges meet exactly, so the incoming
 * screen is *pulled in from the side* the same way a push transition does, and no gap (and no empty
 * space) is ever exposed. When the drag crosses between the spectrum and the lyrics the window
 * stays put and the strip slides inside it.
 *
 * ## The range is a ring, not a line
 *
 * The three transitions the owner listed — left from the spectrum lands on the lyrics, left from
 * the lyrics lands on the playlist, right from the spectrum lands on the playlist — are exactly the
 * transitions of a *cyclic* three-pane pager, so that is what this is: the panes are positions 0,
 * 1, 2 modulo 3, and there is no end of the range to expose an empty screen at. Dragging further
 * than one pane past either direction resists (30 % of the finger's travel) rather than sliding
 * into nothing, and a gesture moves at most one pane.
 *
 * ## The axis lock
 *
 * A mostly-vertical gesture is a scroll and must never move the pager: the first movement past
 * ~10 px picks an axis, and a vertical pick means the pager ignores the rest of the gesture
 * completely (no transform, no `preventDefault`). This is the bug the owner keeps hitting in
 * another form, so it is asserted in `tools/pager-check.mjs` with a real vertical drag over a
 * scrollable pane.
 *
 * ## Origin
 *
 * The `mode` reported is the pane the pager is *resting* on; `offset` is the continuous position
 * including the finger, so a harness can prove the panes followed the finger rather than jumping.
 */

export type PagerMode = 'playlist' | 'spectrum' | 'lyrics';

export interface PagerState {
  /** The pane the pager is resting on: 0 playlist, 1 spectrum, 2 lyrics. */
  position: number;
  /** The continuous position, finger included. Equal to `position` at rest. */
  offset: number;
  /** True while a horizontal drag is in progress. */
  dragging: boolean;
  /** True when no animation is in flight and nothing is being dragged. */
  settled: boolean;
  /** The three transforms, in CSS px, as they are actually applied. */
  translate: { list: number; overlay: number; strip: number };
  mode: PagerMode;
}

export interface PagerOptions {
  /** The element the whole app lives in: the gesture surface. */
  host: HTMLElement;
  /** The app's one scroll container — pane 0. */
  list: HTMLElement;
  /** The now-playing overlay — the window over the strip. */
  overlay: HTMLElement;
  /** The strip inside the overlay: spectrum | lyrics. */
  strip: HTMLElement;
  /** Called when the pager comes to rest, with the pane it rests on. Drives the route. */
  onSettle(position: number): void;
  /**
   * Called once per gesture, when a drag is first read as horizontal, with the pane it is heading
   * for. The app uses it to ready that pane (the lyrics are fetched, the spectrum's canvas sized)
   * so the incoming screen is not empty as it arrives.
   */
  onPrepare?(target: number): void;
}

export interface Pager {
  /** Animate (or jump) to a pane. */
  goTo(position: number, options?: { animate?: boolean }): void;
  /** The now screen is showing on this pane. A rest on the same pane is a no-op. */
  show(position: number): void;
  /** The now screen closed: everything goes back to pane 0, with no animation. */
  hide(): void;
  /** Re-read the width (a rotation, a resize, the keyboard closing). */
  measure(): void;
  /**
   * v1.6: is the gesture surface live at all?
   *
   * Not every screen is part of the pager. Settings and the changelog are *stacked* screens — you
   * opened one from somewhere, and you go back to it — so a horizontal drag there must do nothing
   * whatsoever: not move a pane, not claim the gesture, not `preventDefault`. Disabling also drops
   * an interrupted drag and clears the transforms, so a gate that flips mid-gesture cannot leave the
   * strip translated behind a screen that is not part of the pager.
   */
  setEnabled(enabled: boolean): void;
  state(): PagerState;
}

const SPECTRUM = 1;
/** Panes are numbered modulo three: the playlist, the spectrum and the lyrics form a ring. */
const PANES = 3;
/** Pixels of movement before the gesture picks an axis at all. */
const AXIS_THRESHOLD_PX = 10;
/** How much more vertical than horizontal a gesture has to be to count as a scroll. */
const AXIS_RATIO = 1.1;
/** Beyond one pane of travel the extra distance is resisted to this fraction. */
const OVERSHOOT = 0.3;
/** The fraction of a pane a drag has to cover (or project to) to commit to the next pane. */
const COMMIT = 0.32;
/** A flick is projected this far ahead when deciding, so a short fast swipe still turns a page. */
const PROJECTION_MS = 140;

function widthOf(element: HTMLElement): number {
  return element.clientWidth || element.getBoundingClientRect().width || 0;
}

function translateXOf(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === 'none') return 0;
  try {
    return new DOMMatrixReadOnly(transform).m41;
  } catch {
    return 0;
  }
}

/** Beyond one pane, the finger keeps moving but the panes do not move as far. */
function resisted(panes: number): number {
  if (Math.abs(panes) <= 1) return panes;
  return Math.sign(panes) * (1 + (Math.abs(panes) - 1) * OVERSHOOT);
}

/** Panes are a ring: −1 is the lyrics, 3 is the playlist again. */
function wrap(position: number): number {
  return ((position % PANES) + PANES) % PANES;
}

export function createPager(options: PagerOptions): Pager {
  const { host, list, overlay, strip } = options;
  let position = 0;
  let drag = 0;
  let dragging = false;
  let animating = false;
  let frame = 0;
  /** v1.6: false on a stacked screen (settings, the changelog), where no pane is behind. */
  let enabled = true;
  let width = widthOf(host) || window.innerWidth;

  interface Gesture {
    startX: number;
    startY: number;
    lastX: number;
    lastAt: number;
    /** px per ms, the finger's own speed, so a flick can be read at release. */
    velocity: number;
    axis: 'none' | 'x' | 'y';
  }
  let gesture: Gesture | null = null;

  const setTransform = (element: HTMLElement, px: number): void => {
    element.style.transform = Math.abs(px) < 0.05 ? '' : `translate3d(${px.toFixed(2)}px, 0, 0)`;
  };

  /**
   * Paint the pager at a continuous offset.
   *
   * Each segment is a pair of transforms that tile the screen with no gap: what leaves on one side
   * is exactly what arrives from the other. `base` is the whole pane the drag started from, so the
   * geometry is written once per segment rather than once per pane pair.
   */
  const render = (offset: number): void => {
    const base = Math.floor(offset);
    const frac = offset - base;
    let overlayX: number;
    let listX: number;
    let stripX: number;
    if (base <= -1) {
      // Dragging right off the playlist: the lyrics arrive from the left, the list leaves right.
      overlayX = -frac;
      listX = 1 - frac;
      stripX = -1;
    } else if (base === 0) {
      // The playlist and the spectrum: both layers move, in opposite directions.
      overlayX = 1 - frac;
      listX = -frac;
      stripX = 0;
    } else if (base === 1) {
      // Inside the now screen: the window is fixed and the strip slides under it.
      overlayX = 0;
      listX = -1;
      stripX = -frac;
    } else if (base === 2) {
      // Dragging left off the lyrics, round the ring: the playlist arrives from the right.
      overlayX = -frac;
      listX = 1 - frac;
      stripX = -1;
    } else {
      // A full turn: past the playlist again, the spectrum arrives from the right.
      overlayX = 1 - frac;
      listX = -frac;
      stripX = 0;
    }
    setTransform(list, listX * width);
    setTransform(overlay, overlayX * width);
    setTransform(strip, stripX * width);
  };

  /** Where the pager is, continuously: the resting pane plus the finger's travel. */
  const offsetNow = (): number => position + drag;

  const stop = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    animating = false;
  };

  /** Put the transform back to the exact resting state, and forget it while closed. */
  const rest = (): void => {
    render(position);
    if (position === 0) list.style.transform = '';
  };

  const finish = (target: number): void => {
    stop();
    position = wrap(target);
    drag = 0;
    dragging = false;
    rest();
    options.onSettle(position);
  };

  const animateTo = (target: number): void => {
    const from = offsetNow();
    const distance = Math.abs(target - from);
    if (distance < 0.001) {
      finish(target);
      return;
    }
    stop();
    animating = true;
    const duration = Math.min(340, 150 + distance * 190);
    /*
     * The clock starts at the *first frame's own timestamp*, not at `performance.now()` here.
     *
     * A frame that was already being prepared when this was scheduled hands its callback a
     * timestamp from before this line ran, and a negative progress is not a rounding detail: the
     * ease is cubic, so 17 % early is −61 % of a pane — a screen and a half in the wrong direction,
     * out of nowhere. Measured, that is exactly what happened on the first frame of the opening
     * animation (offset −0.614 where it should have been 0), and it is the "sudden change in the
     * screen" the owner is asking to be rid of. Clamping progress and taking the start from the
     * frame also makes the first frame paint exactly at `from`, which is what the drag left behind.
     */
    let startedAt: number | null = null;
    const step = (now: number): void => {
      if (startedAt === null) startedAt = now;
      const progress = Math.max(0, Math.min(1, (now - startedAt) / duration));
      const eased = 1 - (1 - progress) ** 3;
      const offset = from + (target - from) * eased;
      position = Math.floor(offset);
      drag = offset - position;
      render(offset);
      if (progress < 1) frame = requestAnimationFrame(step);
      else finish(target);
    };
    frame = requestAnimationFrame(step);
  };

  const readyFor = (target: number): void => {
    if (typeof options.onPrepare === 'function') options.onPrepare(wrap(target));
  };

  const beginDrag = (): void => {
    stop();
    dragging = true;
    drag = 0;
  };

  const moveDrag = (panes: number): void => {
    drag = resisted(panes);
    render(offsetNow());
  };

  const settle = (panes: number, velocityPanes: number): void => {
    const projected = panes + velocityPanes * PROJECTION_MS;
    const stepForward = projected >= COMMIT;
    const stepBack = projected <= -COMMIT;
    const target = position + (stepForward ? 1 : stepBack ? -1 : 0);
    animateTo(target);
  };

  /* ---------------------------------------------------------------- gestures */

  /** Controls that own their own horizontal gesture: a slider, a text field, a select. */
  const ownsGesture = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return target.closest('input, textarea, select, [data-pager="off"]') !== null;
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (!enabled || event.touches.length !== 1 || ownsGesture(event.target)) {
      gesture = null;
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    // A second finger while a drag is running is a pinch, not a page turn.
    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastAt: performance.now(),
      velocity: 0,
      axis: 'none',
    };
  };

  const onTouchMove = (event: TouchEvent): void => {
    const active = gesture;
    if (!active) return;
    const touch = event.touches[0];
    if (!touch) return;
    if (active.axis === 'y') return;
    const dx = touch.clientX - active.startX;
    const dy = touch.clientY - active.startY;
    if (active.axis === 'none') {
      if (Math.abs(dx) < AXIS_THRESHOLD_PX && Math.abs(dy) < AXIS_THRESHOLD_PX) return;
      /*
       * The axis lock. Whichever way the gesture is mostly going on its first real movement owns
       * the rest of it: a vertical pick hands the gesture back to the browser untouched (the pane
       * is a scroll container and this listener never calls preventDefault for it), and a
       * horizontal pick is the pager's.
       */
      if (Math.abs(dy) >= Math.abs(dx) * AXIS_RATIO || Math.abs(dx) <= Math.abs(dy)) {
        active.axis = 'y';
        return;
      }
      active.axis = 'x';
      beginDrag();
      readyFor(position + (dx < 0 ? 1 : -1));
    }
    // Claimed: stop the browser from doing anything else with it (a scroll, an edge swipe).
    if (event.cancelable) event.preventDefault();
    const now = performance.now();
    const elapsed = Math.max(1, now - active.lastAt);
    active.velocity = (touch.clientX - active.lastX) / elapsed;
    active.lastX = touch.clientX;
    active.lastAt = now;
    moveDrag(-dx / width);
  };

  const onTouchEnd = (event: TouchEvent): void => {
    const active = gesture;
    gesture = null;
    if (!active || active.axis !== 'x') return;
    const touch = event.changedTouches[0];
    if (!touch) {
      settle(drag, 0);
      return;
    }
    // The release position, not the last move: a finger that travelled between events still counts.
    const panes = resisted(-(touch.clientX - active.startX) / width);
    settle(panes, -active.velocity / width);
  };

  const onTouchCancel = (): void => {
    const active = gesture;
    gesture = null;
    if (!active || active.axis !== 'x') return;
    settle(drag, 0);
  };

  const onResize = (): void => {
    width = widthOf(host) || window.innerWidth;
    stop();
    drag = 0;
    dragging = false;
    rest();
  };

  host.addEventListener('touchstart', onTouchStart, { passive: true });
  host.addEventListener('touchmove', onTouchMove, { passive: false });
  host.addEventListener('touchend', onTouchEnd, { passive: true });
  host.addEventListener('touchcancel', onTouchCancel, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });

  return {
    goTo(target, opts = {}) {
      const wrapped = wrap(target);
      if (opts.animate === false) {
        stop();
        position = wrapped;
        drag = 0;
        dragging = false;
        rest();
        options.onSettle(position);
        return;
      }
      if (dragging) return;
      const from = offsetNow();
      const base = Math.floor(from);
      if (Math.abs(from - wrapped) < 0.001 && !animating) return;
      // Animate through the segment the current offset is in, so the panes still arrive from the
      // side rather than cross-fading, and take the short way round the ring.
      animateTo(base + shortestStep(wrap(base), wrapped));
    },
    show(target) {
      const wrapped = wrap(target);
      if (!dragging && wrapped === position && !animating) {
        // Already there: make sure a half-finished drag left nothing behind.
        rest();
        return;
      }
      this.goTo(wrapped);
    },
    hide() {
      /*
       * Never an early return here. A resting position of 0 does *not* mean nothing is in flight —
       * the first frame of an opening animation is also at offset 0 — and letting that one run is
       * what put the now screen back on screen a third of a second after the app had already
       * navigated away from it: the animation finished, reported its pane, and the route followed it.
       */
      stop();
      position = 0;
      drag = 0;
      dragging = false;
      render(0);
      list.style.transform = '';
    },
    measure() {
      onResize();
    },
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      if (next) return;
      // Off a pager surface: forget the gesture and any animation in flight, and put the panes back
      // where pane 0 is with nothing transformed. A gesture that was mid-drag when the route
      // changed must not leave the strip sitting a third of a screen off.
      gesture = null;
      dragging = false;
      stop();
      position = 0;
      drag = 0;
      render(0);
      list.style.transform = '';
    },
    state() {
      return {
        position: wrap(position),
        offset: Math.round(offsetNow() * 1000) / 1000,
        dragging,
        settled: !dragging && !animating,
        translate: {
          list: Math.round(translateXOf(list) * 100) / 100,
          overlay: Math.round(translateXOf(overlay) * 100) / 100,
          strip: Math.round(translateXOf(strip) * 100) / 100,
        },
        mode: position === 0 ? 'playlist' : position === SPECTRUM ? 'spectrum' : 'lyrics',
      };
    },
  };
}

/**
 * From one pane to another on a ring: the short way round, which is never more than one pane for
 * `LYRICS → playlist` (2 → 0 is +1, not −2).
 */
function shortestStep(from: number, to: number): number {
  let step = to - from;
  if (step > 1) step -= PANES;
  if (step < -1) step += PANES;
  return step;
}
