import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createPkce,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  getCurrentUser,
  searchTracks,
  listPlaylists,
  createPlaylist,
  addItemsToPlaylist,
  getPlaylistItems,
  startPreview,
} from '../src/spotify.js';

async function withSpotifyResponses(responses, run) {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const reply = responses.shift();
    assert.ok(reply, `Unexpected Spotify request: ${url}`);
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };
  let succeeded = false;
  try {
    const result = await run(calls);
    succeeded = true;
    return result;
  } finally {
    globalThis.fetch = oldFetch;
    if (succeeded) assert.equal(responses.length, 0, 'All expected Spotify responses should be consumed');
  }
}

test('PKCE challenge is the SHA-256 digest of a fresh valid verifier', () => {
  const first = createPkce();
  const second = createPkce();
  assert.match(first.verifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.notEqual(first.verifier, second.verifier);
  assert.equal(first.challenge, createHash('sha256').update(first.verifier).digest('base64url'));
});

test('authorization URL requests playlist permissions with PKCE and CSRF state', () => {
  const url = new URL(buildAuthorizationUrl({
    clientId: 'client 123', redirectUri: 'http://127.0.0.1:8080/callback',
    state: 'random-state', challenge: 'pkce-challenge',
  }));
  assert.equal(url.origin, 'https://accounts.spotify.com');
  assert.equal(url.pathname, '/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client 123');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8080/callback');
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.equal(url.searchParams.get('code_challenge'), 'pkce-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(new Set(url.searchParams.get('scope').split(' ')), new Set([
    'playlist-read-private', 'playlist-read-collaborative',
    'playlist-modify-private', 'playlist-modify-public',
    'streaming', 'user-read-email', 'user-read-private', 'user-modify-playback-state',
  ]));
});

test('browser preview starts the chosen recording partway through on its own device', async () => {
  const uri = 'spotify:track:0123456789ABCDEFGHIJKL';
  await withSpotifyResponses([{ status: 204, body: null }], async (calls) => {
    await startPreview({ accessToken: 'test-access', deviceId: 'testdevice1', uri, positionMs: 85000 });
    assert.equal(calls[0].url, 'https://api.spotify.com/v1/me/player/play?device_id=testdevice1');
    assert.equal(calls[0].options.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[0].options.body), { uris: [uri], position_ms: 85000 });
  });
});

test('authorization code exchange sends form fields for PKCE and returns tokens', async () => {
  const tokens = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 };
  await withSpotifyResponses([{ body: tokens }], async (calls) => {
    assert.deepEqual(await exchangeCode({ clientId: 'client', redirectUri: 'http://127.0.0.1/callback', code: 'code', verifier: 'verifier' }), tokens);
    assert.equal(calls[0].url, 'https://accounts.spotify.com/api/token');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), {
      client_id: 'client', grant_type: 'authorization_code', code: 'code',
      redirect_uri: 'http://127.0.0.1/callback', code_verifier: 'verifier',
    });
  });
});

test('refresh keeps the previous refresh token when Spotify does not rotate it', async () => {
  await withSpotifyResponses([{ body: { access_token: 'new', expires_in: 3600 } }], async (calls) => {
    const tokens = await refreshAccessToken({ clientId: 'client', refreshToken: 'old-refresh' });
    assert.equal(tokens.refresh_token, 'old-refresh');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), {
      client_id: 'client', grant_type: 'refresh_token', refresh_token: 'old-refresh',
    });
  });
});

test('profile request sends bearer token and returns account details', async () => {
  await withSpotifyResponses([{ body: { account_id: 'stable-id', display_name: 'Example Listener' } }], async (calls) => {
    assert.equal((await getCurrentUser('secret')).account_id, 'stable-id');
    assert.equal(calls[0].url, 'https://api.spotify.com/v1/me');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  });
});

test('track search encodes query and uses Spotify current ten-result cap', async () => {
  await withSpotifyResponses([{ body: { tracks: { items: [{ uri: 'spotify:track:one', name: 'Song' }] } } }], async (calls) => {
    assert.deepEqual(await searchTracks({ accessToken: 'secret', query: 'Song & Artist', limit: 20 }), [{ uri: 'spotify:track:one', name: 'Song' }]);
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/v1/search');
    assert.equal(url.searchParams.get('q'), 'Song & Artist');
    assert.equal(url.searchParams.get('type'), 'track');
    assert.equal(url.searchParams.get('limit'), '10');
  });
});

test('playlist listing follows pages and returns every playlist', async () => {
  await withSpotifyResponses([
    { body: { items: [{ id: 'first' }], next: 'https://api.spotify.com/v1/me/playlists?limit=50&offset=50' } },
    { body: { items: [{ id: 'second' }], next: null } },
  ], async (calls) => {
    assert.deepEqual(await listPlaylists('secret'), [{ id: 'first' }, { id: 'second' }]);
    assert.equal(calls[0].url, 'https://api.spotify.com/v1/me/playlists?limit=50');
    assert.equal(calls[1].url, 'https://api.spotify.com/v1/me/playlists?limit=50&offset=50');
  });
});

test('playlist creation uses current user endpoint and creates a private playlist', async () => {
  await withSpotifyResponses([{ status: 201, body: { id: 'playlist-id', name: 'Inbox', public: false } }], async (calls) => {
    assert.equal((await createPlaylist({ accessToken: 'secret', name: 'Inbox' })).id, 'playlist-id');
    assert.equal(calls[0].url, 'https://api.spotify.com/v1/me/playlists');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'Inbox', public: false });
  });
});

test('playlist add uses current items endpoint and batches over 100 tracks', async () => {
  const uris = Array.from({ length: 101 }, (_, i) => `spotify:track:${i}`);
  await withSpotifyResponses([
    { status: 201, body: { snapshot_id: 'first' } },
    { status: 201, body: { snapshot_id: 'second' } },
  ], async (calls) => {
    assert.deepEqual(await addItemsToPlaylist({ accessToken: 'secret', playlistId: 'id', uris }), { snapshot_id: 'second' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://api.spotify.com/v1/playlists/id/items');
    assert.deepEqual(JSON.parse(calls[0].options.body), { uris: uris.slice(0, 100) });
    assert.deepEqual(JSON.parse(calls[1].options.body), { uris: uris.slice(100) });
  });
});

test('playlist items follows pages and preserves new item wrappers', async () => {
  await withSpotifyResponses([
    { body: { items: [{ item: { uri: 'spotify:track:one' } }], next: 'https://api.spotify.com/v1/playlists/id/items?limit=50&offset=50' } },
    { body: { items: [{ item: { uri: 'spotify:track:two' } }], next: null } },
  ], async (calls) => {
    assert.deepEqual(await getPlaylistItems({ accessToken: 'secret', playlistId: 'id' }), [
      { item: { uri: 'spotify:track:one' } }, { item: { uri: 'spotify:track:two' } },
    ]);
    assert.equal(calls[0].url, 'https://api.spotify.com/v1/playlists/id/items?limit=50');
  });
});

test('Spotify errors expose status and Retry-After without leaking bearer tokens', async () => {
  await withSpotifyResponses([{ status: 429, headers: { 'retry-after': '4' }, body: { error: { status: 429, message: 'Rate limit exceeded' } } }], async () => {
    await assert.rejects(getCurrentUser('secret-bearer'), (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 4);
      assert.match(error.message, /Rate limit exceeded/);
      assert.doesNotMatch(error.message, /secret-bearer/);
      return true;
    });
  });
});

test('invalid authorization errors expose Spotify reason and status', async () => {
  await withSpotifyResponses([{ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token expired' } }], async () => {
    await assert.rejects(refreshAccessToken({ clientId: 'client', refreshToken: 'expired' }), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'invalid_grant');
      assert.match(error.message, /Refresh token expired/);
      return true;
    });
  });
});
