// netlify/functions/label.js

const QOBUZ_BASE = 'https://www.qobuz.com/api.json/0.2';

// In-memory token cache (survives warm Lambda invocations, resets on cold start)
let _cachedToken = null;

async function getQobuzToken() {
    // 1. Prefer static token if set
    if (process.env.QOBUZ_USER_AUTH_TOKEN) return process.env.QOBUZ_USER_AUTH_TOKEN;

    // 2. Return cached token from a previous auto-login in this Lambda instance
    if (_cachedToken) return _cachedToken;

    // 3. Auto-login using email + password from env
    const email = process.env.QOBUZ_USER_EMAIL;
    const password = process.env.QOBUZ_USER_PASSWORD;
    const appId = process.env.QOBUZ_APP_ID;
    if (!email || !password || !appId) {
        throw new Error('Qobuz credentials not configured. Set QOBUZ_USER_AUTH_TOKEN or QOBUZ_USER_EMAIL + QOBUZ_USER_PASSWORD + QOBUZ_APP_ID.');
    }

    const params = new URLSearchParams({ username: email, password, app_id: appId });
    const res = await fetch(`${QOBUZ_BASE}/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qobuz login failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    _cachedToken = data.user_auth_token;
    if (!_cachedToken) throw new Error('Qobuz login succeeded but no user_auth_token in response');
    return _cachedToken;
}

function similarity(a, b) {
    a = a.toLowerCase().replace(/[^a-z0-9 '\-]/g, '').trim();
    b = b.toLowerCase().replace(/[^a-z0-9 '\-]/g, '').trim();
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    const levenshtein = 1 - dp[m][n] / Math.max(m, n);
    // Weight by sqrt of length ratio to penalise length mismatches without being too harsh
    // "ukiyo"(5) vs "ukioto"(6): 0.67 * sqrt(0.83) = 0.61 — still too close, but combined with
    // the threshold this will reject borderline false matches while keeping good ones
    const lenRatio = Math.min(m, n) / Math.max(m, n);
    return levenshtein * Math.sqrt(lenRatio);
}


// Strip common label suffixes to improve fuzzy matching
// e.g. "Freude am Tanzen Recordings" → "Freude am Tanzen"
function normalizeLabelName(name) {
    return name
        .replace(/\s+(recordings?|records?|music|entertainment|label|group|inc\.?|ltd\.?|llc\.?|gmbh|b\.v\.?)$/i, '')
        .trim();
}

async function findQobuzLabel(name, token) {
    // Try slug-based direct lookup first (works for obscure labels that don't
    // surface in catalog/search). Try multiple slug variants to handle special chars.
    const makeSlug = (s) => s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const slugVariants = [...new Set([
        makeSlug(name),
        makeSlug(normalizeLabelName(name)),
        // For names starting with punctuation like "!K7", also try without it
        makeSlug(name.replace(/^[^a-zA-Z0-9]+/, '')),
    ])].filter(Boolean);

    for (const slug of slugVariants) {
        try {
            const slugUrl = new URL(`${QOBUZ_BASE}/label/get`);
            slugUrl.searchParams.set('slug', slug);
            slugUrl.searchParams.set('extra', 'albums');
            slugUrl.searchParams.set('albums_limit', '1');
            slugUrl.searchParams.set('app_id', process.env.QOBUZ_APP_ID);
            const slugRes = await fetch(slugUrl, { headers: { 'X-User-Auth-Token': token } });
            if (slugRes.ok) {
                const slugData = await slugRes.json();
                const l = slugData.label ?? slugData;
                if (l?.id && l?.name) {
                    const score = similarity(l.name, name);
                    if (l.name.toLowerCase() === name.toLowerCase() || score >= 0.8) {
                        console.log(`[label] Slug "${slug}" matched: "${l.name}" for query "${name}"`);
                        return { id: l.id, name: l.name, slug: l.slug };
                    }
                    console.log(`[label] Slug "${slug}" returned "${l.name}" (score ${score.toFixed(2)}) — rejecting`);
                }
            }
        } catch (e) {
            console.log(`[label] Slug lookup error for "${slug}":`, e.message);
        }
    }

    // Search with original, normalized, and leading-punctuation-stripped variants
    const queries = [name];
    const normalized = normalizeLabelName(name);
    if (normalized !== name) queries.push(normalized);
    // e.g. "!K7 Records" → also search "K7 Records"
    const stripped = name.replace(/^[^a-zA-Z0-9]+/, '').trim();
    if (stripped !== name && stripped !== normalized && stripped.length > 0) queries.push(stripped);

    const seen = new Map();
    for (const query of queries) {
        const url = new URL(`${QOBUZ_BASE}/catalog/search`);
        url.searchParams.set('query', query);
        url.searchParams.set('type', 'albums');
        url.searchParams.set('limit', '50');
        url.searchParams.set('app_id', process.env.QOBUZ_APP_ID);
        const res = await fetch(url, { headers: { 'X-User-Auth-Token': token } });
        if (!res.ok) continue;
        const data = await res.json();
        for (const album of data.albums?.items || []) {
            if (album.label?.id && !seen.has(album.label.id)) {
                // Score against both original and normalized name, take best
                const s1 = similarity(album.label.name, name);
                const s2 = similarity(normalizeLabelName(album.label.name), normalized);
                seen.set(album.label.id, { ...album.label, score: Math.max(s1, s2) });
            }
        }
    }
    if (!seen.size) return null;

    // Exact case-insensitive match wins regardless of Levenshtein score
    const nameLower = name.toLowerCase();
    const exactMatch = [...seen.values()].find(l => l.name.toLowerCase() === nameLower);
    if (exactMatch) return exactMatch;

    const scored = [...seen.values()].sort((a, b) => b.score - a.score);
    // Use 0.6 threshold for all names — exact match above already handles false positives
    // like "SARAW" → "Sarah Records" (not exact, so won't reach here with a passing score)
    return scored[0].score >= 0.65 ? scored[0] : null;
}

async function getQobuzLabelAlbums(labelId, labelName, offset, limit, token) {
    // Use label/get with extra=albums for strict label-only results
    const url = new URL(`${QOBUZ_BASE}/label/get`);
    url.searchParams.set('label_id', String(labelId));
    url.searchParams.set('extra', 'albums');
    url.searchParams.set('albums_limit', String(limit));
    url.searchParams.set('albums_offset', String(offset));
    url.searchParams.set('app_id', process.env.QOBUZ_APP_ID);
    const res = await fetch(url, { headers: { 'X-User-Auth-Token': token } });
    if (!res.ok) throw new Error(`Qobuz label/get failed: ${res.status}`);
    const data = await res.json();

    // label/get returns albums under data.albums.items
    if (data.albums?.items?.length) {
        return { albums: data.albums.items, total: data.albums.total || 0 };
    }

    // Fallback: catalog/search with label_id (less strict but works)
    const fallback = new URL(`${QOBUZ_BASE}/catalog/search`);
    fallback.searchParams.set('type', 'albums');
    fallback.searchParams.set('query', labelName);
    fallback.searchParams.set('label_id', String(labelId));
    fallback.searchParams.set('limit', String(limit));
    fallback.searchParams.set('offset', String(offset));
    fallback.searchParams.set('app_id', process.env.QOBUZ_APP_ID);
    const res2 = await fetch(fallback, { headers: { 'X-User-Auth-Token': token } });
    if (!res2.ok) throw new Error(`Qobuz catalog/search failed: ${res2.status}`);
    const data2 = await res2.json();
    return { albums: data2.albums?.items || [], total: data2.albums?.total || 0 };
}

const TIDAL_INSTANCES = [
    'https://eu-central.monochrome.tf',
    'https://us-west.monochrome.tf',
    'https://arran.monochrome.tf',
    'https://triton.squid.wtf',
    'https://api.monochrome.tf',
];

async function searchTidalAlbums(query) {
    const instances = [...TIDAL_INSTANCES].sort(() => Math.random() - 0.5);
    for (const base of instances) {
        try {
            const res = await fetch(`${base}/search/?al=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(2000) });
            if (!res.ok) continue;
            const data = await res.json();
            return data.data?.albums?.items ?? data.albums?.items ?? data.items ?? [];
        } catch { continue; }
    }
    return [];
}

// Convert a Qobuz album object to the normalized album shape used by the UI.
// If a TIDAL match is provided it takes precedence for id/cover (so the album
// page and TIDAL playback work), but we always keep Qobuz cover as fallback.
function qobuzAlbumToCard(qAlbum, tidalMatch = null) {
    const artistName = qAlbum.artist?.name || '';
    const qCover = qAlbum.image?.large || qAlbum.image?.small || qAlbum.image?.thumbnail || null;

    if (tidalMatch) {
        const cover = tidalMatch.cover ?? tidalMatch.album?.cover ?? tidalMatch.image ?? qCover;
        return {
            id: String(tidalMatch.id),
            title: tidalMatch.title,
            artist: {
                id: String(tidalMatch.artist?.id ?? tidalMatch.artists?.[0]?.id ?? ''),
                name: tidalMatch.artist?.name ?? tidalMatch.artists?.[0]?.name ?? artistName,
            },
            cover,
            releaseDate: tidalMatch.releaseDate ?? tidalMatch.streamStartDate ?? qAlbum.release_date_original ?? null,
            type: tidalMatch.type ?? null,
        };
    }

    // Qobuz-only: use Qobuz data. Cover is a full URL so getCoverUrl passes it through.
    // id is prefixed with "qobuz-" so the router can detect it and open the Qobuz page.
    return {
        id: `qobuz-${qAlbum.id}`,
        title: qAlbum.title,
        artist: { id: String(qAlbum.artist?.id ?? ''), name: artistName },
        cover: qCover,
        releaseDate: qAlbum.release_date_original ?? null,
        type: qAlbum.release_type ?? null,
        _qobuzOnly: true,
        _qobuzUrl: `https://play.qobuz.com/album/${qAlbum.id}`,
    };
}

async function matchOnTidal(qAlbum) {
    const artistName = qAlbum.artist?.name || '';
    const query = `${artistName} ${qAlbum.title}`.trim();
    const tidalAlbums = await searchTidalAlbums(query).catch(() => []);
    if (!tidalAlbums.length) return null;
    let best = null, bestScore = 0;
    for (const ta of tidalAlbums) {
        const tArtist = ta.artist?.name || (Array.isArray(ta.artists) ? ta.artists[0]?.name : '') || '';
        const score = similarity(qAlbum.title, ta.title || '') * 0.6 + similarity(artistName, tArtist) * 0.4;
        if (score > bestScore) { bestScore = score; best = ta; }
    }
    return bestScore >= 0.6 ? best : null;
}

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
};

exports.handler = async (event) => {
    const params = event.queryStringParameters || {};
    const offset = parseInt(params.offset || '0', 10);
    const limit = Math.min(parseInt(params.limit || '24', 10), 200);

    // Accept either ?name=LabelName or ?id=1347492 (Qobuz label ID)
    // Also accept a Qobuz URL as the name param: "https://play.qobuz.com/label/1347492"
    let name = params.name?.trim();
    let directId = params.id ? parseInt(params.id, 10) : null;

    // If name looks like a Qobuz label URL, extract the ID
    if (name) {
        const urlIdMatch = name.match(/play\.qobuz\.com\/label\/(\d+)/);
        if (urlIdMatch) {
            directId = parseInt(urlIdMatch[1], 10);
            name = null; // will fetch name from Qobuz
        }
    }

    if (!name && !directId) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing name or id parameter' }) };
    }

    let token;
    try {
        token = await getQobuzToken();
    } catch (err) {
        return { statusCode: 503, headers: corsHeaders, body: JSON.stringify({ error: err.message || 'Qobuz token not configured' }) };
    }

    let label;
    if (directId) {
        // Direct ID lookup — skip discovery entirely
        try {
            const url = new URL(`${QOBUZ_BASE}/label/get`);
            url.searchParams.set('label_id', String(directId));
            url.searchParams.set('extra', 'albums');
            url.searchParams.set('albums_limit', '1');
            url.searchParams.set('app_id', process.env.QOBUZ_APP_ID);
            const res = await fetch(url, { headers: { 'X-User-Auth-Token': token } });
            if (res.ok) {
                const data = await res.json();
                const l = data.label ?? data;
                if (l?.id && l?.name) label = { id: l.id, name: l.name, slug: l.slug };
            }
        } catch {}
        if (!label) {
            return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Label not found on Qobuz', label: null, albums: [], total: 0 }) };
        }
    } else {
        try {
            label = await findQobuzLabel(name, token);
        } catch {
            return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Qobuz label search failed' }) };
        }
    }

    if (!label) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Label not found on Qobuz', label: null, albums: [], total: 0 }) };
    }

    // Fetch Qobuz albums for this page, then attempt TIDAL matching in parallel.
    // Albums not found on TIDAL are still included using Qobuz data so the full
    // catalogue is visible (Qobuz fallback streaming handles playback via ISRC).
    const SCAN_BATCH = 50;
    const MAX_SCANNED = 300;
    const results = [];
    let qobuzOffset = offset;
    let qobuzTotal = null;

    try {
        while (results.length < limit && qobuzOffset - offset < MAX_SCANNED) {
            const batch = await getQobuzLabelAlbums(label.id, label.name, qobuzOffset, SCAN_BATCH, token);
            if (qobuzTotal === null) qobuzTotal = batch.total;
            if (!batch.albums.length) break;

            // Attempt TIDAL matching with a short per-batch timeout so a dead
            // proxy doesn't stall the whole function. Falls back to Qobuz-only.
            let tidalMatches;
            try {
                tidalMatches = await Promise.race([
                    Promise.all(batch.albums.map(qa => matchOnTidal(qa).catch(() => null))),
                    new Promise(resolve => setTimeout(() => resolve(null), 4000)),
                ]);
            } catch { tidalMatches = null; }

            for (let i = 0; i < batch.albums.length; i++) {
                results.push(qobuzAlbumToCard(batch.albums[i], tidalMatches?.[i] ?? null));
            }

            qobuzOffset += batch.albums.length;
            if (qobuzOffset >= batch.total) break;
        }
    } catch {
        return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to fetch label albums' }) };
    }

    const hasMore = qobuzTotal !== null && qobuzOffset < qobuzTotal;
    const page = results.slice(0, limit);

    return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=3600' },
        body: JSON.stringify({
            label: { id: label.id, name: label.name },
            albums: page,
            total: qobuzTotal ?? 0,
            matched: page.filter(a => !a._qobuzOnly).length,
            nextOffset: qobuzOffset,
            offset, limit, hasMore,
        }),
    };
};
