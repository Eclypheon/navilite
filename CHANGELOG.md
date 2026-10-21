# What changed

Plain language, user-visible changes only. **Newest first** — the newest release is at the top.
The app shows this same list under **Settings → What's new**, and `test/changelog.test.ts` fails if
the two disagree.

## 2.0.0 — 2026-10-22

- Leaving the app keeps the music playing: the Lock Screen and Dynamic Island keep the right song, and coming back picks up at the same second with no loading spinner, no restart and no second copy of the song.
- The next song is ready before the current one ends, so a song change while the app is in your pocket is quick.
- Backgrounding on the first song no longer moves the card onto the next song early, skips that song, or plays the one after it in its place.
- Tapping another song while the phone's background player is playing takes the sound over cleanly: the controls, the seek bar and the spectrum follow the song you picked, and pressing play never starts a second copy.
- The seek bar, pause/play and skip always follow the player that is really making the sound — including from the Lock Screen — and the spectrum stays live on the background player instead of going flat or falling back to album-art colours.
- A song no longer changes length under you: the 3:30 track stays 3:30 after a seek, and the next song plays by itself again.
- Downloading a playlist to your phone now runs in one go to the end, covers and lyrics included. The button shows the exact size and the bytes arriving, retries a failed track on its own, and offers retry only when the job has really stopped.
- The download faults of the beta are gone: "unsupported url", "cannot create file", a download that stopped after a moment, and a temporary lyrics error no longer means "no lyrics" for ever.
- Tapping the song in the bottom bar takes you to its row, then to the spectrum; the transport buttons no longer send you to another screen.
- The app starts at the top of the screen again, with no wide empty band, and the player bar keeps one size.
- Small fixes you may notice: the album lists show the whole library, lyrics that arrive late now appear, the last second of a song reads correctly, and removing all downloads or forgetting your password asks first.

## 1.9 — 2026-10-16

- Tapping a song answers immediately: the row, its name, its artist, its cover and a small marker are drawn before anything is asked of your server.
- The next song is brought over while the current one plays, so moving on starts straight away; the song you left behind stops downloading.
- The music keeps going when the app is in your pocket or the screen is locked: the phone's player is given the next songs and walks them itself, and the Lock Screen's next and previous buttons work.
- A song that ends goes straight into the next one with nothing thrown away in between, and the app no longer closes itself on the first tap or on the way back into it.
- The app opens where you left it — same queue, same song, same second — and no longer starts playing by itself.
- The spectrum stays live across song changes, and the small word on the player bar always means one thing: "spectrum" while the bars are fed, "spectrum…" while the phone is still setting the song up, the transport's own word when nothing is playing, and "native audio" only on a build that really cannot read the song.
- Mobile data gets a smaller stream, and the bar says the number while it does; nothing is reduced for the song you tapped once the link is fast.
- Download a playlist to your phone and it plays with no connection: songs, lyrics and covers come with it. The download button shows the space it will take and the bytes arriving, and Playlists and "On this phone" show what is on the phone.
- A downloaded playlist opens with no connection from the first moment, tracks that are not here are marked "not on this phone", and a download whose file has gone missing plays from the server instead of silence.
- Seeking works: the song moves to where you let go, and the bar shows the position the music really reached.
- Downloads from older builds get their names, lengths and art, and a server message can no longer appear where the lyrics should be.

## 1.8.1 — 2026-10-11

- Your two red circles and the green one. The pills now sit right under the status bar and the controls right above the home bar — that space was empty, and the spectrum has 35 px of it now (the room taken by everything around it went from 208 px to 173 px on your phone). And the seek bar senses your finger on the bar itself instead of a few pixels above it: the strip you drag is a 44 pt target centred on the line, so 40 px either side of it seeks, where before only the 14 px around the thumb answered. The drag and the tap both work exactly as they did.

## 1.8.0 — 2026-10-11

- The seek bar takes your thumb. Dragging it moves the song now, on the phone as well as on the web page: before, only a quick touch worked, because the bar was listening for the kind of event iOS stops sending the moment your thumb starts moving on a slider, so a drag did nothing at all. It listens for the touch itself now, and a sweep along the bar never turns the page.
- And the bars keep up with the sound. Switching to another song used to leave them sitting on the one before it until you paused and played again: they now come up with the track you are hearing, in that song's own colours from its cover art. Pausing lets them settle down to nothing instead of showing the waiting picture.

## 1.7.7 — 2026-10-11

- The bars no longer need a new song before they come back. Pausing, or leaving the app and returning, used to take the spectrum apart and put it back together while the song was already playing — which is why it sometimes stayed dark until you picked another track, and why you heard a small gap in the music just before it returned. It is now fitted once and left alone, so it is there the moment the sound is.

## 1.7.6 — 2026-10-11

- The bars are drawn from the song you are hearing, and nothing else plays underneath it. Up to now a second, silent copy of the same song was fetched and decoded alongside it — two copies of one stream, which is extra work for the phone and for your library in the one place that can make the sound stutter. That copy is gone: one player, the one you can hear.

## 1.7.5 — 2026-10-11

- More exact, everywhere your finger goes: picking a second song right after a first never plays the wrong one, dragging the bar no longer risks stopping the sound while it moves, the time no longer counts up before the music has actually started, and the bars keep moving right to the end of a song instead of disappearing in its last seconds.

## 1.7.4 — 2026-10-11

- Drag the bar to seek. It took a press and a drag before but only a tap ever moved the track: the bar was leaving the drag to the phone's own slider, and the phone's slider was not doing it. The bar now follows your finger itself, from where you press to where you let go, and the screen stays on the spectrum while you scrub.
- The visualiser is smoother, and it wears the album's colours. It was reading each frame raw — which is what made it shimmer and lag — so each bar now rises quickly and settles, and the bars take their colour from the album art the rest of the app is already themed with, the bass to the treble, instead of one blue for every song.
- Pausing lets the spectrum settle. The bars used to disappear and be replaced by the placeholder animation the moment you paused; now they drop to nothing over about a third of a second and stay where they are, and the placeholder is only for when there is nothing loaded at all. The same when a song ends.

## 1.7.3 — 2026-10-11

- One audio engine now. The app had two ways of playing a song and could end up using either of them, and switching between the two was behind every one of these problems. There is one engine now, the phone's own, and the setting that let you choose is gone with it — the app decides, always the same way.
- Coming back to the app always keeps playing. Leaving and returning no longer pauses the track, restarts it, or plays any part of it twice: the app asks the phone's player what it is doing and follows that answer. If you paused from the lock screen while you were away, that is what it shows — one tap on play starts it again from the same second.
- The visualiser is always in step. It reads the player the sound is actually coming out of, and it stays on for as long as a track is playing — it no longer goes dark while the music carries on.
- The clock follows the sound, and only the sound. Backgrounded, paused or interrupted, the time stands still: it never counts on while nothing is playing.
- The time follows your finger. Drag the seek bar and the clock under it counts up or down with your thumb, so you can see where you are about to drop the needle before you let go; if the drag is cancelled, the clock goes back to where the music really is.
- The clock starts when the song does. Picking a track used to sit at 0:00 until the player answered; the time now runs from the moment you tap.

## 1.7.1 — 2026-10-11

- The visualiser is back. It had gone flat when playback moved to the phone's own player, and it reads the music again now — the real reading of what you are hearing, unchanged from before.
- Coming back to the app just works. Returning from the background now asks the player what is actually true and makes the screen agree with it, so the buttons match the sound: still playing shows playing, and if it stopped, one tap on play starts it again from where it stopped — no nudging the seek bar, no pause-then-play to unstick it.
- Pressing play answers at once. The button used to wait for the phone's player to say yes before it changed; it now changes on your touch and is checked a moment later, and the player is got ready when the app opens rather than when you press. Measured in the harness: the screen used to flip a fifth of a second later than the touch, and now flips on it.
- Dragging the seek bar seeks. A swipe that starts on the bar belongs to the bar: the screens no longer turn while you are scrubbing, and the track follows your thumb as you drag it instead of jumping when you let go.

## 1.7 — 2026-10-11

- The music keeps playing when you leave the app. Playback now runs through the phone's own audio engine instead of the page, so leaving the app, locking the screen or switching to something else no longer stops the track you were on. (It already came back on the right track; it now simply never stops in the first place.)
- Your lock screen and the Control Centre have real previous and next buttons next to play/pause, and they work from there — no need to open the app to skip a track.
- Come back and it is exactly where you left it: the same track, at the same second, in the same order. If the phone closed the app while you were away, it picks up from that point rather than from the top of the song.
- The spectrum is still the real one — the reading of the music that is actually playing. It is a foreground picture now: while the app is in the background the screen is off anyway, and it returns the moment you open it.

## 1.6.2 — 2026-10-11

- Holding a song no longer highlights it. Pressing a track used to paint a plate and a ring around it for as long as your finger was down — before it had moved at all — and a row you had touched stayed painted after you let go; nothing is painted on a press now, and the only row that stands out is the one playing. A press you then turn into a swipe is also read as a swipe sooner, so a track under a thumb on its way to a scroll never reads as a tap.

## 1.6.1 — 2026-10-11

- Tapping works again: a tap on a playlist opens it, and a tap on a song plays it, even if your finger rests on the row for a moment first. Dragging to scroll still only scrolls — nothing starts under your thumb.

## 1.6 — 2026-10-11

- Scrolling a list no longer taps a song. Resting a thumb on a track and dragging to scroll used to start that track; a track now starts only on a tap — under 10 px of movement, a short press, and cancelled the moment the list scrolls — and a drag that scrolls the list starts nothing. Measured on the phone-sized screen: 200 px of thumb travel, the list scrolled its 200 px, and no track started.
- Settings is not a swipe page any more. Swiping left or right on settings used to pull the spectrum or the lyrics in; now a sideways swipe there does nothing at all, and a swipe to the right takes you back to the screen you opened settings from. Measured: a left drag left the screen, the list and the strip exactly where they were (nothing on screen moved at all), and a right drag returned to the playlist the gear was tapped on.
- Playback survives coming back to the app. The track you left playing is the track that comes back, the queue keeps its place, and play/pause answers on the first tap afterwards. The app swaps its audio engine while the screen is off so the music keeps playing, and it no longer mistakes that swap for the song ending.
- The colours from the album art are back on a fresh launch. A launch that restored your session was quietly losing the theme the cover art sets, which had been fixed once and came back with the swipe pager.

## 1.5.1 — 2026-10-11

- The settings screen can no longer be dragged sideways. The playback dropdown's own text was still wider than the box it sits in — 301 px of it — so tapping it left the screen free to slide; the box clips its text now and there is nothing to drag (measured on your phone: 301 px before, 0 px after).

## 1.5 — 2026-10-11

- The settings screen stays put. Tapping the playback box there used to zoom the whole screen in and let you drag it about; the boxes take focus at a full-size text height now, so nothing moves when you tap one — measured on your phone, the box that used to take focus at 15 px takes it at 16 px.
- The first line of the lyrics is not tucked under the top of the panel any more. It sat right at the top edge, inside the pale band where the words fade out; measured at 393 px on the phone it was 0 px in, and it starts 18 px in now.
- The now-playing screen is three screens you swipe between — your playlist, the spectrum, the lyrics — and it goes round. The next screen comes in with your finger, edge to edge, instead of the screen changing after you let go: measured, the screens move exactly as far as the finger does, to the pixel, and no gap opens between them.
- Up and down still scrolls. A gesture that is mostly up-and-down scrolls the screen it starts on and turns no page — I measured one with 200 px of sideways travel in it (half a screen) that scrolls and stays put.
- Spectrum and Lyrics at the top of that screen slide it across rather than cutting to it.
- The whole row is the play button. Tapping anywhere on a track starts it, and the little play mark and the star have gone from the row — the row is the target now, rather than a button inside a button. Albums still have their star on the album screen, and the Favourites screen still lists what is starred.
- The lyrics scroll one line early, so the line you are about to hear is already on screen when the current one lights up, and they never scroll past the last line of the song.
- If you scroll the lyrics yourself, it leaves them where you put them for a few seconds instead of pulling the line back out from under your finger.
- Back and forward on the phone walk those three screens the way you would expect: back from the lyrics is the spectrum, forward is the lyrics again.

## 1.4 — 2026-10-11

- The now-playing screen no longer scrolls the list behind it. Open a playlist, open the spectrum, scroll: the list underneath does not move at all — in v1.3 a gesture there dragged it 800 px and left it there — and closing brings you back to the same row you were on.
- The top bar cannot grow, stretch or scroll away any more. It measures 58 px at the top of the screen and the same 58 px after every scroll, and the page itself no longer scrolls anywhere: v1.3 scrolled the whole page 1,660 px, and now there is 0 px of page to scroll at all.
- The app scrolls inside one box of its own now, so the only thing a finger can reach while the now-playing screen is open is that screen: pointing at every part of it lands on the spectrum or the lyrics, never on the list underneath.

## 1.3 — 2026-10-11

- Lyrics now load directly from your library. The app reads the lyrics file that sits next to the song itself, instead of asking the music server what it made of that file — so a lyrics file the server would not have offered you still shows up, with or without timings.
- Tracks that came back empty are no longer written off. A track that had no lyrics when you opened it is looked at again a few minutes later, so the lyrics files that are still being added to your library appear on their own — no clearing anything, no reinstalling. The ones you opened before they existed will fill in.
- Timed and plain files both read exactly as before: a file with timings still lights the current line up with the music, a plain text file is still the normal, comfortable case, and a track with no lyrics file at all still says "no romaji lyrics for this track yet" instead of waiting.
- One safety net behind the other: if the library's own lyrics route cannot be reached, the app asks the music server exactly as it did before. You never see an error, and a slow or missing answer never leaves a blank screen spinning.

## 1.2 — 2026-10-11

- The spectrum is the current frame only. The little mark that floated above each bar and the fading copy of where the bar had been are both gone: nothing on the screen is a leftover of the moment before, and the reading itself no longer averages the previous frame in.
- Lyrics get the whole screen. The album art steps aside in Lyrics mode and the lines are set tighter, so a verse fits at once instead of one line at a time — on your phone the panel is 452 px tall instead of 89, at 13 px a line (about 26 lines visible).
- Measured at your phone's exact width this time: 393 px, with your longest Japanese titles and playlist names, on every screen and in both modes. The old check ran at 390 px, which is why it said clean while your phone still scrolled sideways. There is now a test that runs at 393 px and fails if anything on any screen is wider than the screen.

## 1.1 — 2026-10-11

- No more sideways scrolling: long titles, artist names and addresses now wrap or shorten instead of pushing the page wider than the screen.
- Albums, Favourites and Search are gone from the navigation. It is Library, Playlists and the settings gear now — search is still inside Library.
- Tap the Navilite logo to jump straight to the spectrum.
- Swipe left on the spectrum to get to your playlists.
- Open the app and, if a track was playing when you left, it opens on the spectrum for that track.
- The spectrum screen reads top to bottom: cover art, the spectrum (under the cover now — nothing covers it), the song name, "Playing from <playlist> (3/12)", and one compact bar at the bottom with play/pause, previous/next, shuffle and repeat.
- The spectrum moves sharper. It was dragging behind the music; it now follows every frame, and the two mode notes that used to sit on the screen are gone.
- Lyrics: the switch at the top of the spectrum screen flips between Spectrum and Lyrics. The words come from your own library — the lyrics file that sits next to the song — and the line lights up with the music when the file has timings. No timings is normal and reads fine; a track with no lyrics file at all says so instead of spinning.
- The track that is playing is highlighted in the playlist.
- Settings has a "What's new" page — this text.
- Leave the server address blank and it uses your library's usual address.

## 1.0 — 2026-10-10

- Browse your library by artist and album, and play anything in it.
- The spectrum is real: it reads the music that is actually playing, not a decoration.
- Playlists: play them, make one, add tracks to it, remove tracks from it.
- Favourites: star or unstar albums and tracks.
- Your password is never stored as text on the server — it goes as a one-way code, and it lives in the phone's own keychain.
- Three ways to use it: the phone app (Android APK, iPhone sideload) and the web page.
- Reaches your library over Tailscale only. Nothing is exposed to the public internet.
