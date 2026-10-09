export function normalizeSongPart(value = '') {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function languageForTranslation(text = '') {
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return null;
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  return null;
}

function closeSpelling(a, b) {
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 3) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] <= Math.min(3, Math.max(2, Math.floor(Math.min(a.length, b.length) * .2)));
}

export function compareSongs(a, b) {
  const titleA = normalizeSongPart(a.title);
  const titleB = normalizeSongPart(b.title);
  const artistA = normalizeSongPart(a.artist);
  const artistB = normalizeSongPart(b.artist);
  if (!titleA || !titleB || !artistA || !artistB) return 'different';
  const durationConflict = Number.isFinite(a.durationSeconds) && Number.isFinite(b.durationSeconds)
    && Math.abs(a.durationSeconds - b.durationSeconds) > 2;
  if (titleA === titleB && artistA === artistB) return durationConflict ? 'near' : 'duplicate';
  const titleClose = titleA === titleB || closeSpelling(titleA, titleB)
    || ((a.partial || b.partial) && (titleA.startsWith(titleB) || titleB.startsWith(titleA)));
  const artistClose = artistA === artistB || closeSpelling(artistA, artistB)
    || ((a.partial || b.partial) && (artistA.startsWith(artistB) || artistB.startsWith(artistA)));
  return titleClose && artistClose ? 'near' : 'different';
}

export function uniqueSelectedUris(songs) {
  return [...new Set(songs.filter(song => song.includeInPlaylist !== false).flatMap(song => song.selectedUris || []).filter(Boolean))];
}

function matchPart(value = '') {
  return normalizeSongPart(value.normalize('NFD').replace(/\p{M}/gu, ''));
}

/** Only preselect a recording when its visible title, artist, and available duration agree. */
export function bestSpotifyMatch(song, tracks) {
  if (!song?.title || !song?.artist || song.partial || song.needsReview) return null;
  const title = matchPart(song.title);
  const artist = matchPart(song.artist.split(/,|\s+&\s+/u)[0]);
  if (!title || !artist) return null;
  const matches = (tracks || []).filter(track => track?.uri
    && matchPart(track.name || '') === title
    && track.artists?.some(item => matchPart(item.name || '') === artist));
  if (!matches.length) return null;
  if (!Number.isFinite(song.durationSeconds)) return matches[0];
  const byDuration = matches.filter(track => Number.isFinite(track.duration_ms))
    .map(track => ({ track, difference: Math.abs(track.duration_ms / 1000 - song.durationSeconds) }))
    .sort((a, b) => a.difference - b.difference);
  return byDuration[0]?.difference <= 20 ? byDuration[0].track : null;
}

/** Toggle one result without clearing the other recordings chosen from this review card. */
export function toggleSelectedTrack(songs, song, uri) {
  if (!uri || !songs.includes(song)) return;
  if (song.selectedUris.includes(uri)) {
    song.selectedUris = song.selectedUris.filter(selected => selected !== uri);
    return;
  }
  for (const other of songs) {
    if (other !== song) other.selectedUris = other.selectedUris.filter(selected => selected !== uri);
  }
  song.selectedUris.push(uri);
}

export function previewPosition(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.max(0, Math.min(Math.round(durationMs * .45), Math.round(durationMs - 16000)));
}
