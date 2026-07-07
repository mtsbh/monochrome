// netlify/functions/qobuz-album.js
// Fetches a Qobuz album by numeric ID and returns metadata + tracks
// in the shape expected by renderAlbumPage.

const QOBUZ_BASE = 'https://www.qobuz.com/api.json/0.2';

let _cachedToken = null;

async function getQobuzToken() {
    if (process.env.QOBUZ_USER_AUTH_TOKEN) return process.env.QOBUZ_USER_AUTH_TOKEN;
    if (_cachedToken) return _cachedToken;
    const { QOBUZ_USER_EMAIL: email, QOBUZ_USER_PASSWORD: password, QOBUZ_APP_ID: appId } = process.env;
    if (!email || !password || !appId) throw new Error('Qobuz credentials not configured');
    const res = await fetch(`${QOBUZ_BASE}/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: email, password, app_id: appId }).toString(),
    });
    if (!res.ok) throw new Error(`Qobuz login failed: ${res.status}`);
    const data = await res.json();
    _cachedToken = data.user_auth_token;
    return _cachedToken;
}

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };

    const albumId = event.queryStringParameters?.id?.trim();
    if (!albumId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing id' }) };

    let token;
    try { token = await getQobuzToken(); }
    catch (err) { return { statusCode: 503, headers: corsHeaders, body: JSON.stringify({ error: err.message }) }; }

    try {
        const url = new URL(`${QOBUZ_BASE}/album/get`);
        url.searchParams.set('album_id', albumId);
        url.searchParams.set('extra', 'track_ids,albumsFromSameArtist');
        url.searchParams.set('app_id', process.env.QOBUZ_APP_ID);

        const res = await fetch(url.toString(), { headers: { 'X-User-Auth-Token': token } });
        if (!res.ok) return { statusCode: res.status, headers: corsHeaders, body: JSON.stringify({ error: `Qobuz error: ${res.status}` }) };

        const q = await res.json();

        const cover = q.image?.large || q.image?.small || q.image?.thumbnail || null;

        const album = {
            id: `qobuz-${q.id}`,
            title: q.title,
            cover,
            releaseDate: q.release_date_original || null,
            copyright: q.copyright || null,
            artist: { id: String(q.artist?.id ?? ''), name: q.artist?.name || '' },
            label: q.label ? { id: q.label.id, name: q.label.name } : null,
        };

        const tracks = (q.tracks?.items || []).map((t, i) => ({
            id: `qobuz-${t.id}`,
            title: t.title,
            trackNumber: t.track_number ?? i + 1,
            discNumber: t.media_number ?? 1,
            duration: t.duration ?? 0,
            isrc: t.isrc || null,
            explicit: t.parental_warning ?? false,
            copyright: t.copyright || q.copyright || null,
            artist: { id: String(t.performer?.id ?? q.artist?.id ?? ''), name: t.performer?.name || q.artist?.name || '' },
            artists: t.performers
                ? t.performers.split(' - ').map(p => ({ id: '', name: p.trim().replace(/,.*/, '') }))
                : [{ id: String(t.performer?.id ?? ''), name: t.performer?.name || q.artist?.name || '' }],
            album: { id: `qobuz-${q.id}`, title: q.title, cover },
            _qobuzOnly: true,
        }));

        return {
            statusCode: 200,
            headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=3600' },
            body: JSON.stringify({ album, tracks }),
        };
    } catch (err) {
        return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
    }
};
