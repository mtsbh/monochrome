// netlify/functions/qobuz-stream.js
// Self-hosted Qobuz stream proxy.
//
// Implements the two endpoints the frontend's getQobuzStreamUrl /
// getQobuzStreamUrlByTrackId already call:
//   GET /api/get-music?q=<isrc>&offset=0
//   GET /api/download-music?track_id=<id>&quality=<5|6|7|27>
// so it can be added as a `qobuz` instance with zero client changes.
//
// app_id + app_secret are derived at runtime from the public Qobuz web
// bundle (the same approach qobuz-dl / octo-fiesta use), so no
// QOBUZ_APP_SECRET env var is required. A Qobuz account is still needed for
// full-quality URLs: set QOBUZ_USER_AUTH_TOKEN, or QOBUZ_USER_EMAIL +
// QOBUZ_USER_PASSWORD (+ optional QOBUZ_APP_ID) — same vars as qobuz-album.js.

import crypto from 'node:crypto';

const QOBUZ_BASE = 'https://www.qobuz.com/api.json/0.2';
const PLAY_ORIGIN = 'https://play.qobuz.com';
const APP_TTL_MS = 12 * 60 * 60 * 1000;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

let _appCache = null; // { appId, secrets: [...], ts }
let _tokenCache = null; // user_auth_token
let _goodSecret = null; // last secret that successfully signed a request

// --- Derive app_id + candidate app_secrets from the Qobuz web bundle ---
async function getApp() {
    if (process.env.QOBUZ_APP_ID && process.env.QOBUZ_APP_SECRET) {
        return { appId: process.env.QOBUZ_APP_ID, secrets: [process.env.QOBUZ_APP_SECRET] };
    }
    if (_appCache && Date.now() - _appCache.ts < APP_TTL_MS) return _appCache;

    const loginHtml = await (await fetch(`${PLAY_ORIGIN}/login`, { headers: { 'User-Agent': USER_AGENT } })).text();
    const bm = loginHtml.match(/<script src="(\/resources\/[\d.]+-[a-z]\d{3}\/bundle\.js)"><\/script>/);
    if (!bm) throw new Error('Could not locate Qobuz bundle.js');
    const bundle = await (await fetch(`${PLAY_ORIGIN}${bm[1]}`, { headers: { 'User-Agent': USER_AGENT } })).text();

    const appId = (bundle.match(/production:\{api:\{appId:"(\d{9})"/) || [])[1];
    if (!appId) throw new Error('Could not extract Qobuz app_id from bundle');

    const secrets = [];
    const embedded = (bundle.match(/production:\{api:\{appId:"\d{9}",appSecret:"([a-z0-9]{32})"/) || [])[1];
    if (embedded) secrets.push(embedded);

    // seed + info + extras per timezone -> base64-decode((seed+info+extras) minus last 44 chars)
    const seeds = {};
    let m;
    const seedRe = /[a-z]\.initialSeed\("([\w=]+)",window\.utimezone\.([a-z]+)\)/g;
    while ((m = seedRe.exec(bundle))) seeds[m[2]] = m[1];
    const infos = {};
    const infoRe = /name:"[A-Za-z]+\/([A-Za-z]+)",info:"([\w=]+)",extras:"([\w=]+)"/g;
    while ((m = infoRe.exec(bundle))) infos[m[1].toLowerCase()] = { info: m[2], extras: m[3] };
    for (const tz of Object.keys(seeds)) {
        if (!infos[tz]) continue;
        const combined = seeds[tz] + infos[tz].info + infos[tz].extras;
        try {
            const dec = Buffer.from(combined.slice(0, -44), 'base64').toString('utf8');
            if (/^[a-z0-9]{32}$/.test(dec) && !secrets.includes(dec)) secrets.push(dec);
        } catch {
            // ignore malformed candidate
        }
    }
    if (secrets.length === 0) throw new Error('Could not derive any Qobuz app_secret candidates');

    _appCache = { appId, secrets, ts: Date.now() };
    return _appCache;
}

// --- Qobuz user auth token (same logic as qobuz-album.js) ---
async function getToken(appId) {
    if (process.env.QOBUZ_USER_AUTH_TOKEN) return process.env.QOBUZ_USER_AUTH_TOKEN;
    if (_tokenCache) return _tokenCache;
    const { QOBUZ_USER_EMAIL: email, QOBUZ_USER_PASSWORD: password } = process.env;
    if (!email || !password) return null; // anonymous — getFileUrl will 401 for full quality
    const res = await fetch(`${QOBUZ_BASE}/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: new URLSearchParams({ username: email, password, app_id: appId }).toString(),
    });
    if (!res.ok) throw new Error(`Qobuz login failed: ${res.status}`);
    const data = await res.json();
    _tokenCache = data.user_auth_token;
    return _tokenCache;
}

function qobuzHeaders(appId, token) {
    const h = { 'X-App-Id': appId, 'User-Agent': USER_AGENT };
    if (token) h['X-User-Auth-Token'] = token;
    return h;
}

// --- /api/get-music?q=<isrc> : search by ISRC, return client-expected shape ---
async function handleSearch(isrc) {
    const app = await getApp();
    const token = await getToken(app.appId);
    const url = new URL(`${QOBUZ_BASE}/catalog/search`);
    url.searchParams.set('query', isrc);
    url.searchParams.set('type', 'tracks');
    url.searchParams.set('limit', '25');
    url.searchParams.set('app_id', app.appId);

    const res = await fetch(url.toString(), { headers: qobuzHeaders(app.appId, token) });
    if (!res.ok) return json({ error: `Qobuz search ${res.status}` }, res.status);
    const data = await res.json();
    const items = data?.tracks?.items || [];
    // client reads trackJson.data.tracks.items[].{id,isrc,audio_info}
    return json({ data: { tracks: { items } } });
}

// --- /api/download-music?track_id=<id>&quality=<fmt> : signed getFileUrl ---
async function handleDownload(trackId, formatId) {
    const app = await getApp();
    const token = await getToken(app.appId);

    // try the known-good secret first, then the rest
    const ordered = _goodSecret ? [_goodSecret, ...app.secrets.filter((s) => s !== _goodSecret)] : app.secrets;

    let lastBody = null;
    let lastStatus = 0;
    for (const secret of ordered) {
        const ts = Math.floor(Date.now() / 1000);
        const sig = md5(`trackgetFileUrlformat_id${formatId}intentstreamtrack_id${trackId}${ts}${secret}`);
        const url = new URL(`${QOBUZ_BASE}/track/getFileUrl`);
        url.searchParams.set('request_ts', String(ts));
        url.searchParams.set('request_sig', sig);
        url.searchParams.set('track_id', String(trackId));
        url.searchParams.set('format_id', String(formatId));
        url.searchParams.set('intent', 'stream');

        const res = await fetch(url.toString(), { headers: qobuzHeaders(app.appId, token) });
        const body = await res.json().catch(() => ({}));
        lastStatus = res.status;
        lastBody = body;

        // Wrong secret -> 400 "Invalid Request Signature": try the next candidate.
        if (res.status === 400 && /request_sig/i.test(body?.message || '')) continue;

        // Correct signature.
        _goodSecret = secret;
        if (res.ok && body?.url) {
            return json({ success: true, data: { url: body.url, sample: !!body.sample, format_id: body.format_id } });
        }
        // Signature fine but Qobuz refused (e.g. 401 no token, 200 with no url).
        return json({ success: false, error: body?.message || 'No stream URL returned' }, res.status === 200 ? 502 : res.status);
    }
    return json({ success: false, error: lastBody?.message || 'All app_secret candidates rejected' }, lastStatus || 502);
}

export default async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: { ...JSON_HEADERS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Range, Content-Type' },
        });
    }

    const { searchParams, pathname } = new URL(req.url);
    try {
        if (/download-music/.test(pathname) || searchParams.has('track_id')) {
            const trackId = (searchParams.get('track_id') || '').trim();
            if (!trackId) return json({ error: 'Missing track_id' }, 400);
            const formatId = (searchParams.get('quality') || '6').trim();
            return await handleDownload(trackId, formatId);
        }
        const isrc = (searchParams.get('q') || '').trim();
        if (!isrc) return json({ error: 'Missing q (ISRC)' }, 400);
        return await handleSearch(isrc);
    } catch (err) {
        return json({ error: err.message }, 502);
    }
};

export const config = { path: ['/api/get-music', '/api/download-music'] };
