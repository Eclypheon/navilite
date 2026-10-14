# Research: Offline Playlist Downloads for Navilite

## 1. Recommendation
1. **Storage Target:** Store downloaded media as discrete audio files under `Library/Application Support/offline/<songId>.<ext>` and flag every file with `isExcludedFromBackupKey = true`. Never use `Library/Caches/` (purged by iOS under storage pressure) and never use `Documents/` (violates iCloud backup rules).
2. **Download Transport:** Implement a native Swift plugin (`NaviliteDownloader`) backed by `URLSessionConfiguration.background(withIdentifier:)`. Do not use JS `fetch()` or `@capacitor/filesystem` (JS execution dies 3–5 seconds after backgrounding; base64 filesystem writes spike memory).
3. **Local-First Resolution:** Store media deduplicated per-song by Subsonic `songId`. Playlists are metadata manifests referencing song IDs. When resolving playback in `state/queue.ts`, if `<songId>.<ext>` exists locally, pass its `file://` path to `@capgo/capacitor-native-audio` (AVPlayer plays `file://` natively with range seeking and preserves the `NaviliteSpectrum` FFT tap); otherwise fall back transparently to `library.streamUrl(song)`.
4. **Endpoints:** Fetch downloads using Subsonic `download?id=<songId>` (untranscoded original file) instead of `stream?id=...` with `maxBitRate`. This guarantees exact `Content-Length`, HTTP Range resumability, and avoids server-side `ffmpeg` CPU spikes.

## 2. Alternatives Comparison

| Approach | Background Capable | Storage Resilience | Memory Safety | Audio & Spectrum Tap Compatibility | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A. JS `fetch()` + Blob / Cache Storage** | ❌ Dies in 3s | ❌ Subject to WebKit eviction | ❌ High RAM usage / OOM on FLAC | ❌ WKWebView `<audio>` range issues | **Reject**: Fails on mobile. |
| **B. `@capacitor/filesystem` (downloadFile)** | ❌ Dies when app suspended | ⚠️ Depends on directory | ⚠️ Deprecated; no chunked pipe | ✅ Hands `file://` to AVPlayer | **Reject**: Cannot survive backgrounding. |
| **C. Native `URLSession` Background Plugin** | ✅ Managed by `nsurlsessiond` | ✅ `Application Support` + unbacked | ✅ Streams direct to temp disk | ✅ Full AVPlayer + FFT tap support | **Recommended**: Production standard. |

## 3. Findings by Topic

### 1. Real Mobile Client Implementations
- **Amperfy (iOS / Subsonic):** Stores tracks in the app sandbox container indexed by a local CoreData/SQLite database. Playlists store ordered song references; downloading a playlist queues constituent song downloads. Playback checks `FileManager.fileExists(atPath: localUrl)`: local files take precedence, streaming is fallback. ([Amperfy GitHub](https://github.com/BLeeEZ/amperfy))
- **Symfonium (Android):** Separates ephemeral rolling playback cache from explicit offline downloads (`OfflineMedias/`). Files are deduplicated across albums/playlists by track ID, indexed in SQLite. ([Symfonium Storage Docs](https://symfonium.app/))
- **Plexamp / Feishin:** Maintain a local index (`downloads.db`) mapping remote server rating keys / item IDs to file paths. Playlists are lightweight manifests.

### 2. iOS / Capacitor Mechanics & Storage
- **Directory Selection:** `Library/Application Support/` is the canonical location. `Library/Caches/` is silently purged by iOS during storage pressure (e.g. before taking a photo). `Documents/` is backed up to iCloud by default; putting multi-gigabyte media here causes App Store rejection under Guideline 2.2 / 5.1.1. Files in `Application Support` must set `URLResourceValues.isExcludedFromBackup = true`. ([Apple File System Programming Guide](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html), [Apple isExcludedFromBackupKey](https://developer.apple.com/documentation/foundation/urlresourcekey/1417061-isexcludedfrombackupkey))
- **Capacitor Filesystem Limits:** `@capacitor/filesystem` deprecated `downloadFile` in favor of dedicated transfer plugins. Large file writes over the bridge via base64 cause severe memory pressure.
- **WebView `<audio>` Pitfalls:** WKWebView blocks direct `file://` access from `capacitor://localhost`. Converting paths via `Capacitor.convertFileSrc()` proxies through `WKURLSchemeHandler`, which does not reliably support HTTP 206 Range requests, breaking seeking. Crucially, Navilite uses AVPlayer via `@capgo/capacitor-native-audio` inside the app shell, which natively accepts `file://` URLs, bypassing WebKit restrictions entirely. ([Capacitor Filesystem Docs](https://capacitorjs.com/docs/apis/filesystem))

### 3. Background Downloads on iOS
- **URLSession Background Sessions:** Initialized via `URLSessionConfiguration.background(withIdentifier:)`. Transfers are executed out-of-process by `nsurlsessiond`. They survive app suspension, backgrounding, and system memory termination. ([Apple URLSessionConfiguration.background](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/1407496-background))
- **JS Suspension:** WebKit suspends JS execution within 3–5 seconds of moving to background. Any download initiated via web `fetch()` aborts.
- **App Termination & Resumption:** If terminated while suspended, iOS wakes the app in background upon task completion via `application(_:handleEventsForBackgroundURLSession:completionHandler:)`. Recreating the session with the identical identifier re-attaches delegate events.

### 4. Download Manager Patterns
- **Concurrency & Queuing:** Cap concurrent downloads at 2–3 tasks to prevent connection starvation and I/O bottlenecks.
- **Resumability:** `URLSessionDownloadTask` natively captures `resumeData` on network drops or cancellations, enabling byte-range resumption conforming to HTTP Range semantics. ([RFC 7233 Range Requests](https://datatracker.ietf.org/doc/html/rfc7233), [Apple URLSessionDownloadTask](https://developer.apple.com/documentation/foundation/urlsessiondownloadtask))
- **Atomic Writes:** Download to a staging directory (`.tmp` extension). On successful verification, atomically move (`FileManager.moveItem`) to final path `<songId>.<ext>`.
- **Integrity Checks:** Validate actual bytes written against expected `Song.size` / `Content-Length`. Sweep orphan `.tmp` files on app boot.

### 5. Subsonic / Navidrome Specifics
- **Endpoints:** `stream` supports transcoding (`maxBitRate`), which spawns `ffmpeg` with chunked transfer encoding (unknown total size, inconsistent range seeking). `download` serves the raw original audio file with an exact `Content-Length`. Always download original files. ([Navidrome Subsonic API Docs](https://www.navidrome.org/docs/developers/subsonic-api/))
- **Pre-flight Sizing:** Navidrome’s `getPlaylist` endpoint returns full `Song` metadata for every entry, including `size` (in bytes) and `duration`. Navilite can compute the exact total download payload upfront: `playlist.entry.reduce((sum, s) => sum + (s.size ?? 0), 0)`.
- **Limits:** Downloading un-transcoded files avoids CPU starvation on small servers (e.g., Raspberry Pi).

### 6. Local-First Resolution
- **Resolution Strategy:** Key storage on `songId`. When `PlaybackQueue.select()` / `startCurrent()` runs:
  1. Check if `offlineStore.has(song.id)` and file exists at `file://...`.
  2. If valid, dispatch local file path to `AudioEngine.play()`.
  3. If missing or playback fails (`loadError`), fall back to `library.streamUrl(song)` and mark offline entry corrupt.
- **Deduplication:** A track shared across 5 playlists is stored once on disk and reference-counted in metadata. ([OpenSubsonic API Standards](https://opensubsonic.netlify.app/docs/))

### 7. Eviction & Accounting
- **Accounting:** Local SQLite or JSON index tracks `songId`, `sizeBytes`, `downloadedAt`, and `playlistRefs: string[]`.
- **Storage Reporting:** Query device capacity via `volumeAvailableCapacityKey`. Enforce a pre-flight guard: require `availableStorage > playlistTotalBytes + 250MB`. ([Apple volumeAvailableCapacityKey](https://developer.apple.com/documentation/foundation/urlresourcekey/1415707-volumeavailablecapacitykey))
- **Eviction:** When a playlist is deleted from offline storage, decrement `refCount` for each track; delete track files whose `refCount == 0`.

### 8. OS & App Store Constraints
- **iCloud Backup:** Large audio files in `Documents/` without `isExcludedFromBackup` trigger App Store review rejection under Guideline 2.2 / 5.1.1. ([Apple App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/))
- **Audio Session Abuses:** Apps cannot play silent audio in background solely to keep download loops alive; transfers must use `URLSession`.
- **Cellular Control:** `URLSessionConfiguration.allowsCellularAccess = false` natively enforces user preference for "Wi-Fi Only Downloads".

## 4. What is NOT Possible or is Risky on iOS
1. **Background Downloads via JS:** Impossible. Background execution requires native `nsurlsessiond` delegation.
2. **Predictable Transcoded Sizes:** Navidrome cannot report ahead-of-time file sizes for transcoded streams; downloads must fetch original files.
3. **Storing in `Caches`:** High risk of random file eviction under low memory/disk conditions, breaking offline playback without warning.
4. **App Force-Quit:** If the user swipes away Navilite from the iOS App Switcher, iOS immediately cancels all background `URLSession` tasks.

## 5. Open Questions for the Designer
1. **Cellular Data Policy:** Should Navilite default to "Download on Wi-Fi only", and should user be prompted before downloading over cellular?
2. **Quality vs Size:** Should Navilite always download original files (FLAC/ALAC can be 30MB+ per song), or should settings offer a download quality preference despite transcoding unpredictability?
3. **Sync Frequency:** When a playlist is modified on the server, should Navilite automatically download new tracks in the background, or only sync on user request?
