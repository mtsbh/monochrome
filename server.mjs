// Self-hosted replacement for Netlify: serves the built app from dist/ and runs
// the functions in netlify/ with the same routes netlify.toml defines.
//
//   npm run build:netlify && npm run serve
//
// Env (read from .env if present): MONOCHROME_PORT (default 8888),
// MONOCHROME_HOST (default 127.0.0.1), plus the QOBUZ_* / DISCOGS_TOKEN keys the
// functions use.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const require = createRequire(import.meta.url);

try {
    process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
    // No .env: rely on the real environment.
}

const PORT = Number(process.env.MONOCHROME_PORT) || 8888;
const HOST = process.env.MONOCHROME_HOST || '127.0.0.1';

// Netlify v1 functions: exports.handler(event) -> { statusCode, headers, body }.
const v1 = (file) => ({ kind: 'v1', file: path.join(ROOT, 'netlify/functions', file) });
// Netlify v2 / edge functions: export default (Request) -> Response.
const v2 = (file) => ({ kind: 'v2', file: path.join(ROOT, 'netlify', file) });

const FUNCTIONS = {
    label: v1('label.cjs'),
    'label-art': v1('label-art.cjs'),
    'qobuz-album': v1('qobuz-album.cjs'),
    contributors: v2('functions/contributors.js'),
    'qobuz-stream': v2('functions/qobuz-stream.js'),
    'audio-proxy': v2('edge-functions/audio-proxy.js'),
};

// Mirrors the redirects / config.path entries in netlify.toml and the functions.
const ROUTES = {
    '/api/label': 'label',
    '/api/contributors': 'contributors',
    '/api/get-music': 'qobuz-stream',
    '/api/download-music': 'qobuz-stream',
    '/api/audio-proxy': 'audio-proxy',
};

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml',
};

const loaded = new Map();
async function loadHandler(name) {
    if (loaded.has(name)) return loaded.get(name);
    const fn = FUNCTIONS[name];
    const handler =
        fn.kind === 'v1' ? require(fn.file).handler : (await import(pathToFileURL(fn.file).href)).default;
    if (typeof handler !== 'function') throw new Error(`Function ${name} has no handler`);
    loaded.set(name, handler);
    return handler;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function runV1(handler, req, url, body) {
    const query = Object.fromEntries(url.searchParams);
    const multi = {};
    for (const [k, v] of url.searchParams) (multi[k] ||= []).push(v);

    const result = await handler({
        httpMethod: req.method,
        path: url.pathname,
        rawUrl: url.href,
        rawQuery: url.search.slice(1),
        headers: req.headers,
        queryStringParameters: query,
        multiValueQueryStringParameters: multi,
        body: body.length ? body.toString('utf8') : null,
        isBase64Encoded: false,
    });

    const headers = { ...(result?.headers || {}) };
    for (const [k, values] of Object.entries(result?.multiValueHeaders || {})) headers[k] = values;
    const payload = result?.body ?? '';
    return {
        status: result?.statusCode || 200,
        headers,
        body: result?.isBase64Encoded ? Buffer.from(payload, 'base64') : payload,
    };
}

async function runV2(handler, req, url, body, res) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((item) => headers.append(k, item));
        else if (v != null) headers.set(k, v);
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method) && body.length > 0;
    const request = new Request(url.href, { method: req.method, headers, body: hasBody ? body : undefined });

    const response = await handler(request, { params: {}, geo: {}, ip: req.socket.remoteAddress });
    if (!(response instanceof Response)) throw new Error('Function did not return a Response');

    const outHeaders = {};
    response.headers.forEach((value, key) => {
        // fetch() already decoded the body, so upstream encoding/length headers would be wrong.
        if (key !== 'content-encoding' && key !== 'transfer-encoding') outHeaders[key] = value;
    });
    if (response.headers.get('content-encoding')) delete outHeaders['content-length'];
    res.writeHead(response.status, outHeaders);

    if (!response.body || req.method === 'HEAD') return res.end();
    const stream = Readable.fromWeb(response.body);
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
}

async function runFunction(name, req, res, url) {
    const handler = await loadHandler(name);
    const body = await readBody(req);
    if (FUNCTIONS[name].kind === 'v2') return runV2(handler, req, url, body, res);
    const out = await runV1(handler, req, url, body);
    res.writeHead(out.status, out.headers);
    res.end(out.body);
}

function sendFile(res, filePath, req) {
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const isHashedAsset = filePath.startsWith(path.join(DIST, 'assets') + path.sep);
    res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
}

function serveStatic(req, res, url) {
    let rel;
    try {
        rel = decodeURIComponent(url.pathname);
    } catch {
        res.writeHead(400).end('Bad request');
        return;
    }
    const filePath = path.normalize(path.join(DIST, rel));
    if (!filePath.startsWith(DIST)) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    const candidates = [filePath, path.join(filePath, 'index.html')];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return sendFile(res, candidate, req);
    }
    // SPA fallback, same as the "/*" -> /index.html redirect in netlify.toml.
    sendFile(res, path.join(DIST, 'index.html'), req);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    try {
        const fnMatch = url.pathname.match(/^\/\.netlify\/functions\/([\w-]+)\/?$/);
        const name = fnMatch ? fnMatch[1] : ROUTES[url.pathname.replace(/\/+$/, '')];
        if (name) {
            if (!FUNCTIONS[name]) {
                res.writeHead(404).end('Unknown function');
                return;
            }
            await runFunction(name, req, res, url);
            return;
        }
        serveStatic(req, res, url);
    } catch (err) {
        console.error(`[${req.method} ${url.pathname}]`, err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error');
    }
});

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist/index.html not found - run "npm run build:netlify" first.');
    process.exit(1);
}

server.listen(PORT, HOST, () => {
    console.log(`Monochrome serving on http://${HOST}:${PORT}`);
});
