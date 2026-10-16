/*
 * The bottom container: the player bar's own DOM writes.
 *
 * Sliced out of `app.ts` (v2.0-beta, slice A4). It was the last 233 lines of a 3,455-line file, and
 * every card that touched the bar had to read the whole file to find them; the contract is
 * unchanged — it reads `EngineStatus` and `Shell` and writes DOM, nothing else.
 *
 * The bar's *tap* rules live here too (v2.0-beta items 3 and 4): which region of the container is
 * a tap at all, and what a tap on the song block does. See `containerTap`.
 */
import type { EngineStatus } from '../player/engine-contract.ts';
import type { PlaybackQueue } from '../state/queue.ts';
import { ICONS, cover, formatTime, icon, playIcon, replace } from './dom.ts';
import type { AppContext, Shell } from './context.ts';

/**
 * The playing track is marked wherever it appears in a list. Cheap and to the point: one
 * class toggle per visible row, driven from the player-bar update that already runs.
 */
export function updateRowHighlight(ctx: AppContext, shell: Shell, status?: EngineStatus): void {
  const current = ctx.queue?.currentSong?.id ?? null;
  /*
   * v1.9.0: while a tap is being answered, the row it landed on says so. The loading state has to
   * be visible *in the paint the tap produces* — a tap that shows nothing for seconds reads as a
   * dead screen — and `queue.isLoading` is true from that same synchronous paint until the engine
   * has the stream.
   *
   * v1.9.7 — the status is *handed in* when the caller has one. `updatePlayerBar` is called with the
   * status on every event the engine emits (a dozen a second while playing) and then asked the
   * engine for the same object again here; the render paths that call this without one still read
   * it for themselves, because they have no status to pass.
   */
  const loading = (ctx.queue?.isLoading ?? false) || (status ?? ctx.engine.status()).state === 'loading';
  if (current === shell.highlighted && loading === shell.highlightedLoading) {
    if (current !== null) markRows(ctx, current);
    return;
  }
  for (const [id, rows] of ctx.rows) {
    for (const row of rows) {
      row.classList.toggle('playing', id === current);
      row.classList.toggle('loading', id === current && loading);
    }
  }
  shell.highlighted = current;
  shell.highlightedLoading = loading;
}

function markRows(ctx: AppContext, id: string): void {
  for (const row of ctx.rows.get(id) ?? []) row.classList.add('playing');
}

/* ------------------------------------------------------------- player bar */

export function updatePlayerBar(ctx: AppContext, shell: Shell, status: EngineStatus): void {
  const song = ctx.queue?.currentSong ?? null;
  const visible = song != null;
  /*
   * v1.9.0: the loading state is a thing the screen shows, not a thing that is inferred from a
   * stalled transport. `queue.isLoading` is set by the tap's own synchronous paint, so the row,
   * the bar and the now screen carry it from the instant of the tap until the engine has the
   * stream. Nothing here waits on the network: this function reads state and writes classes.
   */
  const loading = (ctx.queue?.isLoading ?? false) || status.state === 'loading';
  /**
   * v1.9.0 — the cap, where the owner can see it.
   *
   * *"never silently cap quality"*: when the app is asking Navidrome for a smaller stream (because
   * the link measured slow) the bar says so, next to the mode. On a fast link this is `null` and
   * nothing is shown because nothing is capped — the original file plays.
   */
  const cap = ctx.queue?.streamKbps ?? null;
  shell.playerBar.classList.toggle('loading', loading);
  shell.nowOverlay.classList.toggle('loading', loading);
  shell.playerBar.classList.toggle('hidden', !visible);
  updateRowHighlight(ctx, shell, status);
  if (!visible) return;

  const coverUrl = ctx.library?.coverUrl(song.coverArt ?? song.albumId, 256) ?? null;
  const durationMs = status.durationMs || (song.duration ?? 0) * 1000;
  const positionMs = Math.min(status.positionMs, durationMs || status.positionMs);

  if (shell.barCover.dataset.song !== song.id) {
    shell.barCover.dataset.song = song.id;
    replace(shell.barCover, cover(coverUrl, 'pb-art', song.album ?? song.title));
    replace(shell.nowCover, cover(ctx.library?.coverUrl(song.coverArt ?? song.albumId, 512) ?? null, 'now-art', song.album ?? song.title));
    shell.lyrics.show(shell.nowMode === 'lyrics' ? song : null);
  }

  shell.barTitle.textContent = song.title;
  shell.barSubtitle.textContent = [song.artist, song.album].filter(Boolean).join(' · ');
  shell.nowTitle.textContent = song.title;
  shell.nowSubtitle.textContent = [song.artist, song.album].filter(Boolean).join(' · ');
  shell.nowContext.textContent = contextLine(ctx.queue);

  /*
   * v1.9.7 — **the play glyph is rebuilt only when the playing-ness changed.**
   *
   * This runs on every status event, and while a track plays the player reports a dozen of those a
   * second: two `replace()` calls (a `replaceChildren` and a fresh SVG each) to draw the same glyph
   * again. The repeat button below already shows the pattern — the state is kept in `dataset` and the
   * icon is rebuilt on the change, not on the event.
   */
  const playing = status.state === 'playing';
  if (shell.barPlay.dataset.playing !== String(playing)) {
    shell.barPlay.dataset.playing = String(playing);
    replace(shell.barPlay, playIcon(playing));
    replace(shell.nowPlay, playIcon(playing, 26));
  }

  // Shuffle and repeat are state, not icons that lie: pressed = on, and repeat cycles
  // off → all → one with the icon following.
  const shuffle = ctx.queue?.shuffle ?? false;
  shell.nowShuffle.classList.toggle('on', shuffle);
  shell.nowShuffle.setAttribute('aria-pressed', String(shuffle));
  const repeat = ctx.queue?.repeat ?? 'off';
  shell.nowRepeat.classList.toggle('on', repeat !== 'off');
  shell.nowRepeat.setAttribute('aria-pressed', String(repeat !== 'off'));
  shell.nowRepeat.setAttribute('aria-label', repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one');
  if (shell.nowRepeat.dataset.mode !== repeat) {
    shell.nowRepeat.dataset.mode = repeat;
    replace(shell.nowRepeat, icon(repeat === 'one' ? ICONS.repeatOne : ICONS.repeat, 20));
  }

  if (shell.scrubbing && shell.scrubMs !== null) {
    /*
     * A finger is on a seek bar: the label is the *destination*, not the position (v1.7.2). Written
     * here as well as on every move, so a status event that lands mid-drag cannot pull the number
     * back out from under the thumb.
     */
    const text = formatTime(shell.scrubMs / 1000);
    shell.barPosition.textContent = text;
    shell.nowPosition.textContent = text;
  } else if (!shell.scrubbing) {
    const ratio = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
    shell.barProgress.value = String(Math.round(ratio * 1000));
    shell.nowProgress.value = String(Math.round(ratio * 1000));
    shell.barPosition.textContent = formatTime(positionMs / 1000);
    shell.nowPosition.textContent = formatTime(positionMs / 1000);
  }
  shell.barDuration.textContent = formatTime((durationMs || 0) / 1000);
  shell.nowDuration.textContent = formatTime((durationMs || 0) / 1000);

  /*
   * v1.9.6 — **the chip's third word.** v1.9.26 — **and it is the engine's word now, not this
   * file's.**
   *
   * This used to be built here, out of three fields:
   *
   *     status.spectrum ? 'spectrum' : status.spectrumArming ? 'spectrum…' : status.backend === 'native' ? 'native audio' : 'theme'
   *
   * — and that third branch is a capability claim reached **by elimination**. `spectrumArming` is
   * only reported while a native track is *playing*, so every state that is not playing fell through
   * to *native audio*, which is the word for *"the spectrum cannot run on the item playing now"*:
   * `paused`, `ended`, `interrupted` and "between two tracks" all read it. The owner's screenshot on
   * a playlist page (a track paused at 1:28 / 4:55, chip `NATIVE AUDIO`, line `paused · native ·
   * spectrum off`) is that branch, and *"it keeps flashing to native audio"* is what it does at every
   * pause and every change on those screens.
   *
   * So the word is one fact about the item in hand, computed once in the engine
   * (`EngineStatus.visualiser`, `src/player/engine.ts`) from facts only the engine has — the state,
   * the backend, whether the bars are being fed, whether the tap is being asked, and whether this
   * build can measure this item at all. **This file prints it and nothing else**, so the bar and
   * anything else that shows the mode read one source and cannot disagree. What each word means is
   * documented where it is decided (`VisualiserWord`).
   */
  const chip = status.visualiser;
  shell.barChip.textContent = loading ? 'loading…' : `${chip.word}${cap === null ? '' : ` · ${cap} kbps`}`;
  /*
   * The tone is the engine's too, and the loading word — the tap's own, and the one this file owns
   * because its input (`queue.isLoading`, the synchronous paint of v1.9.0) is the queue's — wears the
   * neutral `stopped` colour: a load is neither a measurement nor a fallback, and it has never been
   * a failure.
   */
  shell.barChip.className = `mode-chip ${loading ? 'stopped' : chip.tone}${cap === null ? '' : ' capped'}`;

  /*
   * v1.9.5 — **the app says its own reason, on the screen.**
   *
   * The boundary failure this release exists for reproduces only on the owner's phone, and three
   * rounds of diagnosis were made from source alone — which is why the chip's own evidence was
   * never available: `native audio` was what this chip said for *every* state that is not playing
   * (v1.9.26 moved the word into the engine, so it no longer says that), and `modeReason` has been
   * written in seventeen places and read by no screen at all.
   *
   * So the line carries the whole account at once: the machine's state, the engine that is behind
   * it, whether the spectrum is actually fed, what the *player* last said (its own state, its own
   * reason, and where it thinks it is against its own duration), what the boundary's adoption did,
   * and how many of the bridge's own events were discarded and why. Every one of those is a fact
   * this app already had and never showed.
   *
   * It is shown whenever the state is not a healthy, playing, spectrum-fed track, so it costs the
   * layout nothing in the case that is working and is on the screen in every case that is not. The
   * chip's tooltip carries it always.
   */
  const detail =
    `${status.state} · ${status.backend} · spectrum ${status.spectrum ? 'live' : 'off'} · ` +
    `${status.pluginState === null ? 'player: nothing reported yet' : `player: ${status.pluginState}`} · ` +
    `adopt: ${status.adoptOutcome} · warm: ${status.warmedIds.length} · ` +
    /* v1.9.25 — **the tap's own numbers**, which no build has ever put on the screen: this item's
     * frames, the plugin's two counters and the two slot names. The defect this line exists for is
     * decided by exactly these — `frames/item` standing still while the audio plays is a tap that has
     * stopped measuring, `tapped` ≠ `audible` is a tap on another player, and `frames/item` growing
     * while the bars are flat is the drawing rather than the tap. The engine's sentence
     * (`modeReason`) says what the app concluded; these say what the phone did. */
    `tap: +${status.tap.framesForItem} frames/item · ` +
    `installs ${status.tap.installs ?? '—'}/verifies ${status.tap.verifies ?? '—'} · ` +
    `tapped ${status.tap.tapped ?? '—'} (audible ${status.tap.audible ?? '—'}) · ` +
    `plugin frames ${status.tap.pluginFrames ?? '—'} (${status.tap.pluginItemFrames ?? '—'} for this item) · ` +
    /* v1.9.26 — **the tap's own pace**, the pair the drawing rule is judged on: the period the plugin
     * declared for this item at `prepare` (`maxFrames` over the sample rate) and the age of the frame
     * it is holding. The bars are drawn while the age is no longer than the period, so these two
     * numbers *are* the rule — and the real period is a fact about his phone that no build has ever
     * printed. Both `—` on a build whose plugin does not publish them. */
    `tap pace ${status.tap.framePeriodMs ?? '—'} ms/frame (register ${status.tap.frameAgeMs ?? '—'} ms old) · ` +
    // v1.9.8 — the native player's own boundary: how many slots it will play by itself while the
    // app is away, how many tracks it has taken, and the sentence naming which state it is in.
    `native: ${status.nativeBoundary.armed} armed, ${status.nativeBoundary.advances} taken, ` +
    `${status.nativeBoundary.failures} refused, ${status.nativeBoundary.ignored} ignored · ` +
    `dropped: ${status.droppedEvents.inaudible} inaudible, ${status.droppedEvents.slotGrace} in a slot write · ${status.modeReason}`;
  const abnormal = status.state !== 'playing' || !status.spectrum;
  /*
   * v1.9.7 — **both writes are made only when the sentence changed.**
   *
   * This function runs on every status event and the player emits a dozen of them a second, so a
   * playing track rewrote the same tooltip and the same (hidden) reason line sixty times a minute.
   * The string itself is assembled in memory and costs nothing; the *writes* are what cost — the
   * tooltip is one attribute write and the reason line is a text mutation the moment it is visible,
   * which is exactly the state the reason line exists for. Compared against what is already set, and
   * assigned only on a difference.
   */
  if (shell.barChip.title !== detail) shell.barChip.title = detail;
  const reason = abnormal ? detail : '';
  if (shell.barReason.textContent !== reason) shell.barReason.textContent = reason;
  /*
   * v1.9.28 — **the reason line is not shown any more.** Showing it added a row to this grid, so
   * the whole bottom container grew and shrank every time the spectrum was picked up or lost — the
   * owner's report. The text and the chip's tooltip still carry the diagnostic; the bar keeps one size.
   */

  shell.lyrics.position(positionMs);
}

/** `Playing from {playlist} (x/y)` — x is the track's position in that playlist. */
function contextLine(queue: PlaybackQueue | null): string {
  if (!queue) return '';
  const context = queue.queueContext;
  const name = context?.name ?? 'your queue';
  const total = queue.length;
  const at = queue.songPosition;
  if (total === 0 || at < 0) return `Playing from ${name}`;
  return `Playing from ${name} (${at + 1}/${total})`;
}

/* ------------------------------------------------------ what a tap here means */

/**
 * **Which region of the bottom container a tap landed in** (v2.0-beta, item 3).
 *
 * The guard this replaces was a **tag list** — `closest('button, input')` — so every part of the
 * container that is not a button or the seek input navigated to the now screen: the elapsed and
 * duration labels beside the seek bar, the 12 px gap inside `.pb-main`, the gaps the grid puts
 * around `.pb-controls`, the chip, the reason line and the footer's own padding. *A tap anywhere in
 * the transport area counts as a container tap* is the owner's report, and it is what that guard
 * does.
 *
 * The regions are the two elements that mean something, and nothing else:
 *
 *   - `.pb-cover` and `.pb-meta` — **the song block, and the only container tap** (`containerTap`);
 *   - `.pb-controls` — the three transport buttons, each with its own `onclick` (pause/play, next,
 *     previous). They never navigate and never count as a container tap in any view, and neither do
 *     the gaps *inside* that row: a tap between two of them does nothing. They no longer depend on a
 *     container handler's guard at all, so a future change to one cannot silently re-enable
 *     navigation from the other;
 *   - `.pb-progress` — the range input seeks, and its two `time` labels do nothing (they navigate
 *     today, which is the proven defect);
 *   - everything else — the chip, the reason line, the padding, the grid gaps — is inert.
 */
export function isContainerTap(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.pb-cover, .pb-meta') !== null;
}

/**
 * The playing song's own row on *this* view, in document order, or null.
 *
 * `ctx.rows` is the registry of the rows the current render drew and it is cleared at the top of
 * every route render, so a row registered by a view the owner has left can never answer this. The
 * first row in document order answers for a song listed twice.
 */
function playingRowForThisView(ctx: AppContext): HTMLElement | null {
  const id = ctx.queue?.currentSong?.id ?? null;
  if (id === null) return null;
  return [...(ctx.rows.get(id) ?? [])][0] ?? null;
}

/**
 * Is that row **fully inside the scroll box**? v2.0-beta item 4's definition of visible.
 *
 * Highlighted is not a second condition: the highlighted row *is* the playing song's row
 * (`updateRowHighlight` toggles `.playing` on exactly these rows), so "already visible/highlighted"
 * reduces to "the playing row is on screen in full". A row half under the fixed bar or half under
 * the header is not visible.
 */
export function rowInFull(row: HTMLElement, scrollBox: HTMLElement): boolean {
  const r = row.getBoundingClientRect();
  const box = scrollBox.getBoundingClientRect();
  return r.top >= box.top && r.bottom <= box.bottom;
}

/**
 * Put that row's centre at the centre of the scroll box, as far as the list allows.
 *
 * Both rectangles are read **before** anything is written (one `getBoundingClientRect()` pair, then
 * one `scrollTop` assignment), so the tap cannot force a second layout — and `scrollTop` clamps to
 * the scrollable range itself, which is what makes a first or last row centre as far as it can.
 */
export function centreRow(row: HTMLElement, scrollBox: HTMLElement): void {
  const r = row.getBoundingClientRect();
  const box = scrollBox.getBoundingClientRect();
  scrollBox.scrollTop += r.top + r.height / 2 - (box.top + box.height / 2);
}

/**
 * **A tap on the song block of the bottom container** (v2.0-beta item 4) — the two-tap rule.
 *
 * In the owner's words, and in this order:
 *
 *   1. the view on the screen now has no row for the song that is playing (the Library tab lists
 *      artists; an album page that does not carry the track; a search that did not return it) →
 *      open the now screen. There is nothing to centre, and the alternative — doing nothing —
 *      leaves the bar dead on half his screens;
 *   2. that row is not fully visible → **scroll it to the centre and do not navigate**. No route
 *      change, no pager movement, no pane change: only `scrollTop` moves;
 *   3. that row is already fully visible → open the now screen, exactly as a tap does today.
 *
 * So from a list whose playing row is off-screen the first tap centres and the second opens, and
 * where it is already on screen the first tap opens. A list too short to scroll has the row fully
 * visible by construction, so it opens on the first tap.
 */
export function containerTap(ctx: AppContext, shell: Shell, openNow: () => void, event: Event): void {
  if (!isContainerTap(event.target)) return;
  const row = playingRowForThisView(ctx);
  if (row === null) {
    openNow();
    return;
  }
  if (rowInFull(row, shell.viewScroll)) {
    openNow();
    return;
  }
  centreRow(row, shell.viewScroll);
}
