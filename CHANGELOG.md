# What changed

Plain language, user-visible changes only. The app shows this same list under
**Settings → What's new**, and `test/changelog.test.ts` fails if the two disagree.

## 1.0 — 2026-10-10

- Browse your library by artist and album, and play anything in it.
- The spectrum is real: it reads the music that is actually playing, not a decoration.
- Playlists: play them, make one, add tracks to it, remove tracks from it.
- Favourites: star or unstar albums and tracks.
- Your password is never stored as text on the server — it goes as a one-way code, and it lives in the phone's own keychain.
- Three ways to use it: the phone app (Android APK, iPhone sideload) and the web page.
- Reaches your library over Tailscale only. Nothing is exposed to the public internet.

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

## 1.2 — 2026-10-11

- The spectrum is the current frame only. The little mark that floated above each bar and the fading copy of where the bar had been are both gone: nothing on the screen is a leftover of the moment before, and the reading itself no longer averages the previous frame in.
- Lyrics get the whole screen. The album art steps aside in Lyrics mode and the lines are set tighter, so a verse fits at once instead of one line at a time — on your phone the panel is 452 px tall instead of 89, at 13 px a line (about 26 lines visible).
- Measured at your phone's exact width this time: 393 px, with your longest Japanese titles and playlist names, on every screen and in both modes. The old check ran at 390 px, which is why it said clean while your phone still scrolled sideways. There is now a test that runs at 393 px and fails if anything on any screen is wider than the screen.

## 1.3 — 2026-10-11

- Lyrics now load directly from your library. The app reads the lyrics file that sits next to the song itself, instead of asking the music server what it made of that file — so a lyrics file the server would not have offered you still shows up, with or without timings.
- Tracks that came back empty are no longer written off. A track that had no lyrics when you opened it is looked at again a few minutes later, so the lyrics files that are still being added to your library appear on their own — no clearing anything, no reinstalling. The ones you opened before they existed will fill in.
- Timed and plain files both read exactly as before: a file with timings still lights the current line up with the music, a plain text file is still the normal, comfortable case, and a track with no lyrics file at all still says "no romaji lyrics for this track yet" instead of waiting.
- One safety net behind the other: if the library's own lyrics route cannot be reached, the app asks the music server exactly as it did before. You never see an error, and a slow or missing answer never leaves a blank screen spinning.

## 1.4 — 2026-10-11

- The now-playing screen no longer scrolls the list behind it. Open a playlist, open the spectrum, scroll: the list underneath does not move at all — in v1.3 a gesture there dragged it 800 px and left it there — and closing brings you back to the same row you were on.
- The top bar cannot grow, stretch or scroll away any more. It measures 58 px at the top of the screen and the same 58 px after every scroll, and the page itself no longer scrolls anywhere: v1.3 scrolled the whole page 1,660 px, and now there is 0 px of page to scroll at all.
- The app scrolls inside one box of its own now, so the only thing a finger can reach while the now-playing screen is open is that screen: pointing at every part of it lands on the spectrum or the lyrics, never on the list underneath.

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

## 1.5.1 — 2026-10-11

- The settings screen can no longer be dragged sideways. The playback dropdown's own text was still wider than the box it sits in — 301 px of it — so tapping it left the screen free to slide; the box clips its text now and there is nothing to drag (measured on your phone: 301 px before, 0 px after).

## 1.6 — 2026-10-11

- Scrolling a list no longer taps a song. Resting a thumb on a track and dragging to scroll used to start that track; a track now starts only on a tap — under 10 px of movement, a short press, and cancelled the moment the list scrolls — and a drag that scrolls the list starts nothing. Measured on the phone-sized screen: 200 px of thumb travel, the list scrolled its 200 px, and no track started.
- Settings is not a swipe page any more. Swiping left or right on settings used to pull the spectrum or the lyrics in; now a sideways swipe there does nothing at all, and a swipe to the right takes you back to the screen you opened settings from. Measured: a left drag left the screen, the list and the strip exactly where they were (nothing on screen moved at all), and a right drag returned to the playlist the gear was tapped on.
- Playback survives coming back to the app. The track you left playing is the track that comes back, the queue keeps its place, and play/pause answers on the first tap afterwards. The app swaps its audio engine while the screen is off so the music keeps playing, and it no longer mistakes that swap for the song ending.
- The colours from the album art are back on a fresh launch. A launch that restored your session was quietly losing the theme the cover art sets, which had been fixed once and came back with the swipe pager.

## 1.6.1 — 2026-10-11

- Tapping works again: a tap on a playlist opens it, and a tap on a song plays it, even if your finger rests on the row for a moment first. Dragging to scroll still only scrolls — nothing starts under your thumb.
