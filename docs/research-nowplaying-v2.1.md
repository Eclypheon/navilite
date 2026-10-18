# iOS 18 Now Playing Module, Dynamic Island, and Audio Continuity Research (v2.1)

Authoritative investigation into iOS Media Player (`MPNowPlayingInfoCenter`, `MPRemoteCommandCenter`), `AVAudioSession`, and `AVFoundation` (`AVPlayer`, `AVQueuePlayer`) behaviors for Navilite.

---

## Q1 — What Makes the Now Playing Module Stay Present Across a Track Change?

### 1.1 Audio Session vs. NowPlayingInfo Presence
* **Rule:** The presence and visibility of the Now Playing module on the iOS Lock Screen, Dynamic Island, and Control Center is **co-dependent on both** an active `AVAudioSession` in an audio-capable category (`.playback`) **and** a non-nil, non-empty `MPNowPlayingInfoCenter.default().nowPlayingInfo` dictionary containing at least minimal title metadata.
* **Mechanism:** 
  - `AVAudioSession`: Tells the iOS audio server (`mediaserverd`) that the application is holding an audio route and has background audio execution entitlement (`UIBackgroundModes = ["audio"]`). If `AVAudioSession.sharedInstance().setActive(false)` is invoked at a track boundary, iOS instantly tears down the system Now Playing routing and dismisses the Lock Screen widget and Dynamic Island pill.
  - `MPNowPlayingInfoCenter.default().nowPlayingInfo`: Provides the metadata rendered by SpringBoard / MediaRemote. If `nowPlayingInfo` is set to `nil` or an empty dictionary `[:]`, the system treats the session as having no active media to present, immediately hiding or wiping the card.
* **Source Citations:**
  - Apple Developer Documentation: [AVAudioSession.Category.playback](https://developer.apple.com/documentation/avfaudio/avaudiosession/category/playback)
  - Apple Developer Documentation: [MPNowPlayingInfoCenter](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter)
  - Apple Developer Documentation: [Activating Your Audio Session](https://developer.apple.com/documentation/avfaudio/avaudiosession/activating_your_audio_session)

### 1.2 `MPNowPlayingInfoCenter.playbackState` on iOS
* **Finding:** Prior to iOS 13, Apple documentation noted `playbackState` as macOS-only (`MPNowPlayingPlaybackState`). However, starting in **iOS 13.0+**, `MPNowPlayingInfoCenter.default().playbackState` is supported across iOS, iPadOS, tvOS, and watchOS (`MPNowPlayingPlaybackState.playing`, `.paused`, `.stopped`, `.interrupted`).
* **iOS Correct Way to Express Playing vs. Paused:**
  - Although `playbackState` exists on iOS 13+, the primary and legacy-compatible driver for the system scrubber animation, Dynamic Island waveform/activity bars, and Lock Screen state in MediaRemote remains **`MPNowPlayingInfoPropertyPlaybackRate`** inside `nowPlayingInfo`.
  - For standard playback: set `info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0` when playing, and `0.0` when paused.
  - To ensure 100% platform compliance on iOS 18, both should be updated synchronously:
    ```swift
    info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    if #available(iOS 13.0, *) {
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }
    ```
* **Source Citations:**
  - Apple Developer Documentation: [MPNowPlayingInfoCenter.playbackState](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter/playbackstate)
  - Apple Developer Documentation: [MPNowPlayingPlaybackState](https://developer.apple.com/documentation/mediaplayer/mpnowplayingplaybackstate)

### 1.3 Setting `MPNowPlayingInfoPropertyPlaybackRate = 0` and Visibility Grace Period
* **Finding:** Writing `MPNowPlayingInfoPropertyPlaybackRate = 0.0` signals to SpringBoard and the Lock Screen that playback is paused. It **does NOT** immediately dismiss the Now Playing module.
* **Grace Period Behavior:**
  - When paused (`rate = 0.0`), the Now Playing card remains on the Lock Screen indefinitely as long as the application remains memory-resident and no other media app claims the audio session.
  - Under memory pressure, or after extended idle time (typically ~10–15 minutes depending on system resources and iOS battery management), iOS suspends the app process and may evict the paused Now Playing card.
  - Crucially: Setting `rate = 0.0` during a sub-second track transition does *not* cause the module to vanish; vanishing only occurs if `nowPlayingInfo` is cleared (`nil`), `AVAudioSession` is deactivated (`setActive(false)`), or `AVPlayer` is deallocated before the next one starts without an active audio asset.
* **Source Citations:**
  - Apple Developer Documentation: [MPNowPlayingInfoPropertyPlaybackRate](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfopropertyplaybackrate)
  - WWDC 2019: [Delivering Intuitive Media Playback with AVFoundation](https://developer.apple.com/videos/play/wwdc2019/501/)

### 1.4 Elapsed Playback Time and System Extrapolation
* **Finding:** The system **automatically extrapolates** playback position in the Lock Screen scrubber and Control Center using:
  $$\text{Current Display Time} = \text{ElapsedPlaybackTime} + (\text{Current System Time} - \text{Timestamp}) \times \text{PlaybackRate}$$
* **Rules:**
  - Apps must **NEVER** push updates to `nowPlayingInfo` on a periodic timer (e.g., every 1 second). Doing so degrades battery life, introduces Lock Screen UI hitching, and causes race conditions with remote command handlers.
  - Publish `MPNowPlayingInfoPropertyElapsedPlaybackTime` only upon:
    1. Track start / track boundary transition.
    2. Play / pause state changes.
    3. User seeking / scrubbing (`MPChangePlaybackPositionCommand`).
    4. Substantial drift correction (e.g., after recovering from a buffer stall).
  - Stale elapsed time does not cause the module to be dismissed; if elapsed time exceeds `MPMediaItemPropertyPlaybackDuration`, the scrubber simply clamps to the end.
* **Source Citations:**
  - Apple Developer Documentation: [MPNowPlayingInfoPropertyElapsedPlaybackTime](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfopropertyelapsedplaybacktime)
  - Apple Developer Documentation: [MPChangePlaybackPositionCommand](https://developer.apple.com/documentation/mediaplayer/mpchangeplaybackpositioncommand)

### 1.5 Deactivating and Reactivating `AVAudioSession` Across Track Boundaries
* **Finding:** **Calling `AVAudioSession.sharedInstance().setActive(false)` across a track boundary is the single most common cause of Now Playing module flickering / vanishing.**
* **Mechanism:** 
  - Deactivating the audio session signals the OS that audio playback has concluded. MediaRemote detaches the Now Playing interface.
  - Reactivating the session (`setActive(true)`) creates an entirely new MediaRemote transaction. Between deactivation and reactivation, there is a visible multi-second disappearance on both the Lock Screen and Dynamic Island.
  - **Requirement:** The audio session must remain `.playback` and active continuously throughout track transitions. Never call `setActive(false)` unless playback has been completely stopped by the user or the playlist is exhausted.
* **Source Citations:**
  - Apple Developer Documentation: [AVAudioSession setActive(_:options:)](https://developer.apple.com/documentation/avfaudio/avaudiosession/setactive(_:options:))
  - Apple Developer Forums: [Maintaining Now Playing across track boundaries](https://developer.apple.com/forums/thread/681232)

### 1.6 Companion Keys: `MPNowPlayingInfoPropertyMediaType` and `AssetURL`
* **Finding:**
  - `MPNowPlayingInfoPropertyMediaType`: Must be explicitly set to `MPNowPlayingInfoMediaType.audio.rawValue` (`1`). On iOS 16–18, setting media type to audio indicates to the Lock Screen layout engine to render audio controls, scrubber bars, and compact/full-screen album art modes.
  - `MPNowPlayingInfoPropertyAssetURL`: Optional metadata key pointing to the local or remote URL of the asset. It is primarily used for HLS/AirPlay 2 routing metadata. It does not dictate whether the card renders artwork, but setting it to an invalid or unreachable URL will not break UI rendering if `MPMediaItemPropertyArtwork` is provided.
* **Source Citations:**
  - Apple Developer Documentation: [MPNowPlayingInfoPropertyMediaType](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfopropertymediatype)
  - Apple Developer Documentation: [MPNowPlayingInfoMediaType](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfomediatype)

---

## Q2 — What Governs Whether Tapping the Lock Screen Card / Dynamic Island Opens the App?

### 2.1 Tap-to-Open Mechanics: Dynamic Island vs. Lock Screen
* **Dynamic Island (iOS 16, 17, 18):**
  - **When Unlocked (Home Screen or other Apps):**
    - Single tap on the compact pill (leading artwork icon or trailing waveform animation) **automatically opens the owning app**. This is native OS behavior built into SpringBoard for whichever app owns the current `AVAudioSession` / Now Playing session. No custom URL scheme, Live Activity, or `widgetURL` is needed.
    - Long-press (touch and hold) expands the Dynamic Island into the system Now Playing platter.
  - **When on the Lock Screen:**
    - Tapping the Dynamic Island does not directly open the app, as the Lock Screen requires user authentication (Face ID / Touch ID) first.
* **Lock Screen Mini Player Card (iOS 16, 17, 18):**
  - **Tapping the Album Artwork Thumbnail:** Since iOS 16.0, tapping the album artwork thumbnail **does NOT open the app**. Instead, it expands the album art into the full-screen Lock Screen wallpaper player. Tapping the expanded full-screen artwork minimizes it back to the card.
  - **Tapping Text (Song Title / Artist Name):** Tapping the track title or artist text **is the target that brings the app to the foreground**. If the device is locked, iOS prompts for Face ID / Passcode and then brings the application to the foreground.
  - **App Icon Badge:** On certain iOS versions and iPadOS, tapping the small app icon badge in the player card header prompts unlock and opens the app.
* **Source Citations:**
  - Apple Support: [Use the Dynamic Island on iPhone](https://support.apple.com/guide/iphone/use-the-dynamic-island-iph28f50d10c/ios)
  - Apple Support: [View album art on the iPhone Lock Screen](https://support.apple.com/guide/iphone/view-album-art-on-the-lock-screen-iph4b4fbf6c1/ios)
  - WWDC 2022: [Meet the Dynamic Island](https://developer.apple.com/videos/play/wwdc2022/10098/)

### 2.2 Deep Linking and Lifecycle on Tap
* **Lifecycle Flow:**
  - When the user taps the Dynamic Island pill or the Lock Screen title text, iOS wakes/resumes the app from background execution.
  - If the app uses modern UIScene lifecycle (`SceneDelegate`), iOS calls:
    1. `sceneWillEnterForeground(_:)`
    2. `sceneDidBecomeActive(_:)`
  - If the app uses legacy `AppDelegate`:
    1. `applicationWillEnterForeground(_:)`
    2. `applicationDidBecomeActive(_:)`
* **Is a URL delivered?**
  - Standard Now Playing taps **do NOT deliver a URL** by default. iOS simply activates the app process without calling `scene(_:openURLContexts:)` or `application(_:open:options:)`.
  - `MPNowPlayingInfoPropertyExternalContentIdentifier`: This property does not cause iOS to synthesize an `openURL` event when tapped from Now Playing. It is used by SiriKit and system resume suggestions.
* **Non-Live-Activity Limitation:**
  - For standard `MPNowPlayingInfoCenter` media playback (without ActivityKit / Live Activities), **there is NO supported Apple API to configure custom tap targets or redirect tapping on the album art thumbnail to open the app**. The album art thumbnail tap target is permanently bound by SpringBoard to the Lock Screen wallpaper expansion toggle.
* **Source Citations:**
  - Apple Developer Documentation: [UIWindowSceneDelegate](https://developer.apple.com/documentation/uikit/uiwindowscenedelegate)
  - Apple Developer Documentation: [Responding to the Launch of Your App](https://developer.apple.com/documentation/uikit/app_and_environment/responding_to_the_launch_of_your_app)

---

## Q3 — Album Artwork on the Lock Screen / Dynamic Island

### 3.1 Minimal Correct Recipe for `MPMediaItemArtwork` on iOS 18
* **Recommended Initializer:**
  `MPMediaItemArtwork(boundsSize:requestHandler:)`
* **What `boundsSize` should be:**
  `boundsSize` must specify the maximum intrinsic dimensions of the source image (e.g., `CGSize(width: originalImage.size.width, height: originalImage.size.height)` or a reference square such as `CGSize(width: 600, height: 600)`). It serves as the upper boundary for the closure.
* **What sizes the system actually requests:**
  The system invokes the `requestHandler` closure with the exact size it needs for each surface:
  - Dynamic Island compact leading view: ~20×20 pt (40×40 px @2x, 60×60 px @3x)
  - Dynamic Island expanded view: ~60×60 pt
  - Lock Screen mini player thumbnail: ~48×48 pt to ~64×64 pt
  - Lock Screen full-screen album art: up to device screen width (typically 393×393 pt on iPhone 15/16 Pro, rendered at 1179×1179 px @3x).
* **Implementation Recipe:**
  ```swift
  let artwork = MPMediaItemArtwork(boundsSize: image.size) { requestedSize in
      let renderer = UIGraphicsImageRenderer(size: requestedSize)
      return renderer.image { _ in
          image.draw(in: CGRect(origin: .zero, size: requestedSize))
      }
  }
  ```
* **Source Citations:**
  - Apple Developer Documentation: [MPMediaItemArtwork](https://developer.apple.com/documentation/mediaplayer/mpmediaitemartwork)
  - Apple Developer Documentation: [MPMediaItemArtwork.init(boundsSize:requestHandler:)](https://developer.apple.com/documentation/mediaplayer/mpmediaitemartwork/1649830-init)

### 3.2 Required Companion Keys for Artwork Rendering
* **Essential Keys:**
  1. `MPNowPlayingInfoPropertyMediaType = MPNowPlayingInfoMediaType.audio.rawValue` (Required for Lock Screen media layout).
  2. `MPMediaItemPropertyTitle = "Track Title"` (Must be non-empty string).
  3. `MPMediaItemPropertyPlaybackDuration = duration` (Must be positive `Double`).
* Without `MPNowPlayingInfoPropertyMediaType` and a valid title, SpringBoard frequently fails to instantiate the artwork view or defaults to a generic podcast/audio placeholder glyph.
* **Source Citations:**
  - Apple Developer Documentation: [MPMediaItem](https://developer.apple.com/documentation/mediaplayer/mpmediaitem)

### 3.3 Asynchronous Artwork Loading and Merging
* **Finding:** Artwork **does not** need to be present when `nowPlayingInfo` is first published. It is standard and safe to publish metadata first and merge artwork later once fetched/cached.
* **Correct Merging Pattern:**
  ```swift
  var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
  info[MPMediaItemPropertyArtwork] = artwork
  MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  ```
* **Source Citations:**
  - Apple Developer Documentation: [MPNowPlayingInfoCenter.nowPlayingInfo](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter/1615903-nowplayinginfo)

### 3.4 The Overwriting Bug (Second Writer Dropping Artwork)
* **Critical Finding:** `MPNowPlayingInfoCenter.default().nowPlayingInfo` is a simple dictionary assignment. 
* If any component (such as a playback position sync loop, spectrum plugin, or rate updater) constructs a new dictionary `[:]` and assigns it without preserving existing keys (`info[MPMediaItemPropertyArtwork]`), **the artwork is wiped from MediaRemote immediately**.
* In Navilite, any write to `nowPlayingInfo` must strictly copy the existing dictionary:
  `var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]`
* **Source Citations:**
  - Apple Developer Forums: [Artwork disappearing on position update](https://developer.apple.com/forums/thread/704112)

---

## Q4 — The Gap Between Tracks (Multi-Second Boundary Delay)

### 4.1 Why an Idle `AVPlayer` Cannot Start Instantly
* **The Root Cause:** In an architecture where an `AVPlayer` and `AVPlayerItem` are created ahead of time but left at rate `0.0`:
  1. **Connection & TLS Handshake:** For remote progressive HTTP streams (e.g. Navidrome over Tailscale), creating an `AVPlayerItem` starts initial header fetching, but playback initialization requires a sustained TCP/TLS pipeline.
  2. **Buffer Fill Requirement (`automaticallyWaitsToMinimizeStalling`):** `automaticallyWaitsToMinimizeStalling` defaults to `true`. When `play()` is called, `AVPlayer` **deliberately blocks audio rendering** until it has filled a buffer threshold sufficient to prevent mid-track stalling based on calculated network throughput. On a Tailscale tunnel or mobile network, this evaluation takes 1.5 to 3.5 seconds.
  3. **Audio Output Pipeline Initialization:** The native CoreAudio render graph for the new `AVPlayer` is only committed to the hardware session when playback begins.
* **To make the start instantaneous:**
  - Use `AVPlayer.preroll(atRate:completionHandler:)` while the player is paused. `preroll(atRate: 1.0)` forces AVFoundation to decode the first audio packets and prime the decode pipelines into memory ahead of time.
  - Or configure `automaticallyWaitsToMinimizeStalling = false` and call `playImmediately(atRate: 1.0)` at the boundary (provided enough data has been pre-buffered).
* **Source Citations:**
  - Apple Developer Documentation: [AVPlayer.preroll(atRate:completionHandler:)](https://developer.apple.com/documentation/avfoundation/avplayer/1388049-preroll)
  - Apple Developer Documentation: [AVPlayer.automaticallyWaitsToMinimizeStalling](https://developer.apple.com/documentation/avfoundation/avplayer/1643482-automaticallywaitstominimizestall)
  - Apple Developer Documentation: [AVPlayer.playImmediately(atRate:)](https://developer.apple.com/documentation/avfoundation/avplayer/1643485-playimmediately)

### 4.2 Priming at Volume 0 vs. Pitfalls
* **The Priming Pattern:** Starting the next `AVPlayer` at `volume = 0.0` a few seconds before the current track finishes, then swapping volume at the boundary.
* **Documented Pitfalls:**
  1. **Dual Audio Session Contention:** Multiple `AVPlayer` instances within the same app share the single `AVAudioSession`. If both are actively playing, both stream data concurrently, doubling network bandwidth and CPU decode overhead.
  2. **Now Playing / Remote Command Hijacking:** If both `AVPlayer` instances are actively playing (even if one has volume 0), `AVFoundation`'s internal MediaRemote integration can become confused about which player is primary, causing Now Playing info or lock screen controls to bind to the silent player.
  3. **Battery & Heat:** Running concurrent software decoders on mobile degrades battery efficiency.
* **Source Citations:**
  - WWDC 2016: [Delivering Great Audio Experiences with AVFoundation](https://developer.apple.com/videos/play/wwdc2016/507/)

### 4.3 `AVQueuePlayer` and Progressive HTTP MP3 Streaming
* **Finding:** **`AVQueuePlayer` is NOT sample-accurate gapless for progressive HTTP MP3 streams.**
* **Technical Factors:**
  - MP3 files possess encoder delay and padding (usually 528 or 1052 samples at start/end) that are not natively standardized in MP3 stream headers unless encoded with specific LAME tags.
  - While `AVQueuePlayer` provides seamless transitions for **local files** and **HLS streams** (`EXT-X-DISCONTINUITY`), with non-HLS progressive HTTP MP3 streams it still tears down and renegotiates the demuxer pipeline at the boundary, resulting in an audible 100–300 ms hiccup even with caching.
  - When streaming transcoded FLAC→mp3 from Navidrome over plain HTTP, `AVQueuePlayer` cannot guarantee true zero-gap playback without local disk pre-caching.
* **Source Citations:**
  - Apple Developer Documentation: [AVQueuePlayer](https://developer.apple.com/documentation/avfoundation/avqueueplayer)
  - Apple Developer Forums: [AVQueuePlayer seamless transitions with progressive MP3](https://developer.apple.com/forums/thread/114920)

### 4.4 Transition Strategy: `setVolume(_:fadeDuration:)` vs. Hard Swap
* **Critical Framework Caveat:**
  - **`setVolume(_:fadeDuration:)` DOES NOT EXIST ON `AVPlayer`.** It is an exclusive API of `AVAudioPlayer` (`AVFAudio` framework).
  - Attempting to call `setVolume(_:fadeDuration:)` on `AVPlayer` does not compile.
  - On `AVPlayer`, `.volume` changes are instantaneous. Smooth crossfading on `AVPlayer` requires either:
    1. `AVMutableAudioMixInputParameters.setVolumeRamp(for:timeRange:)` (complex and static; cannot be easily modified on live progressive network streams).
    2. Driving `.volume` via a `CADisplayLink` or `Timer` (unreliable when the app is backgrounded, as timers are severely throttled or suspended).
* **Recommended Transition:**
  - Perform a **hard swap** at the boundary:
    1. Pre-buffer and `preroll(atRate: 1.0)` the next `AVPlayer`.
    2. At the boundary, set `playerNext.playImmediately(atRate: 1.0)`.
    3. Immediately pause and deallocate `playerPrev`.
    4. Update `nowPlayingInfo` in the exact same run-loop turn.
* **Source Citations:**
  - Apple Developer Documentation: [AVAudioPlayer.setVolume(_:fadeDuration:)](https://developer.apple.com/documentation/avfaudio/avaudioplayer/1387600-setvolume)
  - Apple Developer Documentation: [AVMutableAudioMixInputParameters](https://developer.apple.com/documentation/avfoundation/avmutableaudiomixinputparameters)

---

## What This Means for Navilite

### Concrete Mechanisms to Adopt (Priority Order)

1. **Persistent `AVAudioSession`:**
   - Initialize and activate the audio session (`.playback`, `mode: .default`) once upon playback startup.
   - **Never call `AVAudioSession.sharedInstance().setActive(false)`** during track changes or when unloading a finished track. Keep it active across the entire playlist lifecycle.

2. **Atomic `nowPlayingInfo` Mutations:**
   - Always read the existing `MPNowPlayingInfoCenter.default().nowPlayingInfo`, mutate the keys, and write back. Never assign a blank dictionary `[:]` when changing tracks or updating state.
   - Always include `MPNowPlayingInfoPropertyMediaType = MPNowPlayingInfoMediaType.audio.rawValue`.

3. **Accurate Playback Rate & State Synchronization:**
   - When moving to the next track, update `MPNowPlayingInfoPropertyPlaybackRate = 1.0`, `MPNowPlayingInfoPropertyElapsedPlaybackTime = 0.0`, duration, title, and artist in the same turn.
   - Also set `MPNowPlayingInfoCenter.default().playbackState = .playing`.
   - Never run a 1-second interval timer to update elapsed time; let iOS extrapolate.

4. **Preroll Next Asset for Instant Boundary Playback:**
   - When preloading the next track into a standby `AVPlayer` slot:
     ```swift
     nextPlayer.automaticallyWaitsToMinimizeStalling = true
     // When item status reaches .readyToPlay:
     nextPlayer.preroll(atRate: 1.0) { success in
         // Ready for zero-delay start
     }
     ```
   - At the track boundary, execute `nextPlayer.playImmediately(atRate: 1.0)` and pause the old player.

5. **Proper Artwork Bounds & Handlers:**
   - Supply `MPMediaItemArtwork(boundsSize: originalImage.size)` with a resizing handler rather than raw unscaled images to prevent memory spikes in SpringBoard and Dynamic Island rendering.

### Mechanisms to Avoid
- **DO NOT** attempt to make the Lock Screen album art thumbnail open the app. On iOS 16–18, Apple has hardcoded that tap target to toggle full-screen album art. The user must tap the track title or artist text.
- **DO NOT** use a software volume timer loop for crossfading in the background (`AVPlayer` lacks `fadeDuration` and background timers are throttled).
- **DO NOT** run concurrent audible `AVPlayer` instances at volume 0 as a priming hack. Use `preroll(atRate:)`.
- **DO NOT** deactivate the audio session between track transitions.

---

## Flagged Assumptions & Unestablished Items
1. **Dynamic Island Custom Tap Routing:** There is **no public API** to inject a custom deep link or redirect the tap target of the native Dynamic Island Now Playing module to an arbitrary internal page of an app without implementing a full custom `ActivityKit` Live Activity.
2. **Navidrome Transcoding Buffering Latency:** While `preroll(atRate:)` eliminates AVPlayer start delay, network latency on on-the-fly FLAC-to-MP3 transcoding on Navidrome depends on the host CPU. If the server does not transcode faster than real-time, buffering pauses can still occur regardless of client architecture.
