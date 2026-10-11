/**
 * The in-app changelog — the same text as `CHANGELOG.md`, in the app so the owner can read
 * it without a browser tab. `test/changelog.test.ts` fails if the two drift apart, so the
 * file and the button can never disagree.
 *
 * House rules for this list (they are the reason it is short): user-visible only, no
 * build/plumbing/refactor entries, and the owner's own words where they say it better than
 * a summary does.
 */

export interface ChangelogRelease {
  version: string;
  date: string;
  /** One plain sentence per visible change. */
  items: string[];
}

export const CHANGELOG: ChangelogRelease[] = [
  {
    version: '1.0',
    date: '2026-10-10',
    items: [
      'Browse your library by artist and album, and play anything in it.',
      'The spectrum is real: it reads the music that is actually playing, not a decoration.',
      'Playlists: play them, make one, add tracks to it, remove tracks from it.',
      'Favourites: star or unstar albums and tracks.',
      'Your password is never stored as text on the server — it goes as a one-way code, and it lives in the phone\'s own keychain.',
      'Three ways to use it: the phone app (Android APK, iPhone sideload) and the web page.',
      'Reaches your library over Tailscale only. Nothing is exposed to the public internet.',
    ],
  },
  {
    version: '1.1',
    date: '2026-10-11',
    items: [
      'No more sideways scrolling: long titles, artist names and addresses now wrap or shorten instead of pushing the page wider than the screen.',
      'Albums, Favourites and Search are gone from the navigation. It is Library, Playlists and the settings gear now — search is still inside Library.',
      'Tap the Navilite logo to jump straight to the spectrum.',
      'Swipe left on the spectrum to get to your playlists.',
      'Open the app and, if a track was playing when you left, it opens on the spectrum for that track.',
      'The spectrum screen reads top to bottom: cover art, the spectrum (under the cover now — nothing covers it), the song name, "Playing from <playlist> (3/12)", and one compact bar at the bottom with play/pause, previous/next, shuffle and repeat.',
      'The spectrum moves sharper. It was dragging behind the music; it now follows every frame, and the two mode notes that used to sit on the screen are gone.',
      'Lyrics: the switch at the top of the spectrum screen flips between Spectrum and Lyrics. The words come from your own library — the lyrics file that sits next to the song — and the line lights up with the music when the file has timings. No timings is normal and reads fine; a track with no lyrics file at all says so instead of spinning.',
      'The track that is playing is highlighted in the playlist.',
      'Settings has a "What\'s new" page — this text.',
      'Leave the server address blank and it uses your library\'s usual address.',
    ],
  },
  {
    version: '1.2',
    date: '2026-10-11',
    items: [
      'The spectrum is the current frame only. The little mark that floated above each bar and the fading copy of where the bar had been are both gone: nothing on the screen is a leftover of the moment before, and the reading itself no longer averages the previous frame in.',
      'Lyrics get the whole screen. The album art steps aside in Lyrics mode and the lines are set tighter, so a verse fits at once instead of one line at a time — on your phone the panel is 452 px tall instead of 89, at 13 px a line (about 26 lines visible).',
      'Measured at your phone\'s exact width this time: 393 px, with your longest Japanese titles and playlist names, on every screen and in both modes. The old check ran at 390 px, which is why it said clean while your phone still scrolled sideways. There is now a test that runs at 393 px and fails if anything on any screen is wider than the screen.',
    ],
  },
  {
    version: '1.3',
    date: '2026-10-11',
    items: [
      'Lyrics now load directly from your library. The app reads the lyrics file that sits next to the song itself, instead of asking the music server what it made of that file — so a lyrics file the server would not have offered you still shows up, with or without timings.',
      'Tracks that came back empty are no longer written off. A track that had no lyrics when you opened it is looked at again a few minutes later, so the lyrics files that are still being added to your library appear on their own — no clearing anything, no reinstalling. The ones you opened before they existed will fill in.',
      'Timed and plain files both read exactly as before: a file with timings still lights the current line up with the music, a plain text file is still the normal, comfortable case, and a track with no lyrics file at all still says "no romaji lyrics for this track yet" instead of waiting.',
      'One safety net behind the other: if the library\'s own lyrics route cannot be reached, the app asks the music server exactly as it did before. You never see an error, and a slow or missing answer never leaves a blank screen spinning.',
    ],
  },
  {
    version: '1.4',
    date: '2026-10-11',
    items: [
      'The now-playing screen no longer scrolls the list behind it. Open a playlist, open the spectrum, scroll: the list underneath does not move at all — in v1.3 a gesture there dragged it 800 px and left it there — and closing brings you back to the same row you were on.',
      'The top bar cannot grow, stretch or scroll away any more. It measures 58 px at the top of the screen and the same 58 px after every scroll, and the page itself no longer scrolls anywhere: v1.3 scrolled the whole page 1,660 px, and now there is 0 px of page to scroll at all.',
      'The app scrolls inside one box of its own now, so the only thing a finger can reach while the now-playing screen is open is that screen: pointing at every part of it lands on the spectrum or the lyrics, never on the list underneath.',
    ],
  },
];
