# Git and versioning: one branch, one bump list, one build rule

Written 2026-10-12 after the 1.9.4 release, when the repository was left with
`main` several versions behind the branch the releases were actually built on
(`release/v1.7`), five stale branches, and release tags that lived on that side
branch rather than on `main`. This file is the rule that stops that recurring.

## 1. One branch: `main`. No other branch, ever.

Commit straight to `main`. Do not create a per-feature branch, a `release/*`
branch, or a worktree branch (`git worktree add`). One developer plus one
reviewing agent means a branch buys nothing and costs a merge: `main` fell from
v1.4.1 to five releases behind because the work went onto `release/v1.7`, and
the merge that brought it back had to be hand-resolved.

- Builds are made from a clean `main` checkout in `/Users/neokester/navilite`.
- Nothing is ever "only on the feature branch" — if work is worth keeping it is
  committed to `main` before anything else happens.
- State verified on 2026-10-12: local `git branch` = `main` only; `origin` has
  `main` only; `release/v1.5`, `release/v1.5.1`, `release/v1.6`, `release/v1.7`
  and `fix/v1.5-settings-301px` are deleted; there is no `wt/*` branch. All were
  contained in `main` before deletion, so nothing was lost.

## 2. A release tag goes on the commit that carries the release, on `main`

Annotated tag, message `vX.Y.Z — <one line, the owner-visible change>`, on the
commit on `main` that contains that release's body.

Check both directions after tagging:

```bash
git merge-base --is-ancestor v1.9.4^{commit} main && echo "tag is on main"
git branch --contains v1.9.4          # must print main, and nothing else
```

As of 1.9.4 all 24 tags (v1.0 … v1.9.4) are contained in `main`. `v1.9.2` was
never tagged at all and `v1.9.3`/`v1.9.4` were untagged: an untagged release is
invisible in the repository's own history, which is how the tag/`main` drift
went unnoticed for several releases.

## 3. Every file a version bump must touch

One commit does all of these; a bump that touches only some of them is a bug
(it already happened: the changelog test failed on 1.9.4 because the release
check's list was updated in a commit of its own).

| File | What changes |
|---|---|
| `package.json` | `"version"` |
| `android/app/build.gradle` | `versionName "X.Y.Z"` and `versionCode N` (integer, +1 every release, never reused or lowered) |
| `ios/App/App.xcodeproj/project.pbxproj` | `MARKETING_VERSION = X.Y.Z` (two places — Debug and Release) and `CURRENT_PROJECT_VERSION = N` (two places, +1) |
| `src/ui/changelog.ts` | the release entry the app shows under "What's new" (version, date, items) |
| `CHANGELOG.md` | the same entry, same order, same wording — `test/changelog.test.ts` fails on any drift |
| `test/changelog.test.ts` | the expected version list in `the changelog is the owner-visible list` — this is the release check |

Notes:

- `ios/App/App/Info.plist` holds no literal version: it reads
  `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`, so editing it is never
  part of a bump.
- `versionCode` (Android) and `CURRENT_PROJECT_VERSION` (iOS) are independent
  per-platform counters. At 1.9.4 they are **24** and **25** — iOS has been one
  ahead since 1.9.1. Both were +1 per release; do not "align" them, they only
  each have to be higher than that platform's previous release.
- `package-lock.json` has its own root `"version"`, which npm rewrites. If you
  edit `package.json` by hand, run `npm install --package-lock-only` so it does
  not drift again (it sat at 0.1.0 until 1.9.4).
- The app's About line shows the **build id** (the git short SHA from
  `tools/build-id.ts`), not the semver. On iOS the version only exists in the
  built `Info.plist`, which is why step 4 exists.

## 4. The artifact is the proof, not the source file

A version stamp in a source file proves nothing about what was installed. After
a build, read the version out of the artifact itself:

```bash
# iOS IPA
unzip -p artifacts/Navilite-X.Y.Z-unsigned.ipa Payload/App.app/Info.plist \
  | plutil -p - | grep -E 'CFBundleShortVersionString|CFBundleVersion'

# Android APK
"$HOME/Library/Android/sdk/build-tools/36.1.0/aapt2" dump badging \
  artifacts/Navilite-X.Y.Z-debug.apk | head -1
```

Values as shipped for 1.9.4 (verified 2026-10-12):

- IPA `CFBundleShortVersionString` = `1.9.4`, `CFBundleVersion` = `25`
- APK `versionName='1.9.4' versionCode='24'`

## 5. Build and test commands

```bash
npm run typecheck                     # tsc --noEmit
npm run test                          # node --test test/*.test.ts (includes the changelog release check)
npm run build                         # tsc --noEmit && vite build
npm run apk                           # → artifacts/Navilite-<version>-debug.apk
npm run ipa:unsigned                  # → artifacts/Navilite-<version>-unsigned.ipa
```

`npm run apk` / `npm run ipa:unsigned` already run `patch:native`, `build` and
`cap sync` themselves; do not chain them by hand.

## 6. A build happens only after a commit, with an empty `git status`

The rule, in order:

```bash
git status --porcelain    # must print nothing
git log -1 --oneline      # the commit the artifact will be built from
npm run apk               # then the build, then the artifact check in §4
```

If `git status --porcelain` prints anything, commit it first. A build from a
dirty tree cannot be reproduced from any commit and cannot be tagged — which is
exactly how the v1.9.2 and v1.9.3 bodies ended up sharing a single commit.
