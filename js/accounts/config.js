//js/accounts/config.js
import PocketBase from 'pocketbase';

const getPocketBaseURL = () => {
    const local = localStorage.getItem('monochrome-pocketbase-url');
    if (local) return local;

    if (window.__POCKETBASE_URL__) return window.__POCKETBASE_URL__;

    const hostname = window.location.hostname;
    // Default to the user's custom server if on Netlify or samidy.com
    if (hostname.includes('netlify.app') || hostname.includes('samidy.com')) {
        return 'https://pb.ahbh.top';
    }
    
    // Default fallback
    return 'https://pb.ahbh.top';
};

const pb = new PocketBase(getPocketBaseURL());
pb.autoCancellation(false);

// Compatibility shim for upstream features (parties, theme REST store, health
// check) that were built on the better-auth migration we don't run. Defaults to
// the PocketBase URL so those features degrade gracefully; override via
// window.__AUTH_URL__ or localStorage('monochrome-auth-url') to point at a real
// party/auth server if one is ever deployed.
const getAuthBaseURL = () => {
    const local = localStorage.getItem('monochrome-auth-url');
    if (local) return local;
    if (window.__AUTH_URL__) return window.__AUTH_URL__;
    return getPocketBaseURL();
};

export const AUTH_BASE_URL = getAuthBaseURL();

export { pb };
