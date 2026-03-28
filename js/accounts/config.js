//js/accounts/config.js
import PocketBase from 'pocketbase';

const getPocketBaseURL = () => {
    const local = localStorage.getItem('monochrome-pocketbase-url');
    if (local) return local;

    if (window.__POCKETBASE_URL__) return window.__POCKETBASE_URL__;

    return 'https://pb.ahbh.top';
};

const pbUrl = getPocketBaseURL();

// If the active PocketBase URL changed since last load, clear stale auth tokens
// so the new instance doesn't pick up credentials that belong to a different server.
const _lastPbUrl = localStorage.getItem('monochrome-pb-url-active');
if (_lastPbUrl && _lastPbUrl !== pbUrl) {
    // Remove all known PocketBase auth keys before creating the new client
    localStorage.removeItem('pb_auth');
    localStorage.removeItem('pocketbase_auth');
}
localStorage.setItem('monochrome-pb-url-active', pbUrl);

const pb = new PocketBase(pbUrl);
pb.autoCancellation(false);

export { pb };
