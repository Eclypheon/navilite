# v2.0-beta — the design: what the app weighs, what the refactor is, the pill's word, the bottom container, and how the four properties are measured

Card `t_66cf0e1f` (Sage, design gate). Design date 2026-10-17. Baseline: `main` at `8a4b785`
= tag `v1.9.28` = the shipped 1.9.28. **Nothing in this card changes `src/`, `test/` or a
version.** The implementation is card `t_88ee09ab` (nerd); the release is a later card.

Everything below is either *measured here* (with the command that measured it) or *read in the
code* (with `file:line`). Numbers I did not measure myself are attributed.

**Two facts in the card's brief are wrong, and the implementation must not use them:**

1. **There is no `stable-1.9.28` tag.** `git show-ref --tags | grep stable` returns exactly one
   stable tag: `v1.9.11-stable` (`1948fa8`). The diff/rollback point for v2.0-beta is
   **`v1.9.28`** (`git rev-parse v1.9.28^{commit}` = `8a4b785b`, which is also today's `main`).
   A card that runs `git diff stable-1.9.28` gets `fatal: ambiguous argument`.
2. **`src/` is 16,223 lines of TypeScript, not 15,325.** Measured with
   `find src -name '*.ts' | xargs wc -l` (the brief's 15,325 is 898 lines short; the six files it
   names are correct to the line, so the discrepancy is in the tail it calls "rest small" — 24
   files, including `api/subsonic.ts` 429, `api/lyrics.ts` 287, `storage/offline.ts` 227,
   `lyrics/romanize.ts` 177, `storage/session.ts` 156, `storage/lyrics.ts` 147, `api/sidecar.ts`
   145, `api/types.ts` 137).

---

## 1. What the app actually weighs

### 1.1 The numbers, and who measured them

| Fact | Value | Source |
|---|---|---|
| TypeScript source | **16,223 lines / 30 files** | measured here |
| `src/ui/app.ts` | **3,455 lines, 162,686 B** | measured here |
| `src/player/engine.ts` | **3,832 lines, 211,174 B** | measured here |
| … the two together | **7,287 lines = 44.9 % of all source** | measured here |
| `dist/` shipped | **288 KB on disk** | `du -sk dist` |
| JS bundle `index-*.js` | **204,025 B (63,744 B gzip)** | measured here |
| the other five chunks | 18,159 B (5,625 B gzip) | measured here |
| CSS `index-*.css` | **14,071 B (3,658 B gzip)** | measured here |
| all shipped assets, gzip | **73,362 B** | measured here (the brief's 64,270 B is the JS chunk alone, from an earlier build) |
| `Navilite-1.9.28-unsigned.ipa` | 1,031,787 B | orchestrator's reading — **not re-measured here** |
| … `Payload/App.app/App` | 1,140,480 B (arm64 binary, compressed in the zip) | orchestrator's reading |
| … `Frameworks/Capacitor.framework/Capacitor` | 859,552 B | orchestrator's reading |
| … `Assets.car` / `Cordova.framework` | 295,656 B / 110,136 B | orchestrator's reading |
| … our whole bundle inside the IPA | ~222 KB uncompressed, of which the JS is 204 KB | derived from the two rows above + `dist/` |

### 1.2 The bloat statement, said plainly

**The 1 MB IPA is not this app.** Subtract Capacitor's own frameworks, Cordova's and Xcode's
`Assets.car` and the arm64 binary, and what is left of *our* code inside it is ~222 KB of asset
bytes — the same 288 KB that `dist/` is. **Nothing in the refactor below will move that number**,
and the design does not promise that it will. If the IPA size is what he wants smaller, the lever
is the Capacitor shell (a plugin, a framework, a deployment target), not a line of our TypeScript.

**Where the app is actually bloated is the reading cost of two files.** `src/player/engine.ts`
(211 KB ≈ **53k tokens** at 4 B/token) and `src/ui/app.ts` (163 KB ≈ **41k tokens**) are 45 % of
the source, and a card that touches either one has to read it whole — that is where his credits
actually go. The chip-word card `t_71dc787e`, the resume card `t_c8cc01c6` and this one all paid
almost 100k tokens just to *read* before writing a line. That is the thing the refactor is for.

**Also bloated, and free to fix:** 218 `*.bak-<timestamp>` files lie in the working tree (`.bak`
copies of `DECISIONS.md`, `CHANGELOG.md`, `src/ui/app.ts`, `test/*.ts`, `src/styles.css`,
`tools/*.mjs`). `git ls-files | grep -c '\.bak'` = **0** — they are untracked and gitignored
(`.gitignore`: `*.bak-*`), so they are not repository bloat and deleting them produces no commit.
They are *search* bloat: every `grep`/`search_files` an agent runs in this checkout returns their
copies (this card's first three greps were half `.bak-` noise). Delete them before the refactor
(`find . -name '*.bak-*' -not -path './node_modules/*' -delete`) — nothing is lost, they are all
untracked.

### 1.3 What the refactor will and will not shrink

**Will not:** the IPA, the APK, `dist/` bytes, gzip bytes, or runtime speed. Module boundaries are
erased by the bundler; moving a function into a second file changes the bundle by a few bytes.
Expected `dist/` movement: ±2 %. Any larger change means behaviour moved, not code (risk 8, §7).

**Will:** the size of the file a future card must read, and therefore its token cost. Concretely,
after the mandatory slices of §2:

- a change to the pill's word reads `engine.ts` (~2,200 lines) instead of 3,832, and if it is
  confined to the word table it reads nothing else — the table is ~90 lines;
- a change to the bar reads `src/ui/player-bar.ts` (~230 lines ≈ 14 KB ≈ 3.5k tokens) instead of
  reading `app.ts` for it (the bar is currently the last 233 lines of a 3,455-line file, and every
  card that touches it opens the whole file to find those lines);
- no source file is above ~1,100 lines after the mandatory slices, except `engine.ts` (~2,200);
  with the stretch slices, `engine.ts` lands near 1,500.

**Not promised:** a smaller *total*. Moving 4,000 lines between files leaves the total where it
was (±consolidation). The win is locality, not volume, and it is claimed only where §2 names the
tests that keep the behaviour still.

---

## 2. The refactor: slices, seams, pins, reverts

Rules for the whole refactor:

- **One slice = one commit, on `main`** (VERSIONING.md §1). `npm run typecheck && npm test` green
  *inside* that commit. A slice whose suite is not green is reverted (`git revert <sha>`), not
  patched forward — every slice below is independently revertable for that reason: it moves code
  and re-points imports, it does not change behaviour.
- **The refactor lands before the behaviour changes** for the file each behaviour touches, and only
  there: the bar's tap rules (§4) are written into `src/ui/player-bar.ts` *after* A4, not into
  `app.ts` before it.
- **A slice that turns out to be unsafe is stopped and reported** (card rule 4). The mandatory set
  is E1, E3, A1, A4, A5; E2 and E4 are stretch, and A2/A3 are stretch. Stopping a stretch slice is
  a success case, not a failure.
- **Re-pointing imports is part of the slice.** `grep -rn "player/engine\|ui/app" src test tools`
  first; `tsc --noEmit` is the pin for a pure move.

### engine.ts (3,832 lines, 211,174 B)

| # | Slice | From (lines) | To | Seam, and why it is safe | Pinned by |
|---|---|---|---|---|---|
| **E1** | the contract | `engine.ts:1-664` — module doc, `PlaybackBackend`, `EngineState`, `PlayerEvent`, `reduce` (91), `PublishedTrack` (130), `QueueStatement` (150), `TrackRequest` (157), `VisualiserWord` (209), `VisualiserTone` (244), `STOPPED_WORD` (229), `EngineStatus` (246), `EngineOptions` (383), `withDeadline` (494), `askedRate` (646), `spectrumChecksum` (657) | `src/player/engine-contract.ts` (types + `STOPPED_WORD`) and `src/player/engine-helpers.ts` (the three pure functions) | Types, one `Record` and three pure functions with no `this`; nothing in the file they leave refers *back* to the engine, so the dependency edge only ever points one way. 37,322 B out of the biggest file in the repo. | `npm run typecheck` (the compiler is the pin for a move), `npm test` |
| **E2** | the spectrum registers | fields `engine.ts:671-793` (analyser 671, analyserGain 677, graphSource/`graphFailedReason` 678-679, `freq` 680, `spectrumLive`/`spectrumArming` 691-700, `nativeBands` 722, `spectrumPoll` 723, `orphanReattachedFor` 742, `spectrumInstall` 746, `tapFramesAtLastRead` 771, `lastNativeFrame` 787) + methods `measuringPathForTheItem` (1579), `analyserArming` (1635), `tapArming` (1664), `hasSpectrumTap` (1674), `spectrumData` (1686), `readSpectrum` (1712), `sampleRate` (1721) + `3381-3811` (tap frames 3413/3454/3477, `setSpectrumReason` 3498, `verifySpectrum` 3520, `attachSpectrum` 3577, `claimSpectrumInstall` 3611, `settleSpectrumInstall` 3618, `confirmSpectrum` 3630, `setGraphOutput` 3707, meter 3724/3730, `sample` 3738, `silenceReason` 3784) | `src/player/spectrum.ts` — one class, `SpectrumRegisters`, + `src/player/spectrum-web.ts` if the analyser half needs its own file | The seam is the *fact a measurement needs*, not `this`: a read-only port (`state`, `backend`, `track`, `audible`, `positionMs`, `durationMs`) in, and three writes out (`emit`, `arm`, `disarm`) — the same shape `spectrumArming` already has as a flag the engine writes and `status()` reads (1426-1431). **This is the slice most likely to be dropped**: if the port cannot be drawn without threading engine callbacks back in, stop it. | `test/engine-native.test.ts` (the whole tap/arming suite), `test/chip-word-browser.test.ts`, `test/visualizer.test.ts`, `test/local-file-spectrum.test.ts`, `test/spectrum-install-race.test.ts` |
| **E3** | the warm pool | `engine.ts:1744-2120` — `prewarm` (1744), `trimWarmed` (2063), `pruneWarmed` (2079), `warmedUrl` (2094) | `src/player/warm-pool.ts` | The pool already speaks only in `(songId, url)` and holds no transport state: it takes the bridge handle and the item in hand, and hands back slots. `native.ts`'s warm slots are its other half and are not touched. 20,620 B. | `test/queue-ahead.test.ts`, `test/queue-previous.test.ts`, `test/queue-order.test.ts`, `test/queue-restore.test.ts` |
| **E4** *(stretch)* | the native path | `boundaryOwnedByNative` (2178), `adoptNativeAdvance` (2242), `startConsumers` (2990), `disarmConsumers` (3057) → ~1,100 lines | `src/player/native-path.ts` | Honest assessment: this group reads the transport, the clock, the session and the tap, so the port is much wider than E2's and the seam is the least clean in the file. Attempt only after E2, and stop it the moment the port needs a callback back into the engine. | `test/engine-native.test.ts`, `test/queue-ahead.test.ts` |
| **E-left alone** | `src/player/native.ts` (1,782), `src/state/offline.ts` (1,730), `src/state/queue.ts` (1,104) | — | — | Deliberately **not** sliced in v2.0-beta. Offline playback is one of the four properties that must not regress (§5, P2), and `native.ts` is the plugin boundary the whole native path sits on. The lines saved here are the most expensive to earn and the most dangerous to spend. | — |

### app.ts (3,455 lines, 162,686 B)

| # | Slice | From (lines) | To | Seam, and why it is safe | Pinned by |
|---|---|---|---|---|---|
| **A1a** | the context types | `app.ts:90-413` — `NowMode`, `Shell` (92), `AppContext` (164) | `src/ui/context.ts` | Interfaces only; 14,660 B of it is prose inside a type block that every reader of `app.ts` scrolls past. Compiler-pinned. | `npm run typecheck`, `npm test` |
| **A1b** | the shell and the gesture | `buildShell` (455-692), the press/refusal authority and `bindTap*(726-873)`, `currentHead`/`onStackedRoute`/`bindStackedBack` (874-926) | `src/ui/shell.ts` | `buildShell` is a function of `root` alone; the gesture helpers are module-level and share exactly two module-level variables (`press` 741, `suppressClickUntil` 748), so they must move **together** and must not be split. 18,428 B. | `tools/v16-check.mjs`, `test/scroll-containment.test.ts`, `test/pager.test.ts`, `tools/layout-audit.mjs` |
| **A4** *(do first)* | the player bar | `updateRowHighlight` (3223), `markRows` (3251), `updatePlayerBar` (3257-3444), `contextLine` (3447) | `src/ui/player-bar.ts` | It reads `EngineStatus` + `Shell` and writes DOM — the same contract it has now, just a module edge instead of a file position. **First among the app slices**, because §4's tap rules are written here and shipping them into a 3,455-line file first would undo the point. 13,656 B → ~3.5k tokens instead of a 41k-token file read. | `test/slow-link-browser.test.ts`, `test/chip-word-browser.test.ts`, the new container-tap harness (§4.5) |
| **A5** | the now screen | `settlePane` (935), `preparePane` (958), `showNowScreen` (968), `hideNowScreen` (976), `paneOfRoute` (983), `applyNowMode` (993), `setNowMode` (1012), `bindSeek` (1067-1330) | `src/ui/now-screen.ts` | These are the app-side half of the pager, whose other half is already its own module (`src/ui/pager.ts`, 497 lines) — the seam exists, this just finishes it. 19,911 B. | `test/pager.test.ts`, `tools/pager-check.mjs`, `test/scroll-containment.test.ts` |
| **A2** *(stretch)* | offline + downloaded rows | `renderOffline` (1846) and the block at 1811-2130 (`playlistRow` 2078, the download control 1958-2065, `storePlaylistInput` 1913), plus the downloads view (~3011) and the "On this phone" row (2325) | `src/ui/views/offline.ts` | It is one subject — what the app shows with no server — and it already has a harness of its own. Touching it is the one place this refactor can hurt P2, so it goes last among the stretch slices. | `test/offline-browse.test.ts`, `test/offline-views.test.ts`, `tools/offline-check.mjs` |
| **A3** *(stretch)* | the browse views | 2130-3255 — `renderArtists` (2245), `renderAlbums` (2280), `renderArtist` (2422), `renderFavourites` (2874), `renderSearch` (2980), `renderPlaylist` (2763), `albumCard` (2292), `artistRow` (2304) | `src/ui/views/browse.ts` (or one file per view) | Each `render*` is a function of `(ctx, shell, …)` that draws into `shell.view`. Mechanical, but it is ~1,100 lines and the biggest diff in the whole refactor — hence stretch. | `tools/layout-audit.mjs`, `test/layout-393.test.ts` |
| **A-left alone** | `bindSeek`'s seek maths, `connect` (1493), `applyPalette*` (1337/2220), `renderRoute` (1587) / `overtaken` (1807) | — | — | The router is the spine the whole app hangs off and the palette code is shared with the now screen; neither has a clean port today and neither is expensive to read (both under 300 lines). | — |

**Order** (one commit each, suite green in each): `S0` delete the `.bak` files (no commit — they are
untracked) → **A4** → **A1a, A1b** → **A5** → **E1** → **E3** → *(E2)* → *(E4, A2, A3)*.

---

## 3. Item 2 — the pill, and the reversal of §515.4

### 3.1 What the pill reads now, and where that is decided

The engine computes the word once (`EngineStatus.visualiser`, engine.ts:1400-1436, 1507-1557) and
the bar prints it and nothing else (`app.ts:3369-3377`). The existing word list is
`VisualiserWord` (engine.ts:209-219) and **the word this card deletes is `spectrum…`** —
defined at engine.ts:184-193 as *"the item in hand is playing and the thing that measures it has
not answered for it yet"*, produced at engine.ts:1526 (`if (arming) return 'spectrum…'`), and
toned `arming` at engine.ts:1512-1513.

**The window is real and stays:** `arming` is `state === 'playing' && (spectrumArming ||
analyserArming() || tapArming())` (engine.ts:1426) and it is reached by *every* way into `playing`
that is not a start — a track change, a resume, a return from the background — on both paths
(v1.9.27, `DECISIONS.md` §833). What changes is only the word it wears.

### 3.2 The word table, as the owner will see it

| When | Pill reads | Colour (tone) |
|---|---|---|
| nothing playing, nothing loaded | `idle` | stopped (neutral) |
| a load the engine is still fetching (the tap's own window, `queue.isLoading`) | `loading…` | stopped |
| playing, this item's own measurement has answered (the bars are fed) | `spectrum` | live (green) |
| **playing, the measurement has not answered yet** (track change, resume, back from the background, native tap in flight, the web analyser's first frame) | **`spectrum`** | **arming (the mid colour, kept)** |
| paused | `paused` | stopped |
| ended | `ended` | stopped |
| interrupted | `interrupted` | stopped |
| error | `error` | stopped |
| playing, **this item's own verdict**: the browser will not hand the samples over, or silence/frozen frames for this item | `theme` | fallback (amber) |
| playing, **the build has no tap** (the phone today, on some builds) or this item ruled out by the tap | `native audio` | fallback (amber) |

The `· <n> kbps` suffix stays exactly as it is (app.ts:3370), and the `loading…` override stays
where it is — it is the queue's fact, not the engine's.

### 3.3 The reversal, stated explicitly — and recorded

The owner's call of **2026-10-16** (recorded as `DECISIONS.md` §515.4, and spent on one more
transition each path by §833.3) was: *a tap refused for a whole track keeps `spectrum…`*, because
the engine cannot tell *"will never attach"* from *"still attaching"* without a clock, and a clock
is the false capability claim §515 exists to remove. **He has reversed that**, 2026-10-17:
**the pill must never read `spectrum…`.** He reads the window as a second word for *"arming"* and
wants one word for one capability. The decision is written into `DECISIONS.md` in that file's own
format, as its own entry, by this card (see the appended section at the end of `DECISIONS.md`),
marked **unreleased** until the cut carries it.

What the reversal *means*, said plainly: from this release there is **no word on the bar that says
"the measurement has not answered yet"**. The pill says `spectrum` while the reading is being set
up — for ~128 ms on the web at a track start (measured in v1.9.27's record, §30) and one bridge
round trip on the phone — so the word alone can no longer distinguish *measuring now* from *about
to measure*. **The distinction is not deleted, it is moved to the colour** (tone `arming`, the
existing mid colour between green and amber, `styles.css:877`) and to the chip's tooltip
(`spectrumArming` on the reason line, app.ts:3398-3434). If he wants the window visible in the
word as well, that is a new call and his to make; this design does not leave a second word lying
around for it.

### 3.4 What the implementation does, exactly

1. `VisualiserWord` (engine.ts:209-219) **loses the `'spectrum…'` member**. That is the mechanism
   of the whole change: `tsc --noEmit` then names every producer, every consumer and every test
   that mentions it. The member is deleted, not deprecated.
2. `visualiserWord(arming)` (engine.ts:1524-1557) returns `'spectrum'` for the arming window — and
   **the arming term must still short-circuit the capability branch**. The shape that matters is
   not the string but the order: `spectrumLive` → `arming` → *this item's verdict* → *the
   transport's own state*. Deleting the arming branch instead of re-wording it would put the
   window back on `theme` / `native audio` — precisely the defect v1.9.27 exists to fix.
3. `visualiser(arming)` (engine.ts:1507-1521) keeps `arming` as a **tone**:
   `word === 'spectrum' ? (arming ? 'arming' : 'live') : …`. The tone must be computed from the
   fact, not inferred from the word, because the word no longer carries it.
4. `status().spectrumArming` (engine.ts:1431) is unchanged — it is the engine's own fact and the
   tooltip's sentence still uses it.
5. `app.ts` is not touched by this item at all (it already prints `status.visualiser.word`).
   `.mode-chip.arming` (styles.css:877) stays.
6. **The assertions move, they do not disappear.** These files assert the old word and must be
   re-pointed to the new one *and keep asserting the same property* — *no capability word while an
   item is playing*:
   - `test/engine-native.test.ts`: lines 1983, 2009, 2137, 2487, 2501, 2638, 2663, 2721, 2823,
     2836, 2885, 2894, 3016, 3019, 3046, 3074, 3080, 3131, 3153 — the native window, the verdict
     that outranks it, and the resume case. The property (`playing` never wears `native audio`) is
     the thing to keep; the expected *word* changes from `spectrum…` to `spectrum`, and the
     expected *tone* at that read becomes `arming`.
   - `test/chip-word-browser.test.ts`: 462, 503, 530, 533 — the web word sequence and its two runs.
     The `firstComing` check (`indexOf 'spectrum…'`) becomes *the arming read is `spectrum` with
     tone `arming`*, and the run gains the owner's own check: **no read, at any state, is
     `spectrum…`** — that assertion is the acceptance criterion of this item.
   - `docs/verification.md` §30, §31, §32 and `DECISIONS.md` §515.4/§833.3 are **history** and are
     not edited; the new `DECISIONS.md` entry supersedes, and says so.

---

## 4. Items 3 and 4 — the bottom container

### 4.1 What the code does today (proved by reading)

`app.ts:678-681`:

```
playerBar.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('button, input')) return;
  openNow();                                   // → location.hash = '#/now'
});
```

The guard is a **tag list, not a region**. Everything in the bar that is not a `<button>` or an
`<input>` therefore navigates to the now screen: the elapsed and duration labels beside the seek
bar (`barPosition`/`barDuration`, `span`s, app.ts:516-517), the 12 px gap inside `.pb-main`
(styles.css:733-738), the gap the grid puts around `.pb-controls`, the chip, the reason line, and
the footer's own padding. That is "a transport-area tap counts as a container tap", exactly the
report. (The three transport buttons and the seek input are guarded today, which is why *next* and
*previous* "already behave".)

### 4.2 The regions, and what each one does

| Region | Elements | A tap does |
|---|---|---|
| **the song block** | `.pb-cover`, `.pb-meta` (app.ts:521-523) | the *only* container tap — §4.3 |
| **the transport region** | `.pb-controls` (app.ts:524-530): previous, play/pause, next, **including the 8 px gaps and the padding between them** (`gap: 8px`, styles.css:776-781) | that button's action, and nothing else. Never navigation, never a container tap, in any view |
| **the seek region** | `.pb-progress` (app.ts:532): the range input seeks; the two `time` labels | the input seeks; the labels do **nothing** (today they navigate) |
| **inert** | the chip, the reason line, `.pb-main`'s outer padding, the footer's padding, the grid gaps | nothing |

Implementation shape: replace the tag test with a region test — *if the click landed inside
`.pb-meta` or `.pb-cover`, it is a container tap; otherwise the bar does nothing.* The three
transport buttons keep their own `onclick`; after this they no longer depend on the container
handler's guard at all, so a future change to one cannot silently re-enable navigation from the
other.

Acceptance for item 3, in the owner's terms: **from the playlist view and from the library view,
pause/play, next and previous all work and he stays where he is** — the route (`location.hash`), the
rendered list, the scroll offset and the now overlay are all unchanged; only the song playing and
the play glyph change.

### 4.3 Item 4 — the two-tap rule, defined precisely

A tap on the **song block** runs this decision, in this order:

1. **Does the view on the screen now contain a row for the song that is playing?**
   `ctx.rows` (app.ts:177) is the registry of the rows the current render drew, and it is cleared
   at the top of every route render (app.ts:1662) — so a row registered by a view he has left can
   never answer this. If there is no such row (the Library tab lists artists; an album page that
   does not carry the track; a search that did not return it), **open the now screen** — today's
   behaviour, because there is nothing to centre. *(Decision, recorded here: the alternative —
   "do nothing" — leaves the bar dead on half his screens.)*
2. **Is that row already visible?** Visible means **fully inside the scroll box**:
   `const r = row.getBoundingClientRect(); const box = shell.viewScroll.getBoundingClientRect();`
   → `r.top >= box.top && r.bottom <= box.bottom`. Highlighted is not a second condition: the
   highlighted row *is* the playing song's row (`updateRowHighlight`, app.ts:3223-3249, toggles
   `.playing`), so "already visible/highlighted" reduces to "the playing row is on screen in
   full". A row that is half under the fixed bar or under the header is **not** visible.
   - **not visible** → scroll that row to the **centre** of the scroll box (clamped to the
     scrollable range, so a first or last row centres as far as it can), **do not navigate**.
     Nothing else changes: no route change, no pager movement, no pane change.
   - **visible** → `openNow()`: route `#/now`, the now screen on the spectrum pane, exactly as a
     tap does today.
3. Therefore, from a list where the playing row is off-screen, **the first tap centres and the
   second tap opens**; where the row is already on screen, **the first tap opens**. That is his
   sentence word for word.

Degenerate cases, decided: a song listed twice in one list → the first row in document order; a
list too short to scroll → the row is fully visible by definition → opens on the first tap; the
now screen already open → the bar is behind the overlay and the rule does not apply.

### 4.4 The one thing that must not be forgotten: the bar's tap is not a list tap

`bindTapSurface(viewScroll)` (app.ts:687, 800-873) is bound **only to the list**, and the pager
claims a gesture that *starts* on the bar for the pane swipe (`src/ui/pager.ts:122`,
`OWN_GESTURE = 'input, textarea, select, [data-pager="off"]'` — `.pb-main` is not in that list).
So a swipe that begins on the song block ends with a click the bar's handler reads as a tap: today
that opens the spectrum view mid-swipe; **after §4.3 it would scroll his list instead.** The bar
must therefore inherit the list's press/refusal authority (the module-level `press` /
`suppressClickUntil` pair can serve both surfaces — bind the bar to the same functions, or extend
`bindTapSurface` to take the second surface). Acceptance: a real touch drag (CDP
`Input.dispatchTouchEvent`) starting on the song block and ending 100 px to the right produces
**no route change and no scroll from the tap handler**, while the pager still settles.

### 4.5 The acceptance run (one new harness, no simulator)

A muted Chrome run at 393 × 852 over the mock library (`node tools/mock-subsonic.mjs --dist dist`),
driving the real app; the route is readable from the page (`location.hash`), so nothing here needs
a device. Suggested home: `tools/container-tap-check.mjs` (or a `--scenario container-tap` in
`tools/device-probe.mjs`, which already drives the bar and the queue). It must assert:

1. `#/playlists/<id>`: tap play/pause on the bar → hash unchanged, `.now` still `hidden`, the
   playlist still rendered, the play glyph and the engine's state change.
2. The same for next and previous: hash unchanged, the bar's title changes, still on the playlist.
3. A tap on the **time label** next to the seek bar → nothing happens (this is the proven defect).
4. A tap in the **gap** between the title block and the transport buttons → nothing happens.
5. Scroll a long playlist so the playing row is off-screen → tap the song block → hash still
   `#/playlists/<id>`, the playing row's centre within ±6 px of the scroll box's centre, `.now`
   still hidden.
6. Tap the song block again → hash `#/now`, the spectrum pane showing (`applyNowMode('spectrum')`).
7. With the playing row already visible → **one** tap → `#/now`.
8. On `#/artists` (a list with no song rows) → **one** tap → `#/now`.
9. The touch-drag case of §4.4: no route change, no scroll, pager settled.

---

## 5. The four no-regression properties, and how each is measured

Every measurement below is run **before and after**, on the same machine, same fixture, same
script, muted. "Before" means a scratch checkout at `v1.9.28` (`8a4b785`); "after" means the
working tree of the implementation card. Both numbers go in the report, including the ones that
are worse.

### P1 — responsiveness

**What is timed, and how.** `test/slow-link-browser.test.ts` already does this, in `npm test`: it
drives the real app at 393 × 852 against the mock and asserts that **the tap paints in the same
task** (a *synchronous* read after `row.click()`, so no microtask, timer or network callback can
have run in between), and it measures a track change cold and warm off the browser's own resource
timeline.

**Threshold.** The same-task paint is a boolean and must stay true. The cold/warm track-change
numbers are reported as medians before and after; a rise of **+20 % or more** is treated as a
regression to investigate before the cut, not as noise (the run's own variability is recorded
alongside so the two are told apart).

**The new surface must not add a frame.** The bar's tap (§4.3) decides with one
`getBoundingClientRect()` pair and integer comparisons — **read before any write**, so no forced
second layout. The container-tap harness (§4.5) reads the scroll offset synchronously after
`click()` for assertion 5, which is the same-task proof for the new path.

### P2 — offline playback

**Which harness.** `tools/offline-check.mjs --app <origin serving a built dist> [--json report.json]`
— a real page, real `fetch` rejections, the app's own offline mirror seeded in `localStorage`
(exactly what a real install has after a download), 393 × 852, non-zero exit when anything fails.
Plus, in `npm test`: `offline-browse`, `offline-views`, `offline-store`, `offline-resolver`,
`offline-estimate`, `offline-repair-visible`, `lyrics-offline`, `download-lane`,
`local-file-spectrum`.

**Acceptance.** The harness exits 0 before and after, and the two JSON reports agree on every
field it asserts. And the structural guarantee, which is the real one: **no slice in §2 touches
`src/state/offline.ts`, `src/storage/*.ts`, or `native.ts`'s download lane.** Offline playback is
kept by not writing to it — the harness proves the tree still does what it did.

### P3 — backgrounded playback

**How it is exercised (no simulator — owner's rule).** A muted Chrome run at 393 × 852 over the
mock that:

1. **forces the page visible and asserts it** — `Object.defineProperty(document, 'hidden',
   {configurable: true, get: () => false})` then `document.dispatchEvent(new Event('visibilitychange'))`.
   *Verified in this design session:* the app's own listener (`app.ts:329`) receives a dispatched
   `visibilitychange` and reads the property, so this drives the app's real path. **This step is
   not optional**: measured here, a headless Chrome reports `document.hidden === true` at load,
   which means a probe that skips it is measuring a *backgrounded* app while believing it is
   measuring a foreground one.
2. plays a track, reads the clock and the bars;
3. flips the flag to `true`, dispatches, holds ~8 s;
4. flips it back to `false`, dispatches, and reads: the engine's state across the gap (it stayed
   `playing`; no `paused` flash), the position on return against the player's own report (the
   engine's clock may only extrapolate while `foreground`, engine.ts:1001), the bars returning
   (chip `spectrum` within ~1 s), and the tap's per-item frame counter growing again.

**Deterministic half, on every `npm test`:** the fake-bridge cases in `test/engine-native.test.ts`
— the hand-off, the boundary adopt and the return-from-the-background cases.

**Stated limitation.** A faked `document.hidden` is the app's own path, not WebKit's suspension:
the real round trip is `tools/spectrum-roundtrip.mjs` (+ `tools/device-probe.mjs --scenario
spectrum`) on the Simulator, and **this card does not run it** (his Mac is his desk). Also
measured here and worth recording: `Emulation.setPageVisibilityOverride` does not exist in this
Chrome, and `Page.setWebLifecycleState('frozen')` freezes timers but does **not** fire
`visibilitychange` when the page is already hidden — so the flag + event method above is the one
that works, and a `frozen` call is not a substitute.

### P4 — time to first sound

**Same fixture, same method, before and after.** One muted Chrome run at 393 × 852 over the mock
library, 9 taps (3 tracks × cold / warm / repeat):

- `t0` is read **synchronously** at `row.click()`;
- **first sound** = the app's own media element reporting `currentTime > 0` while not paused — the
  element is found with `Runtime.queryObjects` exactly as `tools/spectrum-proof.mjs` finds it —
  cross-checked against the bar's position label leaving `0:00`. The engine's own rule for this is
  `positionReported` (engine.ts:982): the displayed position does **not** run from the press to the
  first sound, so the label is a corroborating signal rather than the source.
- report median and p90, cold and warm, before and after. **Acceptance: p90 no more than 10 %
  slower.**

**Two traps, named so the probe does not fall into them:**

- **Do not use the pill's word as the "first sound" signal.** After item 2 the arming window reads
  `spectrum`, so "first reads `spectrum`" fires *before* sound exists (the window it used to
  exclude).
- Resolution, stated honestly: the element's `currentTime` leads the speaker by a few ms of buffer,
  and every number here is over loopback on this Mac — no relay, no radio — so it measures the
  mechanism, not his phone (the caveat `test/slow-link-browser.test.ts` already writes about
  itself).

---

## 6. The v2.0-beta cut

**Nothing in this card bumps anything.** This is the shape the release card must take.

**Two identities, on purpose.** `2.0-beta` is what he reads; `2.0.0-beta` is what the package
metadata says, because `2.0-beta` **is not valid semver** — measured here:
`semver.valid('2.0-beta')` → `null`, `semver.valid('2.0.0-beta')` → `2.0.0-beta`. npm's
`--package-lock-only` writes `2.0-beta` through without complaint, so the risk is not npm: it is
the next tool in the chain that parses the version strictly. Do not spend that risk to save two
characters.

| File (VERSIONING.md §3 — all of them, one commit) | Change |
|---|---|
| `package.json` | `"version": "2.0.0-beta"` |
| `package-lock.json` | same, in both places (the root and `packages[""]`); regenerate with `npm install --package-lock-only` |
| `android/app/build.gradle` | `versionName "2.0.0-beta"`, `versionCode 49` (48 → 49) |
| `ios/App/App.xcodeproj/project.pbxproj` | `MARKETING_VERSION = 2.0.0` in **both** places (Xcode's marketing version must be numeric — `2.0-beta` is not), `CURRENT_PROJECT_VERSION = 50` in both (49 → 50) |
| `src/ui/changelog.ts` | new entry: `version: '2.0-beta'`, `date: '2026-10-17'` |
| `CHANGELOG.md` | the same entry, same order, same wording — heading `## 2.0-beta — 2026-10-17` |
| `test/changelog.test.ts` | the expected list in *the changelog is the owner-visible list* gains `'2.0-beta'` (line 37), and the test's own title string with it |
| `DECISIONS.md` | the entry appended by this card flips from *unreleased* to *released as v2.0-beta* |

**The changelog entries must satisfy `test/changelog.test.ts`:** no item may match
`/service worker|CORS|vite|webpack|refactor|bundle|esbuild|TypeScript/i` (line 42) — which means
**the refactor cannot be called a refactor in his list.** Drafted in his terms:

- *"The bottom bar no longer sends you somewhere you did not ask to go. Pausing, playing, skipping
  on or back, and dragging the time bar all leave the screen you are on exactly where it is."*
- *"Tap the song in the bottom bar while you are in a playlist and the list scrolls to it and puts
  it in the middle of the screen. Tap it again and you get the spectrum for that song. If the song
  is already on the screen, one tap takes you straight there."*
- *"The label on the bottom bar only ever says \"spectrum\" when a song is playing. The
  \"spectrum…\" that appeared for a moment at every song change is gone; the bar still shows a
  different colour while the reading is being set up."*
- *(optional, housekeeping)* *"The app is tidier behind the scenes: the two giant files everything
  else had to be read through are now a handful of small ones."* — name it *nothing* like
  "refactor" or the release check fails.

**Tag and artifacts.** Annotated tag **`v2.0-beta`** on the release commit on `main`, message
`v2.0-beta — <the one line he would say>`; check both directions (VERSIONING §2). Artifact names
come from `package.json` (`tools/build-ios-ipa.sh:27`), so they are
**`artifacts/Navilite-2.0.0-beta-unsigned.ipa`** and `artifacts/Navilite-2.0.0-beta-debug.apk` —
the release card must not name a file `Navilite-2.0-beta.ipa`. Read the version back **out of the
artifacts** (VERSIONING §4): IPA `CFBundleShortVersionString = 2.0.0`, `CFBundleVersion = 50`; APK
`versionName='2.0.0-beta' versionCode='49'`.

---

## 7. Risks, each with the check that catches it

| # | Risk | Check |
|---|---|---|
| 1 | Deleting the second word deletes the only hint that the bars are not up yet | The tone stays `arming` and the tooltip keeps `spectrumArming`; the chip-word run records **word + tone at every read** and asserts at least one `arming` read exists across a track change (if none does, the window was lost rather than re-worded) |
| 2 | Re-wording the window lets it fall through to the capability branch — the v1.9.27 defect, back | The re-pointed `test/engine-native.test.ts` window cases and both `test/chip-word-browser.test.ts` runs keep asserting *no capability word while playing*; the suite must fail if the arming term stops short-circuiting, so the new expectation is `spectrum` where the old one was `spectrum…` — never a deleted assertion |
| 3 | The region guard kills a tap he uses | Harness items 1-4; the regions are stated in §4.2 (gaps *inside* `.pb-controls` are transport; the gap above it is inert). Moving the boundary is a one-line change if he disagrees |
| 4 | Item 4 adds a tap to reach the spectrum from a list whose playing row is off-screen | Accepted cost, recorded in the changelog bullet; the logo button (`app.ts:485`) still opens the now screen from anywhere |
| 5 | A pager swipe that ends on the bar leaves a click that scrolls his list | The bar gets the list's press/refusal authority (§4.4); harness item 9 |
| 6 | `ctx.rows` answers for a view he has left | `ctx.rows.clear()` per route render (`app.ts:1662`); harness item 8 (library view, no rows) |
| 7 | A slice severs a seam the engine needs (E2, E4) | Card rule 4: stop that slice, keep the tree green, say which one and why. The mandatory set (A4, A1a, A1b, A5, E1, E3) is deliberately all-mechanical |
| 8 | The refactor changes the bundle without anyone noticing | Record `dist/assets/*` bytes + gzip per file before and after; expect ±2 % (§1.3). A larger move means behaviour moved |
| 9 | The version string breaks a tool | `2.0.0-beta` (valid semver, measured) in the two JSON files; `2.0-beta` only in the changelog and the tag; re-run `npm install --package-lock-only && npm run build`, then read the versions out of the artifacts |
| 10 | A measurement is taken on a hidden page and is silently worthless | Every probe asserts `document.hidden === false` before foreground numbers and prints SKIPPED when it cannot (measured here: headless Chrome loads hidden) |
| 11 | The four properties are claimed from a green board rather than a number | Card rule 2: before **and** after numbers for all four, including the ones that are worse; "not measured" is an acceptable answer, an unstated one is not |

## 8. Not claimed by this design

- **No IPA or APK size reduction**, and no `dist/` reduction: the refactor moves code between
  modules; the bundler erases the boundaries (§1.3).
- **No total-source reduction.** Two files stop being 3,500 lines each; the total stays ~16,200.
- **No measurement of his phone.** Every number in §5 is loopback on this Mac, muted.
- **No device run of the native path.** The phone's half of items 2-4 is pinned by the fake-bridge
  suite (`test/engine-native.test.ts`) only; the Simulator round trip is not run by this card.
- **No behaviour change in this card.** No `src/`, no version, no tag, no artifact.
