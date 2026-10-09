import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeImage } from './src/extract.js';
import { translateSongFields } from './src/translation.js';
import {
  addItemsToPlaylist,
  buildAuthorizationUrl,
  createPkce,
  createPlaylist,
  exchangeCode,
  getPlaylistItems,
  listPlaylists,
  refreshAccessToken,
  searchTracks,
  startPreview,
} from './src/spotify.js';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, 'data');
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const publicOrigin = new URL(process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`).origin;
const callbackUrl = `${publicOrigin}/auth/callback`;
const maxImageBytes = 8 * 1024 * 1024;
const maxBodyBytes = 55 * 1024 * 1024;
const pendingAuth = new Map();
const previewScopes = ['streaming', 'user-read-email', 'user-read-private', 'user-modify-playback-state'];
let refreshing;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw httpError(415, 'Send JSON data.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError(413, 'Upload is too large. Try fewer screenshots.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'That request was not valid JSON.');
  }
}

async function loadJson(name) {
  try {
    return JSON.parse(await readFile(join(dataDir, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveJson(name, value) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const destination = join(dataDir, name);
  const temporary = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, destination);
}

async function clientId() {
  return process.env.SPOTIFY_CLIENT_ID || (await loadJson('settings.json'))?.clientId || '';
}

async function storedAuth() {
  return loadJson('spotify-auth.json');
}

async function accessToken() {
  const auth = await storedAuth();
  if (!auth) throw httpError(401, 'Connect Spotify first.');
  if (auth.expiresAt > Date.now() + 60_000) return auth.access_token;
  if (!auth.refresh_token) throw httpError(401, 'Reconnect Spotify to continue.');
  if (!refreshing) {
    refreshing = (async () => {
      const refreshed = await refreshAccessToken({
        clientId: await clientId(),
        refreshToken: auth.refresh_token,
      });
      const updated = {
        ...auth,
        ...refreshed,
        refresh_token: refreshed.refresh_token || auth.refresh_token,
        expiresAt: Date.now() + refreshed.expires_in * 1000,
      };
      await saveJson('spotify-auth.json', updated);
      return updated.access_token;
    })().finally(() => { refreshing = undefined; });
  }
  return refreshing;
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin && new URL(origin).host !== request.headers.host) {
    throw httpError(403, 'This request must come from this webpage.');
  }
}

function authorized(request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return true;
  const encoded = request.headers.authorization?.match(/^Basic (.+)$/i)?.[1];
  if (!encoded) return false;
  let supplied;
  try {
    supplied = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const expected = Buffer.from(`music:${password}`);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function serveStatic(pathname, response) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/song-utils.js': ['song-utils.js', 'text/javascript; charset=utf-8'],
    '/file-help.js': ['file-help.js', 'text/javascript; charset=utf-8'],
    '/logo.png': ['logo.png', 'image/png'],
  };
  const match = files[pathname];
  if (!match) throw httpError(404, 'Page not found.');
  const body = await readFile(join(publicDir, match[0]));
  response.writeHead(200, {
    'Content-Type': match[1],
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self'; script-src 'self' https://sdk.scdn.co; connect-src 'self' https://*.spotify.com wss://*.spotify.com https://sdk.scdn.co; frame-src https://*.spotify.com https://sdk.scdn.co; media-src 'self' blob: https://*.spotify.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function decodeImage(image) {
  const mime = image?.mimeType;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
    throw httpError(400, 'Use PNG, JPEG, or WebP screenshots.');
  }
  const raw = image?.dataBase64?.replace(/^data:[^,]+,/, '');
  if (typeof raw !== 'string' || !raw || !/^[A-Za-z0-9+/=]+$/.test(raw)) {
    throw httpError(400, 'A screenshot could not be read.');
  }
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length || buffer.length > maxImageBytes) {
    throw httpError(413, 'Each screenshot must be under 8 MB.');
  }
  return buffer;
}

async function route(request, response) {
  const url = new URL(request.url, publicOrigin);
  if (!authorized(request) && url.pathname !== '/auth/callback') {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Music Inbox"' });
    response.end('Sign in to Music Inbox.');
    return;
  }
  if (request.method === 'POST') assertSameOrigin(request);

  if (request.method === 'GET' && url.pathname === '/api/status') {
    const auth = await storedAuth();
    sendJson(response, 200, {
      configured: Boolean(await clientId()),
      connected: Boolean(auth?.refresh_token || (auth?.access_token && auth.expiresAt > Date.now())),
      canPreview: previewScopes.every(scope => auth?.scope?.split(' ').includes(scope)),
      user: auth?.user || null,
      callbackUrl,
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/settings') {
    if (process.env.SPOTIFY_CLIENT_ID) throw httpError(409, 'Spotify Client ID is set by the server.');
    const { clientId: newId } = await readJson(request);
    if (typeof newId !== 'string' || !/^[A-Za-z0-9]{20,80}$/.test(newId.trim())) {
      throw httpError(400, 'Enter a valid Spotify Client ID.');
    }
    const oldId = await clientId();
    await saveJson('settings.json', { clientId: newId.trim() });
    if (oldId && oldId !== newId.trim()) {
      await unlink(join(dataDir, 'spotify-auth.json')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    sendJson(response, 200, { configured: true });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/auth/start') {
    const id = await clientId();
    if (!id) throw httpError(400, 'Add your Spotify Client ID first.');
    const state = randomBytes(24).toString('hex');
    const { verifier, challenge } = createPkce();
    pendingAuth.set(state, { verifier, expiresAt: Date.now() + 10 * 60_000 });
    for (const [key, entry] of pendingAuth) {
      if (entry.expiresAt < Date.now()) pendingAuth.delete(key);
    }
    redirect(response, buildAuthorizationUrl({ clientId: id, redirectUri: callbackUrl, state, challenge }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/auth/callback') {
    if (url.searchParams.has('error')) {
      redirect(response, `/?error=${encodeURIComponent('Spotify connection was canceled.')}`);
      return;
    }
    const state = url.searchParams.get('state');
    const entry = pendingAuth.get(state);
    pendingAuth.delete(state);
    if (!entry || entry.expiresAt < Date.now() || !url.searchParams.get('code')) {
      throw httpError(400, 'Spotify sign-in expired. Try connecting again.');
    }
    const tokens = await exchangeCode({
      clientId: await clientId(),
      redirectUri: callbackUrl,
      code: url.searchParams.get('code'),
      verifier: entry.verifier,
    });
    await saveJson('spotify-auth.json', {
      ...tokens,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });
    redirect(response, '/?connected=1');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/disconnect') {
    await unlink(join(dataDir, 'spotify-auth.json')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    sendJson(response, 200, { connected: false });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/analyze') {
    const { images } = await readJson(request);
    if (!Array.isArray(images) || !images.length || images.length > 5) {
      throw httpError(400, 'Choose 1 to 5 screenshots.');
    }
    const results = [];
    for (const image of images) {
      const buffer = decodeImage(image);
      try {
        const result = await analyzeImage(buffer);
        results.push({ name: String(image.name || 'Screenshot').slice(0, 120), ...result });
      } catch (error) {
        results.push({ name: String(image.name || 'Screenshot').slice(0, 120), text: '', candidates: [], error: error.message });
      }
    }
    sendJson(response, 200, { results });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/search') {
    const { query } = await readJson(request);
    if (typeof query !== 'string' || !query.trim() || query.length > 200) {
      throw httpError(400, 'Enter a song title or artist to search.');
    }
    sendJson(response, 200, { tracks: await searchTracks({ accessToken: await accessToken(), query: query.trim(), limit: 5 }) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/translate') {
    const { items } = await readJson(request);
    if (!Array.isArray(items) || !items.length || items.length > 25 || items.some(item =>
      typeof item?.id !== 'string' || item.id.length > 30 ||
      typeof item.title !== 'string' || item.title.length > 120 ||
      typeof item.artist !== 'string' || item.artist.length > 120)) {
      throw httpError(400, 'Choose up to 25 valid song names to translate.');
    }
    const translations = [];
    for (const item of items) {
      try {
        translations.push({ id: item.id, ...await translateSongFields(item) });
      } catch {
        translations.push({ id: item.id, error: 'English translation is unavailable. Try again later.' });
      }
    }
    sendJson(response, 200, { translations });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/playback/token') {
    const auth = await storedAuth();
    if (!previewScopes.every(scope => auth?.scope?.split(' ').includes(scope))) throw httpError(403, 'Reconnect Spotify to enable in-page previews.');
    sendJson(response, 200, { accessToken: await accessToken() });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/playback/start') {
    const auth = await storedAuth();
    if (!previewScopes.every(scope => auth?.scope?.split(' ').includes(scope))) throw httpError(403, 'Reconnect Spotify to enable in-page previews.');
    const { deviceId, uri, positionMs } = await readJson(request);
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9]+$/.test(deviceId)
      || typeof uri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)
      || !Number.isInteger(positionMs) || positionMs < 0 || positionMs > 24 * 60 * 60 * 1000) {
      throw httpError(400, 'Choose a valid track preview.');
    }
    await startPreview({ accessToken: await accessToken(), deviceId, uri, positionMs });
    sendJson(response, 200, { playing: true });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/playlists') {
    sendJson(response, 200, { playlists: await listPlaylists(await accessToken()) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/playlists') {
    const { name } = await readJson(request);
    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
      throw httpError(400, 'Enter a playlist name under 100 characters.');
    }
    const playlist = await createPlaylist({ accessToken: await accessToken(), name: name.trim() });
    sendJson(response, 201, { playlist });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/playlist/add') {
    const { playlistId, uris } = await readJson(request);
    if (typeof playlistId !== 'string' || !/^[A-Za-z0-9]{22}$/.test(playlistId)) {
      throw httpError(400, 'Choose a valid Spotify playlist.');
    }
    if (!Array.isArray(uris) || !uris.length || uris.length > 100 ||
      uris.some(uri => typeof uri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri))) {
      throw httpError(400, 'Choose up to 100 Spotify tracks.');
    }
    const token = await accessToken();
    const existing = new Set((await getPlaylistItems({ accessToken: token, playlistId }))
      .map(row => row.item?.uri || row.track?.uri).filter(Boolean));
    const unique = [...new Set(uris)].filter(uri => !existing.has(uri));
    if (unique.length) await addItemsToPlaylist({ accessToken: token, playlistId, uris: unique });
    sendJson(response, 200, { added: unique.length, skipped: uris.length - unique.length });
    return;
  }
  if (request.method === 'GET') {
    await serveStatic(url.pathname, response);
    return;
  }
  throw httpError(404, 'Page not found.');
}

export function createAppServer() {
  return createServer((request, response) => {
    route(request, response).catch(error => {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        ? error.status : 500;
      if (status >= 500) console.error(error);
      if (!response.headersSent) sendJson(response, status, { error: error.message || 'Something went wrong.' });
      else response.end();
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !process.env.APP_PASSWORD) {
    throw new Error('Set APP_PASSWORD before allowing other devices to reach this server.');
  }
  createAppServer().listen(port, host, () => {
    console.log(`Music Inbox is running at ${publicOrigin}`);
    console.log(`Spotify callback URL: ${callbackUrl}`);
  });
}
