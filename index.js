#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync, exec } = require('child_process');
const dotenv = require('dotenv');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
const stringSimilarity = require('string-similarity');

dotenv.config({ path: path.join(__dirname, '.env') });

const BASE_URL = process.env.QOBUZ_BASE_URL || 'https://qobuz.squid.wtf';
let COOKIE_HEADER = process.env.QOBUZ_COOKIE || '';
const COOKIE_FILE = expandHome(process.env.QOBUZ_COOKIE_FILE || '~/.qobuz-cookie');
const CHROME_PROFILE_BASE_DIR = expandHome(process.env.QOBUZ_CHROME_PROFILE_BASE || '~/.qobuz-cli/chrome-profiles');
const MATCH_CACHE_FILE = expandHome(process.env.QOBUZ_MATCH_CACHE || '~/.qobuz-cli/match-cache.json');
const LOG_FILE = expandHome(process.env.QOBUZ_LOG_FILE || '~/.qobuz-cli/qobuz-dl.log');
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const DEFAULT_QUALITY = process.env.QOBUZ_QUALITY || '7';
const DEFAULT_OUTPUT_DIR = process.env.QOBUZ_OUTPUT_DIR || './downloads';
const DEFAULT_MIN_SCORE = parseFloat(process.env.QOBUZ_MIN_SCORE) || 1.5;
let alwaysConfirm = process.env.QOBUZ_ALWAYS_CONFIRM === 'true';

function expandHome(filePath) {
  if (!filePath || filePath === '~') return process.env.HOME || process.cwd();
  if (filePath.startsWith('~/')) return path.join(process.env.HOME || process.cwd(), filePath.slice(2));
  return filePath;
}

function tryReadChromeCookie(hostPattern, cookieName) {
  const paths = [
    path.join(process.env.HOME, 'Library/Application Support/Google/Chrome/Default/Cookies'),
    path.join(process.env.HOME, 'Library/Application Support/Google/Chrome/Profile 1/Cookies'),
    path.join(process.env.HOME, 'Library/Application Support/Google/Chrome/Profile 2/Cookies'),
  ];
  for (const dbPath of paths) {
    try {
      if (!fs.existsSync(dbPath)) continue;
      const result = execFileSync('sqlite3', [dbPath,
        `SELECT value FROM cookies WHERE host_key LIKE '%${hostPattern}%' AND name='${cookieName}' ORDER BY last_access_utc DESC LIMIT 1;`
      ], { encoding: 'utf8', timeout: 3000 }).trim();
      if (result) return result;
    } catch {}
  }
  return null;
}

function normalizeCookieHeader(value) {
  const cookie = (value || '').trim();
  if (!cookie) return '';
  if (cookie.includes('=')) return cookie;
  return `captcha_verified_at=${cookie}`;
}

function readCookieFile() {
  try {
    if (!fs.existsSync(COOKIE_FILE)) return '';
    const value = fs.readFileSync(COOKIE_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    return normalizeCookieHeader(value);
  } catch {
    return '';
  }
}

function writeCookieFile(cookie) {
  const normalized = normalizeCookieHeader(cookie);
  if (!normalized) return;
  fs.writeFileSync(COOKIE_FILE, `${normalized}\n`, { mode: 0o600 });
  try { fs.chmodSync(COOKIE_FILE, 0o600); } catch {}
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function matchCacheKey(line, quality) {
  return `${quality}:${normalizeForMatch(line)}`;
}

function findChromeBinary() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function waitForDevToolsPort(profileDir, timeoutMs = 30000) {
  const activePortFile = path.join(profileDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const [port] = fs.readFileSync(activePortFile, 'utf8').trim().split('\n');
      if (port) return port;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome DevTools port was not created.');
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

function cdpCall(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = cdpCall.nextId++;
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
cdpCall.nextId = 1;

async function readCaptchaCookieFromChrome(port) {
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    || targets.find((target) => target.webSocketDebuggerUrl);
  if (!page) return '';

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  try {
    const result = await cdpCall(ws, 'Network.getAllCookies');
    const cookie = (result.cookies || []).find((item) => (
      item.name === 'captcha_verified_at' && item.domain.includes('squid.wtf')
    ));
    return cookie ? `${cookie.name}=${cookie.value}` : '';
  } finally {
    ws.close();
  }
}

async function loginCookieWithChrome(timeoutMs = 120000) {
  const chrome = findChromeBinary();
  if (!chrome) throw new Error('Google Chrome/Chromium was not found in /Applications.');

  const profileDir = path.join(CHROME_PROFILE_BASE_DIR, `run-${Date.now()}-${process.pid}`);
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(chrome, [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    BASE_URL,
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  const port = await waitForDevToolsPort(profileDir);
  const started = Date.now();
  console.log(chalk.cyan(`Chrome opened: ${BASE_URL}`));
  console.log(chalk.gray('Solve the captcha in Chrome. The CLI will read the HttpOnly cookie automatically.'));

  while (Date.now() - started < timeoutMs) {
    const cookie = await readCaptchaCookieFromChrome(port).catch(() => '');
    if (cookie) {
      COOKIE_HEADER = cookie;
      writeCookieFile(cookie);
      try { process.kill(-child.pid); } catch {}
      return cookie;
    }
    await sleep(1000);
  }

  throw new Error('Timed out waiting for captcha_verified_at cookie.');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function relaunchInTerminal(args) {
  if (process.platform !== 'darwin') {
    throw new Error('--via-terminal is only supported on macOS.');
  }

  const filteredArgs = args.filter((arg) => arg !== '--via-terminal');
  const command = [process.execPath, __filename, ...filteredArgs].map(shellQuote).join(' ');
  const logDir = path.dirname(LOG_FILE);
  const terminalCommand = `mkdir -p ${shellQuote(logDir)} && cd ${shellQuote(process.cwd())} && (QOBUZ_TERMINAL_LAUNCHED=1 ${command}; printf '\\nqobuz-dl exit code: %s\\n' "$?") 2>&1 | tee -a ${shellQuote(LOG_FILE)}`;
  const script = `tell application "Terminal" to do script ${JSON.stringify(terminalCommand)}`;

  execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
}

function getCookieHeader() {
  if (COOKIE_HEADER) return normalizeCookieHeader(COOKIE_HEADER);

  const fileCookie = readCookieFile();
  if (fileCookie) {
    COOKIE_HEADER = fileCookie;
    return COOKIE_HEADER;
  }

  const val = tryReadChromeCookie('squid.wtf', 'captcha_verified_at');
  if (val) {
    COOKIE_HEADER = `captcha_verified_at=${val}`;
    return COOKIE_HEADER;
  }

  return null;
}

function clearCookieHeader() {
  COOKIE_HEADER = '';
}

function readLine() {
  return new Promise((resolve) => {
    const onData = (data) => {
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve(data.toString().trim());
    };
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

function ask(question) {
  process.stdout.write(question);
  return readLine();
}

function showHelp() {
  console.log(chalk.bold('\nQobuz CLI Downloader\n'));
  console.log('Usage:');
  console.log('  qobuz-dl <playlist.m3u|playlist.txt|url> [options]\n');
  console.log('Options:');
  console.log('  -o, --output <dir>     Output directory (default: ./downloads)');
  console.log('  -q, --quality <id>     Quality: 27=Hi-Res, 7=FLAC 16-bit (default), 6=Lossless, 5=MP3');
  console.log('  -y, --yes              Auto-accept matches at or above --min-score');
  console.log('  -c, --confirm          Always ask before choosing a match');
  console.log('  --min-score <n>        Minimum score for -y (default: 1.5)');
  console.log('  --no-convert           Keep FLAC files instead of converting to WAV');
  console.log('  --login-cookie         Open Chrome and save the HttpOnly captcha cookie automatically');
  console.log('  --via-terminal         Relaunch in Terminal.app on macOS');
  console.log('  -h, --help             Show this help\n');
  console.log('Playlist formats:');
  console.log('  .m3u / .m3u8           #EXTINF lines: "#EXTINF:123,Artist - Title"');
  console.log('  .txt                   One "Artist - Title" per line\n');
  console.log('URL formats:');
  console.log('  Track URL:             https://play.qobuz.com/track/123456');
  console.log('  Album URL:             https://play.qobuz.com/album/abc123');
  console.log('  Spotify playlist:      https://open.spotify.com/playlist/...\n');
  console.log('Environment (.env):');
  console.log('  QOBUZ_BASE_URL         API base URL (default: https://qobuz.squid.wtf)');
  console.log('  QOBUZ_COOKIE           Optional Cookie header for backend download requests');
  console.log('                         (usually set automatically with --login-cookie)');
  console.log('  QOBUZ_COOKIE_FILE      Cookie file (default: ~/.qobuz-cookie)');
  console.log('  QOBUZ_OUTPUT_DIR       Output directory (default: ./downloads)');
  console.log('  QOBUZ_QUALITY          Default quality (default: 7)');
  console.log('  QOBUZ_ALWAYS_CONFIRM   Always ask confirmation (default: false)\n');
  process.exit(0);
}

function curlGetJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '--max-time', '30'];
    const cookie = options.cookie === false ? '' : getCookieHeader();
    if (cookie) args.push('-H', `Cookie: ${cookie}`);
    args.push(url);
    execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl failed${err.code ? ` (exit ${err.code})` : ''}`));
      const body = stdout.trim();
      if (body.startsWith('<!DOCTYPE') || body.startsWith('<html') || body.startsWith('<')) {
        return reject(new Error('Captcha required: server returned HTML instead of JSON.'));
      }
      try {
        const data = JSON.parse(body);
        if (!data.success && data.error) return reject(new Error(data.error));
        resolve(data.data);
      } catch (e) {
        reject(new Error(`JSON parse failed: ${e.message}`));
      }
    });
  });
}

function apiGet(endpoint, params = {}, options = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
    .join('&');
  const url = `${BASE_URL}/api/${endpoint}${qs ? '?' + qs : ''}`;
  return curlGetJson(url, options);
}

async function search(query) {
  return apiGet('get-music', { q: query, offset: 0 }, { cookie: false });
}

async function searchWithRetry(query, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await search(query);
    } catch (err) {
      lastErr = err;
      if (isCaptchaError(err)) {
        if (attempt < attempts) {
          await sleep(2000 * attempt);
          continue;
        }
        break;
      }
      if (attempt < attempts && err.message.includes('curl failed')) {
        await sleep(2000 * attempt);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

async function getAlbumInfo(albumId) {
  return apiGet('get-album', { album_id: albumId });
}

async function getDownloadUrl(trackId, quality) {
  const result = await apiGet('download-music', { track_id: trackId, quality });
  return result.url || result.track_url || result;
}

async function getDownloadUrlWithAuth(trackId, quality, attempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getDownloadUrl(trackId, quality);
    } catch (err) {
      lastErr = err;
      if (!isCaptchaError(err) || attempt >= attempts) break;
      clearCookieHeader();
      console.log(chalk.yellow('    Auth/Captcha refresh needed for download.'));
      await loginCookieWithChrome();
    }
  }
  throw lastErr;
}

function curlGetContentLength(url) {
  return new Promise((resolve) => {
    const args = ['-sI', '--max-time', '15', '-L'];
    const cookie = getCookieHeader();
    if (cookie) args.push('-H', `Cookie: ${cookie}`);
    args.push(url);
    execFile('curl', args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(0);
      const m = stdout.match(/content-length:\s*(\d+)/i);
      resolve(m ? parseInt(m[1]) : 0);
    });
  });
}

function curlDownload(url, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-L', '--max-time', '300'];
    const cookie = getCookieHeader();
    if (cookie) args.push('-H', `Cookie: ${cookie}`);
    args.push('-o', outputPath, url);

    const proc = spawn('curl', args);

    let lastPct = 0;

    proc.stderr.on('data', () => {});

    const checkSize = setInterval(() => {
      try {
        const stat = fs.statSync(outputPath);
        if (stat.size > 0 && onProgress) {
          onProgress(stat.size);
        }
      } catch {}
    }, 500);

    proc.on('close', (code) => {
      clearInterval(checkSize);
      try {
        const stat = fs.statSync(outputPath);
        if (stat.size > 0) onProgress(stat.size);
      } catch {}
      if (code === 0) resolve();
      else reject(new Error(`curl exited with code ${code}`));
    });

    proc.on('error', (err) => {
      clearInterval(checkSize);
      reject(err);
    });
  });
}

const TRACK_URL_REGEX = /https:\/\/(?:play|open)\.qobuz\.com\/track\/(\d+)/;
const ALBUM_URL_REGEX = /https:\/\/(?:play|open)\.qobuz\.com\/album\/([a-zA-Z0-9]+)/;
const SPOTIFY_PLAYLIST_URL_REGEX = /https:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/;

async function getSpotifyToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify credentials missing. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
  }

  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) throw new Error(`Spotify token failed: HTTP ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

async function getSpotifyPlaylistTracks(playlistUrl) {
  const playlistId = playlistUrl.match(SPOTIFY_PLAYLIST_URL_REGEX)?.[1];
  if (!playlistId) throw new Error('Invalid Spotify playlist URL.');

  const token = await getSpotifyToken();
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(name,artists(name)))`;
  const tracks = [];

  while (url) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Spotify playlist failed: HTTP ${response.status}`);
    const data = await response.json();
    for (const item of data.items || []) {
      const track = item.track;
      if (!track?.name || !track.artists?.length) continue;
      tracks.push(`${track.artists.map((artist) => artist.name).join(', ')} - ${track.name}`);
    }
    url = data.next;
  }

  return tracks;
}

function parsePlaylistFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  const tracks = [];

  if (ext === '.m3u' || ext === '.m3u8') {
    for (const line of content.split('\n')) {
      const m = line.match(/^#EXTINF:(-?\d+),\s*(.+)/);
      if (m && m[2].trim()) tracks.push(m[2].trim());
    }
  } else {
    for (const line of content.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (!line.startsWith('#')) tracks.push(line);
    }
  }

  return tracks;
}

function parseSearchLine(line) {
  const trimmed = line.trim();
  for (const sep of [' - ', ' – ', ' — ']) {
    const parts = trimmed.split(sep);
    if (parts.length >= 2) {
      const rawArtist = parts[0].trim();
      const fullTitle = parts.slice(1).join(sep).trim();
      const mainArtist = rawArtist.split(/[,&]|feat\.|ft\./)[0].trim();

      let title = stripMixSuffix(fullTitle);
      let extraArtist = '';
      const remixMatch = fullTitle.match(/(.+?)\s+-\s+(.+?)\s+Remix$/i);
      if (remixMatch) {
        title = remixMatch[1].trim();
        extraArtist = remixMatch[2].trim();
      }

      const queries = [ `${mainArtist} ${title}` ];
      if (extraArtist) {
        queries.push(`${mainArtist} ${title} ${extraArtist} Remix`);
        queries.push(`${mainArtist} ${title} (${extraArtist} Remix)`);
      }

      return { searchQuery: queries[queries.length - 1] || trimmed, artist: mainArtist, title, rawArtist, fullTitle, extraArtist, queries };
    }
  }
  return { searchQuery: trimmed, artist: '', title: trimmed, rawArtist: '', fullTitle: '', extraArtist: '', queries: [trimmed] };
}

function stripMixSuffix(title) {
  return title
    .replace(/\s*[-–—]\s*Original\s+(Mix|Version|Edit)$/i, '')
    .replace(/\s*\((Original\s+)?(Mix|Version|Edit)\)$/i, '')
    .replace(/\s*[-–—]\s*(Radio|Extended|Club|Album)\s+(Mix|Edit|Version)$/i, '')
    .trim();
}

function normalizeForMatch(value) {
  return stripMixSuffix(value || '')
    .toLowerCase()
    .replace(/\b(original|radio|extended|club|album)\s+(mix|edit|version)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreMatch(track, expectedArtist, expectedTitle) {
  const tArtist = normalizeForMatch(track.performer?.name || '');
  const tTitle = normalizeForMatch(track.title || '');
  const expA = normalizeForMatch(expectedArtist);
  const expT = normalizeForMatch(expectedTitle);

  const aSim = stringSimilarity.compareTwoStrings(tArtist, expA);
  const tSim = stringSimilarity.compareTwoStrings(tTitle, expT);
  const aInc = tArtist.includes(expA) || expA.includes(tArtist);
  const tInc = tTitle.includes(expT) || expT.includes(tTitle);

  let score = (aSim * 0.5) + (tSim * 0.5);
  if (aInc) score += 0.2;
  if (tInc) score += 0.2;
  if (aInc && tInc) score += 0.3;
  if (aSim > 0.95 && tSim > 0.95) score += 0.5;

  return { score, artist: tArtist === expA ? track.performer?.name : tArtist, title: tTitle === expT ? track.title : tTitle };
}

async function resolveAndChoose(line, autoAccept, minScore) {
  if (TRACK_URL_REGEX.test(line)) {
    const trackId = parseInt(line.match(TRACK_URL_REGEX)[1]);
    try {
      const albumData = await apiGet('get-album', { album_id: `track_${trackId}` }).catch(() => null);
      if (albumData?.tracks?.items?.[0]) {
        const t = albumData.tracks.items[0];
        console.log(chalk.green(`  ✓ ${t.performer?.name} - ${t.title}`));
        return { track: { ...t, album: albumData }, line };
      }
      const results = await searchWithRetry(trackId.toString());
      const t = results.tracks?.items?.[0];
      if (t) {
        console.log(chalk.green(`  ✓ ${t.performer?.name} - ${t.title}`));
        return { track: t, line };
      }
    } catch (err) {
      console.error(chalk.red(`  Failed: ${err.message}`));
    }
    return { track: null, line, skipped: true };
  }

  if (ALBUM_URL_REGEX.test(line)) {
    const albumId = line.match(ALBUM_URL_REGEX)[1];
    try {
      const album = await getAlbumInfo(albumId);
      const cnt = album.tracks?.items?.length || 0;
      console.log(chalk.green(`  ✓ Album: ${album.artist?.name} - ${album.title} (${cnt} tracks)`));
      return { album, line };
    } catch (err) {
      console.error(chalk.red(`  Failed: ${err.message}`));
    }
    return { track: null, line, skipped: true };
  }

  const { searchQuery, artist, title } = parseSearchLine(line);

  try {
    const results = await searchWithRetry(searchQuery);
    const tracks = (results.tracks?.items || []).filter((t) => t.streamable !== false);

    if (tracks.length === 0) {
      console.log(chalk.yellow(`  No results: "${line}"`));
      return { track: null, line, skipped: true };
    }

    const expArtist = artist || tracks[0]?.performer?.name || '';
    const expTitle = title || tracks[0]?.title || '';

    const scored = tracks
      .map((t) => ({ track: t, ...scoreMatch(t, expArtist, expTitle) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];

    if (autoAccept) {
      if (best.score >= minScore) {
        console.log(chalk.green(`  ✓ ${best.artist} - ${best.title}`) + chalk.gray(` (${Math.round(best.score * 100)}%)`));
        return { track: best.track, line };
      }
      console.log(chalk.red(`  ✗ ${line}`) + chalk.gray(` → ${best.artist} - ${best.title} (${Math.round(best.score * 100)}%, too low)`));
      return { track: null, line, skipped: true };
    }

    if (!alwaysConfirm && best.score > 1.2 && scored.length <= 2) {
      console.log(chalk.green(`  ✓ ${best.artist} - ${best.title}`) + chalk.gray(` (${Math.round(best.score * 100)}%)`));
      return { track: best.track, line };
    }

    if (scored.length === 1 && !alwaysConfirm) {
      console.log(chalk.green(`  ✓ ${best.artist} - ${best.title}`));
      return { track: best.track, line };
    }

    console.log(chalk.cyan(`\n  "${line}"`));
    console.log(chalk.gray('  ─────────────────────────────────────────'));

    for (let i = 0; i < Math.min(scored.length, 5); i++) {
      const { track: t, score, artist: a, title: ti } = scored[i];
      const album = t.album?.title || '';
      const q = t.hires ? 'Hi-Res' : t.maximum_bit_depth >= 16 ? 'Lossless' : 'Lossy';
      console.log(
        `  ${chalk.bold(`[${i + 1}]`)} ${chalk.white(a)} - ${chalk.white(ti)}` +
          chalk.gray(`  (${album}) [${q}] ${Math.round(score * 100)}%`)
      );
    }
    console.log(`  ${chalk.bold('[s]')} Skip  ${chalk.bold('[q]')} Quit`);

    while (true) {
      const answer = await ask(chalk.cyan('\n  Choose [1-5/s/q]: '));
      if (answer.toLowerCase() === 'q') process.exit(0);
      if (answer.toLowerCase() === 's') {
        console.log(chalk.yellow('  Skipped'));
        return { track: null, line, skipped: true };
      }
      const idx = parseInt(answer);
      if (idx >= 1 && idx <= Math.min(scored.length, 5)) {
        const chosen = scored[idx - 1];
        console.log(chalk.green(`  ✓ ${chosen.artist} - ${chosen.title}`));
        return { track: chosen.track, line };
      }
    }
  } catch (err) {
    console.error(chalk.red(`  Search failed: ${err.message}`));
    return { track: null, line, skipped: true };
  }
}

function isHtmlFile(filePath) {
  try {
    const buf = Buffer.alloc(512);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf-8').trim().toLowerCase();
    return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<!');
  } catch {
    return false;
  }
}

function isCaptchaError(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('captcha') || msg.includes('blocked') || msg.includes('forbidden') || msg.includes('challenge');
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${url}`, (err) => {
    if (err) console.error(chalk.red(`  Failed to open browser: ${err.message}`));
  });
}

async function handleServerCaptcha(track, artist, title) {
  console.log(chalk.yellow(`\n    ⚠ Captcha required`));

  if (COOKIE_HEADER) {
    console.log(chalk.red('    Cookie expired or is invalid.'));
    COOKIE_HEADER = '';
  }

  try {
    const cookie = await loginCookieWithChrome();
    if (cookie) {
      console.log(chalk.green(`    ✓ Cookie saved to ${COOKIE_FILE}`));
      return 'retry';
    }
  } catch (err) {
    console.log(chalk.red(`    Automatic cookie login failed: ${err.message}`));
    openBrowser(BASE_URL);
  }

  const input = await ask(chalk.cyan('    Paste a cookie or press Enter to retry: '));
  if (input) {
    COOKIE_HEADER = normalizeCookieHeader(input);
    writeCookieFile(COOKIE_HEADER);
    console.log(chalk.green(`    ✓ Cookie saved to ${COOKIE_FILE}`));
    return 'retry';
  }
  const answer = await ask(chalk.cyan('\n    [r] Retry  [s] Skip  [q] Quit: '));
  if (answer.toLowerCase() === 'q') process.exit(0);
  if (answer.toLowerCase() === 's') return 'skip';
  return 'retry';
}

async function downloadTrack(track, quality, outputDir, progressBar, progressPrefix, maxRetries = 5) {
  const artist = track.performer?.name || 'Unknown Artist';
  const title = track.title || 'Unknown Title';
  const trackId = track.id;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const downloadUrl = await getDownloadUrlWithAuth(trackId, quality);
      if (!downloadUrl) throw new Error('No download URL returned');

      progressBar.update(0, { prefix: `${progressPrefix} ...` });

      const tmp = path.join(outputDir, `.tmp_${trackId}.flac`);
      fs.mkdirSync(outputDir, { recursive: true });

      const totalSize = await curlGetContentLength(downloadUrl);
      if (totalSize > 0) progressBar.setTotal(totalSize);

      await curlDownload(downloadUrl, tmp, (downloaded) => {
        if (totalSize > 0) progressBar.update(downloaded);
        else progressBar.increment();
      });

      if (isHtmlFile(tmp)) {
        try { fs.unlinkSync(tmp); } catch {}
        throw new Error('Captcha required.');
      }

      return { tmp, artist, title, track };
    } catch (err) {
      if (attempt < maxRetries && isCaptchaError(err)) {
        const action = await handleServerCaptcha(track, artist, title);
        if (action === 'retry') { await sleep(3000); continue; }
        if (action === 'skip') throw new Error('Skipped (captcha)');
      }
      throw err;
    }
  }
}

function convertToWav(inputFile, outputFile) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-i', inputFile,
      '-ar', '44100', '-sample_fmt', 's16', '-acodec', 'pcm_s16le',
      outputFile,
    ]);
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exit ${code}`));
    });
    ffmpeg.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim();
}

async function processQueue(entries, quality, outputDir, convert, autoAccept, minScore) {
  let downloaded = 0, skipped = 0;
  const errors = [];
  const matchCache = readJsonFile(MATCH_CACHE_FILE, {});

  console.log(chalk.bold(`\n${chalk.cyan('═'.repeat(50))}`));
  console.log(chalk.bold(`  Processing ${entries.length} items`));
  console.log(chalk.gray(`  API:   ${BASE_URL}`));
  console.log(chalk.gray(`  Out:   ${path.resolve(outputDir)}`));
  console.log(chalk.gray(`  Qual:  ${quality} | Out: ${convert ? 'WAV 16/44.1' : 'FLAC'}`));
  console.log(chalk.bold(`${chalk.cyan('═'.repeat(50))}\n`));

  if (entries.length > 20) {
    console.log(chalk.bold.cyan('▶ Preparing download auth...'));
    console.log(chalk.gray('  Refreshing Captcha cookie before the long matching phase.'));
    await loginCookieWithChrome();
    console.log(chalk.green('  ✓ Download auth ready\n'));
  }

  console.log(chalk.bold.cyan('▶ Phase 1: Searching & matching...\n'));
  const allTracks = [];

  for (let i = 0; i < entries.length; i++) {
    const num = `[${String(i + 1).padStart(String(entries.length).length, ' ')}/${entries.length}]`;
    process.stdout.write(`  ${num} `);
    const cacheKey = matchCacheKey(entries[i], quality);
    let result = matchCache[cacheKey];
    if (result?.track) {
      console.log(chalk.gray(`↻ ${result.track.performer?.name || 'Unknown Artist'} - ${result.track.title || 'Unknown Title'} (cache)`));
    } else {
      result = await resolveAndChoose(entries[i], autoAccept, minScore);
      if (result.track || result.album || result.skipped) {
        matchCache[cacheKey] = result;
        writeJsonFile(MATCH_CACHE_FILE, matchCache);
      }
    }

    if (result.album) {
      for (const t of (result.album.tracks?.items || [])) {
        if (t.streamable !== false) {
          allTracks.push({
            track: { ...t, performer: t.performer || result.album.artist, album: result.album },
            line: `${result.album.artist?.name} - ${t.title}`,
          });
        }
      }
    } else if (result.track) {
      allTracks.push(result);
    }
    if (result.skipped) skipped++;
  }

  if (allTracks.length === 0) {
    console.log(chalk.yellow('\n  No tracks to download.'));
    return;
  }

  const multibar = new cliProgress.MultiBar({
    clearOnComplete: false, hideCursor: true,
    format: '  {prefix} {bar} {percentage}% | {value}/{total}',
    barCompleteChar: '\u2588', barIncompleteChar: '\u2591',
  }, cliProgress.Presets.shades_grey);

  console.log(chalk.bold.cyan(`\n▶ Phase 2: Downloading ${allTracks.length} tracks...\n`));

  for (let i = 0; i < allTracks.length; i++) {
    const { track, line } = allTracks[i];
    const artist = track.performer?.name || 'Unknown Artist';
    const title = track.title || 'Unknown Title';
    const num = `[${String(i + 1).padStart(String(allTracks.length).length, ' ')}/${allTracks.length}]`;
    const label = `${artist} - ${title}`.slice(0, 48);
    const progressPrefix = `  ${num} ${label}`;
    const ext = convert ? 'wav' : 'flac';
    const filename = cleanFilename(`${artist} - ${title}.${ext}`);
    const outPath = path.join(outputDir, filename);

    if (fs.existsSync(outPath)) {
      console.log(chalk.gray(`  ${num} ⏭ ${label} (exists)`));
      skipped++;
      continue;
    }

    const bar = multibar.create(100, 0, { prefix: progressPrefix });

    try {
      bar.update(0);
      const result = await downloadTrack(track, quality, outputDir, bar, progressPrefix);

      if (convert) {
        bar.update(100, { prefix: `  ${num} Converting...` });
        await convertToWav(result.tmp, outPath);
        try { fs.unlinkSync(result.tmp); } catch {}
      } else {
        fs.renameSync(result.tmp, outPath);
      }

      bar.update(100, { prefix: `  ${num} ${chalk.green('✓')} ${label}` });
      downloaded++;
    } catch (err) {
      bar.update(0, { prefix: `  ${num} ${chalk.red('✗')} ${label}` });
      errors.push({ line, error: err.message });
      console.error(chalk.red(`\n    ${err.message}`));
    }

    bar.stop();
  }

  multibar.stop();

  console.log(chalk.bold(`\n${chalk.cyan('═'.repeat(50))}`));
  console.log(chalk.bold(`  ${chalk.green('✓')} Downloaded: ${downloaded}  ${chalk.yellow('⊘')} Skipped: ${skipped}  ${chalk.red('✗')} Errors: ${errors.length}`));
  if (errors.length > 0) {
    console.log(chalk.red.bold('\n  Errors:'));
    for (const e of errors) console.log(chalk.red(`    - ${e.line}: ${e.error}`));
  }
  console.log();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) showHelp();

  if (args.includes('--login-cookie')) {
    try {
      await loginCookieWithChrome();
      console.log(chalk.green(`Cookie saved to ${COOKIE_FILE}`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`Cookie login failed: ${err.message}`));
      process.exit(1);
    }
  }

  if (args.includes('--via-terminal') && process.env.QOBUZ_TERMINAL_LAUNCHED !== '1') {
    try {
      relaunchInTerminal(args);
      console.log(chalk.green('Qobuz download was started in Terminal.app.'));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`Failed to start Terminal.app: ${err.message}`));
      process.exit(1);
    }
  }

  let input = null, outputDir = DEFAULT_OUTPUT_DIR, quality = DEFAULT_QUALITY;
  let autoAccept = false, convert = true, minScore = DEFAULT_MIN_SCORE;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' || arg === '--output') outputDir = args[++i];
    else if (arg === '-q' || arg === '--quality') quality = args[++i];
    else if (arg === '-y' || arg === '--yes') autoAccept = true;
    else if (arg === '-c' || arg === '--confirm') { autoAccept = false; alwaysConfirm = true; }
    else if (arg === '--no-convert') convert = false;
    else if (arg === '--login-cookie') continue;
    else if (arg === '--via-terminal') continue;
    else if (arg === '--min-score') minScore = parseFloat(args[++i]) || DEFAULT_MIN_SCORE;
    else if (!arg.startsWith('-')) input = arg;
  }

  if (!input) { console.error(chalk.red('No input specified.\n')); showHelp(); }

  if (!['27', '7', '6', '5'].includes(quality)) {
    console.error(chalk.red(`Invalid quality "${quality}". Use: 27, 7, 6, 5`));
    process.exit(1);
  }

  let entries;
  const ext = path.extname(input).toLowerCase();
  const isUrl = input.startsWith('http');

  if (SPOTIFY_PLAYLIST_URL_REGEX.test(input)) {
    entries = await getSpotifyPlaylistTracks(input);
    if (entries.length === 0) { console.log(chalk.yellow('No tracks in Spotify playlist.')); process.exit(0); }
    console.log(chalk.green(`Loaded ${entries.length} tracks from Spotify playlist`));
  } else if (isUrl) {
    entries = [input];
  } else if (['.m3u', '.m3u8', '.txt'].includes(ext)) {
    if (!fs.existsSync(input)) { console.error(chalk.red(`File not found: ${input}`)); process.exit(1); }
    entries = parsePlaylistFile(input);
    if (entries.length === 0) { console.log(chalk.yellow('No entries in file.')); process.exit(0); }
    console.log(chalk.green(`Loaded ${entries.length} tracks from ${input}`));
  } else {
    entries = [input];
  }

  await processQueue(entries, quality, outputDir, convert, autoAccept, minScore);
  process.exit(0);
}

main().catch((err) => {
  console.error(chalk.red(`\nFatal: ${err.message}`));
  process.exit(1);
});
