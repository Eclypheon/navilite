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

    /// The two axes of a song's download. The kind is part of every key, never implied by the song.
    private static let audioKind = "audio"
    private static let lyricsKind = "lyrics"
    private static let stagingSuffix = ".part"
    /// E7: a staging file nobody came back for is swept after a day.
    private static let stagingMaxAge: TimeInterval = 24 * 60 * 60

    /// The one key shape: `"<kind>:<songId>"`. Used for the task description and the persisted job.
    private static func taskKey(_ kind: String, _ songId: String) -> String {
        "\(kind):\(songId)"
    }

    /// Which axis a transfer belongs to. The suffix is the discriminator the JS job carries.
    private static func kind(forSuffix suffix: String) -> String {
        suffix == lyricsKind ? lyricsKind : audioKind
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
    }

    /// The lyrics axis of a row (v1.9.12): state, file and measured bytes — never the text.
    private struct LyricsRow: Codable {
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

    private var stagingURL: URL? {
        guard let base = baseURL else { return nil }
        let dir = base.appendingPathComponent("staging", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

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
    private func stagingFile(songId: String, suffix: String) -> URL? {
        stagingURL?.appendingPathComponent("\(songId).\(suffix)\(Self.stagingSuffix)")
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
        // The boot half of the state machine, before any JS runs and before `list()` is ever asked.
        reconcile()
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
        let job = Job(
            songId: songId,
            url: url,
            suffix: call.getString("suffix") ?? "mp3",
            expectedBytes: call.getInt("bytes") ?? 0,
            refs: (call.getArray("refs") as? [String]) ?? [],
            title: call.getString("title") ?? "",
            artist: call.getString("artist") ?? "",
            album: call.getString("album") ?? "",
            durationSec: call.getInt("durationSec") ?? 0
        )
        persist(job: job)
        // Only this song's transfer of this kind: a lyrics enqueue must never cancel the audio one.
        cancelTask(job: job)
        if let staging = stagingFile(songId: songId, suffix: job.suffix) {
            try? FileManager.default.removeItem(at: staging)
        }
        let task = session?.downloadTask(with: target)
        task?.taskDescription = job.taskKey
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
        index.removeValue(forKey: songId)
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

    /// Cancel only the tasks of this song *and* this kind — the key is the whole predicate.
    private func cancelTask(kind: String, songId: String) {
        let key = Self.taskKey(kind, songId)
        session?.getAllTasks { tasks in
            for task in tasks where task.taskDescription == key {
                task.cancel()
            }
        }
    }

    /* ------------------------------------------------------------- completion */

    /// A task finished with bytes on disk. Stage them, verify them, and only then move them into place.
    fileprivate func didFinishDownload(taskKey: String, from location: URL, responseExpected: Int) {
        guard let base = baseURL, let (kind, songId) = Self.splitKey(taskKey) else { return }
        let job = readJobs()[taskKey]
        let suffix = job?.suffix ?? (kind == Self.lyricsKind ? Self.lyricsKind : "mp3")
        // The route's own `Content-Length` when the response carried one (the lyrics route does),
        // else what the JS job promised. `0` means "nothing to check against".
        let expected = responseExpected > 0 ? responseExpected : (job?.expectedBytes ?? 0)
        guard let staged = stagingFile(songId: songId, suffix: suffix) else { return }
        try? FileManager.default.removeItem(at: staged)
        do {
            try FileManager.default.moveItem(at: location, to: staged)
        } catch {
            removeJob(kind: kind, songId: songId)
            notifyListeners("failed", data: ["songId": songId, "kind": kind, "error": error.localizedDescription])
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
            removeJob(kind: kind, songId: songId)
            notifyListeners("failed", data: ["songId": songId, "kind": kind, "error": error.localizedDescription])
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
        var index = readIndex()
        if kind == Self.lyricsKind {
            var row = index[songId] ?? IndexRow(
                songId: songId, suffix: "mp3", bytes: 0, sha: nil, downloadedAt: Date().timeIntervalSince1970,
                state: "staging", refs: job?.refs ?? [], title: job?.title ?? "", artist: job?.artist ?? "",
                album: job?.album ?? "", durationSec: job?.durationSec ?? 0, lyrics: nil
            )
            row.lyrics = LyricsRow(state: "present", file: "\(songId).lyrics", bytes: bytes, fetchedAt: Date().timeIntervalSince1970)
            index[songId] = row
        } else {
            index[songId] = IndexRow(
                songId: songId, suffix: suffix, bytes: bytes, sha: nil, downloadedAt: Date().timeIntervalSince1970,
                state: "complete", refs: job?.refs ?? [], title: job?.title ?? "", artist: job?.artist ?? "",
                album: job?.album ?? "", durationSec: job?.durationSec ?? 0, lyrics: index[songId]?.lyrics
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

    fileprivate func didFail(taskKey: String, error: Error?, status: Int) {
        guard let (kind, songId) = Self.splitKey(taskKey) else { return }
        removeJob(kind: kind, songId: songId)
        // `status` is the HTTP status when the response got that far: the lyrics route answers
        // `404` for a track whose folder holds no sidecar, which is a fact ("asked, there is
        // nothing") and not a failure the playlist should retry forever.
        notifyListeners("failed", data: [
            "songId": songId,
            "kind": kind,
            "status": status,
            "error": error?.localizedDescription ?? "download failed"
        ])
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
        let named = Set(index.values.flatMap { row in ["\(row.songId).\(row.suffix)", "\(row.songId).lyrics"] })
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
         * as the words. Nothing but a `200` is ever promoted, for either axis: a non-200 body whose
         * length happened to match would otherwise become audio just the same way.
         */
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            try? FileManager.default.removeItem(at: location)
            plugin?.didFail(taskKey: taskKey, error: NaviliteDownloads.statusError(status), status: status)
            return
        }
        let expected = Int(downloadTask.response?.expectedContentLength ?? 0)
        plugin?.didFinishDownload(taskKey: taskKey, from: location, responseExpected: expected)
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
            plugin?.didFail(taskKey: taskKey, error: error, status: status)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            NaviliteDownloads.backgroundCompletionHandler?()
            NaviliteDownloads.backgroundCompletionHandler = nil
        }
    }
}
