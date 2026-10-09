import { createHash, randomBytes } from 'node:crypto';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1/';
const PLAYLIST_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
];

export class SpotifyApiError extends Error {
  constructor(status, message, { code, retryAfter } = {}) {
    super(`Spotify request failed (${status}): ${message}`);
    this.name = 'SpotifyApiError';
    this.status = status;
    if (code) this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export function createPkce() {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizationUrl({ clientId, redirectUri, state, challenge }) {
  if (!clientId || !redirectUri || !state || !challenge) {
    throw new TypeError('Spotify authorization requires clientId, redirectUri, state, and challenge');
  }
  const url = new URL('/authorize', ACCOUNTS_BASE);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: PLAYLIST_SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: challenge,
  }).toString();
  return url.toString();
}

async function readJson(response) {
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new SpotifyApiError(response.status, 'Spotify returned an invalid response');
  }

  if (!response.ok) {
    const apiError = data?.error;
    const code = typeof apiError === 'string' ? apiError : undefined;
    const message = data?.error_description || apiError?.message || code || response.statusText || 'Unknown error';
    const retryHeader = response.headers.get('retry-after');
    const parsedRetry = retryHeader === null ? NaN : Number(retryHeader);
    const retryAfter = Number.isFinite(parsedRetry) && parsedRetry >= 0 ? parsedRetry : undefined;
    throw new SpotifyApiError(response.status, message, { code, retryAfter });
  }
  return data;
}

async function tokenRequest(form) {
  const response = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  return readJson(response);
}

export function exchangeCode({ clientId, redirectUri, code, verifier }) {
  return tokenRequest({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

export async function refreshAccessToken({ clientId, refreshToken }) {
  const tokens = await tokenRequest({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return { ...tokens, refresh_token: tokens.refresh_token || refreshToken };
}

function apiUrl(path) {
  const url = new URL(path, API_BASE);
  if (url.origin !== 'https://api.spotify.com' || !url.pathname.startsWith('/v1/')) {
    throw new TypeError('Unexpected Spotify API URL');
  }
  return url.toString();
}

async function apiRequest(accessToken, path, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(apiUrl(path), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return readJson(response);
}

async function allItems(accessToken, firstPath) {
  const items = [];
  const visited = new Set();
  let path = firstPath;
  while (path) {
    const url = apiUrl(path);
    if (visited.has(url)) throw new Error('Spotify returned a repeated pagination URL');
    visited.add(url);
    const page = await apiRequest(accessToken, url);
    if (!Array.isArray(page?.items)) throw new Error('Spotify returned an invalid playlist page');
    items.push(...page.items);
    path = page.next;
  }
  return items;
}

export function getCurrentUser(accessToken) {
  return apiRequest(accessToken, 'me');
}

export async function searchTracks({ accessToken, query, limit = 5 }) {
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('A song search query is required');
  const cappedLimit = Math.min(10, Math.max(1, Math.trunc(Number(limit) || 5)));
  const params = new URLSearchParams({ q: query.trim(), type: 'track', limit: String(cappedLimit) });
  const result = await apiRequest(accessToken, `search?${params}`);
  return result.tracks?.items ?? [];
}

export function listPlaylists(accessToken) {
  return allItems(accessToken, 'me/playlists?limit=50');
}

export function createPlaylist({ accessToken, name }) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('A playlist name is required');
  return apiRequest(accessToken, 'me/playlists', {
    method: 'POST',
    body: { name: name.trim(), public: false },
  });
}

export async function addItemsToPlaylist({ accessToken, playlistId, uris }) {
  if (!playlistId || !Array.isArray(uris) || uris.length === 0 || uris.some((uri) => typeof uri !== 'string' || !uri)) {
    throw new TypeError('A playlist ID and at least one Spotify URI are required');
  }
  let result;
  for (let i = 0; i < uris.length; i += 100) {
    result = await apiRequest(accessToken, `playlists/${encodeURIComponent(playlistId)}/items`, {
      method: 'POST',
      body: { uris: uris.slice(i, i + 100) },
    });
  }
  return result;
}

export function getPlaylistItems({ accessToken, playlistId }) {
  if (!playlistId) throw new TypeError('A playlist ID is required');
  return allItems(accessToken, `playlists/${encodeURIComponent(playlistId)}/items?limit=50`);
}

export function startPreview({ accessToken, deviceId, uri, positionMs }) {
  if (!/^[A-Za-z0-9]+$/.test(deviceId || '') || !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri || '')
    || !Number.isInteger(positionMs) || positionMs < 0) throw new TypeError('A valid preview device, track, and position are required');
  return apiRequest(accessToken, `me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT', body: { uris: [uri], position_ms: positionMs },
  });
}
