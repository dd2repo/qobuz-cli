# Qobuz CLI

Qobuz CLI resolves playlist entries against Qobuz, downloads matching tracks one at a time, and converts FLAC downloads to WAV 16-bit / 44.1 kHz by default.

Supported inputs:

- `.txt` files with one `Artist - Title` entry per line
- `.m3u` and `.m3u8` files with `#EXTINF` entries
- Qobuz track and album URLs
- Spotify playlist URLs

Use this project only with music you are legally allowed to access and download. This project does not provide Qobuz credentials, Qobuz accounts, or access to paid content.

## Requirements

- Node.js 24 or newer
- `ffmpeg` on `PATH`
- Google Chrome or Chromium on macOS for automatic captcha cookie capture
- Spotify Web API credentials for Spotify playlist URLs

## Installation

```bash
git clone https://github.com/dd2repo/qobuz-cli.git
cd qobuz-cli
npm install
cp .env.example .env
```

Optional local CLI install:

```bash
npm link
qobuz-dl --help
```

## Configuration

Edit `.env` as needed.

```bash
QOBUZ_BASE_URL=https://qobuz.squid.wtf
QOBUZ_OUTPUT_DIR=./downloads
QOBUZ_QUALITY=7
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

Quality values:

- `27`: Hi-Res
- `7`: FLAC 16-bit, default
- `6`: Lossless
- `5`: MP3 320

The backend may require a captcha cookie for download URL requests. Run this once when needed:

```bash
qobuz-dl --login-cookie
```

The command opens Chrome with a temporary profile. Solve the captcha in Chrome; the CLI stores the HttpOnly cookie in `~/.qobuz-cookie`.

## Usage

Download from a text playlist:

```bash
qobuz-dl playlist.txt -y --min-score 1.5 -o ~/Music/qobuz-dl
```

Download from Spotify:

```bash
qobuz-dl "https://open.spotify.com/playlist/..." -y --min-score 1.5 -o ~/Music/qobuz-dl
```

Download from a Qobuz album URL:

```bash
qobuz-dl "https://play.qobuz.com/album/abc123" -o ~/Music/qobuz-dl
```

Choose matches interactively:

```bash
qobuz-dl playlist.txt --confirm -o ~/Music/qobuz-dl
```

Keep FLAC files instead of converting to WAV:

```bash
qobuz-dl playlist.txt --no-convert -o ~/Music/qobuz-dl
```

On macOS, relaunch the command in Terminal.app:

```bash
qobuz-dl playlist.txt -y -o ~/Music/qobuz-dl --via-terminal
```

## Resume Behavior

Existing output files are skipped. Search results are cached in `~/.qobuz-cli/match-cache.json`, so interrupted runs can restart faster.

## Troubleshooting

If downloads fail with captcha or HTML responses, refresh the cookie:

```bash
qobuz-dl --login-cookie
```

If Spotify playlist loading fails, check `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`.

If WAV conversion fails, confirm `ffmpeg` is installed:

```bash
ffmpeg -version
```

Logs for `--via-terminal` runs are written to `~/.qobuz-cli/qobuz-dl.log`.

## Development

```bash
npm run smoke
npm audit --omit=dev
npm pack --dry-run
```

Do not commit `.env`, `~/.qobuz-cookie`, logs, or downloaded audio.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
