import UIKit
import Capacitor

/**
 * What the system asked this app's scene to do (v2.0-beta.16).
 *
 * The owner's report is that a tap on the Now Playing card (or the island's expanded view) opens
 * nothing. That tap is routed by SpringBoard to the CFBundleIdentifier the media remote holds, and
 * the app is then activated through FrontBoard: a scene **connect** on a cold start, a
 * `sceneDidBecomeActive` on a warm one, or `scene(_:openURLContexts:)` when the route carries a URL.
 * None of that is visible from JavaScript — so without these counters, "the tap opened nothing" and
 * "the app was never asked to open" produce the same empty diagnostics, which is exactly the blind
 * round this exists to end.
 *
 * Every callback is counted **and** appended to the same persisted log as the boundaries
 * (`NaviliteRemote.appendSceneLine`), so one file read off the phone says what actually arrived.
 */
final class NaviliteSceneEvents {
    static let shared = NaviliteSceneEvents()

    private let lock = NSLock()
    private var connects = 0
    private var opens = 0
    private var activations = 0
    private var resignations = 0
    private var last = "none"
    private var lastUrl = ""
    private var lastAt = 0

    /// Note one scene callback: `connect`, `openurl`, `active` or `resign`.
    func note(_ kind: String, url: String = "") {
        lock.lock()
        let counts: (connects: Int, opens: Int, activations: Int, resignations: Int)
        switch kind {
        case "connect": connects += 1
        case "openurl": opens += 1
        case "active": activations += 1
        case "resign": resignations += 1
        default: break
        }
        counts = (connects, opens, activations, resignations)
        last = kind
        if !url.isEmpty { lastUrl = url }
        lastAt = Int((Date().timeIntervalSince1970 * 1000).rounded())
        lock.unlock()

        // The same fact into the file, so a scene that was never asked leaves no line at all.
        var facts: [String: Any] = [
            "event": kind,
            "connects": counts.connects,
            "opens": counts.opens,
            "activations": counts.activations,
            "resignations": counts.resignations
        ]
        if !url.isEmpty { facts["url"] = url }
        NaviliteRemote.appendSceneLine(facts)
    }

    /// The counters, for `NaviliteRemote.now()`.
    var summary: [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return [
            "connects": connects,
            "opens": opens,
            "activations": activations,
            "resignations": resignations,
            "last": last,
            "lastUrl": lastUrl,
            "lastAt": lastAt
        ]
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // v2.0-beta.16 — a cold start that came from an external open carries the URL here, not
        // through `openURLContexts`: count it, and the URL says whether the route was the tap's.
        NaviliteSceneEvents.shared.note("connect", url: connectionOptions.urlContexts.first?.url.absoluteString ?? "")
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // v1.4: `ViewController` is Capacitor's bridge with the web view's elastic scrolling turned
        // off — see ios/App/App/ViewController.swift for why the top bar needs it.
        window?.rootViewController = ViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        NaviliteSceneEvents.shared.note("openurl", url: URLContexts.first?.url.absoluteString ?? "")
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// v2.0-beta.16 — the app was brought to the foreground. A warm activation (the app suspended in
    /// the background, the system raising it) never touches the URL path, so without this method the
    /// one activation shape most likely to be the owner's tap would be invisible.
    func sceneDidBecomeActive(_ scene: UIScene) {
        NaviliteSceneEvents.shared.note("active")
    }

    func sceneWillResignActive(_ scene: UIScene) {
        NaviliteSceneEvents.shared.note("resign")
    }
}
