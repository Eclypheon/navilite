/**
 * MD5 is load-bearing (it is the Subsonic token primitive), so it is checked against
 * the RFC 1321 test vectors *and*, for arbitrary strings, against node:crypto as an
 * independent implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { md5Hex, randomSalt } from '../src/api/md5.ts';

const VECTORS: Array<[string, string]> = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
  ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
];

test('matches the RFC 1321 test vectors', () => {
  for (const [input, expected] of VECTORS) {
    assert.equal(md5Hex(input), expected, `md5(${JSON.stringify(input)})`);
  }
});

test('handles multi-block input and UTF-8', () => {
  for (const length of [55, 56, 63, 64, 65, 119, 120, 121, 1000]) {
    const input = 'x'.repeat(length);
    const expected = createHash('md5').update(input, 'utf8').digest('hex');
    assert.equal(md5Hex(input), expected, `length ${length}`);
  }
  const unicode = 'héllo — 世界 🎵';
  assert.equal(md5Hex(unicode), createHash('md5').update(unicode, 'utf8').digest('hex'));
});

test('agrees with node:crypto on random passwords and salts', () => {
  for (let i = 0; i < 200; i += 1) {
    const password = randomBytes(Math.floor(Math.random() * 24)).toString('base64');
    const salt = randomSalt();
    const expected = createHash('md5').update(password + salt, 'utf8').digest('hex');
    assert.equal(md5Hex(password + salt), expected);
  }
});

test('salts are hex and comfortably above the API minimum length', () => {
  const salt = randomSalt();
  assert.match(salt, /^[0-9a-f]{16}$/);
  assert.ok(salt.length >= 6);
  assert.notEqual(randomSalt(), randomSalt());
});
