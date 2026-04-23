const SELF_PROXY = '/api/audio-proxy';
const FALLBACK_PROXY = 'https://audio-proxy.binimum.org/proxy-audio';

export const getProxyUrl = (url) => {
    if (!url || typeof url !== 'string') return url;
    if (window.__tidalOriginExtension) return url;
    if (url.startsWith('blob:')) return url;
    if (url.startsWith(SELF_PROXY) || url.startsWith(FALLBACK_PROXY)) return url;
    return `${SELF_PROXY}?url=${encodeURIComponent(url)}`;
};
