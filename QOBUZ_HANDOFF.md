# Qobuz CLI Handoff - Projektuebergabe

## Was das Projekt macht

CLI-Tool (`qobuz-dl`) das Playlist-Dateien (M3U/TXT) und Spotify-Playlists verarbeitet:

1. **Playlist parsen**: Liest `Artist - Titel` Zeilen aus `.m3u`/`.txt` Dateien
2. **Spotify-Integration**: Holt Playlist-Tracks via Spotify Web API (Client ID + Secret vorhanden)
3. **Qobuz-Suche**: Sucht jeden Track über die squid.wtf API (keine eigenen Qobuz-Credentials nötig)
4. **Smart Matching**: Fuzzy-String-Matching zwischen Playlist und Qobuz-Ergebnissen
5. **Download-Queue**: Lädt Tracks sequentiell als FLAC 16-bit 44.1kHz
6. **WAV-Konvertierung**: ffmpeg konvertiert automatisch zu WAV 16-bit 44.1kHz (pcm_s16le, 44100 Hz) – verlustfrei

## Standort

```
~/qobuz-cli/
  index.js        # Haupt-CLI
  package.json    # Dependencies (chalk, cli-progress, string-similarity, altcha-lib)
  .env.example    # Vorlage für Konfiguration
  get-cookie.scpt # (veraltet) AppleScript zum Cookie-Auslesen
```

Spotify Playlist-Tracks: `/tmp/hato_playlist.txt` (241 Tracks, HATO's DnB Crate)
Bereits heruntergeladen: `~/Music/qobuz-dl/` (67 WAVs)

## Aufruf

```bash
qobuz-dl playlist.txt -y --min-score 1.5 -o ~/Music/qobuz-dl
```

- `-y`: Auto-accept Matches mit Score >= 1.5
- `-c`: Interaktiver Modus (bei Unsicherheit auswählen)
- `--no-convert`: FLAC behalten (kein WAV)
- `--min-score <n>`: Schwellwert anpassen (default 1.5)

## Die Pipeline

```
Playlist (M3U/TXT/Spotify)
  → Phase 1: Qobuz-Suche + Fuzzy-Match (100 API-Calls)
  → Phase 2: Download-Queue (1 Track nach dem anderen)
    → /api/download-music → Download-URL holen
    → Audio von Qobuz-CDN herunterladen
    → ffmpeg: FLAC → WAV 16/44.1
```

## Infrastruktur

- **API-Backend**: `https://qobuz.squid.wtf` (gehostete Qobuz-DL Instanz mit gültigen Qobuz-Credentials)
- **ALTCHA-Schutz**: squid.wtf verwendet ALTCHA (Proof-of-Work Captcha). Nach Lösen setzt der Server einen `captcha_verified_at` Cookie (HttpOnly). Dieser Cookie ist ~30 Minuten gültig und muss bei jedem API-Call mitgeschickt werden.
- **VPN (Mullvad)**: Split-Tunneling aktiv. iTerm2 ist vom VPN ausgeschlossen (direkte Verbindung). Squid.wtf blockiert Direktverbindungen nach Rate-Limiting. Downloads MÜSSEN über VPN laufen.

## Aktuelles Problem: Cookie-Extraktion

Der `captcha_verified_at` Cookie ist **HttpOnly** – kann per JavaScript (`document.cookie`) nicht gelesen werden. Derzeit muss der User ihn manuell aus Chrome DevTools (F12 → Network → Request Headers → Cookie) kopieren.

### Was versucht wurde

| Ansatz | Ergebnis |
|--------|----------|
| `sqlite3` Chrome Cookies DB | Cookie ist Session-Cookie, Wert nicht persistiert |
| JXA / AppleScript `tab.execute({javascript})` | HttpOnly → `document.cookie` liefert leeren String |
| Chrome DevTools Protocol (CDP) via `--remote-debugging-port=9222` | Chrome verweigert CDP auf Default-Profil. Mit kopiertem Profil startet Chrome, stürzt aber ab (GPU/Network crashes) |
| ALTCHA programmatisch lösen (`altcha-lib`) | Challenge-Solving funktioniert (42ms), aber Verify schlägt fehl – Server nutzt HMAC-Secret das wir nicht haben |

### Nächste Schritte

1. **Cookie-Workflow verbessern**: erledigt. CLI liest `~/.qobuz-cookie` automatisch, akzeptiert Header oder reinen `captcha_verified_at`-Wert und speichert Cookies mit `0600`. Zusätzlich gibt es `--login-cookie`: öffnet ein separates Chrome-Profil, der User löst nur das Captcha, danach liest die CLI den HttpOnly-Cookie per Chrome DevTools Protocol automatisch und speichert ihn.
2. **Download über VPN routen**: erledigt. CLI unterstützt `--via-terminal` und startet den aktuellen Download-Befehl per Terminal.app neu, damit Mullvad Split-Tunneling nicht durch iTerm2 umgangen wird.
3. **Bester Mullvad-Relay**: `nl-ams-wg-002` (Amsterdam) – 1.42s Latenz, squid.wtf Edge-Node ebenfalls in Amsterdam

## Spotify-Credentials

```
SPOTIFY_CLIENT_ID=<set in .env>
SPOTIFY_CLIENT_SECRET=<set in .env>
```

Playlist-ID: `45aO6bvaVvk2iuglOGelEL` (241 Tracks)

## Update

- Spotify-Playlist-URLs werden direkt via Spotify Web API geladen (`open.spotify.com/playlist/...`).
