# Qobuz CLI

CLI for resolving playlist tracks against Qobuz via `qobuz.squid.wtf`, downloading them sequentially, and converting FLAC downloads to WAV 16-bit / 44.1 kHz.

Use this project only with music you are legally allowed to access and download. The author does not provide Qobuz credentials, Qobuz accounts, or access to paid content.

## Features

- Reads `.m3u`, `.m3u8`, `.txt`, Qobuz track/album URLs, and Spotify playlist URLs.
- Resolves tracks with fuzzy artist/title matching.
- Downloads one track at a time to avoid hammering the backend.
- Converts FLAC to WAV 16-bit / 44.1 kHz using `ffmpeg`.
- Skips already existing output files on resume.
- Stores Qobuz captcha cookies in `~/.qobuz-cookie` with `0600` permissions.
- Can refresh the HttpOnly captcha cookie through a separate Chrome DevTools Protocol profile.
- Can relaunch via macOS Terminal.app to avoid iTerm2 VPN split-tunnel exclusions.
- Caches Phase 1 matches in `~/.qobuz-cli/match-cache.json` so interrupted runs resume faster.
- Writes Terminal-run logs to `~/.qobuz-cli/qobuz-dl.log` when using `--via-terminal`.

## Requirements

- Node.js 24 or newer.
- `ffmpeg` available on `PATH`.
- Google Chrome or Chromium in `/Applications` for `--login-cookie`.
- Spotify Web API credentials for Spotify playlist URLs.

## Setup

```bash
npm install
cp .env.example .env
```

Optional local CLI install:

```bash
npm link
qobuz-dl --help
```

Set Spotify credentials in `.env` if you use Spotify playlists:

```bash
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

## Usage

```bash
node index.js playlist.txt -y --min-score 1.5 -o ~/Music/qobuz-dl
```

Spotify playlist:

```bash
node index.js "https://open.spotify.com/playlist/..." -y --min-score 1.5 -o ~/Music/qobuz-dl
```

Run through macOS Terminal.app for VPN routing:

```bash
node index.js "https://open.spotify.com/playlist/..." -y --min-score 1.5 -o ~/Music/qobuz-dl --via-terminal
```

Refresh Qobuz captcha cookie without starting a download:

```bash
node index.js --login-cookie
```

## Cookie Flow

The backend sets a HttpOnly `captcha_verified_at` cookie after captcha completion. The CLI avoids manual cookie copy/paste by launching a separate Chrome profile with DevTools Protocol enabled. After the captcha is solved, it reads the HttpOnly cookie through CDP and stores it in `~/.qobuz-cookie`.

Search requests do not send the cookie. Download URL requests use the cookie and trigger an automatic refresh when auth/captcha fails.

## Safety Notes

- Do not commit `.env`, `~/.qobuz-cookie`, logs, or downloaded audio.
- Spotify credentials must be supplied through environment variables or `.env`.
- `--login-cookie` starts a separate Chrome profile under `~/.qobuz-cli/chrome-profiles`.
- `--via-terminal` is macOS-specific.

## Changelog

### 1.0.0

- Initial CLI for playlist parsing, Qobuz search, matching, download, and WAV conversion.
- Added Spotify playlist import through Spotify Web API.
- Added automatic HttpOnly captcha cookie capture via Chrome DevTools Protocol.
- Added `~/.qobuz-cookie` cache with restricted file permissions.
- Added `--via-terminal` for macOS Terminal.app relaunch and VPN split-tunnel routing.
- Added resume behavior that skips existing output WAVs.
- Added match normalization for mix suffixes such as `Original Mix`, `Radio Edit`, and `Extended Mix`.
- Added Phase 1 match cache at `~/.qobuz-cli/match-cache.json`.
- Added terminal-run log file at `~/.qobuz-cli/qobuz-dl.log`.
- Removed hardcoded Spotify credentials; use `.env` instead.
