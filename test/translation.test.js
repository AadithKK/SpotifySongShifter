import test from 'node:test';
import assert from 'node:assert/strict';
import { languageForTranslation, translateSongFields } from '../src/translation.js';

test('detects Korean and Chinese text without treating Japanese kana or Latin as Chinese', () => {
  assert.equal(languageForTranslation('바람의 노래'), 'ko');
  assert.equal(languageForTranslation('月光花'), 'zh');
  assert.equal(languageForTranslation('Moon Festival Theme (月光花)'), 'zh');
  assert.equal(languageForTranslation('新しい星'), null);
  assert.equal(languageForTranslation('Midnight Current'), null);
});

test('keeps original song metadata and adds English hints only for fields that need them', async () => {
  const original = { title: '바람의 노래', artist: 'Nova Reed' };
  const calls = [];
  const result = await translateSongFields(original, async (text, language) => {
    calls.push([text, language]);
    return 'Song of the Wind';
  });
  assert.deepEqual(result, { englishTitle: 'Song of the Wind', englishArtist: '' });
  assert.deepEqual(calls, [['바람의 노래', 'ko']]);
  assert.deepEqual(original, { title: '바람의 노래', artist: 'Nova Reed' });
});

test('translates non-Latin title and artist independently', async () => {
  const result = await translateSongFields({ title: '月光花', artist: '星河乐团' }, async text =>
    text === '月光花' ? 'Moonflower' : 'Star River Ensemble');
  assert.deepEqual(result, { englishTitle: 'Moonflower', englishArtist: 'Star River Ensemble' });
});
