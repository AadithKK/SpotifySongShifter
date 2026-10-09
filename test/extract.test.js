import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImage, extractCandidates } from '../src/extract.js';

test('finds a chat recommendation while ignoring message chrome', () => {
  const candidates = extractCandidates('8:41\nMaya\nYou should listen to Good Luck, Babe! by Chappell Roan.\nDelivered');

  assert.deepEqual(candidates.map(({ title, artist }) => ({ title, artist })), [
    { title: 'Good Luck, Babe!', artist: 'Chappell Roan' },
  ]);
  assert.match(candidates[0].sourceText, /listen to Good Luck, Babe!/i);
  assert.ok(candidates[0].confidence >= 0.8 && candidates[0].confidence <= 1);
});

test('finds multiple explicitly labeled song and artist pairs', () => {
  const candidates = extractCandidates('Song: Pink + White\nArtist: Frank Ocean\n\nSong: Kill Bill\nArtist: SZA');

  assert.deepEqual(candidates.map(({ title, artist }) => ({ title, artist })), [
    { title: 'Pink + White', artist: 'Frank Ocean' },
    { title: 'Kill Bill', artist: 'SZA' },
  ]);
});

test('does not pair an artist label with the next song when cards are adjacent', () => {
  const candidates = extractCandidates('Song: Pink + White\nArtist: Frank Ocean\nSong: Kill Bill\nArtist: SZA');

  assert.deepEqual(candidates.map(({ title, artist }) => ({ title, artist })), [
    { title: 'Pink + White', artist: 'Frank Ocean' },
    { title: 'Kill Bill', artist: 'SZA' },
  ]);
});

test('finds tracks in saved audio cards ending with Use audio', () => {
  const candidates = extractCandidates('Saved audio\nPink + White\nFrank Ocean\nUse audio\nSave\nKill Bill\nSZA\nUse audio');

  assert.deepEqual(candidates.map(({ title, artist }) => ({ title, artist })), [
    { title: 'Pink + White', artist: 'Frank Ocean' },
    { title: 'Kill Bill', artist: 'SZA' },
  ]);
});

test('finds a music overlay with an explicit music cue', () => {
  const candidates = extractCandidates('♫ Blinding Lights · The Weeknd\nInstagram Reels');

  assert.deepEqual(candidates.map(({ title, artist }) => ({ title, artist })), [
    { title: 'Blinding Lights', artist: 'The Weeknd' },
  ]);
});

test('deduplicates repeated mentions of the same recording', () => {
  const candidates = extractCandidates('Song: Pink + White\nArtist: Frank Ocean\nListen to Pink + White by Frank Ocean');

  assert.equal(candidates.length, 1);
});

test('does not turn incidental messages or generic audio labels into songs', () => {
  const candidates = extractCandidates('8:41\nFollowed by Alex\nSaved audio\nOriginal audio\n12.3K reels\nUse audio\nMessage sent\nPhoto by Jordan');

  assert.deepEqual(candidates, []);
});

test('does not guess a song when a chat mentions a title without an artist', () => {
  assert.deepEqual(extractCandidates('Can you listen to that song I sent yesterday?'), []);
});

test('rejects an empty image before starting OCR', async () => {
  await assert.rejects(analyzeImage(Buffer.alloc(0)), /non-empty image buffer/i);
});
