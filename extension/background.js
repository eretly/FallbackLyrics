const ALLOWED = /^https:\/\/(?:lrclib\.net|api\.lyrics\.ovh|genius\.com|api\.genius\.com|txtsong\.ru|[a-z0-9-]+\.translate\.goog)\//i;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'PS_FETCH' || typeof msg.url !== 'string') return;

    if (!ALLOWED.test(msg.url)) {
        sendResponse({ error: 'Blocked URL' });
        return;
    }

    (async () => {
        try {
            const res = await fetch(msg.url, {
                method: msg.method || 'GET',
                headers: msg.headers || {},
                credentials: 'omit',
                redirect: 'follow',
            });
            const text = await res.text();
            sendResponse({
                status: res.status,
                statusText: res.statusText,
                contentType: res.headers.get('content-type') || 'application/octet-stream',
                text,
            });
        } catch (e) {
            sendResponse({ error: String((e && e.message) || e) });
        }
    })();

    return true;
});
