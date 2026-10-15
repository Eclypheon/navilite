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

## 1.6.2 — 2026-10-11

- Holding a song no longer highlights it. Pressing a track used to paint a plate and a ring around it for as long as your finger was down — before it had moved at all — and a row you had touched stayed painted after you let go; nothing is painted on a press now, and the only row that stands out is the one playing. A press you then turn into a swipe is also read as a swipe sooner, so a track under a thumb on its way to a scroll never reads as a tap.

## 1.7 — 2026-10-11

- The music keeps playing when you leave the app. Playback now runs through the phone's own audio engine instead of the page, so leaving the app, locking the screen or switching to something else no longer stops the track you were on. (It already came back on the right track; it now simply never stops in the first place.)
- Your lock screen and the Control Centre have real previous and next buttons next to play/pause, and they work from there — no need to open the app to skip a track.
- Come back and it is exactly where you left it: the same track, at the same second, in the same order. If the phone closed the app while you were away, it picks up from that point rather than from the top of the song.
- The spectrum is still the real one — the reading of the music that is actually playing. It is a foreground picture now: while the app is in the background the screen is off anyway, and it returns the moment you open it.

## 1.7.1 — 2026-10-11

- The visualiser is back. It had gone flat when playback moved to the phone's own player, and it reads the music again now — the real reading of what you are hearing, unchanged from before.
- Coming back to the app just works. Returning from the background now asks the player what is actually true and makes the screen agree with it, so the buttons match the sound: still playing shows playing, and if it stopped, one tap on play starts it again from where it stopped — no nudging the seek bar, no pause-then-play to unstick it.
- Pressing play answers at once. The button used to wait for the phone's player to say yes before it changed; it now changes on your touch and is checked a moment later, and the player is got ready when the app opens rather than when you press. Measured in the harness: the screen used to flip a fifth of a second later than the touch, and now flips on it.
- Dragging the seek bar seeks. A swipe that starts on the bar belongs to the bar: the screens no longer turn while you are scrubbing, and the track follows your thumb as you drag it instead of jumping when you let go.

## 1.7.3 — 2026-10-11

- One audio engine now. The app had two ways of playing a song and could end up using either of them, and switching between the two was behind every one of these problems. There is one engine now, the phone's own, and the setting that let you choose is gone with it — the app decides, always the same way.
- Coming back to the app always keeps playing. Leaving and returning no longer pauses the track, restarts it, or plays any part of it twice: the app asks the phone's player what it is doing and follows that answer. If you paused from the lock screen while you were away, that is what it shows — one tap on play starts it again from the same second.
- The visualiser is always in step. It reads the player the sound is actually coming out of, and it stays on for as long as a track is playing — it no longer goes dark while the music carries on.
- The clock follows the sound, and only the sound. Backgrounded, paused or interrupted, the time stands still: it never counts on while nothing is playing.
- The time follows your finger. Drag the seek bar and the clock under it counts up or down with your thumb, so you can see where you are about to drop the needle before you let go; if the drag is cancelled, the clock goes back to where the music really is.
- The clock starts when the song does. Picking a track used to sit at 0:00 until the player answered; the time now runs from the moment you tap.

## 1.7.4 — 2026-10-11

- Drag the bar to seek. It took a press and a drag before but only a tap ever moved the track: the bar was leaving the drag to the phone's own slider, and the phone's slider was not doing it. The bar now follows your finger itself, from where you press to where you let go, and the screen stays on the spectrum while you scrub.
- The visualiser is smoother, and it wears the album's colours. It was reading each frame raw — which is what made it shimmer and lag — so each bar now rises quickly and settles, and the bars take their colour from the album art the rest of the app is already themed with, the bass to the treble, instead of one blue for every song.
- Pausing lets the spectrum settle. The bars used to disappear and be replaced by the placeholder animation the moment you paused; now they drop to nothing over about a third of a second and stay where they are, and the placeholder is only for when there is nothing loaded at all. The same when a song ends.


## 1.7.5 — 2026-10-11

- More exact, everywhere your finger goes: picking a second song right after a first never plays the wrong one, dragging the bar no longer risks stopping the sound while it moves, the time no longer counts up before the music has actually started, and the bars keep moving right to the end of a song instead of disappearing in its last seconds.

## 1.7.6 — 2026-10-11

- The bars are drawn from the song you are hearing, and nothing else plays underneath it. Up to now a second, silent copy of the same song was fetched and decoded alongside it — two copies of one stream, which is extra work for the phone and for your library in the one place that can make the sound stutter. That copy is gone: one player, the one you can hear.

## 1.7.7 — 2026-10-11

- The bars no longer need a new song before they come back. Pausing, or leaving the app and returning, used to take the spectrum apart and put it back together while the song was already playing — which is why it sometimes stayed dark until you picked another track, and why you heard a small gap in the music just before it returned. It is now fitted once and left alone, so it is there the moment the sound is.

## 1.8.0 — 2026-10-11

- The seek bar takes your thumb. Dragging it moves the song now, on the phone as well as on the web page: before, only a quick touch worked, because the bar was listening for the kind of event iOS stops sending the moment your thumb starts moving on a slider, so a drag did nothing at all. It listens for the touch itself now, and a sweep along the bar never turns the page.
- And the bars keep up with the sound. Switching to another song used to leave them sitting on the one before it until you paused and played again: they now come up with the track you are hearing, in that song's own colours from its cover art. Pausing lets them settle down to nothing instead of showing the waiting picture.

## 1.8.1 — 2026-10-11

- Your two red circles and the green one. The pills now sit right under the status bar and the controls right above the home bar — that space was empty, and the spectrum has 35 px of it now (the room taken by everything around it went from 208 px to 173 px on your phone). And the seek bar senses your finger on the bar itself instead of a few pixels above it: the strip you drag is a 44 pt target centred on the line, so 40 px either side of it seeks, where before only the 14 px around the thumb answered. The drag and the tap both work exactly as they did.

## 1.9.0 — 2026-10-12

- A song that finishes plays the next one again. It had stopped doing that on both the phone and the web page: a track reaching its end only reached the queue through one notification, and when that notification was late or lost the music simply stopped at the end of the song. The player's own position at the very end of an item now counts as its end as well, and whichever of the two arrives first moves the list on — exactly once, so nothing is skipped.
- Tapping a song answers immediately. The row you touch, its name, its artist, its cover and a small turning marker are all drawn on the spot, before the app has asked your server for anything at all. It used to sit there showing the previous song for as long as the request took, so on a slow connection the screen looked dead for seconds.
- The next song is brought over while the current one is playing. The opening of the track after the one you are hearing is already on its way before you get to it, so moving on does not start from nothing. If you change your mind quickly, the track you left behind stops downloading straight away and only the one you chose has anything in flight.
- Mobile data gets a smaller stream, and it tells you so. Over a connection that is not your home wifi the app asks your server to send a smaller version of the song instead of the full-size original — the bar shows the number while it is doing that — because asking for the original over a relay makes it wait. It starts modest on a connection it has not measured yet, raises the number when it has measured the connection doing better, and asks for nothing smaller at all once the link is fast.

## 1.9.1 — 2026-10-12

- The next song is loaded while the current one is still playing, so it starts the instant the current one ends. The whole length of a track is now spent getting the one after it ready on the player itself, and when the track finishes the app switches to what is already waiting instead of fetching anything — that is the difference between "instant" and the wait you had.
- The seek bar no longer stops the playlist moving on by itself. On some songs the app was left waiting for an answer from the player that never came, and while it waited the end of a track was ignored — so a track that finished after a seek did nothing at all, for the rest of the session. Seeking is now a thing the app waits for only very briefly, and a track that ends after a seek moves the queue on as it always should.
- Tapping a row always paints what you touched. Tapping the song that was already being fetched used to light the row and then settle it with nothing sent at all, which looked exactly like a tap the app had missed; the row now stays lit until that song is really on its way.
- The visualiser shows the new song from its first moment, and the sound no longer waits behind it. Working out which track to measure used to hold up the app while the new stream was being fetched, which is why the bars stayed dark through that gap and why the start was slower than a plain tap.

## 1.9.2 — 2026-10-12

- The app uses one stable security code per session, so your server can recognise and cache files over relay connections instead of negotiating a fresh code on every request.
- The app measures how long each song actually takes to start playing rather than downloading extra bytes in the background.
- The next song is prepared directly on the phone's player and seamlessly handed over when the track changes.
- Dragging the seek bar is smooth and responsive, sending one clean position update without piling up delayed requests.
- The player honestly shows its loading state and confirms sound is coming out before reporting that music is playing.

## 1.9.3 — 2026-10-12

- Moving the seek bar never leaves the player hanging if the phone takes longer than usual to settle on the new position.
- Rapidly switching songs or scrubbing cleanly releases earlier requests so playback never stalls.
- Clearer recovery and retry if a track fails to start over a lossy mobile connection.

## 1.9.4 — 2026-10-12

- The next song starts on its own again when one finishes - the look-ahead is re-armed even if preparing a track had failed, so it never goes quiet for the rest of the session.
- Picking a song far down a playlist no longer waits on preparing a track you did not ask for: your choice takes that slot immediately.
- Scrubbing the seek bar no longer confuses where a song started, so moving the bar and then letting the playlist continue both work.
- The player only steps down to a lower-quality stream when your phone actually slows down, instead of after one quick start.

## 1.9.5 — 2026-10-12

- When a song ends, the next one starts by itself again and the bars stay live across the change. The bar used to switch to "native audio" at the end of every song and stay there, which is the thing you reported - the end of a track was arriving as a report the app treated as an interruption, so it stopped the queue and went quiet instead of moving on.
- A song you pick from far down a playlist starts playing as soon as its first few seconds have arrived, not after the whole song has downloaded.
- The song before the one playing, and the two songs after it, are kept ready on the phone - so stepping back or forward starts straight away instead of waiting for a fetch.
- When something is not playing, the bar now says why, in one line under the button: the app's own state, what the phone's player last reported, whether handing over from one song to the next worked, and how many of the player's own messages were dropped.

## 1.9.6 — 2026-10-12

- When a song hands over to the next one, the chip on the bar stays on the spectrum instead of flashing "native audio" at every change: while the new song's reading is still being set up it says "spectrum…", and the bars come back on their own a moment later.
- The line under the bar no longer counts a hand-over that worked as a lost message from the phone: the "playing" report for the song that took over was being thrown away as if it belonged to the song before it.

## 1.9.7 — 2026-10-12

- A song no longer shows as playing before it has started. The report the app took as "this track is sounding" could come from the song it was replacing, so a track that had fetched nothing looked like it was playing - and if it then failed, nothing was ever said and nothing tried again. Only the song you actually started can now say it is playing, and one that does not start says so and is retried.
- If a song cannot be started at all, the row stops waiting and says so instead of sitting on the loading state for the rest of the session.
- A track that ends is no longer missed while the app is getting the next one ready: the song being replaced saying "I have finished" was being ignored because a track was still being loaded.
- The bars are only drawn while the now screen is open, and dragging the seek bar no longer rewrites your saved session about eight times a second - both were work you could not see, on the screens that have to keep up with your finger.
- If the bars cannot re-attach to the song that is playing, the chip stops saying "spectrum…" and says the bars are on the album-art theme, which is what was actually happening.

## 1.9.8 — 2026-10-13

- A song that ends while the app is in your pocket or the screen is locked now goes on to the next one. Until now the phone's player had no idea what came next - it was waiting to be told by the app, and the app was not running - so the music simply stopped at the end of the song. The phone's player is given the next song now, and it plays it itself.
- The song after the one playing is really already there. The app used to report a song as "ready" the moment it had made a player for it, before a single byte had arrived - which is why waiting for the next song to start still meant waiting for it. It now waits until the song's own audio has actually arrived, and says so honestly when it has not.
- The first song you tap is played as the file sits on your server, exactly as v1.7 did. The app had started asking the server for a smaller copy of every song before the first note, and on your setup that means the server re-encodes the song before it sends a byte - which is why the first tap had got slower. Nothing is re-encoded for a song you are waiting to hear any more.
- A song that fails to start is asked for again on the song that is already there, instead of being thrown away and downloaded a second time - so a hiccup can no longer turn into another long wait, or into the same song starting over.
- The line under the bar now also says what the phone's player did on its own while the app was away: how many songs it was holding ready to play, how many it moved on to by itself, and where it could not.

## 1.9.9 — 2026-10-13

- The app no longer closes itself on the first song you tap. It was asking the phone's player to get a song ready in a state the player refuses, which took the app down the moment a song was tapped — and then again every time it opened, because it opened on the song that had been playing. Nothing is asked of the player now until it says it is ready for it.
- A song that ends while the app is in your pocket always goes on to the next one, however many go by. The phone's player is given the whole queue to walk now, and when the next song is not already sitting in it, it fetches that song itself.
- Next and previous no longer wait for a song that is being got ready in the background. Starting a song and preparing the following one were sharing one line, so a tap could sit behind a whole download and look like it had done nothing.
- Previous does what it says now. More than three seconds into a song it restarts that song; inside the first three seconds it goes back a song. It used to restart the song and then play the previous one anyway, so going forward was the only thing that ever worked.
- A song you are waiting for is never a smaller copy of the file on your server. The app was still asking for a lower-quality version for the next songs and then playing it, so on a slow connection the song you tapped was quietly the reduced one.
- Opening the app no longer starts playing by itself. It comes up where you left it — same queue, same song, same second — and one tap on play carries on from there.
- The next and previous buttons on the lock screen now work while the app is in the background, and going back works more than once.

## 1.9.10 — 2026-10-13

- The app no longer closes itself on your way back into it after a song ended while it was in your pocket, and no longer closes when you skip ahead a few songs in a row. Both were one fault: it was asking the phone's player for something about a song the player had already moved on from — one that had finished, one that had failed to load, or one the next song had already replaced — and a question like that is answered by taking the app down. Nothing is asked of a song now unless the player itself says that song is loaded, has not already been played to its end, and is still the song the player is holding.
- The lock screen shows how long the song is, from the moment it starts — the scrubber is right without you pressing anything first. The card it had carried the name and the artist but no length at all: the length is asked for in the same breath as the song starting, before the player knows it, and nothing ever went back for it.

## 1.9.11 — 2026-10-13

- A song that ends goes straight into the next one, with nothing thrown away in between. At the end of every song the app was emptying the phone's player and fetching the next song from the beginning — that is the moment you described, where it pauses and then sits there with no songs loaded — and it dropped the songs it had already got ready while it did it, which is the prewarming you asked for being spent for nothing. The next song is handed over from what is already loaded on the player now, and the song it replaces is only let go once the new one is playing, so the player is never empty and the lock screen never has to show nothing.
- No more freezing, and no more being closed by the phone, when you skip ahead a few songs quickly. The app was asking the phone's player about the incoming song — how long it is, which track it is — in a way that waits for an answer from your server, and it was asking on the one thread that must never wait for anything. It asks those questions the way that does not wait now, so a fast run of skips can no longer lock the app up.

## 1.9.12 — 2026-10-16

- Download a playlist to your phone and it plays without a connection — the download button shows how much space it will take before you start.
- Songs you have downloaded play from your phone instead of over the network: faster to start, and it uses no data.
- Downloading keeps going while the app is in the background, and a playlist you have downloaded still plays from your phone on the lock screen.
- Playlists you download bring their lyrics with them: the words and the line highlight still work with no connection, and the download size includes them.

## 1.9.13 — 2026-10-15

- Seeking works now: drag the seek bar and the song moves to where you let go. Before, the bar followed your finger and the sound started again from the beginning — the bar and the music were reading two different clocks, and there is one clock now.
- And the bar never claims a move the music did not make: the position you see is the position the player itself reports, so a seek that cannot be performed leaves the bar on where the music really is instead of on where you asked it to go.
