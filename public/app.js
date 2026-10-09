import { bestSpotifyMatch, compareSongs, languageForTranslation, previewPosition, toggleSelectedTrack, uniqueSelectedUris } from './song-utils.js';

const $ = (id) => document.getElementById(id);
const state = { files: [], songs: [], connected: false, canPreview: false, configured: false, playlists: [], skippedOriginalAudio: 0, duplicateCount: 0 };
let noticeTimer;
const busyContents = new WeakMap();
let nextSongId = 0;
const preview = { player: null, deviceId: '', uri: '', timer: null, pending: false };
let sdkPromise;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

function notify(message, isError = false) {
  const notice = $('notice');
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, isError ? 8000 : 5000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  if (busy) {
    busyContents.set(button, [...button.childNodes]);
    button.replaceChildren(document.createTextNode(label));
  } else if (busyContents.has(button)) {
    button.replaceChildren(...busyContents.get(button));
    busyContents.delete(button);
  }
}

function updateTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('themeSelect').value = theme;
  try { localStorage.setItem('music-inbox-theme', theme); } catch (_) { /* Private mode may block storage. */ }
}

function renderStatus(user) {
  const status = $('connectionStatus');
  status.classList.toggle('connected', state.connected);
  status.lastChild.textContent = state.connected
    ? ` Connected${user?.display_name ? ` as ${user.display_name}` : ''}`
    : state.configured ? ' Spotify not connected' : ' Spotify setup needed';
  $('connectPrompt').hidden = state.connected;
  $('playlistControls').hidden = !state.connected;
  $('connectButton').textContent = state.configured ? 'Connect Spotify' : 'Set up Spotify';
  $('reconnectButton').hidden = !state.configured;
  $('disconnectButton').hidden = !state.connected;
}

async function loadStatus() {
  try {
    const result = await api('/api/status');
    state.configured = result.configured;
    state.connected = result.connected;
    state.canPreview = result.canPreview;
    renderStatus(result.user);
    if ($('callbackUrl')) $('callbackUrl').textContent = result.callbackUrl;
    if (state.connected) await loadPlaylists();
  } catch (error) {
    notify(`Could not reach the server: ${error.message}`, true);
  }
}

function updatePreviewButtons() {
  document.querySelectorAll('.preview-button').forEach(button => {
    const playing = button.dataset.previewUri === preview.uri;
    button.setAttribute('aria-pressed', String(playing));
    button.replaceChildren(icon(playing ? 'pause' : 'play'));
    button.setAttribute('aria-label', `${playing ? 'Pause' : 'Play a middle section of'} ${button.dataset.previewName}`);
    button.title = playing ? 'Pause preview' : 'Play about 15 seconds from the middle';
  });
}

function clearPreview() {
  clearTimeout(preview.timer);
  preview.timer = null;
  preview.uri = '';
  updatePreviewButtons();
}

function loadSpotifySdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.onerror = () => reject(new Error('Spotify player could not load. Check your browser or content blocker.'));
      window.onSpotifyWebPlaybackSDKReady = resolve;
      document.head.append(script);
    }).catch(error => { sdkPromise = null; throw error; });
  }
  return sdkPromise;
}

async function readyPreviewPlayer() {
  if (preview.player && preview.deviceId) return preview.player;
  await loadSpotifySdk();
  if (!preview.player) {
    preview.player = new window.Spotify.Player({
      name: 'Music Inbox preview',
      getOAuthToken: callback => api('/api/playback/token')
        .then(result => callback(result.accessToken))
        .catch(error => notify(error.message, true)),
      volume: .5,
    });
    preview.player.addListener('ready', ({ device_id: deviceId }) => { preview.deviceId = deviceId; });
    preview.player.addListener('not_ready', () => { preview.deviceId = ''; clearPreview(); });
    for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
      preview.player.addListener(event, ({ message }) => { clearPreview(); notify(`Spotify preview: ${message}`, true); });
    }
  }
  if (!preview.deviceId) {
    let timeout;
    const ready = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Spotify player did not become ready. Try again.')), 12000);
      preview.player.addListener('ready', ({ device_id: deviceId }) => { clearTimeout(timeout); resolve(deviceId); });
    });
    try {
      const connected = await preview.player.connect();
      if (!connected) throw new Error('Spotify could not connect the browser player.');
      preview.deviceId = await ready;
    } catch (error) {
      clearTimeout(timeout);
      ready.catch(() => {});
      throw error;
    }
  }
  return preview.player;
}

async function togglePreview(track) {
  if (preview.pending) return;
  if (!state.connected) { notify('Connect Spotify to play a preview.', true); return; }
  if (!state.canPreview) { notify('Reconnect Spotify in settings to enable previews.', true); $('settingsDialog').showModal(); return; }
  if (!Number.isFinite(track.duration_ms) || track.duration_ms <= 16000) {
    notify('A middle preview is unavailable for this recording.', true);
    return;
  }
  preview.pending = true;
  try {
    if (preview.uri === track.uri) {
      clearPreview();
      await preview.player.pause();
      return;
    }
    const player = await readyPreviewPlayer();
    await player.activateElement();
    clearPreview();
    await api('/api/playback/start', { method: 'POST', body: JSON.stringify({
      deviceId: preview.deviceId, uri: track.uri, positionMs: previewPosition(track.duration_ms),
    }) });
    preview.uri = track.uri;
    updatePreviewButtons();
    preview.timer = setTimeout(async () => {
      const uri = preview.uri;
      try {
        const current = await player.getCurrentState();
        if (preview.uri === uri && current?.track_window?.current_track?.uri === uri) await player.pause();
      } catch (_) { /* The browser player may already be gone. */ }
      if (preview.uri === uri) clearPreview();
    }, 15000);
  } catch (error) {
    clearPreview();
    notify(`Could not play preview: ${error.message}`, true);
  } finally {
    preview.pending = false;
  }
}

function addFiles(files) {
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']);
  for (const file of files) {
    if (state.files.length >= 25) { notify('Choose up to 25 screenshots at a time.', true); break; }
    if (!allowed.has(file.type)) { notify(`${file.name}: use PNG, JPG, or WebP.`, true); continue; }
    if (file.size > 8 * 1024 * 1024) { notify(`${file.name}: each screenshot must be under 8 MB.`, true); continue; }
    if (state.files.some(entry => entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified)) continue;
    state.files.push({ file, url: URL.createObjectURL(file), processed: false });
  }
  renderFiles();
}

function renderFiles() {
  const list = $('fileList');
  list.replaceChildren();
  $('fileArea').hidden = state.files.length === 0;
  $('fileCount').textContent = `${state.files.length} screenshot${state.files.length === 1 ? '' : 's'} · ${state.files.filter(entry => entry.processed).length} read`;
  state.files.forEach((entry, index) => {
    const row = element('div', 'file-item');
    const image = element('img', 'file-thumb');
    image.src = entry.url;
    image.alt = '';
    const name = element('span', 'file-name', `${entry.file.name}${entry.processed ? ' · read' : ''}`);
    name.title = entry.file.name;
    const remove = element('button', 'file-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${entry.file.name}`);
    remove.append(icon('close'));
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(entry.url);
      state.files.splice(index, 1);
      renderFiles();
    });
    row.append(image, name, remove);
    list.append(row);
  });
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function makeSong(candidate = {}, source = {}) {
  return {
    id: String(++nextSongId),
    title: candidate.title || '',
    artist: candidate.artist || '',
    confidence: candidate.confidence || 0,
    sourceText: candidate.sourceText || source.text || '',
    sourceName: source.name || 'Added by you',
    sourceUrl: source.url || '',
    cropUrl: source.cropUrl || '',
    durationSeconds: candidate.durationSeconds,
    partial: Boolean(candidate.partial),
    needsReview: Boolean(candidate.needsReview),
    sourceCount: 1,
    nearDuplicate: false,
    tracks: [],
    selectedUris: [],
    includeInPlaylist: true,
    showAlternatives: false,
    searchState: '',
    searchRequestId: 0,
    englishTitle: '',
    englishArtist: '',
    translationState: '',
    translationRequestId: 0,
    translationTimer: null,
  };
}

function cropSource(url, region) {
  if (!url || !region) return Promise.resolve('');
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = region.width;
      canvas.height = region.height;
      canvas.getContext('2d').drawImage(image, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
      resolve(canvas.toDataURL('image/jpeg', .82));
    };
    image.onerror = () => resolve('');
    image.src = url;
  });
}

function addCandidate(candidate, source) {
  for (const existing of state.songs) {
    const relationship = compareSongs(existing, candidate);
    if (relationship === 'duplicate') {
      existing.sourceCount += 1;
      existing.needsReview ||= candidate.needsReview;
      state.duplicateCount += 1;
      return false;
    }
    if (relationship === 'near') existing.nearDuplicate = true;
  }
  const song = makeSong(candidate, source);
  song.nearDuplicate = state.songs.some(existing => compareSongs(existing, song) === 'near');
  state.songs.push(song);
  return true;
}

async function analyzeFiles() {
  const pending = state.files.filter(entry => !entry.processed);
  if (!pending.length) { notify('All queued screenshots have been read. Add more to continue.'); return; }
  const button = $('analyzeButton');
  setBusy(button, true, `Reading 0 of ${pending.length}…`);
  let count = 0;
  let errors = 0;
  const importedSongs = [];
  try {
    for (let offset = 0; offset < pending.length; offset += 5) {
      const group = pending.slice(offset, offset + 5);
      button.textContent = `Reading ${offset + 1}–${offset + group.length} of ${pending.length}…`;
      const images = await Promise.all(group.map(async ({ file }) => ({
        name: file.name, mimeType: file.type, dataBase64: await readDataUrl(file),
      })));
      const { results } = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ images }) });
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const entry = group[index];
        if (result.error) { errors += 1; notify(`${result.name}: ${result.error}`, true); continue; }
        entry.processed = true;
        state.skippedOriginalAudio += result.skippedOriginalAudio || 0;
        if (result.candidates?.length) {
          for (const candidate of result.candidates) {
            const cropUrl = await cropSource(entry.url, candidate.region);
            if (addCandidate(candidate, { name: result.name, text: result.text, url: entry.url, cropUrl })) {
              count += 1;
              importedSongs.push(state.songs.at(-1));
            }
          }
        } else if (result.format !== 'instagram') {
          state.songs.push(makeSong({}, { name: result.name, text: result.text, url: entry.url }));
        }
      }
      renderFiles();
      renderReview();
      renderSelection();
      $('importProgress').textContent = `${Math.min(offset + group.length, pending.length)} of ${pending.length} screenshots read · ${state.songs.length} review cards`;
    }
    notify(`${count} new song${count === 1 ? '' : 's'} for review · ${state.duplicateCount} repeat${state.duplicateCount === 1 ? '' : 's'} combined · ${state.skippedOriginalAudio} Original audio skipped${errors ? ` · ${errors} failed` : ''}.`);
    $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    notify(`A group could not be read: ${error.message}. Completed groups are saved here; press Find songs to retry the rest.`, true);
  } finally {
    if (importedSongs.length) void translateSongs(importedSongs);
    if (state.connected && importedSongs.length) await autoSearchSongs(importedSongs, button);
    setBusy(button, false);
  }
}

function field(labelText, value, onInput, placeholder) {
  const label = element('label', '', labelText);
  const input = element('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = 120;
  input.addEventListener('input', () => onInput(input.value));
  label.append(input);
  return label;
}

function trackRow(song, track) {
  const selected = song.selectedUris.includes(track.uri);
  const row = element('div', `track-item${selected ? ' selected' : ''}`);
  row.dataset.songId = song.id;
  row.dataset.trackUri = track.uri || '';
  const coverUrl = track.album?.images?.at(-1)?.url || track.album?.images?.[0]?.url;
  if (coverUrl) {
    const art = element('img', 'track-art');
    art.src = coverUrl;
    art.alt = '';
    art.loading = 'lazy';
    row.append(art);
  } else {
    const art = element('span', 'track-art');
    art.append(icon('music'));
    row.append(art);
  }
  const play = element('button', 'preview-button');
  play.type = 'button';
  play.dataset.previewUri = track.uri || '';
  play.dataset.previewName = `${track.name || 'track'} by ${track.artists?.map(artist => artist.name).join(', ') || 'unknown artist'}`;
  play.setAttribute('aria-pressed', String(preview.uri === track.uri));
  play.setAttribute('aria-label', `${preview.uri === track.uri ? 'Pause' : 'Play a middle section of'} ${play.dataset.previewName}`);
  play.title = preview.uri === track.uri ? 'Pause preview' : 'Play about 15 seconds from the middle';
  play.append(icon(preview.uri === track.uri ? 'pause' : 'play'));
  play.addEventListener('click', () => togglePreview(track));
  row.append(play);
  const copy = element('div', 'track-copy');
  copy.append(element('strong', '', track.name || 'Untitled'), element('span', '', track.artists?.map(artist => artist.name).join(', ') || 'Unknown artist'));
  const choose = element('button', 'match-choice', selected ? 'Selected' : 'Choose');
  choose.type = 'button';
  choose.dataset.trackName = `${track.name} by ${track.artists?.map(artist => artist.name).join(', ') || 'unknown artist'}`;
  choose.setAttribute('aria-pressed', String(selected));
  choose.setAttribute('aria-label', `${selected ? 'Remove' : 'Choose'} ${choose.dataset.trackName}${selected ? ' from selection' : ''}`);
  choose.title = selected ? 'Remove from selection' : 'Add to selection';
  choose.addEventListener('click', () => {
    const previousOwners = state.songs.filter(other => other !== song && other.selectedUris.includes(track.uri));
    toggleSelectedTrack(state.songs, song, track.uri);
    updateChoiceButtons();
    renderSelection();
    previousOwners.forEach(refreshSongSearch);
    if (!song.showAlternatives) renderMatches(song, row.closest('.match-region'));
  });
  row.append(copy);
  if (track.external_urls?.spotify) {
    const spotifyLink = element('a', 'track-link', 'Spotify');
    spotifyLink.href = track.external_urls.spotify;
    spotifyLink.target = '_blank';
    spotifyLink.rel = 'noopener noreferrer';
    spotifyLink.setAttribute('aria-label', `Open ${track.name} on Spotify`);
    row.append(spotifyLink);
  }
  row.append(choose);
  return row;
}

function updateChoiceButtons() {
  document.querySelectorAll('.match-choice').forEach(button => {
    const row = button.closest('.track-item');
    const song = state.songs.find(item => item.id === row.dataset.songId);
    const selected = Boolean(song?.selectedUris.includes(row.dataset.trackUri));
    row.classList.toggle('selected', selected);
    button.textContent = selected ? 'Selected' : 'Choose';
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `${selected ? 'Remove' : 'Choose'} ${button.dataset.trackName}${selected ? ' from selection' : ''}`);
    button.title = selected ? 'Remove from selection' : 'Add to selection';
  });
}

function renderMatches(song, container) {
  if (!container) return;
  container.replaceChildren();
  if (song.searchState === 'loading') {
    container.append(element('div', 'match-message', 'Searching Spotify…'));
  } else if (song.searchState === 'error') {
    container.append(element('div', 'match-message error', 'Search failed. Check your connection and try again.'));
  } else if (song.searchState === 'done') {
    if (!song.tracks.length) {
      container.append(element('div', 'match-message', 'No match found. Try editing the title or artist and search again.'));
    } else {
      const selected = song.tracks.filter(track => song.selectedUris.includes(track.uri));
      if (!song.showAlternatives) {
        container.append(element('p', 'match-heading', selected.length ? 'Selected Spotify recording · check before adding' : 'No clear automatic match · review the options'));
      } else {
        container.append(element('p', 'match-heading', 'Choose one or more recordings'));
      }
      const list = element('div', 'track-list');
      (song.showAlternatives ? song.tracks : selected).forEach(track => list.append(trackRow(song, track)));
      container.append(list);
      const alternatives = element('button', 'subtle-button alternative-button', song.showAlternatives ? 'Hide other options' : 'Choose different song');
      alternatives.type = 'button';
      alternatives.setAttribute('aria-expanded', String(song.showAlternatives));
      alternatives.addEventListener('click', () => {
        song.showAlternatives = !song.showAlternatives;
        renderMatches(song, container);
      });
      container.append(alternatives);
    }
  }
}

function refreshSongSearch(song) {
  const card = [...$('reviewList').children].find(item => item.dataset.songId === song.id);
  if (!card) return;
  const button = card.querySelector('.song-search');
  button.disabled = song.searchState === 'loading';
  button.textContent = song.searchState === 'loading' ? 'Searching Spotify…'
    : song.searchState === 'done' ? 'Search Spotify again' : 'Find Spotify match';
  renderMatches(song, card.querySelector('.match-region'));
}

async function searchSong(song, automatic = false) {
  const query = [song.title.trim(), song.artist.trim()].filter(Boolean).join(' ');
  if (!query) { if (!automatic) notify('Enter a song title or artist first.', true); return false; }
  if (!state.connected) { if (!automatic) notify('Connect Spotify to search for songs.', true); return false; }
  const requestId = ++song.searchRequestId;
  song.searchState = 'loading';
  if (!automatic) song.showAlternatives = true;
  refreshSongSearch(song);
  try {
    const result = await api('/api/search', { method: 'POST', body: JSON.stringify({ query }) });
    if (song.searchRequestId !== requestId || !state.songs.includes(song)) return false;
    song.tracks = result.tracks || [];
    song.searchState = 'done';
    if (automatic && !song.selectedUris.length) {
      const match = bestSpotifyMatch(song, song.tracks);
      if (match) {
        const previousOwners = state.songs.filter(other => other !== song && other.selectedUris.includes(match.uri));
        toggleSelectedTrack(state.songs, song, match.uri);
        previousOwners.forEach(refreshSongSearch);
      }
    }
  } catch (error) {
    if (song.searchRequestId !== requestId || !state.songs.includes(song)) return false;
    song.searchState = 'error';
    if (!automatic) notify(error.message, true);
  }
  refreshSongSearch(song);
  renderSelection();
  return song.selectedUris.length > 0;
}

async function autoSearchSongs(songs, button) {
  const searchable = songs.filter(song => song.title.trim() && song.artist.trim());
  if (!searchable.length) return;
  let next = 0;
  let completed = 0;
  const worker = async () => {
    while (next < searchable.length) {
      const song = searchable[next++];
      await searchSong(song, true);
      completed += 1;
      const message = `Matching ${completed} of ${searchable.length} songs on Spotify…`;
      button.textContent = message;
      $('importProgress').textContent = message;
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, searchable.length) }, worker));
  const selected = searchable.filter(song => song.selectedUris.length).length;
  $('importProgress').textContent = `${searchable.length} songs searched · ${selected} songs with Spotify selections · review before adding`;
}

function renderTranslation(song, container) {
  const needed = languageForTranslation(song.title) || languageForTranslation(song.artist);
  container.hidden = !needed;
  container.replaceChildren();
  if (!needed) return;
  if (song.translationState === 'loading') {
    container.append(element('span', '', 'Getting an English meaning locally…'));
  } else if (song.translationState === 'error') {
    container.append(element('span', '', 'English meaning unavailable. The original name is still used for Spotify.'));
    const retry = element('button', 'text-button', 'Try translation again');
    retry.type = 'button';
    retry.addEventListener('click', () => { void translateSongs([song]); });
    container.append(retry);
  } else if (song.translationState === 'done') {
    if (song.englishTitle && song.englishTitle !== song.title) {
      container.append(element('span', '', `English title: ${song.englishTitle}`));
    }
    if (song.englishArtist && song.englishArtist !== song.artist) {
      container.append(element('span', '', `English artist: ${song.englishArtist}`));
    }
    if (!container.childNodes.length) container.append(element('span', '', 'No clear English meaning. Check the original text.'));
  }
}

function refreshSongTranslation(song) {
  const card = [...$('reviewList').children].find(item => item.dataset.songId === song.id);
  if (card) renderTranslation(song, card.querySelector('.translation-hint'));
}

async function translateSongs(songs) {
  const needed = songs.filter(song => languageForTranslation(song.title) || languageForTranslation(song.artist));
  for (let offset = 0; offset < needed.length; offset += 25) {
    const batch = needed.slice(offset, offset + 25).map(song => {
      clearTimeout(song.translationTimer);
      song.translationState = 'loading';
      const requestId = ++song.translationRequestId;
      refreshSongTranslation(song);
      return { song, requestId, title: song.title, artist: song.artist };
    });
    try {
      const { translations } = await api('/api/translate', {
        method: 'POST',
        body: JSON.stringify({ items: batch.map(({ song, title, artist }) => ({ id: song.id, title, artist })) }),
      });
      const byId = new Map((translations || []).map(item => [item.id, item]));
      for (const item of batch) {
        const { song, requestId, title, artist } = item;
        if (!state.songs.includes(song) || song.translationRequestId !== requestId || song.title !== title || song.artist !== artist) continue;
        const result = byId.get(song.id);
        song.englishTitle = result?.englishTitle || '';
        song.englishArtist = result?.englishArtist || '';
        song.translationState = result && !result.error ? 'done' : 'error';
        refreshSongTranslation(song);
      }
    } catch {
      for (const { song, requestId } of batch) {
        if (!state.songs.includes(song) || song.translationRequestId !== requestId) continue;
        song.translationState = 'error';
        refreshSongTranslation(song);
      }
    }
  }
}

function scheduleTranslation(song) {
  clearTimeout(song.translationTimer);
  if (languageForTranslation(song.title) || languageForTranslation(song.artist)) {
    song.translationTimer = setTimeout(() => { void translateSongs([song]); }, 650);
  }
}

function renderReview() {
  const list = $('reviewList');
  list.replaceChildren();
  $('reviewEmpty').hidden = state.songs.length > 0;
  state.songs.forEach(song => {
    const card = element('article', 'song-card glass-panel');
    card.dataset.songId = song.id;
    const top = element('div', 'song-card-top');
    const thumb = element('span', 'source-thumb');
    if (song.sourceUrl) {
      const image = element('img');
      image.src = song.cropUrl || song.sourceUrl;
      image.alt = '';
      thumb.append(image);
    } else thumb.append(icon('music'));
    const meta = element('div', 'source-meta');
    meta.append(element('span', 'source-label', song.sourceUrl ? 'From screenshot' : 'Added by you'), element('strong', '', `${song.sourceName}${song.sourceCount > 1 ? ` · ${song.sourceCount} copies` : ''}`));
    const remove = element('button', 'song-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${song.title || 'song'}`);
    remove.append(icon('close'));
    remove.addEventListener('click', () => {
      clearTimeout(song.translationTimer);
      state.songs = state.songs.filter(item => item.id !== song.id);
      renderReview();
      renderSelection();
    });
    top.append(thumb, meta, remove);
    const fields = element('div', 'song-fields');
    const clearMatch = () => {
      song.searchRequestId += 1;
      song.selectedUris = [];
      song.tracks = [];
      song.searchState = '';
      song.showAlternatives = false;
      song.translationRequestId += 1;
      song.englishTitle = '';
      song.englishArtist = '';
      song.translationState = '';
      refreshSongSearch(song);
      refreshSongTranslation(song);
      renderSelection();
    };
    fields.append(
      field('Song title', song.title, value => { song.title = value; clearMatch(); scheduleTranslation(song); }, 'Song title'),
      field('Artist', song.artist, value => { song.artist = value; clearMatch(); scheduleTranslation(song); }, 'Artist name'),
    );
    const translation = element('div', 'translation-hint');
    renderTranslation(song, translation);
    const actions = element('div', 'song-card-actions');
    const confidence = element('span', `confidence${song.confidence >= .85 ? ' high' : song.confidence && song.confidence < .7 ? ' low' : ''}`,
      song.nearDuplicate ? 'Similar entry nearby · compare versions' : song.needsReview ? 'Cut off or unclear · check the source row' : song.confidence ? 'Possible song found · check details' : 'Add the song details');
    const search = element('button', 'subtle-button song-search', song.searchState === 'loading' ? 'Searching Spotify…'
      : song.searchState === 'done' ? 'Search Spotify again' : 'Find Spotify match');
    search.type = 'button';
    search.disabled = song.searchState === 'loading';
    search.addEventListener('click', () => searchSong(song));
    actions.append(confidence, search);
    const includeLabel = element('label', 'include-song');
    const include = element('input');
    include.type = 'checkbox';
    include.checked = song.includeInPlaylist;
    include.setAttribute('aria-label', `Add ${song.title || 'this song'} to playlist`);
    include.addEventListener('change', () => {
      song.includeInPlaylist = include.checked;
      renderSelection();
    });
    includeLabel.append(include, element('span', '', 'Add to playlist'));
    const matches = element('div', 'match-region');
    renderMatches(song, matches);
    card.append(top, fields, translation, actions, includeLabel, matches);
    if (song.sourceText) {
      const details = element('details', 'detected-text');
      details.append(element('summary', '', 'View detected text'), element('p', '', song.sourceText));
      card.append(details);
    }
    list.append(card);
  });
}

function renderSelection() {
  const selected = uniqueSelectedUris(state.songs);
  $('selectedCount').textContent = `${selected.length} song${selected.length === 1 ? '' : 's'} selected`;
  $('selectedHint').textContent = selected.length ? 'Ready to add after you choose a playlist.' : 'Choose Spotify matches in Review.';
  $('addToPlaylistButton').disabled = !selected.length || !$('playlistSelect').value;
}

async function loadPlaylists() {
  try {
    const { playlists } = await api('/api/playlists');
    state.playlists = (playlists || []).filter(playlist => playlist?.id && playlist?.name);
    const select = $('playlistSelect');
    const previous = select.value;
    select.replaceChildren(new Option('Choose a playlist', ''));
    state.playlists.forEach(playlist => select.add(new Option(playlist.name, playlist.id)));
    if (state.playlists.some(playlist => playlist.id === previous)) select.value = previous;
    renderSelection();
  } catch (error) {
    notify(`Could not load playlists: ${error.message}`, true);
  }
}

async function createNewPlaylist(event) {
  event.preventDefault();
  const input = $('newPlaylistName');
  const name = input.value.trim();
  if (!name) return;
  const button = $('createPlaylistForm').querySelector('button');
  button.disabled = true;
  try {
    const { playlist } = await api('/api/playlists', { method: 'POST', body: JSON.stringify({ name }) });
    state.playlists.unshift(playlist);
    const option = new Option(playlist.name, playlist.id);
    $('playlistSelect').add(option, 1);
    $('playlistSelect').value = playlist.id;
    input.value = '';
    renderSelection();
    notify(`Created “${playlist.name}”.`);
  } catch (error) {
    notify(`Could not create playlist: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

async function addToPlaylist() {
  const uris = uniqueSelectedUris(state.songs);
  const playlistId = $('playlistSelect').value;
  if (!uris.length || !playlistId) return;
  const button = $('addToPlaylistButton');
  setBusy(button, true, 'Adding songs…');
  let added = 0;
  let skipped = 0;
  try {
    for (let offset = 0; offset < uris.length; offset += 100) {
      const result = await api('/api/playlist/add', {
        method: 'POST', body: JSON.stringify({ playlistId, uris: uris.slice(offset, offset + 100) }),
      });
      added += result.added;
      skipped += result.skipped;
    }
    notify(`${added} added to your playlist${skipped ? ` · ${skipped} already there` : ''}.`);
  } catch (error) {
    notify(`Could not finish adding songs${added ? ` · ${added} added before the error` : ''}: ${error.message}`, true);
  } finally {
    setBusy(button, false);
    renderSelection();
  }
}

function wireEvents() {
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest('button, .step-link, .dropzone');
    if (!control || control.disabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    control.classList.remove('press-pop');
    void control.offsetWidth;
    control.classList.add('press-pop');
    setTimeout(() => control.classList.remove('press-pop'), 340);
  });
  $('themeSelect').addEventListener('change', event => updateTheme(event.target.value));
  $('settingsButton').addEventListener('click', () => $('settingsDialog').showModal());
  $('closeSettingsButton').addEventListener('click', () => $('settingsDialog').close());
  $('settingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('saveSettingsButton');
    setBusy(button, true, 'Saving…');
    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ clientId: $('clientIdInput').value.trim() }) });
      state.configured = true;
      state.connected = false;
      renderStatus();
      $('settingsDialog').close();
      notify('Client ID saved. Now connect Spotify.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      setBusy(button, false);
    }
  });
  $('connectButton').addEventListener('click', () => {
    if (!state.configured) $('settingsDialog').showModal();
    else window.location.assign('/api/auth/start');
  });
  $('reconnectButton').addEventListener('click', () => window.location.assign('/api/auth/start'));
  $('disconnectButton').addEventListener('click', async () => {
    try {
      clearPreview();
      if (preview.player) await preview.player.disconnect();
      await api('/api/disconnect', { method: 'POST' });
      state.connected = false;
      state.canPreview = false;
      state.playlists = [];
      renderStatus();
      $('settingsDialog').close();
      notify('Spotify disconnected from this webpage.');
    } catch (error) { notify(error.message, true); }
  });
  $('fileInput').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
  $('dropzone').addEventListener('click', () => $('fileInput').click());
  $('dropzone').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('fileInput').click(); }
  });
  ['dragenter', 'dragover'].forEach(type => $('dropzone').addEventListener(type, event => {
    event.preventDefault();
    $('dropzone').classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(type => $('dropzone').addEventListener(type, event => {
    event.preventDefault();
    $('dropzone').classList.remove('dragging');
  }));
  $('dropzone').addEventListener('drop', event => addFiles(event.dataTransfer.files));
  $('clearFilesButton').addEventListener('click', () => {
    state.files.forEach(entry => URL.revokeObjectURL(entry.url));
    state.files = [];
    state.songs = [];
    state.skippedOriginalAudio = 0;
    state.duplicateCount = 0;
    $('importProgress').textContent = '';
    renderFiles();
    renderReview();
    renderSelection();
  });
  $('analyzeButton').addEventListener('click', analyzeFiles);
  $('addManualButton').addEventListener('click', () => {
    state.songs.push(makeSong());
    renderReview();
    $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('refreshPlaylistsButton').addEventListener('click', loadPlaylists);
  $('playlistSelect').addEventListener('change', renderSelection);
  $('createPlaylistForm').addEventListener('submit', createNewPlaylist);
  $('addToPlaylistButton').addEventListener('click', addToPlaylist);
}

const theme = (() => { try { return localStorage.getItem('music-inbox-theme'); } catch (_) { return null; } })();
updateTheme(['light', 'dark', 'system'].includes(theme) ? theme : 'system');
wireEvents();
renderFiles();
renderReview();
renderSelection();
loadStatus();

const query = new URLSearchParams(location.search);
if (query.has('error')) notify(query.get('error'), true);
if (query.has('connected')) notify('Spotify connected. Your playlists are ready.');
if (query.has('error') || query.has('connected')) history.replaceState(null, '', location.pathname);
