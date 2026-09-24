const ALLOWED_HOSTS = [
    'tidal.com',
    'audio.tidal.com',
    'sp-pr.audio.tidal.com',
    'sp-fa.audio.tidal.com',
    'resources.tidal.com',
    'akamaized.net',
    'qobuz.com',
    'streaming.qobuz.com',
    'squid.wtf',
    'dzcdn.net',
];

function isAllowed(url) {
    try {
        const { hostname } = new URL(url);
        return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
    } catch {
        return false;
    }
}

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Type',
};

export default async (request) => {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');

    if (!target || !isAllowed(target)) {
        return new Response('Forbidden', { status: 403 });
    }

    const rangeHeader = request.headers.get('Range');
    const upstream = await fetch(target, {
        headers: {
            ...(rangeHeader ? { Range: rangeHeader } : {}),
        },
    });

    // Some backends (e.g. deemix.squid.wtf) ignore Range and answer 200 with the
    // full body and no Accept-Ranges. HTML5 <audio> needs a 206 to stream/seek,
    // so synthesize one. Streaming backends that already return 206 fall through
    // to the plain relay below untouched.
    if (rangeHeader && upstream.status === 200 && !upstream.headers.get('content-range')) {
        const total = Number(upstream.headers.get('content-length')) || 0;
        const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        const start = m ? parseInt(m[1], 10) : 0;

        // Initial progressive request (bytes=0-): stream the body straight
        // through as a 206 without buffering the whole file into memory.
        if (start === 0 && total > 0) {
            const headers = new Headers(upstream.headers);
            headers.set('Content-Range', `bytes 0-${total - 1}/${total}`);
            headers.set('Content-Length', String(total));
            headers.set('Accept-Ranges', 'bytes');
            for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
            return new Response(upstream.body, { status: 206, headers });
        }

        // Seek request (start > 0): buffer then slice.
        const buf = new Uint8Array(await upstream.arrayBuffer());
        const totalBytes = buf.byteLength;
        const safeStart = Math.min(start, Math.max(0, totalBytes - 1));
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), totalBytes - 1) : totalBytes - 1;
        const slice = buf.subarray(safeStart, end + 1);
        const headers = new Headers();
        headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
        headers.set('Content-Length', String(slice.byteLength));
        headers.set('Content-Range', `bytes ${safeStart}-${end}/${totalBytes}`);
        headers.set('Accept-Ranges', 'bytes');
        for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
        return new Response(slice, { status: 206, headers });
    }

    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);

    return new Response(upstream.body, {
        status: upstream.status,
        headers,
    });
};
