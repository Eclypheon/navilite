import AVFoundation
import Capacitor
import Foundation
import MediaPlayer

/**
 * Navilite's own lock-screen remote commands, and the audio session's re-arm — the two things the
 * native-audio plugin does not do for us.
 *
 * Why this file exists at all (v1.7): playback on iOS is AVFoundation, driven by
 * `@capgo/capacitor-native-audio`, which sets the `AVAudioSession` to `.playback`, activates it,
 * publishes the Now Playing card and targets `MPRemoteCommandCenter` — for **play, pause, stop,
 * toggle, skip-15s and scrub**. It does not enable `nextTrackCommand` / `previousTrackCommand`, so a
 * lock screen driven by that plugin alone has no next/previous buttons. Those two buttons are what
 * this plugin adds, and nothing else: it must not touch the session category or the Now Playing
 * card, because two writers on one session is exactly how the transport goes dead.
 *
 * `activateSession()` is the second half: after a call, Siri, or another app taking the session, iOS
 * deactivates ours, and re-activating it is the documented fix for "playback looks fine but the
 * controls do nothing" after a return to the foreground. It only calls `setActive(true)` — it never
 * changes the category, so it cannot undo what the audio plugin set up.
 *
 * Registered from `ViewController.capacitorDidLoad()` (a local plugin has no npm package for
 * `cap sync` to discover, so registration is explicit), and reachable from JavaScript as
 * `NaviliteRemote`; `src/player/native.ts` treats it as optional and works without it.
 */
@objc(NaviliteRemote)
public class NaviliteRemote: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NaviliteRemote"
    public let jsName = "NaviliteRemote"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activateSession", returnType: CAPPluginReturnPromise)
    ]

    /// The command/target pairs to remove again on `detach` — a target left behind would call into
    /// a web layer that is gone.
    private var targets: [(command: MPRemoteCommand, token: Any)] = []

    @objc func attach(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            if self.targets.isEmpty {
                let center = MPRemoteCommandCenter.shared()

                center.nextTrackCommand.isEnabled = true
                let next = center.nextTrackCommand.addTarget { [weak self] _ in
                    guard let self else { return .commandFailed }
                    self.notifyListeners("next", data: [:])
                    return .success
                }
                self.targets.append((command: center.nextTrackCommand, token: next))

                center.previousTrackCommand.isEnabled = true
                let previous = center.previousTrackCommand.addTarget { [weak self] _ in
                    guard let self else { return .commandFailed }
                    self.notifyListeners("previous", data: [:])
                    return .success
                }
                self.targets.append((command: center.previousTrackCommand, token: previous))
            }
            call.resolve(["attached": true])
        }
    }

    @objc func detach(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve(["attached": false])
                return
            }
            for target in self.targets {
                target.command.removeTarget(target.token)
            }
            self.targets.removeAll()
            call.resolve(["attached": false])
        }
    }

    /// Re-activate the audio session without changing how it is configured. Idempotent.
    @objc func activateSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try AVAudioSession.sharedInstance().setActive(true)
                call.resolve(["active": true])
            } catch {
                call.reject("audio session could not be activated: \(error.localizedDescription)")
            }
        }
    }
}
