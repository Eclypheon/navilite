/*
 * v2.0-beta slice A1b — the shell and the gesture, out of `app.ts`.
 *
 * Two things live here, and they are here together because they are the same subject: the bottom
 * container (`buildShell` — the header, the list box, the player bar, the now overlay and the toast
 * host, plus every listener that hangs off them), and the tap-vs-scroll authority the list and the
 * bar share (`refuseNextClick`, `refuseClick`, `bindTap`, `bindTapSurface`).
 *
 * The gesture helpers deliberately keep module-level state (`press`, `suppressClickUntil`) and are
 * not split: one drag arms exactly one refusal, and both surfaces read the same pair. `TAP_SLOP_PX`
 * and `SUPPRESS_TTL_MS` moved with them for the same reason.
 *
 * `currentHead`/`onStackedRoute`/`bindStackedBack` are the route header's own readers, which is why
 * they came too: they are what `buildShell`'s back gesture is bound to.
 *
 * The module reads `app.ts`'s refs live (`queueRef`, `queueRefRef`) and calls back into it for the
 * few things that stayed with the router (`toast`, `openNow`, `routeParts`, `DEFAULT_ROUTE`,
 * `STACKED_ROUTES`) and into `now-screen.ts` for the pager half (`settlePane`, `preparePane`,
 * `setNowMode`, `bindSeek`). That is the import cycle app.ts <-> shell.ts, and it is safe because
 * neither module touches the other's bindings while it is being evaluated — every call happens
 * inside a listener or after `boot`.
 */
import { DEFAULT_ROUTE, PANE_PLAYLIST, STACKED_ROUTES, openNow, queueRef, queueRefRef, routeParts } from './app.ts';
import type { Shell } from './context.ts';
import { ICONS, h, icon, playIcon } from './dom.ts';
import { type LyricsView } from './lyrics.ts';
import { bindSeek, preparePane, setNowMode, settlePane } from './now-screen.ts';
import { createPager } from './pager.ts';

/**
 * Pixels of movement that still counts as a tap rather than a scroll.
 *
 * v1.6.2. The number is the whole discriminator now — it was one of three in v1.6, and the other two
 * were the ones refusing real taps (see `bindTapSurface`). **8 px, measured as straight-line
 * distance**, is the canonical value for this: it is the `DRAG_SLOP` in the tap-vs-scroll research
 * this release was asked to conform to (`navilite-tap-vs-scroll-canonical.md`, §1 and §3 — "px of
 * touch movement that is still a tap"; `@use-gesture`'s `tapsThreshold` defaults to 3, Swiper uses a
 * comparable per-device number, and both are in the same order as WebKit's own slop before it gives
 * up on a tap).
 *
 * Note the direction: the app was at 10 px *per axis*, which is up to 14 px of travel diagonally,
 * so moving to the documented 8 px straight-line is **tighter**, not looser — a press-and-hold that
 * then swipes has to be recognised as a drag sooner, which is what the owner asked for. That change
 * is the one risky edit in this release (refusing a click is how v1.6 broke tapping), which is why
 * the harness now also proves a *wobbling* tap still plays: see `holdThenDrag` and `jitterTap` in
 * `tools/v16-check.mjs`.
 */
const TAP_SLOP_PX = 8;
/**
 * How long a refusal may wait for the click it belongs to.
 *
 * A refusal is armed when a gesture ends as a drag and is consumed by the *very next* click. If that
 * click never comes — WebKit claims the gesture itself and cancels the touch sequence, or the
 * browser suppresses the click on its own — the refusal has to expire rather than sit there and eat a
 * later tap. 700 ms is longer than the gap between a real drag's `touchend` and its click on every
 * engine here, and shorter than any deliberate pause between two taps.
 */
const SUPPRESS_TTL_MS = 700;


/* ------------------------------------------------------------------ shell */

export function buildShell(root: HTMLElement): Shell {
  const tabs = new Map<string, HTMLButtonElement>();
  // v1.1: two tabs, not five. Albums, Favourites and Search were removed at the owner's
  // request; search stays reachable from inside Library (see renderArtists), and the album
  // and favourites views still exist as routes for deep links.
  const tabDefs: Array<[string, string]> = [
    ['artists', 'Library'],
    ['playlists', 'Playlists'],
  ];
  const nav = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Sections' },
    tabDefs.map(([route, label]) => {
      const button = h('button', {
        class: 'tab',
        text: label,
        onclick: () => {
          location.hash = `#/${route}`;
        },
      });
      tabs.set(route, button);
      return button;
    }),
  );
  const brand = h(
    'button',
    {
      class: 'brand',
      'aria-label': 'Now playing',
      title: 'Now playing',
      onclick: () => openNow(),
    },
    [h('span', { class: 'brand-mark', text: '◧' }), h('span', { text: 'Navilite' })],
  );
  const header = h('header', { class: 'topbar' }, [
    brand,
    nav,
    h('button', { class: 'icon-button', 'aria-label': 'Settings', onclick: () => (location.hash = '#/settings') }, [
      icon(ICONS.settings),
    ]),
  ]);

  const view = h('main', { class: 'view', id: 'view' });
  /*
   * v1.4: one fixed shell plus one inner scroll container per view.
   *
   * The document does not scroll any more (see styles.css), so this box is the only thing a scroll
   * gesture can move: the header above it is a fixed row of the shell and the player bar is fixed
   * to the bottom of the screen, which is what makes "the top bar cannot grow or scroll away" true
   * by construction rather than by careful styling. Every view still draws into `.view` exactly as
   * before — the wrapper is the scroll context, not a second layout.
   */
  const viewScroll = h('div', { class: 'view-scroll' }, [view]);

  const barCover = h('div', { class: 'pb-cover' });
  const barTitle = h('span', { class: 'pb-title', text: '—' });
  const barSubtitle = h('span', { class: 'pb-sub', text: '' });
  const barPlay = h('button', { class: 'transport', 'aria-label': 'Play or pause', onclick: () => void togglePlayback() }, [
    playIcon(false),
  ]);
  const barProgress = h('input', { class: 'progress', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Seek' });
  const barPosition = h('span', { class: 'time', text: '0:00' });
  const barDuration = h('span', { class: 'time', text: '0:00' });
  const barChip = h('span', { class: 'mode-chip', text: 'idle' });
  const barReason = h('p', { class: 'pb-reason hidden', text: '' });
  const playerBar = h('footer', { class: 'playerbar hidden' }, [
    h('div', { class: 'pb-main' }, [
      barCover,
      h('div', { class: 'pb-meta' }, [barTitle, barSubtitle]),
      h('div', { class: 'pb-controls' }, [
        h('button', { class: 'transport small', 'aria-label': 'Previous', onclick: () => void queueRef?.previous() }, [
          icon(ICONS.previous),
        ]),
        barPlay,
        h('button', { class: 'transport small', 'aria-label': 'Next', onclick: () => void queueRef?.next() }, [icon(ICONS.next)]),
      ]),
    ]),
    h('div', { class: 'pb-progress', 'data-pager': 'off' }, [barPosition, barProgress, barDuration]),
    barChip,
    barReason,
  ]);

  const canvas = h('canvas', { class: 'now-canvas' });
  const visualizerHost = h('div', { class: 'now-visualizer' }, [canvas]);
  const nowCover = h('div', { class: 'now-cover' });
  const nowTitle = h('h2', { class: 'now-title', text: 'Nothing playing' });
  const nowSubtitle = h('p', { class: 'now-sub', text: '' });
  const nowContext = h('p', { class: 'now-context', text: '' });
  const nowProgress = h('input', { class: 'progress', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Seek' });
  const nowPosition = h('span', { class: 'time', text: '0:00' });
  const nowDuration = h('span', { class: 'time', text: '0:00' });
  const nowPlay = h('button', { class: 'transport big', 'aria-label': 'Play or pause', onclick: () => void togglePlayback() }, [
    playIcon(false, 26),
  ]);
  const nowShuffle = h(
    'button',
    {
      class: 'transport small toggle',
      'aria-label': 'Shuffle',
      'aria-pressed': 'false',
      onclick: () => {
        queueRef?.setShuffle(!(queueRef?.shuffle ?? false));
      },
    },
    [icon(ICONS.shuffle, 20)],
  );
  const nowRepeat = h(
    'button',
    {
      class: 'transport small toggle',
      'aria-label': 'Repeat',
      'aria-pressed': 'false',
      onclick: () => {
        queueRef?.cycleRepeat();
      },
    },
    [icon(ICONS.repeat, 20)],
  );

  const pillSpectrum = h('button', { class: 'pill-option active', text: 'Spectrum', onclick: () => setNowMode('spectrum') });
  const pillLyrics = h('button', { class: 'pill-option', text: 'Lyrics', onclick: () => setNowMode('lyrics') });
  const pill = h('div', { class: 'pill', role: 'tablist', 'aria-label': 'Spectrum or lyrics' }, [pillSpectrum, pillLyrics]);

  const lyricsHost = h('div', { class: 'now-lyrics' });
  /*
   * v1.5: the middle of the now-playing screen is a two-pane strip, and the overlay around it is
   * the window the playlist is paged past — the geometry is in `src/ui/pager.ts`, the panes are
   * here. The (x/y) line, the title block and the compact transport bar deliberately sit *outside*
   * the strip: they are the same controls on whichever pane is showing, which is what keeps them
   * working while a finger is mid-drag.
   */
  const nowPages = h('div', { class: 'now-pages' }, [
    h('div', { class: 'now-page now-page-spectrum' }, [nowCover, visualizerHost]),
    h('div', { class: 'now-page now-page-lyrics' }, [lyricsHost]),
  ]);
  const nowOverlay = h('section', { class: 'now hidden', 'aria-label': 'Now playing' }, [
    h('div', { class: 'now-top', 'data-pager': 'off' }, [
      h('button', { class: 'icon-button now-close', 'aria-label': 'Close now playing', onclick: () => closeNow() }, [
        icon(ICONS.close),
      ]),
      pill,
    ]),
    nowPages,
    nowTitle,
    nowSubtitle,
    nowContext,
    h('div', { class: 'now-progress', 'data-pager': 'off' }, [nowPosition, nowProgress, nowDuration]),
    h('div', { class: 'now-bar', 'data-pager': 'off', 'aria-label': 'Playback controls' }, [nowShuffle, h('button', {
      class: 'transport',
      'aria-label': 'Previous',
      onclick: () => void queueRef?.previous(),
    }, [icon(ICONS.previous, 22)]), nowPlay, h('button', {
      class: 'transport',
      'aria-label': 'Next',
      onclick: () => void queueRef?.next(),
    }, [icon(ICONS.next, 22)]), nowRepeat]),
  ]);

  const toastNode = h('div', { class: 'toast' });

  /*
   * The pager is built before the shell object because the shell carries it: its callbacks reach
   * the app through the same late-bound references the rest of the shell uses (`queueRefRef` is the
   * shell, `queueRef` the queue), so none of them need the shell to exist yet.
   */
  const pager = createPager({
    host: root,
    list: viewScroll,
    overlay: nowOverlay,
    strip: nowPages,
    onSettle: (position) => settlePane(position),
    onPrepare: (target) => preparePane(target),
  });

  const shell: Shell = {
    header,
    viewScroll,
    view,
    playerBar,
    nowOverlay,
    visualizerHost,
    canvas,
    toast: toastNode,
    tabs,
    barCover,
    barTitle,
    barSubtitle,
    barPlay,
    barProgress,
    barPosition,
    barDuration,
    barChip,
    barReason,
    nowCover,
    nowTitle,
    nowSubtitle,
    nowContext,
    nowProgress,
    nowPosition,
    nowDuration,
    nowPlay,
    nowShuffle,
    nowRepeat,
    lyricsHost,
    nowPages,
    pillSpectrum,
    pillLyrics,
    nowMode: 'spectrum',
    pager,
    lyrics: null as unknown as LyricsView,
    highlighted: null,
    highlightedLoading: false,
    lastBrowseRoute: DEFAULT_ROUTE,
    stackedFrom: '',
    scrubbing: false,
    scrubMs: null,
    viewRoute: null,
    scrollLocked: false,
    pendingScroll: null,
  };

  bindSeek(shell.barProgress, shell, () => queueRef);
  bindSeek(shell.nowProgress, shell, () => queueRef);
  /*
   * v2.0-beta items 3 and 4 — **the bar's own tap handler is bound in `boot`**, where the app context
   * exists, because the rules need the shell and the drawn view (`containerTap`, `./player-bar.ts`).
   *
   * What is bound *here* is the gesture authority: the bar is a tap surface in its own right, so a
   * swipe that starts on the song block is a drag and the click it leaves behind is refused. The
   * pager claims a gesture that starts on the bar — its `OWN_GESTURE` list does not name `.pb-main`
   * — so without this, the click a pane swipe leaves behind would run the container-tap rule and
   * scroll his list mid-swipe (or open the spectrum view), on a gesture that was neither.
   */
  bindTapSurface(playerBar);
  /*
   * v1.6.1: the list is the tap surface. It owns both facts a tap needs — where the finger went down,
   * and whether the list moved under it — and refuses exactly one click after a drag, once.
   * See `bindTapSurface`.
   */
  bindTapSurface(viewScroll);
  bindStackedBack(root);

  root.replaceChildren(header, viewScroll, playerBar, nowOverlay, toastNode);
  return shell;
}


function togglePlayback(): void {
  void queueRef?.toggle();
}


/** The × on the now screen: page back to the playlist he is on, through the pager. */
function closeNow(): void {
  queueRefRef.pager.goTo(PANE_PLAYLIST, { animate: true });
}


/* ------------------------------------------------------------ the gesture */

/**
 * The finger that is down on the list, and whether it has moved far enough to be a drag.
 *
 * v1.6.1: one press for the whole list, not one per row. A row cannot be the authority on "was this a
 * tap" — the touch sequence and the click it may or may not produce need not land on the same element
 * once a finger drifts a little — and a per-row copy of the state also has to be reset on
 * `touchcancel`, which v1.6 never did: a touch the engine cancelled left a row believing a press was
 * still in flight.
 */
interface Press {
  x: number;
  y: number;
  /** True once the finger travelled past {@link TAP_SLOP_PX}, or the list scrolled under it. */
  moved: boolean;
}
export let press: Press | null = null;
/**
 * The one-shot refusal: a timestamp until which the next click is refused, or 0 for "nothing armed".
 *
 * Consumed by the first click that arrives ({@link refuseClick}), so one drag can never refuse two
 * clicks, and cleared when a new finger goes down, so it can never cross into the next gesture.
 */
let suppressClickUntil = 0;


/** The gesture ended as a drag: the click it leaves behind is refused, once. */
function refuseNextClick(): void {
  suppressClickUntil = performance.now() + SUPPRESS_TTL_MS;
}

/**
 * Is this click the one a drag left behind? Always consumes the refusal — armed or expired, it never
 * survives this call.
 */
function refuseClick(now: number): boolean {
  if (suppressClickUntil === 0) return false;
  const refuse = now <= suppressClickUntil;
  suppressClickUntil = 0;
  return refuse;
}

/**
 * Activate an element on a click, and on nothing else.
 *
 * The click is the browser's own, so a thumb, a keyboard Enter, a switch control, a VoiceOver
 * double-tap and a script all arrive by the same door. Nothing is reconstructed from touch maths: that
 * was v1.6's mistake — it rebuilt a tap out of `touchstart`/`touchmove`/`touchend`, and the two
 * thresholds it invented (a press longer than 700 ms, and *any* `scroll` event during the press)
 * refused taps that a synthetic one-pixel tap never produces but a real thumb produces constantly.
 *
 * What can be refused is the click a drag leaves behind, and that is decided once, on the surface the
 * rows sit on — see {@link bindTapSurface}. A click with no drag in front of it cannot be refused: by
 * construction nothing arms the refusal for it.
 */
export function bindTap<T extends HTMLElement>(element: T, activate: () => void): T {
  element.addEventListener('click', () => activate());
  return element;
}

/**
 * The tap surface: the scroll container every row lives in. It owns the only two facts a tap needs.
 *
 *   - where the finger went down, so {@link TAP_SLOP_PX} of travel can be told from a still finger;
 *   - whether the list moved, which is a scroll however still the finger was.
 *
 * A gesture that did either arms {@link refuseNextClick} — a one-shot consumed by the very next click
 * and expired by {@link SUPPRESS_TTL_MS}, so it can never eat a later tap. The click is read in the
 * capture phase, so a refused one never reaches the row's own handler.
 *
 * Note what is deliberately *not* here: any judgement of a press by how long it lasted. v1.6 refused a
 * click when the press had been down for more than 700 ms from `touchstart` — and WebKit delivers the
 * click *after* `touchend` — so a deliberate tap, or a tap WebKit spent a moment deciding about, was
 * refused for being slow rather than for being a drag. That is the plainest way "tapping does nothing"
 * becomes *"i'm not even able to tap to go into my playlist"*.
 */
function bindTapSurface(surface: HTMLElement): void {
  surface.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1) {
        press = null;
        return;
      }
      // A new finger supersedes the last gesture: any click still to come belongs to this press.
      suppressClickUntil = 0;
      press = { x: touch.clientX, y: touch.clientY, moved: false };
    },
    { passive: true },
  );
  surface.addEventListener(
    'touchmove',
    (event) => {
      const active = press;
      if (!active) return;
      const touch = event.touches[0];
      if (!touch) return;
      if (Math.hypot(touch.clientX - active.x, touch.clientY - active.y) > TAP_SLOP_PX) {
        active.moved = true;
      }
    },
    { passive: true },
  );
  /*
   * The list moved under a finger that did not — momentum from a flick, or the scroller settling.
   * That is a scroll, not a tap, and it is the case a movement threshold alone cannot see. Only a
   * scroll *while a finger is down* counts: engines deliver scroll events coalesced and late, and a
   * scroll from before this press must not be read as part of it.
   */
  surface.addEventListener(
    'scroll',
    () => {
      if (press) press.moved = true;
    },
    { passive: true },
  );
  const release = (): void => {
    const ended = press;
    press = null;
    if (ended?.moved) refuseNextClick();
  };
  surface.addEventListener('touchend', release, { passive: true });
  // WebKit fires `touchcancel` the moment it claims a touch sequence for itself. v1.6 had no handler
  // here at all, which left a row convinced that a press was still in flight.
  surface.addEventListener('touchcancel', release, { passive: true });
  surface.addEventListener(
    'click',
    (event) => {
      /*
       * Only a *user's* click can be the one a drag left behind, and only a user's click is refused.
       *
       * `isTrusted` is the whole distinction: a click the browser delivers — from a thumb, a mouse, a
       * keyboard Enter, a switch control — is trusted, and WebKit's click at the end of a drag is one
       * of those. A click a script synthesises (`element.click()`) is not a gesture at all, and
       * refusing it would take the rows away from every diagnostic that drives them — measured here,
       * not reasoned: an untrusted click arriving inside the refusal's 700 ms window was eaten, which
       * is what `test/pager.test.ts` and `test/scroll-containment.test.ts` caught within a minute of
       * this being written.
       */
      if (!event.isTrusted) return;
      if (!refuseClick(performance.now())) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}

/** The route the app is on right now, by its first segment. */
function currentHead(): string {
  return routeParts()[0] ?? 'artists';
}

/** True when the screen on top is a stacked one (settings, the changelog, the connect form). */
function onStackedRoute(): boolean {
  return STACKED_ROUTES.has(currentHead());
}

/**
 * v1.6: from a stacked screen, a right swipe is *back* — and it is the only horizontal gesture that
 * does anything there, because settings is not a pane of the pager (see `renderRoute`, which gates
 * `pager.setEnabled`). The owner's words: *"when im in settings, swiping left or right seems to bring
 * me to the spectrum or lyrics. this should not be the case, i should only be able to swipe right to
 * return to the previous screen which i accessed settings from."*
 *
 * It reads the recorded opener rather than `history.back()`, so it still works on the first screen
 * after a cold start (where back would leave the app).
 */
function bindStackedBack(host: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  host.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      tracking = Boolean(touch) && event.touches.length === 1 && onStackedRoute();
      if (!touch || !tracking) return;
      startX = touch.clientX;
      startY = touch.clientY;
    },
    { passive: true },
  );
  host.addEventListener(
    'touchend',
    (event) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      // Right, mostly horizontal, and far enough to be meant.
      if (dx < 60 || dx < Math.abs(dy) * 1.4) return;
      const target = queueRefRef?.stackedFrom;
      if (target) location.hash = target;
    },
    { passive: true },
  );
}
