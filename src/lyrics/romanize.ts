/**
 * Kana → romaji, in the browser, with no dictionary and no dependency.
 *
 * What this can and cannot do is the whole point of the module, so it is worth stating
 * plainly: it romanises **kana** (hiragana, katakana, their voiced forms, digraphs, the
 * sokuon and the long-vowel mark). It cannot romanise **kanji**, because a kanji's reading
 * depends on the word it is in and that lives in a dictionary (MeCab/unidic, ~40 MB) —
 * far too heavy for "keep the app light", and not something a browser can guess.
 *
 * So a line that still contains kanji after conversion is reported as `complete: false`
 * rather than silently presented as romaji. The lyrics panel uses that flag for one honest
 * line of small print.
 *
 * In practice the owner's lyrics files are already romaji or English, so this module mostly
 * does nothing — it is the safety net for a kana line that arrives un-transliterated, not
 * the feature.
 *
 * Convention: modified Hepburn, unmarked long vowels ("kyou", not "kyō"), which is what a
 * reader who can't read kana actually wants to type back into a search box.
 */

/** Readings for one kana "unit". Digraphs are included so the matcher can take 2 chars first. */
const READINGS: Record<string, string> = {
  // vowels and small vowels
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゔ: 'vu', ゕ: 'ka', ゖ: 'ke',
  // k / g
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  // s / z
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  // t / d
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  // n
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  ん: 'n',
  // h / b / p
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  // m
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  // y
  や: 'ya', ゆ: 'yu', よ: 'yo', ゃ: 'ya', ゅ: 'yu', ょ: 'yo',
  // r
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  // w
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ゎ: 'wa',
  // digraphs — two kana, one reading
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', きぇ: 'kye',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che',
  ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  // loanword shapes
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', ふゅ: 'fyu',
  てぃ: 'ti', てゅ: 'tyu', でぃ: 'di', でゅ: 'dyu',
  とぅ: 'tu', どぅ: 'du',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo', うゅ: 'yu',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo', ゔゅ: 'vyu',
  つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso',
  すぃ: 'si', ずぃ: 'zi', きぃ: 'kii', ぐぁ: 'gwa',
};

/** Longest key first, so きゃ is never read as き + ゃ. */
const KEYS = Object.keys(READINGS).sort((a, b) => b.length - a.length);

const SOKUON = 'っ';
const LONG_VOWEL = 'ー';
const KANJI = /[\u3005\u3006\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);

/** Katakana → hiragana, so there is exactly one table above. `ー` and `・` are left alone. */
export function katakanaToHiragana(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCodePoint(code - 0x60);
    else if (code === 0x30f7) out += 'ゔぁ';
    else if (code === 0x30f8) out += 'ゔぃ';
    else if (code === 0x30f9) out += 'ゔぇ';
    else if (code === 0x30fa) out += 'ゔぉ';
    else out += char;
  }
  return out;
}

/** True when the text still contains characters that need a dictionary to read. */
export function hasKanji(text: string): boolean {
  return KANJI.test(text);
}

/**
 * Romanise every kana it recognises and leave everything else (kanji, latin, punctuation)
 * exactly where it was.
 */
export function kanaToRomaji(input: string): string {
  const text = katakanaToHiragana(input);
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];

    if (char === SOKUON) {
      // Geminate the next syllable: がっこう → gakkou, っち → tchi (Hepburn).
      const rest = text.slice(index + 1);
      const key = matchReading(rest);
      if (key) {
        const reading = READINGS[key];
        out += reading.startsWith('ch') ? 't' : reading[0];
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === LONG_VOWEL) {
      // Repeat the previous vowel; `コーヒー` → koohii.
      const last = lastVowel(out);
      if (last) out += last;
      index += 1;
      continue;
    }

    const matched = matchReading(text.slice(index));
    if (matched) {
      const reading = READINGS[matched];
      if (matched === 'ん') {
        // n' before a vowel or y, so `ほんやく` does not read as "honyaku".
        const followingKey = matchReading(text.slice(index + 1));
        const followingReading = followingKey ? READINGS[followingKey] : null;
        const needsApostrophe = followingReading !== null && (VOWELS.has(followingReading[0]) || followingReading[0] === 'y');
        out += needsApostrophe ? "n'" : 'n';
      } else {
        out += reading;
      }
      index += matched.length;
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

function matchReading(rest: string): string | null {
  for (const key of KEYS) if (rest.startsWith(key)) return key;
  return null;
}

function lastVowel(text: string): string | null {
  for (let i = text.length - 1; i >= 0; i -= 1) if (VOWELS.has(text[i])) return text[i];
  return null;
}

export interface RomanizedLine {
  text: string;
  /** False when kanji survived, i.e. this line is only partly romaji. */
  complete: boolean;
}

export function romanizeLine(line: string): RomanizedLine {
  const text = kanaToRomaji(line);
  return { text, complete: !hasKanji(text) };
}
