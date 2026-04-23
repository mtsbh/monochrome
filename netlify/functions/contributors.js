export default async (req, context) => {
    try {
        const response = await fetch('https://api.github.com/repos/monochrome-music/monochrome/contributors?per_page=100', {
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'monochrome-app',
            },
        });

        if (!response.ok) {
            return new Response(JSON.stringify({ error: 'upstream failed' }), {
                status: response.status,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
        }

        const data = await response.json();
        return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }
};

export const config = { path: '/api/contributors' };
