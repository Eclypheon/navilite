# beta-3 — the design: one row, one move, and the second tap on visibility

Card `t_f32b823f` (Sage, design gate). Design date 2026-10-17. Baseline: `main` at `eadcf73`
= tag `v2.0-beta.2` (`03eb486`) + the release record; the shipped bytes are
`artifacts/Navilite-2.0.0-beta-2-unsigned.ipa`. **Nothing in this card changes `src/`, `test/`, a
version or a tag.** The implementation is card `t_691c88c8` (nerd); the release is a later card.

Everything below is either *read in the code* (with `file:line`) or *read in the shipped bundle*
(the IPA's own chunk, with the byte offset), and the one number that is neither is labelled
*derived from the CSS*. No harness was run in this card: every "today" verdict below is a prediction
of the shipped code that card `t_691c88c8` must confirm or refute with the fail-before in §4.

---

## 0. The verdict on the brief, up front

**The owner's hypothesis is wrong, and his conclusion is right anyway.**

He suspects the scroll is "based on the current track that is playing rather than which is
highlighted/selected on the list". In the shipped bytes **both** are keyed on the same fact — the
playing song's **id** — so there is no playing-track-vs-highlighted-row mismatch to fix: the mark
(`src/ui/player-bar.ts:20-46`) and the scroll target (`:289-293`) read the *same*
`ctx.queue.currentSong.id`. Changing "which key decides the current row" would fix nothing.

The defect is one level below the key: **which element answers for that id.** The target is taken
from a registry (`ctx.rows`) that keeps every row element a view has ever registered in the current
route render — **including rows the same view detached when it painted its list a second time** —
and it takes the *first-registered* one. When a view paints twice, the first-registered row for a
song is a **ghost**: a detached element whose `getBoundingClientRect()` is `(0,0,0,0)`. Every symptom
in his report falls out of that one fact:

- the ghost's zero rect is *above* the scroll box, so `centreRow` computes a **negative** delta and
  the list jumps **upwards** to its top — "it scrolls upwards a random chunk" (the chunk is however
  far he was scrolled, clamped at 0);
- for a track near the **top** of the playlist that jump happens to put his title on the screen
  ("This especially fails for tracks that are at the top of the playlist"), while the app's idea of
  what is on screen is still the ghost — so
- `rowInFull(ghost)` is `0 >= box.top` = **false** for every list whose scroll box starts below the
  header, i.e. always — so the second tap takes the *scroll* branch again, the scroll is already at
  its limit, nothing moves, and **"i'm not able to tap again when the song title is on the screen to
  go into spectrum view."**

So: it is **neither** a wrong-key targeting bug **nor** a row-measured-before-it-exists race (the two
candidates the card offers). It is a **stale-element bug in the row registry**, and the flakiness is
not randomness — it is a fixed property of the state he is in (which view, whether that playlist has a
local manifest, whether the mirror has hydrated, and whether he tapped before or after the second
paint), none of which he can see from the outside.

---

## 1. What decides the target today, exactly

### 1.1 The path, read out of `src/` and confirmed in the shipped bundle

| Step | Code | What it does |
|---|---|---|
| the mark | `src/ui/player-bar.ts:20-46` | `updateRowHighlight`: for **every** row registered under `currentSong.id`, toggle `.playing` (`:38-43`). That class *is* the list's "this is the current row" mark, and it is what `styles.css` draws and what the harness reads. |
| the target | `src/ui/player-bar.ts:289-293` | `playingRowForThisView`: `[...(ctx.rows.get(id) ?? [])][0]` — **the first element registered for that song id this route render**, whatever it is |
| the registry | `src/ui/app.ts:99`, `:2179-2184`, `:694` | `ctx.rows: Map<songId, Set<HTMLElement>>`; `songRow` adds to the set as it builds each row; the map is cleared **once per route render** (`:694`) and **nothing removes a row when its element leaves the document** |
| visibility | `src/ui/player-bar.ts:303-307` | `rowInFull`: the row's rect is inside the **scroll box's** rect (`>= top && <= bottom`) |
| the move | `src/ui/player-bar.ts:316-320` | `centreRow`: one `getBoundingClientRect()` pair, then a single `scrollTop += rowCentre − boxCentre` |
| the rule | `src/ui/player-bar.ts:339-351` | `containerTap`: no row → open now; row fully visible → open now; else centre **and do not navigate** |
| the region gate | `src/ui/player-bar.ts:278-280`, bound at `src/ui/app.ts:110` | only a tap on `.pb-cover, .pb-meta` counts |

**In the shipped bytes** (`artifacts/Navilite-2.0.0-beta-2-unsigned.ipa`,
`Payload/App.app/public/assets/index-ugOtIRG3.js`, byte offset 162083 — the same five functions
minified):

```js
function xr(e){let t=e.queue?.currentSong?.id??null;return t===null?null:[...e.rows.get(t)??[]][0]??null}
function Sr(e,t){let n=e.getBoundingClientRect(),r=t.getBoundingClientRect();return n.top>=r.top&&n.bottom<=r.bottom}
function Cr(e,t){let n=e.getBoundingClientRect(),r=t.getBoundingClientRect();t.scrollTop+=n.top+n.height/2-(r.top+r.height/2)}
function wr(e,t,n,r){if(!br(r.target))return;let i=xr(e);i===null||Sr(i,t.viewScroll)?n():Cr(i,t.viewScroll)}
```

So what shipped is what the source says: **`[...rows][0]` decides the target**, and the comment above
it (`src/ui/player-bar.ts:283-288`: *"that row in document order… The first row in document order
answers for a song listed twice"*) describes something the code does **not** do. A `Set` iterates in
**insertion** order, and insertion order is paint order, not document order.

### 1.2 Where the ghosts come from — two views paint their list twice inside one route render

A "ghost" is created whenever a view registers rows and then replaces those elements with a new
list, inside a single route render (i.e. without `ctx.rows.clear()` at `src/ui/app.ts:694` running
in between). `replace()` is `host.replaceChildren()` + append (`src/ui/dom.ts:52-55`), so the old
rows are detached and stay in the registry.

**(a) The playlist page, offline-first** — `src/ui/app.ts:1762-1796`:

1. `paintPlaylist(..., localSongs, { local: true })` at `:1772` — drawn from the phone's own
   manifest the moment the page opens, whenever that playlist has a manifest with nothing missing
   (`localSongs = record !== null && record.done > 0 ? record.songs : []`, `:1767`). Its rows are
   registered at `:1862` → `:2179-2184`, and then attached by `replace(...)` at `:1864-1868`.
2. `await ctx.library.playlist(id)` (`:1783`) — and `paintPlaylist(..., playlist.entry, ...)` at
   `:1795` builds **brand-new row elements** for the same songs and `replace()`s the first list
   away.

Both batches stay in `ctx.rows` for the same song ids, the **first batch first**. Every subsequent
bar tap on that page resolves to a detached element.

**This is the population the owner lives in**: he plays from playlists he has downloaded (the
"On this phone" screen held **497 tracks** on the build where it was last measured —
`src/ui/app.ts:2212-2214`), and a playlist is only painted twice when it *has* a manifest.

**(b) Search, on every second submit** — `src/ui/app.ts:1960-2008`: `submit()` refills the same
results host (`:1974-1990`) and registers a fresh row for every hit, on every Enter. A song returned
by two searches in the same visit to `#/search` has a ghost at the front of its set.

**The views that cannot produce a ghost** (single paint per render, rows stay live): an album page
(`:1512-1524`), "On this phone" (`:1398-1429`), Favourites (`:1937`), a playlist with **no**
manifest (the first paint is skipped — `painted = false` — and `loading()` is drawn instead), and a
downloaded playlist **with the server refused** (the `await` throws at `:1784` and the second paint
never happens).

### 1.3 Why the same tap sometimes lands correctly — and why it is not "random"

Every one of these is a state, not a coin flip:

| Working today | Why |
|---|---|
| any album / "On this phone" / Favourites page | one paint → the registered row *is* the row on screen |
| a playlist he never downloaded | one paint (no manifest) → same |
| **any** playlist with the server refused | the second paint never runs (`:1784-1790`) → same |
| a downloaded playlist **before the mirror has hydrated** | no record yet at `:1766` → one paint |
| a tap that lands **between** the two paints | the first batch is still attached → the ghost is live at that instant |
| a **song that is not on the phone**, in a downloaded playlist | `notOnPhoneRow` (`:1879-1891`) registers nothing, so only the server's live row answers |

And the failure he does report is exactly its complement: **a downloaded playlist, online, on a track
that is in its manifest.** That is why it "especially fails" where he notices it — and why the same
playlist "works" for him offline and fails online.

### 1.4 The two competing "current row" notions, named

1. **The row the app registered** — `ctx.rows`, insertion-ordered, retaining detached elements
   (`src/ui/app.ts:99`, `player-bar.ts:292`). This is what decides the scroll today.
2. **The row the app marked on the screen** — the element carrying `.playing` that is actually in the
   document, which is the row the owner's eye and the existing harness both look at
   (`tools/container-tap-check.mjs:115` reads `.row.song.playing` from the DOM).

They agree until a view paints twice, and today's code reads notion 1 while everyone else means
notion 2. **Notion 2 is the answer**, exactly as he argued — not because the *key* was wrong, but
because the *element* was.

Two things that are **not** competing notions, and must not become any:

- `queue.songPosition` (`src/ui/player-bar.ts:249`) is the queue **index**, used for the "Playing from
  X (3/12)" line and nothing else. The target must never be an index: a Library or album view whose
  order differs from the queue is what would expose that, and today it is exposed by nothing
  (`playingRowForThisView` keys on the id). Keep it that way — §2 row 4 exists to pin it.
- `shell.highlighted` (`src/ui/player-bar.ts:34`, `:44`) is bookkeeping for the mark's own
  short-circuit, not a second source of the current row. It is set to `null` at the top of every
  browse render (`src/ui/app.ts:694-695`) so a new view re-marks from scratch.

### 1.5 Is there a chunk-walk in the shipped code? No.

Requirement 2 asks that "chunk-walking" become impossible. Read against the shipped bytes: the tap
path is **one** assignment (`Cr` above / `player-bar.ts:316-320`) and there is **no** direction
guess, **no** step, **no** retry and **no** timer in it — nor anywhere else in the list's scroll
code (`src/ui/lyrics.ts:104-128` is the only other scroll writer, and it is the lyrics panel's own
line scroll). So the walk he describes is not a loop: it is the same wrong target seen from a
mid-list position (it lands at the top) and then seen again.

**One residual I could not settle from here, named so nobody builds on it:** the bar's click can in
principle be *refused* by the tap-vs-scroll authority the bar inherits (`src/ui/shell.ts:398-470`,
`SUPPRESS_TTL_MS` 700 ms, `src/ui/shell.ts:55-56`), which would read as "that tap did nothing, tap
again" — the other way "chunks at a time" can be perceived. I did not measure whether his sequence
hits it. §4's move counter settles it: **a refused tap moves the list zero times, a ghost tap moves
it once, and a walk would show two or more.**

---

## 2. The acceptance table

"First tap" and "second tap" are the owner's two taps on the song block of the bottom container.
"Shipped" is what I predict `v2.0.0-beta.2` does; the harness must confirm each prediction before
the fix is written against it (§4).

| # | Case | After the first tap | After the second tap | Shipped |
|---|---|---|---|---|
| 1 | **Middle row**, list scrolled to the top, long playlist | row centre within ±6 px of the box centre; **exactly one** `scrollTop` write; route unchanged; now overlay hidden | opens `#/now` on the `spectrum` pane | **passes** (no ghost) — must keep passing |
| 2 | **First row** of the list, list scrolled down | row fully inside the box; `scrollTop === 0` (the list's own limit); one write, never a negative offset | opens `#/now` | **fails** on a downloaded playlist: it reaches `scrollTop 0` by accident — the row he wanted is not the app's target — and the second tap does nothing at all |
| 3 | **Last row**, list scrolled to the top | row fully inside the box **and above the bar's top edge**; `scrollTop === max` | opens `#/now` | passes without a ghost; must be asserted explicitly (see §3.3 — the clearance is thin) |
| 4 | A view **whose order differs from the queue** (`#/album/…`, whose rows are in album order) | the target is the row the *view* marks, resolved by song id — the queue's index is never consulted; row centred | opens `#/now` | passes; asserted so a future "find the index in the queue" cannot land |
| 5 | **`#/artists`** — no row for the song in this view | no movement; **opens on the first tap** (v2.0-beta decision 1) | — | passes (`tools/container-tap-check.mjs` check 8) |
| 6 | The row **already fully on screen** | **`scrollTop` unchanged — no movement at all**; opens on this tap | — | passes (check 7) |
| 7 | **A downloaded playlist, online** (the ghost's population) | as row 1 | opens `#/now` | **FAILS**: `scrollTop` jumps to 0, the target is never centred, and the second tap re-scrolls and never opens |
| 8 | **The same downloaded playlist, server refused** | as row 1 | opens `#/now` | passes — the same list, the same tap, opposite result. This pair *is* the owner's "seems pretty random" |
| 9 | A **partial** playlist (only some tracks downloaded), server answer landing between the taps | one move per tap | if the late paint inserted rows above the target, the second tap may re-centre **once** and a third tap opens — **never two moves from one tap** | today the tap is dead before this can be observed |
| 10 | **Search after two submits**, an overlapping hit, row off screen | as row 1 | opens `#/now` | **FAILS** (ghost from the first result set) |
| 11 | A tap while the list is **still loading** (no row in the view yet) | opens `#/now`; no movement | — | passes; v2.0-beta's decision, kept |

Motion accounting for rows 1, 2, 3, 7-10 is the same assertion: **one `scrollTop` write per tap, and
zero on a tap that opens.**

---

## 3. The fix, as a shape (for `t_691c88c8`)

The card is docs-only; this is the contract, not the code. Nothing here adds a moving part: every
piece is a *deletion* or a *re-pointing* of something that already exists.

### 3.1 One source for "the current row": **the row the view on screen marks**

Delete the registry read at `src/ui/player-bar.ts:289-293` and resolve the target from the mark the
list itself puts on the screen:

```ts
/** The row this view marks as current — the only row a tap may scroll to. */
function currentRowInView(shell: Shell): HTMLElement | null {
  return shell.view.querySelector('.row.playing');   // first in document order
}
```

Why this is the right source, in the owner's own terms:

- **It is the row that is on the screen.** `querySelector` cannot return a detached node, so the
  ghost cannot exist on this path. The class is `styles.css`'s own highlight and the only thing any
  harness reads (`tools/container-tap-check.mjs:115`).
- **"Document order" becomes true rather than claimed** (a song listed twice → the first one).
- **The view is part of the question.** Scoped to `shell.view` — the drawn view inside the scroller —
  so a row belonging to a screen he has left (or to a pane behind the now overlay) cannot answer.
- The mark is already guaranteed to be on the live row: every list painter re-marks after it paints
  (`src/ui/app.ts:1409`, `:1429`, `:1524`, `:1869`, `:1991`), and `updateRowHighlight`'s
  short-circuit path re-adds the class to rows registered since the last pass
  (`src/ui/player-bar.ts:34-37`, `markRows` at `:48-50`).

**The one thing that must not change:** the mark has to be *removed* when it is no longer the current
row — which the toggling loop already does (`:38-43`: `row.classList.toggle('playing', id === current)`).
Do not replace that loop with an add-only pass.

**The rejected alternative, named so it is not chosen by accident:** keep the registry read, but
filter `row.isConnected` and take document order. It fixes the ghost too, and it is *worse*, because
it leaves two sources of one fact (the registry and the mark) that can drift again — and drift is
what this card exists to delete. If the implementer keeps any registry read in the tap path, the
harness's row-7 and row-10 cases must be shown failing-then-passing on their own.

### 3.2 One move, derived from the row's own offset, clamped by the list

```ts
/** The scrollTop that puts this row's centre at the box's centre, clamped to the list's own range. */
export function centreOffset(row: HTMLElement, box: HTMLElement): number {
  const r = row.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const wanted = box.scrollTop + (r.top + r.height / 2) - (b.top + b.height / 2);
  const max = Math.max(box.scrollHeight - box.clientHeight, 0);
  return Math.min(Math.max(wanted, 0), max);
}
```

- **Both reads happen before the only write** → the tap still cannot force a second layout, which is
  P1's own rule (`docs/design-v2.0-beta.md:351-354`).
- The clamp is not a special case for the ends: a first or last row simply *asks* for an offset
  outside the range and gets the range's end. `scrollTop`'s own clamping is kept as a belt-and-braces
  assignment, but the **decision** (below) needs the clamped number, so it must be computed.
- Never `scrollTo({ behavior: 'smooth' })`: a smooth scroll is a move over time and can be overtaken
  by a second tap.

### 3.3 The second tap keys on visibility — and, at the ends, on "the list cannot do better"

```ts
export function containerTap(ctx, shell, openNow, event): void {
  if (!isContainerTap(event.target)) return;
  const row = currentRowInView(shell);
  if (row === null) { openNow(); return; }                     // nothing to bring on screen
  if (visibleInBand(row, shell)) { openNow(); return; }         // already there → no movement at all
  const wanted = centreOffset(row, shell.viewScroll);
  if (wanted === shell.viewScroll.scrollTop) { openNow(); return; }  // the list cannot move it closer
  shell.viewScroll.scrollTop = wanted;                          // one move, no navigation
}
```

- `visibleInBand(row, shell)` = the row's rect fully inside `shell.viewScroll`'s rect **and above the
  player bar's top edge**. The header is not part of this: `.topbar` is a `flex: none` row of the
  shell *outside* the scroller (`src/styles.css:135-152`, shell built at `src/ui/shell.ts:115`), so
  the scroll box's own top edge is already the visible top. The bar is the one thing that covers the
  scroller: `position: fixed; inset: auto 0 0 0` (`src/styles.css:712-715`).
  **Read the bar's own rect, and treat "the bar is not on screen" explicitly** — `.playerbar.hidden`
  is `display: none` (`src/styles.css:728-731`), whose rect is all zeros, so a `Math.min` against it
  would collapse the band to nothing.
- **The third branch is what makes the ends work**, and it is also what makes a list shorter than the
  box work (there, `max === 0` and `wanted === scrollTop` by construction). It is the honest
  restatement of his own rule: *as long as it is on screen — as on screen as this list can put it —
  the tap goes to the spectrum.*
- **The clearance at the bottom is thin and must not be assumed.** *Derived from the CSS*: the `.view`
  padding reserves `--bar-height + 28px` = 100 px (`src/styles.css:22`, `:228`) at the end of every
  list, while the bar's own height is `min-height: var(--bar-height)` (72, border-box) against
  `44 px` of content plus `8 + 8 + safe-area-bottom` of padding (`src/styles.css:720-721`) → **72 px
  with no home indicator, ~94 px with his iPhone's 34 px inset**. So the last row has ~28 px of
  clearance in the desktop harness and **~6 px on his phone**. Row 3's assertion is what keeps that
  honest: if the last row's bottom is under the bar's top at max scroll, the third branch still opens
  the now screen (the tap must never be the thing that is wrong), and the padding gets the one-line
  `+ env(safe-area-inset-bottom)` — that is a decision for the implementation card, and the harness
  reading both rects is what decides it, not this paragraph.
- **The load case stays as it is** (row 11): no row in the view → open the now screen. That is
  v2.0-beta's decision 1 and the fix must not turn it into "do nothing".

### 3.4 What is explicitly *not* in the fix

- **No timer, no retry, no second move.** Nothing in §3 needs one: after §3.1 the row is read from
  the document, and if it is not there the answer is "open the now screen", not "wait".
- **No re-centring triggered by a paint.** A view that paints its list again (the server's answer at
  `src/ui/app.ts:1795` replacing the manifest's list) may move the target out from under a tap that
  has already run. That costs one extra tap in the partial-playlist case (row 9) and is **accepted**;
  a paint that scrolls the list would be the second move from one tap that the card forbids. The
  cheaper long-term answer — painting the server's answer into the existing rows instead of
  replacing them — is a different card and is **not** in this one.
- **No change to the regions** (`isContainerTap`, `src/ui/player-bar.ts:278-280`), to the
  no-navigation rule, or to `ctx.rows`' job of *marking* rows. Optional tidy-up, ranked last and
  independent of the fix: the sets hold detached elements for the life of a route render
  (`src/ui/app.ts:2179-2184`); dropping the replaced batch in `paintPlaylist`/`submit` would stop the
  registry leaking, and is worth doing **only** because it stops the next reader from trusting it.

---

## 4. The harness plan — it must FAIL on the shipped bytes

**Reuse what exists; do not write a new harness.** `tools/container-tap-check.mjs` already owns this
rule and already drives real taps through Chrome's input pipeline at 393 × 852, muted, no simulator
(its header, `:1-38`). Two things about it are exactly why the defect shipped:

1. its fixture never makes the playlist page paint twice — `#/playlist/pl-stress-long` with a fresh
   browser profile and **no** `navilite.offline` mirror in `localStorage`
   (`tools/container-tap-check.mjs:186-226`), so `renderPlaylist`'s first paint is skipped
   (`src/ui/app.ts:1767`), there is no ghost, and checks 5 and 6 are green on the shipped bytes; and
2. it reads the row the *eye* sees (`.row.song.playing` from the DOM, `:115`) while the app resolves
   the row the *registry* holds — so it is measuring the right thing and the app is not.

### 4.1 The fixture that reproduces his symptom

Add a second fixture to the same harness, built out of the app's own offline mirror — the exact
structure `tools/offline-check.mjs:209-233` writes and `tools/offline-check.mjs:436` puts in
`localStorage['navilite.offline']`, and what a real install has after a download
(`src/storage/offline.ts`, read back by `src/state/offline.ts`). Build it from the mock's own
playlist so the two paints draw the **same** songs in the **same** order:

- `GET /rest/getPlaylist?id=pl-stress-long` against `tools/mock-subsonic.mjs --stress` → the songs;
- write one mirror row per song (`path` under the harness's art dir, `bytes`, `state: 'complete'`,
  `title`, `artist`, `album`, `coverArt`, `durationSec`) and one manifest
  (`playlists['pl-stress-long'] = { name, requestedAt, state: 'complete', songs: [...] }`);
- reload, then run the checks 5/6 sequence unchanged (`tools/container-tap-check.mjs:305-341`).

### 4.2 The fail-before, and its own guard

Run the harness against **a build of the shipped tag**, not the working tree:

```
git worktree add ../navilite-before v2.0-beta.2 && (cd ../navilite-before && npm ci && npm run build)
node tools/mock-subsonic.mjs --port 4651 --stress --dist ../navilite-before/dist
node tools/container-tap-check.mjs --url http://127.0.0.1:4651 --json before.json
```

On those bytes the seeded fixture must fail, and it must fail **in the owner's shape**, not next to
it — that is the whole point of the fixture:

- `scrollTop` ends at **0** with the row neither centred nor on screen (the ghost's zero rect);
- the second tap **does not** reach `#/now` (it re-runs the scroll branch);
- **and the same fixture with the API refused passes** (`node tools/mock-subsonic.mjs` pointed at a
  dead port, per `tools/offline-check.mjs`'s two-server method). Same list, same tap, opposite
  result — the pair is the reproduction, and a harness that cannot produce both halves has not
  reproduced his report.

**Guard the fixture itself, or a green run means nothing.** Before the tap, the harness must assert
that the page really did paint twice (the precondition that makes a ghost possible) — read it out of
the app's own observable state, e.g. that the local manifest's list was on screen *before* the
server's answer landed (the playlist's rows are drawn with the manifest's own names), and print the
count of registered-vs-connected rows for the target id. If that assertion cannot be made, the check
must report **SKIPPED with the reason**, never pass.

**If the fail-before does not fire on the shipped bytes, this diagnosis is incomplete** — report it
on the card and stop; do not adjust the fix until the harness reproduces his words.

### 4.3 The rows the shipped harness never covered

Add to the same file, each one a check with a number in the JSON report (same read helper, `:98-120`):

1. **first row** of a long playlist, list scrolled down → `scrollTop === 0`, row fully inside the box,
   second tap opens (acceptance row 2);
2. **last row** → row fully inside the box *and* `row.bottom <= bar.top`, `scrollTop === max`, second
   tap opens (row 3) — this is also the check that decides the padding question in §3.3;
3. **album page** (`#/album/…`, rows in album order, queue in playlist order) → centred by id, second
   tap opens (row 4);
4. **two-submit search** → the row he is on is found, centred, second tap opens (row 10);
5. **a tap during the load window** → `#/now`, no movement (row 11);
6. **the motion count** — the harness installs its own `scroll` listener on `.view-scroll` (its own
   probe, no app hook) and asserts **one write per tap, zero on the tap that opens** (§2's accounting,
   rows 1-3, 7-10). This is the assertion that separates the ghost from the refused-tap reading in
   §1.5: zero moves means refused, one means the ghost, two or more would be the walk nobody has
   found in the code.

### 4.4 Pin it in `npm test`

`tools/container-tap-check.mjs` is **not** run by `npm test` today (only `tools/scroll-check.mjs` is
— `test/scroll-containment.test.ts:12`, `:117`). Add `test/container-tap.test.ts` in that exact shape
(spawn the harness with `--json`, assert the reported **numbers**, not the exit code, and SKIP with
the reason printed when Chrome or a built `dist/` is missing) so this defect cannot come back
silently. Keep it out of the critical path: the harness really plays audio, so it stays muted
(`--mute-audio`, already the default in `tools/layout-audit.mjs`'s page options) and no iOS Simulator
is booted, ever.

**Budget:** this is one browser run plus the refused-server half — reuse the existing mock and the
existing driver. Do not build a second harness and do not add a device probe.

---

## 5. The four no-regression properties, same method as `v2.0.0-beta`

Same machine, same fixture, **before and after**, muted; both numbers reported, including the worse
one (`docs/design-v2.0-beta.md:331-336`). "Before" for this card is a scratch checkout at
`v2.0-beta.2` (`03eb486`) with its own `dist/`; "after" is the implementation card's tree.

| Property | Method (unchanged from v2.0-beta) | Acceptance |
|---|---|---|
| **P1 responsiveness** | `test/slow-link-browser.test.ts`, in `npm test`: the tap paints **in the same task** (a synchronous read after `row.click()`), plus cold/warm track-change medians. The new surface is held to the same boolean: §3.2 reads both rects before the single write, and the harness's motion count is read synchronously after the click | the same-task paint stays `true`; cold/warm medians rise `< 20 %` |
| **P2 offline playback** | `tools/offline-check.mjs --app <origin with a built dist> --json report.json`, plus the nine offline files in `npm test` (`docs/design-v2.0-beta.md:356-368`) | the harness exits 0 before and after and the two reports agree field for field; **structurally**, this card touches `src/ui/player-bar.ts` (and possibly one line of `src/styles.css`) and **no** offline/native file |
| **P3 backgrounded playback** | `tools/playback-property-check.mjs --url … --label before\|after` — muted Chrome, the forced `document.hidden` + dispatched `visibilitychange` method, no simulator (`docs/design-v2.0-beta.md:370-398`) | the invariants in that harness hold; no `paused` flash; the bars re-feed on return |
| **P4 time to first sound** | the same run: 9 taps, `t0` at `row.click()`, first sound = the app's own media element reporting `currentTime > 0` while not paused — **not** the chip's word (`docs/design-v2.0-beta.md:400-422`) | p90 no more than **+10 %**; medians and p90 reported both ways |

Honest expectation, stated so a flat number is not read as a missing measurement: this card changes
no engine, queue or storage code, so P2-P4 should be *the same number twice*. They are still measured
before and after, because "should be unaffected" is a claim and the card's own rule is that a claim
without a number is not one (`docs/design-v2.0-beta.md:488`).

---

## 6. Risks, each with the check that catches it

| # | Risk | Check |
|---|---|---|
| 1 | The mark is missing on a row the view drew → the first tap goes straight to the spectrum | the fixture asserts `document.querySelector('.row.playing')` is non-null before every centre-tap; §3.1's "every painter re-marks" list is the code-side audit |
| 2 | A DOM read becomes a second source of the same fact | one read, scoped to `shell.view`, in one function, with the reason in the comment; the rejected registry alternative is written down in §3.1 so it is not chosen quietly |
| 3 | The band's bottom edge is computed from a hidden bar | the bar-on-screen test is explicit (`display: none` gives a zero rect, `src/styles.css:728-731`); the harness asserts the tap opens with the bar on screen and after P3 backgrounds and restores it |
| 4 | A late paint moves the target under a tap that already happened | row 9: **one move per tap**; if a third tap is ever needed on a partial playlist, it is recorded in the changelog bullet rather than hidden |
| 5 | The ghost is closed on the playlist path and left alive in search | row 10 is its own judgement, with its own numbers |
| 6 | A green harness is green because the fixture stopped making ghosts | the pre-tap "painted twice" assertion in §4.2, and the offline half of the same fixture that must pass (a fixture that fails in both halves is a broken fixture, not a repro) |
| 7 | The fix becomes a "wait for the row" race | §3.4: no timer, no retry; if an implementation needs one, that is a signal the diagnosis is wrong — come back to the card |

## 7. Not claimed by this design

- **Nothing was run.** No browsers, no harness, no build, no simulator (his rule). Every "today"
  verdict in §1 and §2 is read out of the source and the shipped bundle and is a prediction for §4.
- **No version bump, no tag, no artifact, no `src/`** — this card is docs only. The release card
  decides the number, and if the number is `beta.3`, `docs/VERSIONING.md` §3's file list is what the
  release card touches.
- **No number from his phone.** §5's numbers are loopback on this Mac, muted — the caveat the
  existing harnesses already write about themselves.
- **No claim about WebKit's own gesture handling**: everything here is Chrome's pipeline. The iOS
  round trip is a device/Simulator run this card does not do and no card here is allowed to boot.
- **No claim that every view is now covered** — §2's table plus §4.3 is the whole of what "fixed"
  means here.
