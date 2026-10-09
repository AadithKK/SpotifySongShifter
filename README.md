# Music Inbox

Music Inbox is a self-hosted webpage that turns screenshots of music into a Spotify playlist. It reads Instagram **Saved** and **For you** music lists and some song recommendations in message screenshots. After reading a screenshot, it searches Spotify and selects clear matches for review. Nothing is added until you press **Add selected songs**.

Recognition runs locally in the Node.js server with bundled English, Arabic, simplified and traditional Chinese, Japanese, Korean, French, and Portuguese OCR data. The French and Portuguese models help check accents in Latin-script titles. Chinese and Korean text can also get an English meaning beside the original name. The first use downloads local translation models (about 230 MB for both languages) into `data/translation-models/`; song text is translated on your server. No vision or translation API key is needed. Screenshots are processed in memory and are not saved; Spotify connection data is saved privately in `data/`. OCR and machine translation can make mistakes, so check the source row and Spotify result.

## Set up on your computer

1. Install [Node.js 20 or newer](https://nodejs.org/). Download this repository and open a terminal in its folder.
2. Run `npm ci`, then `npm start`. On a Mac, you can also double-click `Start Music Inbox.command` after installing Node.js. **Do not open `public/index.html` directly**; the webpage needs its local server to load the design and Spotify connection.
3. Open <http://127.0.0.1:4173>.
4. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create **your own** app. Add `http://127.0.0.1:4173/auth/callback` as a redirect URI, exactly as written. Spotify requires the explicit loopback address `127.0.0.1`, rather than `localhost`, for local HTTP callbacks.
5. Copy the app's **Client ID** into Music Inbox settings, save it, and choose **Connect Spotify**. Sign in and approve access. Do not enter a Client Secret; Music Inbox uses PKCE. Each person hosting Music Inbox connects their own Spotify app and account.
6. Upload up to 25 PNG, JPEG, or WebP screenshots, each under 8 MB. Music Inbox reads five at a time and keeps completed groups if a later group fails.
7. In **Review**, check the title, artist, source crop, and suggested Spotify match. Chinese and Korean names show an English hint when translation finishes; the original name stays in the editable fields and is used for Spotify search. Music Inbox preselects a recording only when its original title, artist, and available duration agree. Unclear or cut-off names remain for manual review. Uncheck **Add to playlist** on any card you want to leave out. Use **Choose different song** to see the other Spotify results; click **Selected** to deselect a recording, then **Choose** on the one you want. You can select more than one recording. The small play button previews about 15 seconds from the middle. If you connected before previews were added, reconnect Spotify in Settings once to grant playback access.
8. Choose an existing playlist or create one, then click **Add selected songs**. Music Inbox avoids adding a track already in that playlist.

The owner of a Spotify Development Mode app currently needs Spotify Premium, and Development Mode apps have user limits. See [Spotify's Development Mode rules](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) and [redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).

## How the reader works

- It locates list rows by the title above an artist, reel count, and optional duration. Search bars, tabs, badges, and other interface text are ignored.
- It imports visible songs from **Saved** and **For you**, regardless of bookmark icon. Generic **Original audio** rows are skipped and counted.
- It combines repeated title-and-artist rows when visible durations agree. Different versions stay separate; uncertain pairs are flagged for comparison. If two cards resolve to the same Spotify track, only one selection remains.
- It keeps message-screenshot detection for clearly written song recommendations and supports light, dark, and device-matched themes.
- English hints are machine translations of Chinese and Korean text, not official release titles. The original script stays available for matching and review. A Han-only Japanese title can be mistaken for Chinese, so check its hint against the source.

Synthetic example: a mock list showing `Midnight Current` above `Nova Reed · 1.2K reels · 4:01` becomes one review card for **Midnight Current — Nova Reed**. The same row in another screenshot counts as a repeat. `Original audio` above `creator · 1 reel · 0:18` is skipped. These examples are invented text, not personal screenshots.

## Phone and home server access

For use on a private local network, first connect Spotify from the host computer. Then restart Music Inbox with a password:

```sh
HOST=0.0.0.0 APP_PASSWORD='choose-a-long-password' npm start
```

Open `http://<host-LAN-IP>:4173` on your phone. The browser login uses username `music` and your chosen password. Do not expose this HTTP address to the public internet. For remote access, use a private network or HTTPS reverse proxy with authentication.

For a home server, run `npm ci` there, set `HOST`, `APP_PASSWORD`, and `PUBLIC_ORIGIN=https://your-domain.example`, and add `https://your-domain.example/auth/callback` to your Spotify app. `PORT` defaults to `4173`; `DATA_DIR` can point to a persistent private folder; `SPOTIFY_CLIENT_ID` can provide the Client ID without entering it on the webpage. Keep `data/` private because it contains Spotify tokens. Copy it separately during a move if you want to preserve a connection.

## Troubleshooting

- **Redirect URI mismatch:** Copy the callback shown in Music Inbox settings into your Spotify app exactly. For local use, choose `127.0.0.1`, not `localhost`. For a proxied server, set `PUBLIC_ORIGIN` to its HTTPS origin and restart.
- **App or user not allowed:** Check Spotify Development Mode Premium and user access. Each installation needs its own Spotify app.
- **No songs found:** Use a clear screenshot with both title and artist. Message screenshots need a clear song-and-artist cue; you can always add a song manually.
- **Wrong suggested song:** Uncheck **Add to playlist** to exclude it, or click **Choose different song** to change the recording. Edit the title or artist and search again if the results are wrong. Always check automatic suggestions before adding them.
- **Preview will not play:** Reconnect Spotify in Settings to grant playback access. Previews need Premium and a browser that supports Spotify's Web Playback SDK. A content blocker can stop the player from loading. Playing a preview can switch your active Spotify device to the browser. The preview starts around 45% through the track; Music Inbox does not detect the chorus or best part.
- **A group fails:** Finished groups remain in Review. Press **Find songs in screenshots** again to retry unread images.
- **OCR is slow:** The first scan loads bundled language models. Large batches take longer; progress updates after each group of five.
- **English meaning missing:** The first Chinese or Korean entry needs an internet connection to download its local model. If the download fails, the original title remains usable; click **Try translation again** on the review card.

## Development and privacy

Run `npm test` for local checks. GitHub Actions runs tests on macOS, Windows, and Linux. Tests use synthetic rows and mocked Spotify requests; they never add tracks to a real account.

The `data/` folder, dependencies, and private screenshots are excluded from Git. Screenshot images are processed in memory by your server. This repository does not include personal screenshots, Client IDs, or OAuth tokens. YouTube playlist creation and optional song downloading are ideas for later versions and are not included here.

To publish this project, upload the source files and folders from a clean copy to a new GitHub repository. Keep your local `data/`, `node_modules/`, screenshots, `.env` files, and any existing `.git/` history on your own computer. The included `.gitignore` helps protect future commits, but check files before each public upload.

Licensed under [MIT](LICENSE).
