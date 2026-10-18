import Capacitor
import Foundation

/**
 * Navilite's offline playlist downloads (v1.9.12): a background `URLSession` that fetches the
 * **original, untranscoded** file (`download?id=`) into staging and moves it into place only once
 * the bytes have been verified against `Content-Length`.
 *
 * This is a deliberately separate lane from the audio bridge. The audible load and the warm pool
 * own `src/player/native.ts`'s `AssetLanes`; a download must never `prepareNext`, `warmedUrl`,
 * `discardPrepared` or `yieldToAudible`, and this plugin is not on that bridge at all. The transfer
 * runs inside `nsurlsessiond`, so it continues while the app is suspended — the JS side treats
 * every progress event as advisory and `list()` as the truth.
 *
 * **Two transfers per song, keyed by `songId` *and* kind.** A track is downloaded as `audio` and,
 * separately, as `lyrics`; both may be in flight at once. Every task, every persisted job and
 * every cancellation is keyed `"<kind>:<songId>"` (`audio:abc123`, `lyrics:abc123`), so the lyrics
 * enqueue can never overwrite, cancel or complete the audio transfer of the same song — the defect
 * v1.9.12 shipped with, where both lanes shared the bare `songId`. `cancel(songId:)` with no kind
 * stops both of a song's transfers; `remove(songId:)` always removes both.
 *
 * Storage (`Library/Application Support/navilite-offline/`):
 *
 *   <songId>.<suffix>                a complete, verified file (audio; `lyrics` for a lyric body)
 *   staging/<songId>.<suffix>.part   transferred bytes, not yet verified — never audible,
 *                                    never addressable
 *   index.json                       the native index — THE truth for what is on disk
 *
 * `index.json` is written atomically (write `.tmp`, `replaceItemAt`) after every state change. A
 * completion handler never waits on JS: the staging write, the verification and the move all happen
 * natively, so the file is correct even if JavaScript never runs again. Every file this plugin
 * creates — each promoted `<id>.<suffix>` and the index itself — carries
 * `isExcludedFromBackupKey = true`, not just the enclosing directory (invariant 9).
 *
 * **The boot reconcile** (`reconcile()` in `load()`), which is the half that makes a kill
 * survivable:
 *
 *   - a staging file whose byte count equals the transfer's expected `Content-Length` is promoted
 *     to `complete` (the bytes arrived, only the callback was lost) — §5's resume rule, E2;
 *   - any other staging file is deleted and its job dropped, so the track is re-fetched — E1;
 *   - staging files with no job, or older than 24 h, are deleted — E7;
 *   - a file in the root that the index does not name is deleted — E7.
 */
@objc(NaviliteDownloads)
public class NaviliteDownloads: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NaviliteDownloads"
    public let jsName = "NaviliteDownloads"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "freeBytes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readLyrics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeLyrics", returnType: CAPPluginReturnPromise)
    ]

    /// Set by `AppDelegate` when the OS hands back the background session's completion handler.
    static var backgroundCompletionHandler: (() -> Void)? = nil

    private static let sessionIdentifier = "com.navilite.offline-downloads"
    private static let jobsKey = "navilite.offline.jobs"
    private static let maxConcurrent = 3

    /// The axes of a song's download. The kind is part of every key, never implied by the song.
    private static let audioKind = "audio"
    private static let lyricsKind = "lyrics"
    /// The third axis (v1.9.20): a cover, keyed by **cover id** rather than by song, because one
    /// file serves every track of an album. Without its own kind an art job keys as `audio:<id>`,
    /// overwrites the song's audio job and writes `suffix: "art"` into the song's audio row — i.e.
    /// `pathFor()` hands the player a JPEG.
    private static let artKind = "art"
    private static let stagingSuffix = ".part"
    /// E7: a staging file nobody came back for is swept after a day.
    private static let stagingMaxAge: TimeInterval = 24 * 60 * 60

    /**
     * **Every transfer this plugin created and has not yet seen end**, keyed by job key
     * (v2.0.0-beta.6).
     *
     * A cancel names its victim *here*. The build before this one cancelled through
     * `session.getAllTasks { … }` — an **asynchronous** completion — while `enqueue` created and
     * resumed the replacement in the same synchronous turn, so the block ran *after* the new task was
     * already running, walked every task carrying that `taskDescription` and cancelled it. Each
     * transfer died as `NSURLErrorCancelled` a few milliseconds after it connected, nothing could ever
     * reach `Content-Length`, and the staging file was deleted: the owner's "it climbs and then drops
     * back, no song is ever downloaded", on every track, because the race is in the happy path.
     */
    private var liveTasks: [String: URLSessionTask] = [:]
    /// Keys whose in-flight transfer is being replaced on purpose: the cancelled task's `didFail` is
    /// the replacement's own doing, not a failure, so it is neither reported nor recorded. Keyed by
    /// the task **object**, so a mark is consumed by exactly the transfer it belongs to.
    private var replacedTasks: Set<ObjectIdentifier> = []
    /**
     * The file-error family's per-launch budget (v2.0.0-beta.9). `-3000`/`-3001`/`-3003` are
     * `URLSession` failing on its **own** temp file — before a byte is written and before a request
     * reaches the server — so they are retried **once per track per launch** and then left `failed`:
     * `fileErrorRetried` has taken that one retry, `fileErrorExhausted` may not take another.
     */
    private var fileErrorRetried: Set<String> = []
    private var fileErrorExhausted: Set<String> = []
    /// Tasks the boot sweep cancelled for having no persisted job: their cancellation is nobody's
    /// failure, so `didFail` swallows it and JS is told nothing.
    private var silentTasks: Set<ObjectIdentifier> = []
    /// Both maps are touched from the plugin's queue (`enqueue`/`cancel`/`remove`) *and* from the
    /// session's delegate queue (completions), so every access goes through this lock. The
    /// per-launch file-error sets are behind the same lock.
    private let taskLock = NSLock()

    /// The one key shape: `"<kind>:<songId>"`. Used for the task description and the persisted job.
    private static func taskKey(_ kind: String, _ songId: String) -> String {
        "\(kind):\(songId)"
    }

    /// Which axis a transfer belongs to. The suffix is the discriminator the JS job carries.
    private static func kind(forSuffix suffix: String) -> String {
        if suffix == lyricsKind { return lyricsKind }
        return suffix == artKind ? artKind : audioKind
    }

    /// Split a `"<kind>:<songId>"` key back into its two halves.
    private static func splitKey(_ key: String) -> (kind: String, songId: String)? {
        guard let separator = key.firstIndex(of: ":") else { return nil }
        let kind = String(key[key.startIndex..<separator])
        let songId = String(key[key.index(after: separator)...])
        guard !songId.isEmpty, !kind.isEmpty else { return nil }
        return (kind, songId)
    }

    /// The error a non-`200` transfer is reported with; `status` travels beside it in the event.
    fileprivate static func statusError(_ status: Int) -> NSError {
        NSError(domain: "NaviliteDownloads", code: status, userInfo: [NSLocalizedDescriptionKey: "HTTP \(status)"])
    }

    /// A failure of **our own** step (a staging directory, a move), carrying the path it was writing
    /// so the note can name the file as well as the code (v2.0.0-beta.9).
    private struct LocalFailure: Error {
        let path: String
        let underlying: Error
    }

    /**
     * `localizedDescription` **plus its numeric code** (v2.0.0-beta.9). The note the owner reads used
     * to carry the words alone — `cannot create file` says nothing a diagnosis can act on, while
     * `cannot create file (-3000)` names `NSURLErrorCannotCreateFile`: `URLSession` could not make its
     * own temp file, before a byte was written and before a request reached the server.
     */
    fileprivate static func describe(_ error: Error) -> String {
        let ns = error as NSError
        return "\(ns.localizedDescription) (\(ns.code))"
    }

    /// `URLSession`'s file-system family: cannot create (-3000), cannot write (-3001), cannot close (-3003).
    fileprivate static func isFileError(_ error: NSError) -> Bool {
        guard error.domain == NSURLErrorDomain else { return false }
        return [-3000, -3001, -3003].contains(error.code)
    }

    /**
     * The whole-file byte count a completed response implies, or `0` for **"nothing to check
     * against"** (v2.0.0-beta.6).
     *
     * A `200` answers with the file's own `Content-Length`. A `206` answers with the length of *that
     * range*, so comparing the finished file to it fails every correct resumed transfer for ever —
     * the file's total is the `Content-Range` total instead (`bytes 0-…/2097152`). `Content-Range:
     * bytes 0-…/2097152`). A `Content-Range` whose byte range is a literal `*` (a star, then the
     * total), a missing header, or a response that carried no length at all are honestly
     * unknowable, and `0` says exactly that: the completion path promotes on `0` and trusts the
     * file's own bytes rather than rejecting a correct file over a guessed one.
     */
    fileprivate static func expectedTotal(_ response: HTTPURLResponse?) -> Int {
        guard let response else { return 0 }
        if response.statusCode == 206 {
            guard let range = response.value(forHTTPHeaderField: "Content-Range"),
                  let slash = range.lastIndex(of: "/") else { return 0 }
            let total = range[range.index(after: slash)...].trimmingCharacters(in: .whitespaces)
            return Int(total) ?? 0
        }
        let length = Int(response.expectedContentLength)
        return length > 0 ? length : 0
    }

    /**
     * The lyrics route's own "no sidecar" document —
     * `{"error": "no lyrics sidecar for this track", "path": …, "tried": […]}` — which arrives as a
     * **404 body**. Before v1.9.14 the completion handler never read the HTTP status, so such a body
     * was promoted as the lyric file and recorded `present`; those rows are still on the owner's
     * phone. The guard therefore stays where the bytes become an index row, so a bad body can never
     * be recorded as `present` again. The two tests are the same two `isRouteErrorBody` makes in
     * `src/api/lyrics.ts` (Swift cannot import it); the window is decoded with `String(decoding:)`
     * rather than `String(data:encoding:)` because the latter returns `nil` when byte 512 lands
     * mid-character and the guard would then fail **open** — the one thing a last door may not do.
     */
    fileprivate static func looksLikeRouteError(_ url: URL) -> Bool {
        guard let data = try? Data(contentsOf: url) else { return false }
        let head = String(decoding: data.prefix(512), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return head.hasPrefix("{\"error\"") || head.contains("no lyrics sidecar for this track")
    }

    /// Is this file an image? (v1.9.20)
    ///
    /// The art axis's last door, the exact shape of the lyrics rule above: a `200` whose body is not
    /// an image — a JSON error envelope, an HTML door page — is **not a cover**, and promoting it
    /// would record a row that renders nothing and themes nothing. JS is already safe behind it
    /// (`createImageBitmap` throws and `paletteFromArtwork` catches), but a wrong body is worse than
    /// an absent one, so it is refused where the bytes become a row. Magic numbers only: five
    /// formats, twelve bytes, no decoding.
    fileprivate static func looksLikeImage(_ url: URL) -> Bool {
        guard let data = try? Data(contentsOf: url) else { return false }
        let head = [UInt8](data.prefix(12))
        guard head.count >= 4 else { return false }
        if head[0] == 0xFF, head[1] == 0xD8, head[2] == 0xFF { return true } // JPEG
        if head[0] == 0x89, head[1] == 0x50, head[2] == 0x4E, head[3] == 0x47 { return true } // PNG
        if head[0] == 0x47, head[1] == 0x49, head[2] == 0x46 { return true } // GIF
        if head[0] == 0x42, head[1] == 0x4D { return true } // BMP
        if head.count >= 12, head[0] == 0x52, head[1] == 0x49, head[2] == 0x46, head[3] == 0x46,
           head[8] == 0x57, head[9] == 0x45, head[10] == 0x42, head[11] == 0x50 { return true } // WEBP
        return false
    }

    /// One enqueued download, persisted so a relaunch can reconcile `URLSession`'s own tasks.
    private struct Job: Codable {
        var songId: String
        var url: String
        var suffix: String
        var expectedBytes: Int
        var refs: [String]
        var title: String
        var artist: String
        var album: String
        var durationSec: Int
        /// The cover this row belongs to (v1.9.20). Optional by hard rule: a job persisted by
        /// 1.9.19 must still decode, or the whole jobs dictionary is dropped as unreadable.
        var coverArt: String? = nil
        /// For an **art** job: the songs that share the cover. It is how a row written by 1.9.19 —
        /// which has no cover id of its own, and whose audio job is never re-enqueued — learns which
        /// cover is its own when the file lands.
        var coverOf: [String]? = nil

        /// The axis this transfer belongs to — derived from the suffix, never stored twice.
        var kind: String { NaviliteDownloads.kind(forSuffix: suffix) }

        /// This job's key in the jobs dictionary and this job's task's `taskDescription`.
        var taskKey: String { NaviliteDownloads.taskKey(kind, songId) }

        /// The file name of this transfer's staging file.
        var stagingName: String { "\(songId).\(suffix)\(NaviliteDownloads.stagingSuffix)" }
    }

    /// One row of `index.json`.
    private struct IndexRow: Codable {
        var songId: String
        var suffix: String
        var bytes: Int
        var sha: String?
        var downloadedAt: Double
        var state: String
        var refs: [String]
        var title: String
        var artist: String
        var album: String
        var durationSec: Int
        var lyrics: LyricsRow?
        /// This row's cover id (v1.9.20). **Optional, and it must stay optional**: `readIndex()`
        /// returns `[:]` when the decode fails, and the boot sweep below then deletes every file the
        /// index does not name — one non-optional field against the owner's 1.9.19 `index.json` is a
        /// silent deletion of 5 GB of downloads.
        var coverArt: String? = nil
        /// The art axis of this row; the file is shared between every row of the same cover.
        var art: ArtRow? = nil
    }

    /// The lyrics axis of a row (v1.9.12): state, file and measured bytes — never the text.
    private struct LyricsRow: Codable {
        var state: String
        var file: String?
        var bytes: Int
        var fetchedAt: Double?
    }

    /// The art axis of a row (v1.9.20): state, the **cover's** file name, and the measured bytes.
    private struct ArtRow: Codable {
        var state: String
        var file: String?
        var bytes: Int
        var fetchedAt: Double?
    }

    private var session: URLSession?
    private var delegate: DownloadSessionDelegate?
    private var allowsCellular = false

    /* ---------------------------------------------------------------- storage */

    private var baseURL: URL? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let dir = support.appendingPathComponent("navilite-offline", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            excludeFromBackup(dir)
        } catch {
            // A missing directory is fatal to downloads, but never to playback.
        }
        return dir
    }

    /**
     * The staging directory, **created here, at the point of use** (v2.0.0-beta.9).
     *
     * It used to be `try?`-ed inside a computed property that returned the URL regardless, so a
     * directory that could not be made turned into a *move into nothing*: the job then failed with a
     * move error whose words said nothing about the directory (the owner's `cannot create file`).
     * A failure now carries the path and the underlying errno, and the job fails on it instead.
     */
    private func stagingDirectory() throws -> URL {
        guard let base = baseURL else {
            throw LocalFailure(
                path: "applicationSupport/navilite-offline/staging",
                underlying: NSError(
                    domain: NSCocoaErrorDomain,
                    code: NSFileNoSuchFileError,
                    userInfo: [NSLocalizedDescriptionKey: "no application support directory"]
                )
            )
        }
        let dir = base.appendingPathComponent("staging", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            throw LocalFailure(path: dir.path, underlying: error)
        }
        return dir
    }

    /// The non-throwing form, for the two paths where a missing directory is only "nothing to list".
    private var stagingURL: URL? { try? stagingDirectory() }

    private var indexPath: URL? { baseURL?.appendingPathComponent("index.json") }

    /// Invariant 9: the files, not only the directory that holds them.
    private func excludeFromBackup(_ url: URL) {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try? mutable.setResourceValues(values)
    }

    private func fileSize(_ url: URL) -> Int {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return 0 }
        return (attributes[.size] as? Int) ?? 0
    }

    /// Where a transfer's bytes live until they have been verified.
    private func stagingFile(songId: String, suffix: String) throws -> URL {
        try stagingDirectory().appendingPathComponent("\(songId).\(suffix)\(Self.stagingSuffix)")
    }

    /* ------------------------------------------------------------------- load */

    public override func load() {
        let delegate = DownloadSessionDelegate()
        delegate.plugin = self
        self.delegate = delegate
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.allowsCellularAccess = allowsCellular
        config.httpMaximumConnectionsPerHost = Self.maxConcurrent
        config.isDiscretionary = false
        session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        /*
         * **Orphans before jobs** (v2.0.0-beta.9). A background session survives an install-over, so
         * a launch can be handed tasks whose jobs are gone from `UserDefaults` — each answers
         * `-3000` for ever and the pump re-enqueues it, which is a download that can never finish.
         * They are cancelled here, before `reconcile()`, and their cancellation is reported to
         * nobody: no track in this launch owns those bytes.
         */
        pruneOrphanTasks()
        // The boot half of the state machine, before any JS runs and before `list()` is ever asked.
        reconcile()
    }

    /**
     * Cancel every task the session hands back whose `taskDescription` has **no persisted job**
     * (v2.0.0-beta.9). Marked silent first, so the delegate's `didFail` for the cancellation is
     * swallowed instead of being announced as a failure of a track that is not in this launch.
     */
    private func pruneOrphanTasks() {
        guard let session else { return }
        let jobs = readJobs()
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            for task in tasks {
                let key = task.taskDescription ?? ""
                if !key.isEmpty, jobs[key] != nil { continue }
                self.markSilent(task)
                task.cancel()
            }
        }
    }

    /// This task's cancellation is nobody's failure: no event reaches JS for it.
    private func markSilent(_ task: URLSessionTask) {
        taskLock.lock()
        silentTasks.insert(ObjectIdentifier(task))
        taskLock.unlock()
    }

    /** Was this task cancelled by the boot sweep? Consumed: one mark, one cancellation. */
    private func takeSilent(_ task: URLSessionTask) -> Bool {
        taskLock.lock()
        defer { taskLock.unlock() }
        return silentTasks.remove(ObjectIdentifier(task)) != nil
    }

    /* ------------------------------------------------- the per-launch file-error budget */

    /// Has this key already spent its one retry for the file-error family?
    private func fileErrorExhausted(_ key: String) -> Bool {
        taskLock.lock()
        defer { taskLock.unlock() }
        return fileErrorExhausted.contains(key)
    }

    /**
     * Record a file-error failure for `key` and answer whether it may be retried (v2.0.0-beta.9):
     * `true` the first time in this launch — the pump's next pass **is** that retry — and `false` on
     * every occurrence after, which is what stops `-3000` looping on a track nothing can create.
     */
    private func takeFileErrorRetry(_ key: String) -> Bool {
        taskLock.lock()
        defer { taskLock.unlock() }
        if fileErrorExhausted.contains(key) { return false }
        if fileErrorRetried.contains(key) {
            fileErrorRetried.remove(key)
            fileErrorExhausted.insert(key)
            return false
        }
        fileErrorRetried.insert(key)
        return true
    }

    /// One line for a failure of ours, naming the step, the code and the path — never the transfer.
    fileprivate static func localMessage(step: String, error: Error) -> String {
        if let local = error as? LocalFailure {
            return "\(step): \(describe(local.underlying)) · \(local.path)"
        }
        return "\(step): \(describe(error))"
    }

    /**
     * A failure of **our own** step (a staging directory, a move), reported with the path it was
     * writing and the numeric code (v2.0.0-beta.9). No new UI: the existing note prints `error`.
     */
    private func reportLocalFailure(kind: String, songId: String, step: String, path: URL? = nil, error: Error) {
        let ns: NSError
        var failingPath = path?.path
        if let local = error as? LocalFailure {
            ns = local.underlying as NSError
            failingPath = local.path
        } else {
            ns = error as NSError
        }
        removeJob(kind: kind, songId: songId)
        var message = "\(step): \(Self.describe(ns))"
        if let failingPath, !failingPath.isEmpty { message += " · \(failingPath)" }
        var data: [String: Any] = [
            "songId": songId,
            "kind": kind,
            "status": 0,
            "error": message,
            "domain": ns.domain,
            "code": ns.code
        ]
        if let failingPath, !failingPath.isEmpty { data["path"] = failingPath }
        notifyListeners("failed", data: data)
    }

    /* ---------------------------------------------------------------- methods */

    @objc func configure(_ call: CAPPluginCall) {
        allowsCellular = call.getBool("allowsCellular") ?? false
        if let max = call.getInt("maxConcurrent") {
            session?.configuration.httpMaximumConnectionsPerHost = max
        }
        call.resolve(["allowsCellular": allowsCellular])
    }

    @objc func enqueue(_ call: CAPPluginCall) {
        guard let songId = call.getString("songId"), !songId.isEmpty,
              let url = call.getString("url"), let target = URL(string: url) else {
            call.reject("enqueue needs a songId and a url")
            return
        }
        /*
         * **A download task needs an absolute URL** (v2.0.0-beta.7). `URL(string: "download?id=x")`
         * parses — as a *relative* URL — and then `URLSession` answers `NSURLErrorUnsupportedURL`
         * without ever making a request, which the owner's phone reported as `failed: unsupported
         * URL` on every lyric and cover of a playlist whose audio transferred fine. The JS side now
         * resolves every URL it hands over (`offlineUrl`), so this is the last door: refuse loudly
         * rather than enqueue something that can only fail silently.
         */
        guard let scheme = target.scheme, !scheme.isEmpty, target.host != nil,
              scheme == "http" || scheme == "https" else {
            call.reject("enqueue needs an absolute http(s) url, got: \(url)")
            return
        }
        let job = Job(
            songId: songId,
            url: url,
            suffix: call.getString("suffix") ?? "mp3",
            expectedBytes: call.getInt("bytes") ?? 0,
            refs: (call.getArray("refs") as? [String]) ?? [],
            title: call.getString("title") ?? "",
            artist: call.getString("artist") ?? "",
            album: call.getString("album") ?? "",
            durationSec: call.getInt("durationSec") ?? 0,
            coverArt: call.getString("coverArt"),
            coverOf: call.getArray("coverOf") as? [String]
        )
        /*
         * **A file error that already took its retry is not retried again** (v2.0.0-beta.9). The
         * family above is a file-system condition, not a transfer: the pump's next pass is the one
         * retry, and when that one fails too the track sticks at `failed` — answered here, with no
         * transfer started and no job persisted, so nothing loops for the rest of the launch.
         */
        if fileErrorExhausted(job.taskKey) {
            call.resolve(["queued": false, "givenUp": true])
            return
        }
        persist(job: job)
        /*
         * **Idempotent for a live transfer** (v2.0.0-beta.6). A second enqueue of a job that is still
         * in flight is a no-op: no cancel, no staging delete, no restart of the bytes that have
         * already arrived. The owner's tap, the boot resume and the pump all enumerate the same
         * playlist, so before this guard two overlapping walks destroyed each other's transfers —
         * every re-enqueue cancelled the task it had just resumed.
         */
        if let live = liveTask(job.taskKey), live.state == .running || live.state == .suspended {
            call.resolve(["queued": true, "already": true])
            return
        }
        // Only this song's transfer of this kind: a lyrics enqueue must never cancel the audio one.
        // By **identity**, synchronously, before its successor exists — never by enumerating the
        // session, whose completion runs after the replacement has been resumed.
        stopTask(key: job.taskKey, deliberate: true)
        // …and the staging bytes go only for a transfer that is genuinely not live any more.
        do {
            let staging = try stagingFile(songId: songId, suffix: job.suffix)
            try? FileManager.default.removeItem(at: staging)
        } catch {
            /*
             * The directory these bytes would be staged in cannot be made (v2.0.0-beta.9). Fail the
             * job HERE, naming the path and the errno: a transfer whose staging directory does not
             * exist can only end as a move into nothing, and the words of that failure ("cannot
             * create file") blame the network for a directory.
             */
            removeJob(kind: job.kind, songId: songId)
            call.reject(Self.localMessage(step: "cannot stage a download", error: error))
            return
        }
        let task = session?.downloadTask(with: target)
        task?.taskDescription = job.taskKey
        // Registered before it is resumed, so a cancel issued from this same turn can name it.
        if let task { register(task, key: job.taskKey) }
        task?.resume()
        call.resolve(["queued": true])
    }

    @objc func cancel(_ call: CAPPluginCall) {
        let songId = call.getString("songId") ?? ""
        if let kind = call.getString("kind") {
            cancelTask(kind: kind, songId: songId)
            removeJob(kind: kind, songId: songId)
        } else {
            // No kind named: the caller is cancelling the song, so both of its transfers stop.
            for kind in [Self.audioKind, Self.lyricsKind] {
                cancelTask(kind: kind, songId: songId)
                removeJob(kind: kind, songId: songId)
            }
        }
        call.resolve(["cancelled": true])
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let songId = call.getString("songId") else {
            call.reject("remove needs a songId")
            return
        }
        for kind in [Self.audioKind, Self.lyricsKind] {
            cancelTask(kind: kind, songId: songId)
            removeJob(kind: kind, songId: songId)
        }
        var index = readIndex()
        let removed = index.removeValue(forKey: songId)
        /*
         * v1.9.20 — **the art file belongs to the download**, and it is *shared*: one file serves
         * every row of the same cover. So it goes when the last index row that **names** it goes, and
         * not before — otherwise removing one playlist would take the cover off an album another
         * playlist still holds.
         */
        if let file = removed?.art?.file, !file.isEmpty {
            let stillNamed = index.values.contains { $0.art?.file == file }
            if !stillNamed, let base = baseURL {
                try? FileManager.default.removeItem(at: base.appendingPathComponent(file))
            }
        }
        writeIndex(index)
        if let base = baseURL {
            let suffixes = ["mp3", "flac", "wav", "m4a", "ogg", "opus", "lyrics"]
            for suffix in suffixes {
                try? FileManager.default.removeItem(at: base.appendingPathComponent("\(songId).\(suffix)"))
            }
        }
        if let staging = stagingURL, let contents = try? FileManager.default.contentsOfDirectory(atPath: staging.path) {
            for name in contents where name.hasPrefix("\(songId).") {
                try? FileManager.default.removeItem(at: staging.appendingPathComponent(name))
            }
        }
        call.resolve(["removed": true])
    }

    @objc func list(_ call: CAPPluginCall) {
        let index = readIndex()
        let rows = index.values.map { row -> [String: Any] in
            let fileURL = baseURL?.appendingPathComponent("\(row.songId).\(row.suffix)")
            var result: [String: Any] = [
                "songId": row.songId,
                "path": fileURL?.absoluteString ?? "",
                "suffix": row.suffix,
                "bytes": row.bytes,
                "state": row.state,
                "downloadedAt": row.downloadedAt,
                "refs": row.refs,
                "title": row.title,
                "artist": row.artist,
                "album": row.album,
                "durationSec": row.durationSec
            ]
            if let lyrics = row.lyrics {
                result["lyrics"] = [
                    "state": lyrics.state,
                    "file": lyrics.file as Any,
                    "bytes": lyrics.bytes,
                    "fetchedAt": lyrics.fetchedAt as Any
                ]
            }
            // v1.9.20 — the art axis and the row's cover id, so the JS store can resolve a cover
            // from disk (`artPathFor`) and draw the badge without a round trip of its own.
            result["coverArt"] = row.coverArt as Any
            if let art = row.art {
                result["art"] = [
                    "state": art.state,
                    "file": art.file as Any,
                    "bytes": art.bytes,
                    "fetchedAt": art.fetchedAt as Any
                ]
            }
            return result
        }
        call.resolve(["rows": rows])
    }

    @objc func freeBytes(_ call: CAPPluginCall) {
        let free: Int64
        if let base = baseURL,
           let values = try? base.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let capacity = values.volumeAvailableCapacityForImportantUsage {
            free = capacity
        } else {
            free = -1
        }
        call.resolve(["free": free])
    }

    @objc func readLyrics(_ call: CAPPluginCall) {
        guard let songId = call.getString("songId"), !songId.isEmpty else {
            call.reject("readLyrics needs a songId")
            return
        }
        var body = ""
        if let file = baseURL?.appendingPathComponent("\(songId).lyrics"),
           let data = try? Data(contentsOf: file),
           let text = String(data: data, encoding: .utf8) {
            body = text
        }
        call.resolve(["body": body])
    }

    @objc func writeLyrics(_ call: CAPPluginCall) {
        guard let songId = call.getString("songId"), !songId.isEmpty,
              let text = call.getString("text"),
              let base = baseURL,
              let data = text.data(using: .utf8) else {
            call.reject("writeLyrics needs a songId and text")
            return
        }
        let destination = base.appendingPathComponent("\(songId).lyrics")
        try? data.write(to: destination, options: .atomic)
        excludeFromBackup(destination)
        var index = readIndex()
        var row = index[songId] ?? IndexRow(
            songId: songId, suffix: "mp3", bytes: 0, sha: nil, downloadedAt: Date().timeIntervalSince1970,
            state: "staging", refs: [], title: "", artist: "", album: "", durationSec: 0, lyrics: nil
        )
        row.lyrics = LyricsRow(state: "present", file: "\(songId).lyrics", bytes: data.count, fetchedAt: Date().timeIntervalSince1970)
        index[songId] = row
        writeIndex(index)
        call.resolve(["written": true])
    }

    /* ---------------------------------------------------------------- the index */

    private func readIndex() -> [String: IndexRow] {
        guard let indexPath, let data = try? Data(contentsOf: indexPath) else { return [:] }
        return (try? JSONDecoder().decode([String: IndexRow].self, from: data)) ?? [:]
    }

    private func writeIndex(_ index: [String: IndexRow]) {
        guard let indexPath, let data = try? JSONEncoder().encode(index) else { return }
        let tmp = indexPath.appendingPathExtension("tmp")
        try? data.write(to: tmp, options: .atomic)
        try? FileManager.default.replaceItemAt(indexPath, withItemAt: tmp)
        excludeFromBackup(indexPath)
    }

    /* -------------------------------------------------------------------- jobs */

    private func persist(job: Job) {
        var jobs = readJobs()
        jobs[job.taskKey] = job
        writeJobs(jobs)
    }

    private func removeJob(kind: String, songId: String) {
        var jobs = readJobs()
        jobs.removeValue(forKey: Self.taskKey(kind, songId))
        writeJobs(jobs)
    }

    /// The expected byte count of the transfer that has just started arriving, when the server sent
    /// one. Recorded on the job so a kill mid-transfer can still verify the staging file at boot.
    private func recordExpectedBytes(kind: String, songId: String, total: Int) {
        let key = Self.taskKey(kind, songId)
        guard total > 0 else { return }
        var jobs = readJobs()
        guard var job = jobs[key], job.expectedBytes != total else { return }
        job.expectedBytes = total
        jobs[key] = job
        writeJobs(jobs)
    }

    private func readJobs() -> [String: Job] {
        guard let data = UserDefaults.standard.data(forKey: Self.jobsKey) else { return [:] }
        let decoded = (try? JSONDecoder().decode([String: Job].self, from: data)) ?? [:]
        var normalized: [String: Job] = [:]
        for (key, job) in decoded {
            // A job persisted before the kind was part of the key is re-keyed rather than dropped.
            normalized[Self.splitKey(key) != nil ? key : job.taskKey] = job
        }
        return normalized
    }

    private func writeJobs(_ jobs: [String: Job]) {
        guard let data = try? JSONEncoder().encode(jobs) else { return }
        UserDefaults.standard.set(data, forKey: Self.jobsKey)
    }

    private func cancelTask(job: Job) {
        cancelTask(kind: job.kind, songId: job.songId)
    }

    /**
     * Cancel only the tasks of this song *and* this kind — the key is the whole predicate, and the
     * task is named **by the handle this plugin created for it** (v2.0.0-beta.6), synchronously.
     */
    private func cancelTask(kind: String, songId: String) {
        stopTask(key: Self.taskKey(kind, songId), deliberate: false)
    }

    /** The live transfer for a key, if this plugin created one and has not seen it end. */
    private func liveTask(_ key: String) -> URLSessionTask? {
        taskLock.lock()
        defer { taskLock.unlock() }
        return liveTasks[key]
    }

    /** Record a task under its key **before** it is resumed, so a cancel can always name it. */
    private func register(_ task: URLSessionTask, key: String) {
        taskLock.lock()
        liveTasks[key] = task
        taskLock.unlock()
    }

    /**
     * A transfer reached a terminal state: it is no longer live, and no longer a replacement.
     *
     * **By identity, not by key.** A task cancelled *as a replacement* keeps reporting its own
     * failure/finish after its successor is already registered under the same key, so removing
     * "whatever is under this key" unregistered the SUCCESSOR: the idempotency guard in `enqueue`
     * then saw nothing live, started a second transfer for the same bytes, and the duplicate's
     * failure was reported for a track whose first transfer was still moving. Same discipline
     * `stopTask` already uses — the task object, never the string.
     */
    fileprivate func forgetTask(_ task: URLSessionTask) {
        guard let key = task.taskDescription, !key.isEmpty else { return }
        taskLock.lock()
        if liveTasks[key] === task { _ = liveTasks.removeValue(forKey: key) }
        taskLock.unlock()
    }

    /**
     * Cancel the transfer **this plugin** created for `key`, by its own handle and synchronously,
     * before any successor exists. `deliberate` marks the cancellation as a replacement, so the
     * cancelled task's `didFail` is not reported to JS as a failure of the track.
     */
    @discardableResult
    private func stopTask(key: String, deliberate: Bool) -> Bool {
        taskLock.lock()
        let task = liveTasks.removeValue(forKey: key)
        if let task, deliberate { replacedTasks.insert(ObjectIdentifier(task)) }
        taskLock.unlock()
        guard let task else { return false }
        task.cancel()
        return true
    }

    /** Was this task's cancellation a deliberate replacement? Consumed: one mark, one cancellation. */
    private func takeReplacement(_ task: URLSessionTask) -> Bool {
        taskLock.lock()
        defer { taskLock.unlock() }
        return replacedTasks.remove(ObjectIdentifier(task)) != nil
    }

    /* ------------------------------------------------------------- completion */

    /// A task finished with bytes on disk. Stage them, verify them, and only then move them into place.
    fileprivate func didFinishDownload(task: URLSessionDownloadTask, from location: URL, responseExpected: Int) {
        // The transfer reached its end under its own steam: it is no longer live — and it is only
        // forgotten if it is still the task registered under its key (never its successor).
        forgetTask(task)
        guard let taskKey = task.taskDescription, !taskKey.isEmpty,
              let base = baseURL, let (kind, songId) = Self.splitKey(taskKey) else { return }
        let job = readJobs()[taskKey]
        let suffix = job?.suffix ?? (kind == Self.lyricsKind ? Self.lyricsKind : kind == Self.artKind ? Self.artKind : "mp3")
        // The response's own length for the whole file when it carried one (`expectedTotal`: a `206`
        // is asked for its `Content-Range` total, never its range length). `0` means "nothing to
        // check against" — an unknown length is **unverifiable, not a mismatch** (v2.0.0-beta.6):
        // the JS job's `bytes` was the fallback here, and it can be a stale or rounded guess, which
        // failed a correct file for ever on every retry.
        let expected = responseExpected > 0 ? responseExpected : 0
        let staged: URL
        do {
            staged = try stagingFile(songId: songId, suffix: suffix)
        } catch {
            reportLocalFailure(kind: kind, songId: songId, step: "cannot stage the download", error: error)
            return
        }
        try? FileManager.default.removeItem(at: staged)
        do {
            try FileManager.default.moveItem(at: location, to: staged)
        } catch {
            reportLocalFailure(
                kind: kind,
                songId: songId,
                step: "cannot move the transfer into staging",
                path: staged,
                error: error
            )
            return
        }
        let actual = fileSize(staged)
        let matches = expected <= 0 || actual == expected
        guard matches else {
            // E1: wrong bytes are never promoted — the staging file goes, the track is re-fetched.
            try? FileManager.default.removeItem(at: staged)
            removeJob(kind: kind, songId: songId)
            notifyListeners("failed", data: ["songId": songId, "kind": kind, "error": "byte count \(actual) != \(expected)"])
            return
        }
        let destination = base.appendingPathComponent("\(songId).\(suffix)")
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: staged, to: destination)
        } catch {
            try? FileManager.default.removeItem(at: staged)
            reportLocalFailure(kind: kind, songId: songId, step: "cannot move the file into place", path: destination, error: error)
            return
        }
        excludeFromBackup(destination)
        finish(kind: kind, songId: songId, suffix: suffix, job: job, bytes: actual, destination: destination)
    }

    /// The one place a verified file becomes an index row, shared by the completion handler and the
    /// boot promotion. Never waits on JS: the row is written here.
    private func finish(kind: String, songId: String, suffix: String, job: Job?, bytes: Int, destination: URL) {
        /*
         * The last door on the lyric axis (§3): a body that is the route's own error document is
         * **not lyrics**. A build before v1.9.14 promoted it (the status was never read), so the
         * check stays here, where the bytes become a row, and it is reported as the `404` it is —
         * `none` to JS, so the playlist is not held on `· retry`.
         */
        if kind == Self.lyricsKind, Self.looksLikeRouteError(destination) {
            try? FileManager.default.removeItem(at: destination)
            removeJob(kind: kind, songId: songId)
            notifyListeners("failed", data: [
                "songId": songId,
                "kind": kind,
                "status": 404,
                "error": "no lyrics sidecar for this track"
            ])
            return
        }
        /*
         * **The art axis** (v1.9.20, §5.4). The transfer's key is a **cover id**, and one file serves
         * every row that carries that cover — so the row is not `index[songId]`, it is *every* row
         * that names this cover, exactly as the JS side fans out.
         *
         * The final file is `<coverId>.art` (built from the key and the suffix by the caller), which
         * is why the boot sweep has to be taught about it: it is not `<songId>.<suffix>` for any row.
         */
        if kind == Self.artKind {
            /*
             * The last door on the art axis: a `200` whose body is not an image is not a cover. The
             * lyrics rule's exact shape, one axis over.
             */
            guard Self.looksLikeImage(destination) else {
                try? FileManager.default.removeItem(at: destination)
                removeJob(kind: kind, songId: songId)
                notifyListeners("failed", data: [
                    "songId": songId,
                    "kind": kind,
                    "status": 0,
                    "error": "the body is not an image"
                ])
                return
            }
            let cover = job?.coverArt ?? songId
            let artRow = ArtRow(state: "present", file: "\(cover).art", bytes: bytes, fetchedAt: Date().timeIntervalSince1970)
            let covered = Set(job?.coverOf ?? [])
            var index = readIndex()
            /*
             * Every row that names the cover: `key == cover` (the rare case where a row is keyed by
             * the cover itself), the songs the job carried (`coverOf`, which is how a row written by
             * 1.9.19 — with no cover id of its own — learns which cover is its own), and any row that
             * already knows it. Collected first and then written, so nothing is mutated while the
             * dictionary is being walked.
             */
            let targets = index.keys.filter { key in
                key == cover || covered.contains(key) || index[key]?.coverArt == cover
            }
            for key in targets {
                index[key]?.coverArt = cover
                index[key]?.art = artRow
            }
            writeIndex(index)
            removeJob(kind: kind, songId: songId)
            guard !targets.isEmpty else {
                /*
                 * No row carries this cover: the audio of every one of its songs never landed, so
                 * there is nothing to annotate and the file is not named by the index. It is left on
                 * disk for the boot sweep (§5.7) rather than deleted here — a transfer of the same
                 * cover may still be in flight — and reported as a failure so no row claims a cover
                 * that no song holds.
                 */
                notifyListeners("failed", data: [
                    "songId": cover,
                    "kind": kind,
                    "status": 0,
                    "error": "no song on this phone carries this cover"
                ])
                return
            }
            notifyListeners("done", data: ["songId": cover, "kind": kind, "bytes": bytes])
            return
        }
        var index = readIndex()
        if kind == Self.lyricsKind {
            var row = index[songId] ?? IndexRow(
                songId: songId, suffix: "mp3", bytes: 0, sha: nil, downloadedAt: Date().timeIntervalSince1970,
                state: "staging", refs: job?.refs ?? [], title: job?.title ?? "", artist: job?.artist ?? "",
                album: job?.album ?? "", durationSec: job?.durationSec ?? 0, lyrics: nil
            )
            row.lyrics = LyricsRow(state: "present", file: "\(songId).lyrics", bytes: bytes, fetchedAt: Date().timeIntervalSince1970)
            // The cover id travels with the audio row too (v1.9.20), so the art fan-out can find this
            // row without the `coverOf` list on a later download of the same album.
            if row.coverArt == nil { row.coverArt = job?.coverArt }
            index[songId] = row
        } else {
            index[songId] = IndexRow(
                songId: songId, suffix: suffix, bytes: bytes, sha: nil, downloadedAt: Date().timeIntervalSince1970,
                state: "complete", refs: job?.refs ?? [], title: job?.title ?? "", artist: job?.artist ?? "",
                album: job?.album ?? "", durationSec: job?.durationSec ?? 0, lyrics: index[songId]?.lyrics,
                coverArt: job?.coverArt ?? index[songId]?.coverArt,
                art: index[songId]?.art
            )
        }
        writeIndex(index)
        removeJob(kind: kind, songId: songId)
        if kind == Self.lyricsKind {
            notifyListeners("done", data: ["songId": songId, "kind": Self.lyricsKind, "bytes": bytes])
        } else {
            notifyListeners("done", data: ["songId": songId, "kind": Self.audioKind, "path": destination.absoluteString, "bytes": bytes])
        }
    }

    fileprivate func didFail(task: URLSessionTask, error: Error?, status: Int) {
        guard let taskKey = task.taskDescription, !taskKey.isEmpty else { return }
        // By identity: a superseded task's late failure must not unregister its successor.
        forgetTask(task)
        /*
         * A task this plugin cancelled **on purpose**, to replace it, is not a failure of the track:
         * the successor is already running and the job just persisted is its own. Identity is the
         * whole test — the cancelled task object, not the key — so a mark can never swallow the next
         * genuine failure for the same track. One mark, one cancellation.
         */
        if takeReplacement(task) { return }
        // …and the boot sweep's cancellations belong to no track in this launch (v2.0.0-beta.9).
        if takeSilent(task) { return }
        guard let (kind, songId) = Self.splitKey(taskKey) else { return }
        let job = readJobs()[taskKey]
        removeJob(kind: kind, songId: songId)
        /*
         * **The note names the code, and the file when the failure is ours** (v2.0.0-beta.9).
         * `localizedDescription` alone printed the owner `failed: cannot create file`, which says
         * nothing: with the code it reads `cannot create file (-3000)` — `NSURLErrorCannotCreateFile`,
         * `URLSession` failing on its own temp file before a byte was written and before a request
         * reached the server.
         */
        let ns: NSError? = error.map { $0 as NSError }
        var message = ns.map(Self.describe) ?? "download failed"
        /*
         * **The file-error family is retried once per track per launch.** -3000/-3001/-3003 are a
         * file-system condition, not a transfer: the staging bytes go, the failure is reported (which
         * is what makes the pump's next pass the one retry), and a second occurrence in the same
         * launch is exhausted — `enqueue` then answers without starting anything, so the row stays
         * `failed` instead of looping for ever.
         */
        var retried = true
        if let ns, Self.isFileError(ns) {
            if let suffix = job?.suffix, let staging = try? stagingFile(songId: songId, suffix: suffix) {
                try? FileManager.default.removeItem(at: staging)
            }
            retried = takeFileErrorRetry(taskKey)
            if !retried { message += " · not retried again this launch" }
        }
        var data: [String: Any] = [
            "songId": songId,
            "kind": kind,
            "status": status,
            "error": message,
            "retried": retried
        ]
        if let ns {
            data["domain"] = ns.domain
            data["code"] = ns.code
        }
        notifyListeners("failed", data: data)
    }

    fileprivate func didProgress(taskKey: String, bytes: Int, total: Int) {
        guard let (kind, songId) = Self.splitKey(taskKey) else { return }
        recordExpectedBytes(kind: kind, songId: songId, total: total)
        notifyListeners("progress", data: ["songId": songId, "kind": kind, "bytes": bytes, "total": total])
    }

    /* ------------------------------------------------------------- the reconcile */

    /**
     * §5's boot half, run once in `load()` — before JS exists, so no `staging` row is ever left
     * unexamined and no orphan file is left to fill the volume (E1, E2, E7).
     */
    private func reconcile() {
        guard let base = baseURL, let staging = stagingURL else { return }
        let jobs = readJobs()
        let now = Date().timeIntervalSince1970
        if let contents = try? FileManager.default.contentsOfDirectory(
            at: staging,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) {
            for file in contents {
                let name = file.lastPathComponent
                guard name.hasSuffix(Self.stagingSuffix) else { continue }
                let attributes = try? file.resourceValues(forKeys: [.contentModificationDateKey])
                let modified = attributes?.contentModificationDate?.timeIntervalSince1970 ?? now
                let stale = now - modified > Self.stagingMaxAge
                /* The promotion rule, applied where the bytes are: a staging file whose byte count
                 * equals the transfer's expected length is the finished file (only the callback was
                 * lost); anything else — including a job-less or day-old file — is not. */
                guard let job = jobs.values.first(where: { $0.stagingName == name }) else {
                    try? FileManager.default.removeItem(at: file)
                    continue
                }
                let actual = fileSize(file)
                if !stale, job.expectedBytes > 0, actual == job.expectedBytes {
                    let destination = base.appendingPathComponent("\(job.songId).\(job.suffix)")
                    try? FileManager.default.removeItem(at: destination)
                    if (try? FileManager.default.moveItem(at: file, to: destination)) != nil {
                        excludeFromBackup(destination)
                        finish(kind: job.kind, songId: job.songId, suffix: job.suffix, job: job, bytes: actual, destination: destination)
                        continue
                    }
                }
                try? FileManager.default.removeItem(at: file)
                removeJob(kind: job.kind, songId: job.songId)
            }
        }
        // E7's other half: a file the index does not name is nobody's download.
        let index = readIndex()
        /*
         * **Every file the index names** — including each row's art file (v1.9.20).
         *
         * The art file is named after a **cover id**, so it is not `<songId>.<suffix>` for any row:
         * without this last entry the sweep would delete every cover on the next launch, and the
         * owner would see the art he just downloaded vanish between two starts of the app.
         */
        let named = Set(
            index.values.flatMap { row -> [String] in
                var names = ["\(row.songId).\(row.suffix)", "\(row.songId).lyrics"]
                if let file = row.art?.file, !file.isEmpty { names.append(file) }
                return names
            }
        )
        if let contents = try? FileManager.default.contentsOfDirectory(
            at: base,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) {
            for file in contents where file.lastPathComponent != "index.json" && !file.hasDirectoryPath {
                if !named.contains(file.lastPathComponent) {
                    try? FileManager.default.removeItem(at: file)
                }
            }
        }
    }
}

/** The session delegate: the one place transferred bytes become index rows. */
private final class DownloadSessionDelegate: NSObject, URLSessionDownloadDelegate {
    weak var plugin: NaviliteDownloads?

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let taskKey = downloadTask.taskDescription, !taskKey.isEmpty else { return }
        /*
         * **The status first.** A 4xx/5xx is a *successful transfer of an error body*: the response
         * arrived, so URLSession calls this and never `didCompleteWithError` (`error == nil`). The
         * lyrics route answers `404` with a JSON document for a track whose folder holds no sidecar —
         * normal and common — and promoting that body wrote the server's error into the offline copy
         * as the words. So only a whole (`200`) or partial (`206`) body is ever promoted, for either
         * axis: a non-2xx body whose length happened to match would otherwise become audio just the
         * same way.
         */
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        /*
         * **A `206` is not a failure** (v2.0.0-beta.6). This door sits behind Caddy, which passes
         * Range through: a transfer that asks for a range — or one the system resumes on the app's
         * behalf — answers `206 Partial Content` with perfectly good bytes, and the old `status ==
         * 200` guard deleted them and reported `HTTP 206` as an error. Every track was then re-fetched
         * for ever and none ever completed, which is the owner's "500 MB downloaded, still 0 of 233".
         * The status is still read *first*, and anything that is neither a whole response nor a
         * partial one is still deleted and reported as failed.
         */
        guard status == 200 || status == 206 else {
            try? FileManager.default.removeItem(at: location)
            plugin?.didFail(task: downloadTask, error: NaviliteDownloads.statusError(status), status: status)
            return
        }
        let expected = NaviliteDownloads.expectedTotal(downloadTask.response as? HTTPURLResponse)
        plugin?.didFinishDownload(task: downloadTask, from: location, responseExpected: expected)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let taskKey = downloadTask.taskDescription, !taskKey.isEmpty else { return }
        let total = totalBytesExpectedToWrite > 0 ? Int(totalBytesExpectedToWrite) : 0
        plugin?.didProgress(taskKey: taskKey, bytes: Int(totalBytesWritten), total: total)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let taskKey = task.taskDescription, !taskKey.isEmpty else { return }
        if let error {
            let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
            plugin?.didFail(task: task, error: error, status: status)
        } else {
            // No error and no `didFinishDownloadingTo` body left to promote: this transfer is over —
            // forgotten only if it is still the task its key names.
            plugin?.forgetTask(task)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            NaviliteDownloads.backgroundCompletionHandler?()
            NaviliteDownloads.backgroundCompletionHandler = nil
        }
    }
}
