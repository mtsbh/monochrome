const ALLOWED_HOSTS = [
    'tidal.com',
    'audio.tidal.com',
    'sp-pr.audio.tidal.com',
    'sp-fa.audio.tidal.com',
    'resources.tidal.com',
];

function isAllowed(url) {
    try {
        const { hostname } = new URL(url);
        return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
    } catch {
        return false;
    }
}

export default async (request) => {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Range, Content-Type',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
            },
        });
    }

    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');

    if (!target || !isAllowed(target)) {
        return new Response('Forbidden', { status: 403 });
    }

    const upstream = await fetch(target, {
        headers: {
            ...(request.headers.get('Range') ? { Range: request.headers.get('Range') } : {}),
        },
    });

    const headers = new Headers(upstream.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Headers', 'Range, Content-Type');

    return new Response(upstream.body, {
        status: upstream.status,
        headers,
    });
};

export const config = { path: '/api/audio-proxy' };
