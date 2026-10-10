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
