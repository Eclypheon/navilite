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
 * Storage (`Library/Application Support/navilite-offline/`, `isExcludedFromBackupKey = true`):
 *
 *   <songId>.<suffix>            a complete, verified file
 *   staging/<songId>.<suffix>.part   in-progress bytes; never audible, never addressable
 *   index.json                   the native index — THE truth for what is on disk
 *
 * `index.json` is written atomically (write `.tmp`, `replaceItemAt`) after every state change. A
 * completion handler never waits on JS: the move happens natively, so the file is correct even if
 * JavaScript never runs again.
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
    static var backgroundCompletionHandler: (() -> Void)?

    private static let sessionIdentifier = "com.navilite.offline-downloads"
    private static let jobsKey = "navilite.offline.jobs"
    private static let maxConcurrent = 3

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
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutable = dir
            try mutable.setResourceValues(values)
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
        cancelTask(songId: songId)
        if let staging = stagingURL {
            try? FileManager.default.removeItem(at: staging.appendingPathComponent("\(songId).\(job.suffix).part"))
        }
        let task = session?.downloadTask(with: target)
        task?.taskDescription = songId
        task?.resume()
        call.resolve(["queued": true])
    }

    @objc func cancel(_ call: CAPPluginCall) {
        let songId = call.getString("songId") ?? ""
        cancelTask(songId: songId)
        removeJob(songId: songId)
        call.resolve(["cancelled": true])
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let songId = call.getString("songId") else {
            call.reject("remove needs a songId")
            return
        }
        cancelTask(songId: songId)
        removeJob(songId: songId)
        var index = readIndex()
        index.removeValue(forKey: songId)
        writeIndex(index)
        if let base = baseURL {
            let suffixes = ["mp3", "flac", "wav", "m4a", "ogg", "opus", "lyrics"]
            for suffix in suffixes {
                try? FileManager.default.removeItem(at: base.appendingPathComponent("\(songId).\(suffix)"))
            }
            if let staging = stagingURL, let contents = try? FileManager.default.contentsOfDirectory(atPath: staging.path) {
                for name in contents where name.hasPrefix(songId) {
                    try? FileManager.default.removeItem(at: staging.appendingPathComponent(name))
                }
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
    }

    private func persist(job: Job) {
        var jobs = readJobs()
        jobs[job.songId] = job
        writeJobs(jobs)
    }

    private func removeJob(songId: String) {
        var jobs = readJobs()
        jobs.removeValue(forKey: songId)
        writeJobs(jobs)
    }

    private func readJobs() -> [String: Job] {
        guard let data = UserDefaults.standard.data(forKey: Self.jobsKey) else { return [:] }
        return (try? JSONDecoder().decode([String: Job].self, from: data)) ?? [:]
    }

    private func writeJobs(_ jobs: [String: Job]) {
        guard let data = try? JSONEncoder().encode(jobs) else { return }
        UserDefaults.standard.set(data, forKey: Self.jobsKey)
    }

    private func cancelTask(songId: String) {
        session?.getAllTasks { tasks in
            for task in tasks where task.taskDescription == songId {
                task.cancel()
            }
        }
    }

    /* ------------------------------------------------------------- completion */

    /// A task finished with bytes on disk. Move staging → final only when the byte count matches.
    fileprivate func didFinishDownload(songId: String, from location: URL) {
        guard let base = baseURL else { return }
        let job = readJobs()[songId]
        let suffix = job?.suffix ?? "mp3"
        let isLyrics = suffix == "lyrics"
        let expected = job?.expectedBytes ?? 0
        let destination = base.appendingPathComponent("\(songId).\(suffix)")
        let attributes = try? FileManager.default.attributesOfItem(atPath: location.path)
        let actual = (attributes?[.size] as? Int) ?? 0
        let matches = expected <= 0 || actual == expected
        do {
            try FileManager.default.removeItem(at: destination)
            if matches {
                try FileManager.default.moveItem(at: location, to: destination)
            } else {
                // Wrong bytes: never promoted. Drop the partial and report a failure.
                try? FileManager.default.removeItem(at: location)
                removeJob(songId: songId)
                notifyListeners("failed", data: ["songId": songId, "kind": isLyrics ? "lyrics" : "audio", "error": "byte count \(actual) != \(expected)"])
                return
            }
        } catch {
            removeJob(songId: songId)
            notifyListeners("failed", data: ["songId": songId, "kind": isLyrics ? "lyrics" : "audio", "error": error.localizedDescription])
            return
        }
        var index = readIndex()
        if isLyrics {
            var row = index[songId] ?? IndexRow(
                songId: songId, suffix: "mp3", bytes: 0, sha: nil, downloadedAt: Date().timeIntervalSince1970,
                state: "staging", refs: job?.refs ?? [], title: job?.title ?? "", artist: job?.artist ?? "",
                album: job?.album ?? "", durationSec: job?.durationSec ?? 0, lyrics: nil
            )
            row.lyrics = LyricsRow(state: "present", file: "\(songId).lyrics", bytes: actual, fetchedAt: Date().timeIntervalSince1970)
            index[songId] = row
        } else {
            index[songId] = IndexRow(
                songId: songId, suffix: suffix, bytes: actual, sha: nil, downloadedAt: Date().timeIntervalSince1970,
                state: "complete", refs: job?.refs ?? [], title: job?.title ?? "", artist: job?.artist ?? "",
                album: job?.album ?? "", durationSec: job?.durationSec ?? 0, lyrics: index[songId]?.lyrics
            )
        }
        writeIndex(index)
        removeJob(songId: songId)
        if isLyrics {
            notifyListeners("done", data: ["songId": songId, "kind": "lyrics", "bytes": actual])
        } else {
            notifyListeners("done", data: ["songId": songId, "path": destination.absoluteString, "bytes": actual])
        }
    }

    fileprivate func didFail(songId: String, error: Error?) {
        let suffix = readJobs()[songId]?.suffix ?? "mp3"
        removeJob(songId: songId)
        notifyListeners("failed", data: ["songId": songId, "kind": suffix == "lyrics" ? "lyrics" : "audio", "error": error?.localizedDescription ?? "download failed"])
    }

    fileprivate func didProgress(songId: String, bytes: Int, total: Int) {
        notifyListeners("progress", data: ["songId": songId, "bytes": bytes, "total": total])
    }
}

/** The session delegate: the one place staging bytes become index rows. */
private final class DownloadSessionDelegate: NSObject, URLSessionDownloadDelegate {
    weak var plugin: NaviliteDownloads?

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let songId = downloadTask.taskDescription, !songId.isEmpty else { return }
        plugin?.didFinishDownload(songId: songId, from: location)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let songId = downloadTask.taskDescription, !songId.isEmpty else { return }
        plugin?.didProgress(songId: songId, bytes: Int(totalBytesWritten), total: Int(totalBytesExpectedToWrite))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let songId = task.taskDescription, !songId.isEmpty else { return }
        if let error { plugin?.didFail(songId: songId, error: error) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            NaviliteDownloads.backgroundCompletionHandler?()
            NaviliteDownloads.backgroundCompletionHandler = nil
        }
    }
}
