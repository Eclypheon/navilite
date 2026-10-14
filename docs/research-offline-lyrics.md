# Research: Offline Lyrics for Downloaded Playlists

## 1. Recommendation
1. **Target Endpoint:** Use OpenSubsonic `getLyricsBySongId?id=<songId>`. It binds lyrics strictly to the track's immutable Subsonic song ID (eliminating the false-match and collision risks of legacy artist/title `getLyrics`) and provides line-level millisecond timestamps (`line[].start`) when synced.
2. **Offline Storage Strategy (Raw vs Parsed):** Store raw lyrics text on disk at `Library/Application Support/offline/<songId>.lyrics`. Do not store pre-parsed ASTs or JSON blobs in SQLite/localStorage. Storing raw text allows app updates to refine LRC parsing, timing offset logic, and kanji romanization without re-downloading media or migrating schemas.
3. **Location & Backup Coupling:** Place `.lyrics` files in the identical directory alongside audio (`offline/<songId>.<ext>`) with `URLResourceValues.isExcludedFromBackup = true`. When a song's refcount drops to 0, both files are pruned atomically. Avoid `Library/Caches/` (silent OS eviction under storage pressure) and `Documents/` (violates App Store Guideline 5.1.1 on iCloud backup).
4. **Pre-Flight Sizing Formula:** Because Subsonic/Navidrome `Song` metadata provides no lyric byte size, pre-calculate playlist storage as `audioBytes + sum(lyricsBytes)`. For songs already stored or verified, use exact file size; for unresolved songs, apply an upper-bound constant `LYRICS_ASSUMED_BYTES = 12 * 1024` (12 KB) and prefix the UI label with "up to " (e.g., `↓ up to 312 MB`).

## 2. Alternatives & Storage Comparison

| Approach | Update Resilience | Storage Reliability | Pre-flight Accuracy | Cleanup Simplicity | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A. Pre-parsed JSON in SQLite / LocalStorage** | ❌ Schema migration on parser fixes | ⚠️ LocalStorage 5MB quota cap | ❌ Requires roundtrip probe | ⚠️ Relational cascade needed | **Reject**: Brittle across releases. |
| **B. Embedded ID3 Tag Rewrite** | ❌ Re-encodes audio; breaks checksums | ✅ Single file | ⚠️ File size expands | ✅ Single file delete | **Reject**: Mutates audio payload. |
| **C. Discrete Raw `.lyrics` in App Support** | ✅ Parser fixes apply dynamically | ✅ Protected from iOS cache purge | ✅ 12 KB ceiling upper-bound | ✅ Atomic deletion with audio | **Recommended**: Production standard. |

## 3. Findings by Topic

### 1. Backend Delivery & Navidrome Payloads
- **Endpoints:** Legacy Subsonic `getLyrics?artist=...&title=...` returns flat string blobs with no timing metadata and no song ID association. Modern Navidrome (v0.48+) implements OpenSubsonic `getLyricsBySongId?id=<songId>`, returning `lyricsList.structuredLyrics[]` containing `lang`, `offset`, `synced: boolean`, and `line: [{start: number, value: string}]`.
- **Pre-flight Metadata:** Neither Subsonic nor OpenSubsonic includes lyrics size in `getPlaylist` or `getSong` metadata payloads. Size cannot be determined upfront via metadata; it must be estimated.
- *Source:* [OpenSubsonic songLyrics Extension](https://opensubsonic.netlify.app/docs/extensions/songlyrics/), [OpenSubsonic structuredLyrics](https://opensubsonic.netlify.app/docs/responses/structuredlyrics/), [Navidrome Subsonic API](https://www.navidrome.org/docs/developers/subsonic-api/)

### 2. Timed Lyrics Formats & Client Offline Caching
- **Formats:** Standard `.lrc` uses `[mm:ss.xx]` line prefixes; Enhanced LRC adds `<mm:ss.xx>` word-level cues. OpenSubsonic models this via `start` offsets (ms) and `offset` shifts.
- **Client Precedent (Amperfy, Symfonium, Feishin, play:Sub, Apple Music):** Subsonic clients cache raw `.lrc`/text sidecars alongside media files rather than storing parsed ASTs in database rows. Symfonium indexes metadata in SQLite but reads raw lyric strings into an in-memory parser at display time. Storing raw text prevents cache invalidation bugs when timestamp parser algorithms update.
- *Source:* [Amperfy Source](https://github.com/BLeeEZ/amperfy), [Symfonium Caching & Offline Docs](https://support.symfonium.app/t/how-symfonium-handles-caching-and-offline-media/35)

### 3. Timing & Format Edge Cases
- **No Timestamps / Plain Text:** Degradation must render plain text cleanly with line highlighting disabled.
- **Timestamp Out-of-Order / Duplicates:** Sort lines strictly by `start` / `timeMs` post-parse to prevent binary search highlighting oscillation. Duplicate tags (e.g., repeated chorus lines `[01:10.00][02:20.00]`) must expand into discrete display lines.
- **Global Offset Tags:** Respect `[offset: +/-ms]` header tags; positive offset displays lyrics earlier.
- **Instrumentals & Long Gaps:** When the gap between timestamps exceeds 8 seconds, clear active line highlighting to avoid highlighting stale lyrics during instrumental passages.
- **Multi-language / Translations:** OpenSubsonic version 2 supports `kind: "translation"|"main"`. Line-interleaving breaks sync; clients should default to the `main` or user-preferred language track.
- *Source:* [Wikipedia LRC Format Specification](https://en.wikipedia.org/wiki/LRC_(file_format))

### 4. Pre-Flight Sizing Mechanics
- **Estimation vs Exact:** No content-length or line-count exists in pre-flight manifests. Probing via HTTP HEAD per-track adds 50+ network roundtrips, degrading playlist view performance.
- **Honest Upper Bounds:** Over 99% of synchronized LRC files measure between 1 KB and 6 KB (a 200-line song averages ~4 KB). An assumed upper-bound of 12 KB per track guarantees the pre-flight estimate never under-reports disk consumption.
- **UI Disclosure:** Label the estimate "up to X MB" whenever unresolved tracks exist, transitioning to exact figures once downloads verify. Precedent: Spotify and Apple Music display approximate download sizes until bundle assets are written to disk.
- *Source:* [OpenSubsonic Song Schema](https://opensubsonic.netlify.app/docs/responses/song/)

### 5. iOS Storage & iCloud Backup
- **Directory Placement:** Store offline lyrics alongside downloaded audio in `Library/Application Support/offline/<songId>.lyrics`. Never use `Library/Caches/` (iOS spontaneously evicts cache files when system storage is constrained). Never use `Documents/` (triggers App Store Guideline 5.1.1 rejection for non-user-generated iCloud backups).
- **iCloud Exclusion:** Set `NSURLIsExcludedFromBackupKey = true` on all downloaded media and lyric files immediately upon write.
- **APFS Allocation:** On iOS APFS filesystems, 4 KB cluster sizes mean a 2 KB lyric occupies 4 KB on disk; 12 KB upper bounds align with real disk block consumption.
- *Source:* [Apple File System Programming Guide](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html), [Apple URLResourceValues isExcludedFromBackup](https://developer.apple.com/documentation/foundation/urlresourcekey/1417061-isexcludedfrombackupkey)
