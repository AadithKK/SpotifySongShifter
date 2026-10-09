import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLanguageReadings, parseInstagramLines, selectTitleReading } from '../src/instagram.js';
import { bestSpotifyMatch, compareSongs, previewPosition, toggleSelectedTrack, uniqueSelectedUris } from '../public/song-utils.js';

const line = (text, y, confidence = 94) => ({ text, confidence, bbox: { x0: 100, x1: 490, y0: y, y1: y + 20 } });

test('pairs Instagram music rows and leaves interface text out', () => {
  const result = parseInstagramLines([
    line('Search...', 190), line('For you  Trending  Saved  Original audio', 270),
    line('Open Sky', 350), line('Aria Vale · 18K reels · 3:24', 382),
    line('Midnight Current', 430), line('Nova Reed · 1.2K reels · 4:01', 462),
    line('Original audio', 510), line('username · 1 reel · 0:18', 542),
  ], 591, 1280);
  assert.deepEqual(result.candidates.map(({ title, artist, durationSeconds }) => ({ title, artist, durationSeconds })), [
    { title: 'Open Sky', artist: 'Aria Vale', durationSeconds: 204 },
    { title: 'Midnight Current', artist: 'Nova Reed', durationSeconds: 241 },
  ]);
  assert.equal(result.skippedOriginalAudio, 1);
});

test('marks cropped names and keeps non-Latin language reading', () => {
  const english = parseInstagramLines([line('Sora EH', 350, 72), line('Mina Rae · 141 reels · 1:38', 382)], 591, 1280);
  const other = parseInstagramLines([line('Sora ソラ', 350, 88), line('Mina Rae · 141 reels · 1:38', 382)], 591, 1280);
  assert.equal(mergeLanguageReadings(english, other, 1280).candidates[0].title, 'Sora ソラ');
  const truncated = parseInstagramLines([line('When The Lanterns Rise (...', 350), line('Luma Vale · 145 reels · 3:19', 382)], 591, 1280);
  assert.equal(truncated.candidates[0].needsReview, true);
});

test('keeps a clipped metadata row for review without inventing interface songs', () => {
  const result = parseInstagramLines([
    line('Link Spotify', 330), line('Link your account to share the music', 350),
    line('Silver Harbour', 680), line('↗ City Strings · 58K...', 712),
    line('Afterglow', 764), line('Calo · 2.4K reels · 1:35', 796),
  ], 591, 1280);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].title, 'Silver Harbour');
  assert.equal(result.candidates[0].needsReview, true);
  assert.equal(result.anchors, 1);
});

test('flags an artist initial that OCR may confuse with a capital I', () => {
  const result = parseInstagramLines([
    line('Sea Glass', 350), line('lune6teen · 885 reels · 2:18', 382),
  ], 591, 1280);
  assert.equal(result.candidates[0].needsReview, true);
});

test('collapses exact copies but leaves remixes and conflicting durations separate', () => {
  const openSky = { title: 'Open Sky', artist: 'Aria Valé', durationSeconds: 204 };
  assert.equal(compareSongs(openSky, { title: 'OPEN SKY', artist: 'Aria Valé', durationSeconds: 204 }), 'duplicate');
  assert.equal(compareSongs(openSky, { title: 'Open Sky (Remix)', artist: 'Aria Valé', durationSeconds: 204 }), 'different');
  assert.equal(compareSongs(openSky, { ...openSky, durationSeconds: 220 }), 'near');
  assert.equal(compareSongs({ title: 'RIVANCÔ', artist: 'MELLIN' }, { title: 'RIVANGO', artist: 'MELLIN' }), 'near');
  assert.equal(compareSongs({ title: 'Midnight Current', artist: 'Nova Reed' }, { title: 'midnight current', artist: 'NOVA REED' }), 'duplicate');
  assert.deepEqual(uniqueSelectedUris([{ selectedUris: ['spotify:track:abc', 'spotify:track:def'] }, { selectedUris: ['spotify:track:abc'] }]), ['spotify:track:abc', 'spotify:track:def']);
});

test('chooses several recordings per review card and toggles each independently', () => {
  const first = { selectedUris: [] };
  const second = { selectedUris: [] };
  const songs = [first, second];
  toggleSelectedTrack(songs, first, 'spotify:track:one');
  toggleSelectedTrack(songs, first, 'spotify:track:two');
  toggleSelectedTrack(songs, second, 'spotify:track:three');
  assert.deepEqual(first.selectedUris, ['spotify:track:one', 'spotify:track:two']);
  assert.deepEqual(uniqueSelectedUris(songs), ['spotify:track:one', 'spotify:track:two', 'spotify:track:three']);

  toggleSelectedTrack(songs, first, 'spotify:track:one');
  assert.deepEqual(first.selectedUris, ['spotify:track:two']);
  assert.deepEqual(uniqueSelectedUris(songs), ['spotify:track:two', 'spotify:track:three']);

  toggleSelectedTrack(songs, second, 'spotify:track:two');
  assert.deepEqual(first.selectedUris, []);
  assert.deepEqual(second.selectedUris, ['spotify:track:three', 'spotify:track:two']);
  assert.deepEqual(uniqueSelectedUris(songs), ['spotify:track:three', 'spotify:track:two']);
});

test('automatic Spotify choice requires a matching title and artist and prefers the matching duration', () => {
  const tracks = [
    { uri: 'spotify:track:wrong-version', name: 'Lanterns (Radio Edit)', artists: [{ name: 'Pulse Avenue' }], duration_ms: 152000 },
    { uri: 'spotify:track:long', name: 'Lanterns (Club Mix)', artists: [{ name: 'Pulse Avenue' }], duration_ms: 240000 },
    { uri: 'spotify:track:right', name: 'Lanterns (Club Mix)', artists: [{ name: 'Pulse Avenue' }], duration_ms: 152000 },
  ];
  assert.equal(bestSpotifyMatch({ title: 'Lanterns (Club Mix)', artist: 'Pulse Avenue', durationSeconds: 152 }, tracks)?.uri, 'spotify:track:right');
  assert.equal(bestSpotifyMatch({ title: 'Lanterns (Club Mix)', artist: 'Pulse Avenue', durationSeconds: 152 }, tracks.slice(0, 1)), null);
  assert.equal(bestSpotifyMatch({ title: 'Lanterns (Club Mix)', artist: 'Other Artist' }, tracks), null);
  assert.equal(bestSpotifyMatch({ title: 'Lanterns (Club Mix)', artist: 'Pulse Avenue', durationSeconds: 200 }, tracks), null);
});

test('automatic choice tolerates accent differences but leaves clipped names for review', () => {
  const tracks = [{ uri: 'spotify:track:open-sky', name: 'Open Sky', artists: [{ name: 'Aria Valé' }], duration_ms: 203000 }];
  assert.equal(bestSpotifyMatch({ title: 'Open Sky', artist: 'Aria Vale', durationSeconds: 204 }, tracks)?.uri, 'spotify:track:open-sky');
  assert.equal(bestSpotifyMatch({ title: 'Open Sk...', artist: 'Aria Valé', partial: true }, tracks), null);
  assert.equal(bestSpotifyMatch({ title: 'Open Sky', artist: 'Aria Valé', needsReview: true }, tracks), null);
});

test('excluding a matched card preserves its choice but removes it from playlist count', () => {
  const songs = [
    { selectedUris: ['spotify:track:one'], includeInPlaylist: false },
    { selectedUris: ['spotify:track:two'], includeInPlaylist: true },
  ];
  assert.deepEqual(uniqueSelectedUris(songs), ['spotify:track:two']);
  assert.deepEqual(songs[0].selectedUris, ['spotify:track:one']);
  songs[0].includeInPlaylist = true;
  assert.deepEqual(uniqueSelectedUris(songs), ['spotify:track:one', 'spotify:track:two']);
});

test('previews start inside the recording and leave room for a short ending', () => {
  assert.equal(previewPosition(200000), 90000);
  assert.equal(previewPosition(30000), 13500);
  assert.equal(previewPosition(10000), 0);
  assert.equal(previewPosition(undefined), 0);
});

test('focused title readings fix spacing without erasing accents or accepting weak guesses', () => {
  assert.equal(selectTitleReading('STARLIGHT', { text: 'STAR LIGHT', confidence: 95 }, 'english').title, 'STAR LIGHT');
  assert.equal(selectTitleReading('42Intro', { text: '42 Intro', confidence: 94 }, 'english').title, '42 Intro');
  assert.equal(selectTitleReading('42Intro', { text: '42 Intro', confidence: 83 }, 'english').title, '42 Intro');
  assert.equal(selectTitleReading('Crystal Nights Il', { text: 'Crystal Nights II', confidence: 88 }, 'english').title, 'Crystal Nights II');
  assert.equal(selectTitleReading('élégance', { text: 'elegance', confidence: 95 }, 'english').title, 'élégance');
  assert.equal(selectTitleReading('Sora EH', { text: 'Sora EY', confidence: 84 }, 'english').title, 'Sora EH');
  assert.equal(selectTitleReading('RIVANGO', { text: ':7.YW. Too]', confidence: 5 }, 'english').title, 'RIVANGO');
});

test('language readings restore script and accents while keeping uncertain rows in review', () => {
  assert.deepEqual(selectTitleReading('thd fs', { text: '바람의 노래', confidence: 94 }, 'kor'), { title: '바람의 노래', changed: true, uncertain: true });
  assert.equal(selectTitleReading('Sora EH', { text: 'Sora ソラ', confidence: 95 }, 'jpn').title, 'Sora ソラ');
  assert.equal(selectTitleReading('STAR LIGHT', { text: 'قسم أغنية', confidence: 61 }, 'ara').title, 'STAR LIGHT');
  assert.equal(selectTitleReading('Elégance', { text: 'Élégance', confidence: 95 }, 'accent').title, 'Élégance');
  assert.equal(selectTitleReading('RIVANGO', { text: 'RIVANÇÔ', confidence: 91 }, 'accent').title, 'RIVANGO');
  assert.equal(selectTitleReading('Moon Festival Theme (EE kif)', {
    text: 'Moon Festival Theme ( 月 光 花 )', confidence: 80,
  }, 'chi_tra').title, 'Moon Festival Theme ( 月 光 花 )');
});
