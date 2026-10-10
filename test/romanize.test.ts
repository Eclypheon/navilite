/**
 * The kana → romaji converter, including the part it deliberately does not do.
 *
 * The kanji assertions are the important ones: the module must never pretend a line it
 * could not read is romaji, because the UI passes that flag straight to the user.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasKanji, kanaToRomaji, katakanaToHiragana, romanizeLine } from '../src/lyrics/romanize.ts';

test('katakana folds onto hiragana, so there is only one table', () => {
  assert.equal(katakanaToHiragana('コーヒー'), 'こーひー');
  assert.equal(katakanaToHiragana('ヴァイオリン'), 'ゔぁいおりん');
  assert.equal(katakanaToHiragana('ひらがな'), 'ひらがな');
  // The long-vowel mark is not a kana and must survive the fold.
  assert.ok(katakanaToHiragana('ロー').includes('ー'));
});

test('the common kana read the way a person would write them', () => {
  // Particles keep their kana reading: は is "ha" here, not the "wa" a reader would say,
  // because getting that right needs grammar, not a kana table. Documented, not hidden.
  assert.equal(kanaToRomaji('こんにちは'), 'konnichiha');
  assert.equal(kanaToRomaji('ありがとう'), 'arigatou');
  assert.equal(kanaToRomaji('さくら'), 'sakura');
  assert.equal(kanaToRomaji('ふじさん'), 'fujisan');
});

test('digraphs, the sokuon and the long-vowel mark all collapse correctly', () => {
  assert.equal(kanaToRomaji('きょう'), 'kyou');
  assert.equal(kanaToRomaji('しゃしん'), 'shashin');
  assert.equal(kanaToRomaji('がっこう'), 'gakkou');
  assert.equal(kanaToRomaji('ちょっと'), 'chotto');
  assert.equal(kanaToRomaji('コーヒー'), 'koohii');
  assert.equal(kanaToRomaji('ヴァイオリン'), 'vaiorin');
});

test('ん is n before a consonant and n\' before a vowel or y', () => {
  assert.equal(kanaToRomaji('しんぶん'), 'shinbun');
  assert.equal(kanaToRomaji('ほんやく'), "hon'yaku");
  assert.equal(kanaToRomaji('かんい'), "kan'i");
});

test('any っ is doubled, not dropped', () => {
  assert.equal(kanaToRomaji('ロック'), 'rokku');
  assert.equal(kanaToRomaji('まっちゃ'), 'matcha');
});

test('latin text, punctuation and kanji are left exactly where they were', () => {
  assert.equal(kanaToRomaji('ハロー World!'), 'haroo World!');
  assert.equal(kanaToRomaji('「さよなら」'), '「sayonara」');
  // Kanji is not guessed at: it stays put, and only the kana around it converts.
  assert.equal(kanaToRomaji('夜に駆ける'), '夜ni駆keru');
});

test('a line with kanji is reported as incomplete, not as romaji', () => {
  const mixed = romanizeLine('夜に駆ける 君と');
  assert.equal(mixed.text, '夜ni駆keru 君to');
  assert.equal(mixed.complete, false);

  const pure = romanizeLine('きみと');
  assert.equal(pure.text, 'kimito');
  assert.equal(pure.complete, true);

  assert.equal(hasKanji('駆'), true);
  assert.equal(hasKanji('かける'), false);
  assert.equal(hasKanji(''), false);
});
