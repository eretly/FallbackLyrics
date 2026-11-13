(function () {
    'use strict';

    if (window.__psFetchBridgeInstalled) return;
    window.__psFetchBridgeInstalled = true;

    const nativeFetch = window.fetch.bind(window);
    const canBridge = () => typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

    function normalizeHeaders(headers) {
        const out = {};
        if (!headers) return out;
        if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
            headers.forEach((value, key) => { out[key] = value; });
            return out;
        }
        if (Array.isArray(headers)) {
            for (const [key, value] of headers) out[key] = value;
            return out;
        }
        return Object.assign(out, headers);
    }

    window.fetch = async function (input, init) {
        const opts = init || {};
        const url = typeof input === 'string' ? input : (input && input.url) || '';

        let sameOrigin = true;
        try {
            sameOrigin = new URL(url, location.href).origin === location.origin;
        } catch (_) {}

        if (!url || sameOrigin || !canBridge()) return nativeFetch(input, init);

        const signal = opts.signal;
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

        let reply;
        try {
            reply = await chrome.runtime.sendMessage({
                type: 'PS_FETCH',
                url,
                method: opts.method || 'GET',
                headers: normalizeHeaders(opts.headers),
            });
        } catch (_) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            return nativeFetch(input, init);
        }

        if (!reply) return nativeFetch(input, init);
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (reply.error) throw new Error(reply.error);

        return new Response(reply.text || '', {
            status: reply.status || 200,
            statusText: reply.statusText || '',
            headers: { 'Content-Type': reply.contentType || 'text/plain' },
        });
    };
})();
