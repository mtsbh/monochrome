// netlify/functions/label-art.js
// Fetches label artwork from Discogs by label name.
// Uses personal access token if DISCOGS_TOKEN is set (60 req/min),
// otherwise falls back to unauthenticated (25 req/min).

const DISCOGS_BASE = 'https://api.discogs.com';
const USER_AGENT = 'Monochrome/1.0 +https://monochrome.netlify.app';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders, body: '' };
    }

    const name = event.queryStringParameters?.name?.trim();
    if (!name) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing name' }) };
    }

    const headers = { 'User-Agent': USER_AGENT };
    if (process.env.DISCOGS_TOKEN) {
        headers['Authorization'] = `Discogs token=${process.env.DISCOGS_TOKEN}`;
    }

    try {
        const url = new URL(`${DISCOGS_BASE}/database/search`);
        url.searchParams.set('q', name);
        url.searchParams.set('type', 'label');
        url.searchParams.set('per_page', '5');

        const res = await fetch(url.toString(), { headers });
        if (!res.ok) {
            return { statusCode: res.status, headers: corsHeaders, body: JSON.stringify({ error: `Discogs error: ${res.status}` }) };
        }

        const data = await res.json();
        const results = data.results || [];

        // Find best match: exact name first, then first result
        const nameLower = name.toLowerCase();
        const exact = results.find(r => r.title?.toLowerCase() === nameLower);
        const best = exact || results[0];

        if (!best?.thumb) {
            return { statusCode: 200, headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=86400' }, body: JSON.stringify({ thumb: null }) };
        }

        return {
            statusCode: 200,
            headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=86400' },
            body: JSON.stringify({ thumb: best.thumb, name: best.title, id: best.id }),
        };
    } catch (err) {
        return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
    }
};
