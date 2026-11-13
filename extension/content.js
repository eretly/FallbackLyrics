(function () {
    'use strict';

    // ================== НАСТРОЙКИ ==================
    const S = {
        longPressMs: 800,
    };

    try {
        const injected = window.PulseSyncSettings || window.pulsesyncSettings;
        if (injected && typeof injected === 'object') Object.assign(S, injected);
        if (typeof S.longPressMs === 'number' && S.longPressMs > 0 && S.longPressMs < 50) {
            S.longPressMs = S.longPressMs * 1000;
        }
        if (typeof S.longPressMs !== 'number' || !(S.longPressMs > 0)) S.longPressMs = 800;
    } catch (_) {}

    let currentTrackKey = '';
    let currentTrack = null;
    let ourModeActive = false;
    let syncTimerId = null;
    let syncLines = null;
    let ovPressed = false;

    let pressState = null;
    let longPressTimer = null;
    let suppressNextClick = false;

    let dockSourceStates = new Map();
    let dockActiveSource = null;
    let dockTrack = null;
    let dockAbort = null;
    let loadGeneration = 0;
    let statusTimer = null;

    // ================== СТИЛЬ ==================
    function injectForceStyleOnce() {
        if (document.getElementById('ps-lyrics-force-style')) return;
        const st = document.createElement('style');
        st.id = 'ps-lyrics-force-style';
        st.textContent = `
            html body .ps-force-enabled {
                cursor: pointer !important;
                pointer-events: auto !important;
                opacity: 1 !important;
                filter: none !important;
            }

            html body .ps-force-enabled,
            html body .ps-force-enabled *,
            html body .ps-force-enabled svg,
            html body .ps-force-enabled svg use {
                color: var(--ym-controls-color-secondary-text-enabled, inherit) !important;
                fill: currentColor !important;
            }

            html body .ps-force-enabled.ps-force-hover,
            html body .ps-force-enabled.ps-force-hover *,
            html body .ps-force-enabled.ps-force-hover svg,
            html body .ps-force-enabled.ps-force-hover svg use {
                color: var(--ym-controls-color-secondary-text-hovered,
                        var(--ym-controls-color-secondary-text-enabled, inherit)) !important;
                fill: currentColor !important;
            }
        `;
        document.head.appendChild(st);
    }
    injectForceStyleOnce();

    // ================== TRANSLIT ==================
    const TRANSLIT_MAP = {
        'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i',
        'й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t',
        'у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'',
        'э':'e','ю':'yu','я':'ya',
        'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z','И':'I',
        'Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T',
        'У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Sch','Ъ':'','Ы':'Y','Ь':'',
        'Э':'E','Ю':'Yu','Я':'Ya',
    };
    function translit(str) {
        if (!str) return '';
        return str.split('').map(c => TRANSLIT_MAP[c] !== undefined ? TRANSLIT_MAP[c] : c).join('');
    }

    // ================== UTIL ==================
    function cleanString(str) {
        if (!str) return '';
        return str
            .replace(/\+/g, ' ')
            .replace(/18\+/gi, ' ')
            .replace(/\s*[\(\[][^()\[\]]*(remaster|deluxe|bonus|edit|prod|ost|версия|feat|ft\.|version|remix)[^()\[\]]*[\)\]]/gi, '')
            .replace(/\s*\(feat\..*?\)/gi, '')
            .replace(/\s*\(ft\..*?\)/gi, '')
            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ================== КЭШ ==================
    const CACHE_KEY = 'ps-fallback-lyrics-cache-v1';
    const CACHE_TTL = 14 * 24 * 60 * 60 * 1000;
    const CACHE_LIMIT = 40;

    function makeCacheKey(artist, title) {
        return `${cleanString(artist)}|${cleanString(title)}`.toLowerCase();
    }

    function readCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            const data = raw ? JSON.parse(raw) : null;
            return data && typeof data === 'object' ? data : {};
        } catch (_) {
            return {};
        }
    }

    function writeCache(cache) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
    }

    function getCacheEntry(artist, title) {
        const key = makeCacheKey(artist, title);
        const cache = readCache();
        let entry = cache[key];

        const isValid = (e) => {
            if (!e || !e.candidate || !e.candidate.text) return false;
            if (!e.savedAt || Date.now() - e.savedAt > CACHE_TTL) return false;
            return true;
        };

        if (!isValid(entry)) {
            const wantedTitle = cleanString(title).toLowerCase();
            const wantedArtist = cleanString(artist).toLowerCase();
            let best = null;

            if (wantedTitle) {
                for (const [k, e] of Object.entries(cache)) {
                    if (k === key || !isValid(e) || !e.title) continue;
                    if (cleanString(e.title).toLowerCase() !== wantedTitle) continue;

                    const a = cleanString(e.artist || '').toLowerCase();
                    let score = 0;
                    if (!a || !wantedArtist) score = 1;
                    else if (a === wantedArtist) score = 2;
                    else if (a.includes(wantedArtist) || wantedArtist.includes(a)) score = 1;
                    if (!score) continue;

                    if (!best || score > best.score || (score === best.score && (e.savedAt || 0) > (best.entry.savedAt || 0))) {
                        best = { entry: e, score };
                    }
                }
            }

            if (best) entry = best.entry;
        }

        if (!isValid(entry)) {
            if (entry) {
                delete cache[key];
                writeCache(cache);
            }
            return null;
        }
        return entry;
    }

    function saveCacheEntry(artist, title, data) {
        const candidate = data && data.candidate ? data.candidate : null;
        const emptySources = data && Array.isArray(data.emptySources) ? data.emptySources : [];

        const hasCandidate = !!(candidate && candidate.text);
        if (!hasCandidate) return;

        const key = makeCacheKey(artist, title);
        const cache = readCache();
        cache[key] = {
            savedAt: Date.now(),
            artist,
            title,
            candidate: hasCandidate ? candidate : null,
            emptySources,
        };

        const keys = Object.keys(cache).sort(
            (a, b) => (cache[b].savedAt || 0) - (cache[a].savedAt || 0)
        );
        for (const k of keys.slice(CACHE_LIMIT)) delete cache[k];

        writeCache(cache);
    }

    function clearCacheEntry(artist, title) {
        const key = makeCacheKey(artist, title);
        const cache = readCache();
        if (!cache[key]) return;
        delete cache[key];
        writeCache(cache);
    }

    // ================== СВОЙ ТЕКСТ ==================
    const CUSTOM_KEY = 'ps-fallback-custom-lyrics-v1';

    function readCustomStore() {
        try {
            const raw = localStorage.getItem(CUSTOM_KEY);
            const data = raw ? JSON.parse(raw) : null;
            return data && typeof data === 'object' ? data : {};
        } catch (_) {
            return {};
        }
    }

    function writeCustomStore(store) {
        try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(store)); } catch (_) {}
    }

    function getCustomLyrics(artist, title) {
        const key = makeCacheKey(artist, title);
        const entry = readCustomStore()[key];
        return entry && typeof entry.text === 'string' && entry.text.trim() ? entry : null;
    }

    function saveCustomLyrics(artist, title, text) {
        const value = normalizeLyricsText(String(text || ''));
        if (!value) return false;

        const key = makeCacheKey(artist, title);
        const store = readCustomStore();
        store[key] = {
            savedAt: Date.now(),
            artist,
            title,
            text: value,
        };
        writeCustomStore(store);
        return !!getCustomLyrics(artist, title);
    }

    function removeCustomLyrics(artist, title) {
        const key = makeCacheKey(artist, title);
        const store = readCustomStore();
        if (!store[key]) return;
        delete store[key];
        writeCustomStore(store);
    }

    const LYRICS_UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
    const LYRICS_ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

    function normalizeLyricLine(line) {
        return String(line || '')
            .replace(LYRICS_UNICODE_SPACES, ' ')
            .replace(LYRICS_ZERO_WIDTH, '')
            .replace(/[ \t]+/g, ' ')
            .trim();
    }

    function normalizeLyricsText(text) {
        if (!text) return '';

        const lines = String(text)
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map(normalizeLyricLine);

        while (lines.length && !lines[0]) lines.shift();
        while (lines.length && !lines[lines.length - 1]) lines.pop();

        const out = [];
        for (const line of lines) {
            if (!line) {
                if (out.length && out[out.length - 1] !== '') out.push('');
            } else {
                out.push(line);
            }
        }

        return out.join('\n');
    }

    function htmlToPlainLyrics(input) {
        if (!input) return '';

        let root = input;
        if (typeof input === 'string') {
            root = document.createElement('div');
            root.innerHTML = input;
        }

        const extractText = (node) => {
            let text = '';

            const walk = (n) => {
                if (!n) return;
                if (n.nodeType === 3) {
                    text += String(n.nodeValue || '').replace(/\s+/g, ' ');
                    return;
                }
                if (n.nodeType !== 1) return;

                const tag = n.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INS') return;
                if (tag === 'BR') {
                    text += '\n';
                    return;
                }

                if (n.childNodes) {
                    for (const child of n.childNodes) walk(child);
                }
            };

            walk(node);
            return normalizeLyricsText(text);
        };

        const blocks = [];

        for (const node of Array.from(root.childNodes || [])) {
            if (!node || node.nodeType !== 1) continue;

            const tag = node.tagName;
            if (tag === 'UL' || tag === 'OL') {
                for (const li of Array.from(node.children || [])) {
                    if (li.tagName !== 'LI') continue;
                    const text = extractText(li);
                    if (text) blocks.push({ type: 'li', text });
                }
            } else if (tag === 'P' || tag === 'DIV') {
                const text = extractText(node);
                if (text) blocks.push({ type: 'p', text });
            } else if (tag !== 'SCRIPT' && tag !== 'STYLE') {
                const text = extractText(node);
                if (text) blocks.push({ type: 'p', text });
            }
        }

        if (!blocks.length) return extractText(root);

        let result = '';
        for (let i = 0; i < blocks.length; i++) {
            if (i > 0) {
                const prev = blocks[i - 1];
                const cur = blocks[i];

                if (prev.type === 'p' && cur.type === 'p') result += '\n\n';
                else if (prev.type === 'p' && cur.type === 'li') result += '\n';
                else if (prev.type === 'li' && cur.type === 'p') result += '\n\n';
                else result += '\n';
            }
            result += blocks[i].text;
        }

        return result;
    }

    function parseLRC(lrc) {
        const out = [];
        const re = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)/;
        for (const line of String(lrc || '').replace(/\r\n?/g, '\n').split('\n')) {
            const m = re.exec(line);
            if (!m) continue;
            const min = parseInt(m[1], 10);
            const sec = parseInt(m[2], 10);
            const ms  = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
            const text = normalizeLyricLine(m[4]);
            if (text) out.push({ time: min * 60 + sec + ms / 1000, text });
        }
        out.sort((a, b) => a.time - b.time);
        return out;
    }
    function stripLRC(lrc) {
        return normalizeLyricsText(String(lrc || '').replace(/\[\d+:\d+(?:[.:]\d+)?\]\s?/g, ''));
    }

    function decodeHTMLEntities(str) {
        if (!str) return '';
        const ta = document.createElement('textarea');
        ta.innerHTML = str;
        return ta.value;
    }

    // ================== СЕТЬ ==================
    async function tryFetch(url, headers = {}, signal) {
        try {
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json, text/plain, */*', ...headers },
                credentials: 'omit',
                mode: 'cors',
                signal,
            });
            const text = await res.text();
            if (!res.ok) return { _status: res.status, raw: text };
            try { return { data: JSON.parse(text), raw: text, _status: res.status }; }
            catch { return { raw: text, _status: res.status }; }
        } catch (e) {
            return {
                _error: String(e && e.message || e),
                _blocked: true,
                _aborted: !!(signal && signal.aborted),
            };
        }
    }

    async function tryFetchWithTimeout(url, headers, signal, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => {
            try { controller.abort(); } catch (_) {}
        }, timeoutMs);
        const onAbort = () => {
            try { controller.abort(); } catch (_) {}
        };

        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
            return await tryFetch(url, headers || {}, controller.signal);
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }

    function firstResult(promises) {
        return new Promise(resolve => {
            let pending = promises.length;
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            for (const p of promises) {
                Promise.resolve(p).then(value => {
                    if (value) finish(value);
                    else if (--pending === 0) finish(null);
                }).catch(() => {
                    if (--pending === 0) finish(null);
                });
            }
        });
    }

    // ================== ПЛЕЕР ==================
    function getVisiblePlayerBar() {
        const bars = document.querySelectorAll([
            '[class*="PlayerBarDesktopWithBackgroundProgressBar_player"]',
            '[class*="PlayerBarDesktop"]',
            '[class*="PlayerBar_root"]',
        ].join(','));
        for (const b of bars) {
            if (b.offsetParent !== null && b.getBoundingClientRect().height > 0) return b;
        }
        return null;
    }

    function getActiveTrackData() {
        const bar = getVisiblePlayerBar();
        let titleNode  = bar ? bar.querySelector('[data-test-id="TRACK_TITLE"]') : null;
        let artistNode = bar ? (bar.querySelector('[data-test-id="SEPARATED_ARTIST_TITLE"]') || bar.querySelector('[data-test-id="TRACK_ARTIST"]')) : null;

        if (!titleNode) titleNode = document.querySelector('[data-test-id="TRACK_TITLE"]');
        if (!artistNode) artistNode = document.querySelector('[data-test-id="SEPARATED_ARTIST_TITLE"]') || document.querySelector('[data-test-id="TRACK_ARTIST"]');

        let rawTitle  = titleNode ? titleNode.textContent.trim() : '';
        let rawArtist = artistNode ? artistNode.textContent.trim() : '';

        if (!rawTitle) {
            try {
                const md = navigator.mediaSession && navigator.mediaSession.metadata;
                if (md && md.title) {
                    rawTitle = md.title;
                    rawArtist = md.artist || '';
                }
            } catch (_) {}
        }

        if (!rawTitle) return null;

        if (!rawArtist && rawTitle.includes(' - ')) {
            const p = rawTitle.split(' - ');
            rawArtist = p[0].trim();
            rawTitle  = p.slice(1).join(' - ').trim();
        }
        return {
            title:  rawTitle.replace(/18\+/g, '').replace(/…|\.\.\./g, '').trim(),
            artist: rawArtist.replace(/…|\.\.\./g, '').trim()
        };
    }

    function getNativeLyricsBtn() {
        const bar = getVisiblePlayerBar();
        if (!bar) return null;
        return bar.querySelector('[data-test-id="PLAYERBAR_DESKTOP_SYNC_LYRICS_BUTTON"]')
            || bar.querySelector('[data-test-id*="LYRICS_BUTTON"]')
            || bar.querySelector('button[aria-label*="текст" i]')
            || bar.querySelector('button[title*="текст" i]');
    }

    function isNativeDisabled(btn) {
        if (!btn) return false;
        return btn.disabled === true || btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true';
    }

    // ================== МОНТИРОВАНИЕ ДОКА ==================
    function getAppContentRoot() {
        const candidates = [
            '.Content_root__IsH8s',
            '[class*="Content_root"]',
            '[class*="CommonLayout_content"]',
        ];
        for (const sel of candidates) {
            const el = document.querySelector(sel);
            if (el && el.getBoundingClientRect().width > 200) return el;
        }
        return null;
    }

    function mountDock(dock) {
        const root = getAppContentRoot();
        if (root) {
            if (getComputedStyle(root).position === 'static') {
                root.style.position = 'relative';
            }
            root.appendChild(dock);
        } else {
            dock.classList.add('ps-dock-fixed');
            document.body.appendChild(dock);
        }
    }

    // ================== ЗАКРЫТИЕ ДОКА С АНИМАЦИЕЙ ==================
    function closeDock(dock) {
        if (!dock) return;
        if (dock.classList.contains('ps-dock-closing')) return;

        loadGeneration++;
        abortDockSearch();
        clearStatusTimer();
        stopSync();
        dock.classList.add('ps-dock-closing');

        let removed = false;
        const finish = () => {
            if (removed) return;
            removed = true;
            dock.remove();
        };

        const safety = setTimeout(finish, 400);

        dock.addEventListener('animationend', (e) => {
            if (e.animationName !== 'psDockSlideOut') return;
            clearTimeout(safety);
            finish();
        }, { once: true });
    }

    // ================== UI ==================
    function openSidebar(title, artist) {
        const existing = document.querySelector('.ps-native-lyrics-dock');
        if (existing) existing.remove();

        const dock = document.createElement('div');
        dock.className = 'ps-native-lyrics-dock';
        dock.innerHTML = `
            <header class="ps-dock-header">
                <div class="ps-dock-meta">
                    <h2 class="ps-dock-title"></h2>
                    <span class="ps-dock-artist"></span>
                </div>
                <div class="ps-dock-header-actions">
                    <button class="ps-dock-icon-btn ps-dock-close" type="button" title="Закрыть" aria-label="Закрыть">
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
            </header>
            <div class="ps-dock-body">
                <div class="ps-dock-status"></div>
                <div class="ps-dock-sources"></div>
                <div class="ps-dock-editor" hidden>
                    <textarea class="ps-dock-editor-text" spellcheck="false" placeholder="Вставь свой текст песни..."></textarea>
                    <div class="ps-dock-editor-actions">
                        <button class="ps-dock-editor-save" type="button">Сохранить</button>
                        <button class="ps-dock-editor-cancel" type="button">Отмена</button>
                        <button class="ps-dock-editor-delete" type="button" hidden>Удалить</button>
                    </div>
                    <div class="ps-dock-editor-hint">
                        Свой текст хранится отдельно для этого трека и не пропадёт при смене источника.
                        Пустое поле не удаляет сохранённый текст.
                    </div>
                </div>
                <div class="ps-dock-text"></div>
                <div class="ps-dock-source"></div>
            </div>`;
        dock.querySelector('.ps-dock-title').textContent  = title;
        dock.querySelector('.ps-dock-artist').textContent = artist || 'Неизвестный исполнитель';
        dock.querySelector('.ps-dock-close').onclick = async () => {
            if (editorHasChanges() && !(await showConfirm('Закрыть без сохранения изменений текста?', {
                confirmLabel: 'Закрыть',
                danger: true,
            }))) return;
            closeDock(dock);
        };
        const editor = dock.querySelector('.ps-dock-editor');
        if (editor) {
            editor.querySelector('.ps-dock-editor-save').onclick = () => { saveCustomEditor(); };
            editor.querySelector('.ps-dock-editor-cancel').onclick = () => { closeCustomEditor(); };
            editor.querySelector('.ps-dock-editor-delete').onclick = () => { deleteCustomEditor(); };
            editor.querySelector('.ps-dock-editor-text').addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    closeCustomEditor();
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    saveCustomEditor();
                }
            });
        }

        dock.addEventListener('animationend', (e) => {
            if (e.animationName !== 'psDockSlide') return;
            ovPressed = false;
            const ov = document.getElementById('ps-lyrics-btn-overlay');
            if (!(ov && ov.matches(':hover'))) setHover(false);
        }, { once: true });

        mountDock(dock);

        return dock;
    }

    function applyStatus(text) {
        const el = document.querySelector('.ps-native-lyrics-dock .ps-dock-status');
        if (el) el.textContent = text || '';
    }
    function clearStatusTimer() {
        if (statusTimer) {
            clearTimeout(statusTimer);
            statusTimer = null;
        }
    }
    function setStatus(text) {
        clearStatusTimer();
        applyStatus(text);
    }
    function setStatusTimed(text, ms) {
        clearStatusTimer();
        applyStatus(text);
        statusTimer = setTimeout(() => {
            statusTimer = null;
            applyStatus('');
        }, ms || 1500);
    }
    function setSource(text) {
        const el = document.querySelector('.ps-native-lyrics-dock .ps-dock-source');
        if (el) el.textContent = text || '';
    }
    function setSidebarText(text) {
        const el = document.querySelector('.ps-native-lyrics-dock .ps-dock-text');
        if (el) el.textContent = text;
    }
    function setSidebarHTML(html) {
        const el = document.querySelector('.ps-native-lyrics-dock .ps-dock-text');
        if (el) el.innerHTML = html;
    }

    // ================== ИСТОЧНИКИ ==================

    // ---------- LRCLIB ----------
    async function lrclibRequest(artist, title, signal) {
        const url = `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
        const r = await tryFetch(url, {}, signal);
        if (signal && signal.aborted) return [];
        if (!r || r._status !== 200) return [];

        let list = r.data;
        if (!Array.isArray(list) && r.raw) { try { list = JSON.parse(r.raw); } catch (_) {} }
        if (!Array.isArray(list) || !list.length) return [];

        const wanted = (artist + ' ' + title).toLowerCase();
        const words = wanted.split(/\s+/).filter(w => w.length > 2);

        const scored = [];
        for (const item of list) {
            if (!item) continue;
            const hay = ((item.artistName || '') + ' ' + (item.trackName || '')).toLowerCase();
            let score = 0;
            for (const w of words) if (hay.includes(w)) score++;
            const hasSynced = item.syncedLyrics && item.syncedLyrics.trim().length > 10;
            const hasPlain = item.plainLyrics && item.plainLyrics.trim().length > 10;
            if (!hasSynced && !hasPlain) continue;
            scored.push({ item, score, hasSynced });
        }
        scored.sort((a, b) => (b.score + (b.hasSynced ? 0.5 : 0)) - (a.score + (a.hasSynced ? 0.5 : 0)));

        const out = [];
        const seen = new Set();
        for (const s of scored) {
            const it = s.item;
            const label = `${it.artistName || '?'} - ${it.trackName || '?'}`;
            const id = label.toLowerCase();
            if (seen.has(id)) continue;
            seen.add(id);

            const text = s.hasSynced ? it.syncedLyrics : it.plainLyrics;
            if (!text || !String(text).trim() || String(text).trim().length < 10) continue;

            out.push({
                source: 'LRCLIB',
                type: s.hasSynced ? 'synced' : 'plain',
                text,
                label,
            });
            if (out.length >= 5) break;
        }
        return out;
    }

    async function fetchLrclib(artist, title, signal) {
        const r1 = await lrclibRequest(artist, title, signal);
        if (signal && signal.aborted) return [];
        if (r1.length) return r1;

        const transA = translit(artist);
        const transT = translit(title);
        if (transA !== artist || transT !== title) {
            const r2 = await lrclibRequest(transA, transT, signal);
            if (signal && signal.aborted) return [];
            if (r2.length) return r2;
        }
        return [];
    }

    // ---------- txtsong (via Google Translate proxy) ----------
    const TXTSONG_PROXY = 'https://txtsong-ru.translate.goog';

    const TXTSONG_TRANSLIT = {
        'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y',
        'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
        'х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
        'і':'i','ї':'i','є':'e','ґ':'g',
    };

    function txtsongSlug(str) {
        return String(str || '')
            .toLowerCase()
            .split('')
            .map(ch => TXTSONG_TRANSLIT[ch] !== undefined ? TXTSONG_TRANSLIT[ch] : ch)
            .join('')
            .replace(/[’'`"]/g, '')
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/^-+|-+$/g, '');
    }

    function txtsongNorm(str) {
        return String(str || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
    }

    function txtsongScore(wantedTitle, wantedArtist, title, artist) {
        const q = txtsongNorm(wantedTitle);
        const qt = txtsongNorm(title);
        const a = txtsongNorm(wantedArtist);
        const at = txtsongNorm(artist);
        let titleScore = 0;
        let artistScore = 0;

        if (q && qt) {
            if (q === qt) titleScore += 100;
            else if (qt.includes(q) || q.includes(qt)) titleScore += 60;
            else {
                const qw = q.split(' ').filter(Boolean);
                const tw = new Set(qt.split(' ').filter(Boolean));
                let hits = 0;
                for (const w of qw) if (tw.has(w)) hits++;
                titleScore += (hits / Math.max(1, qw.length)) * 40;
            }
        }

        if (a && at) {
            if (a === at) artistScore += 30;
            else if (at.includes(a) || a.includes(at)) artistScore += 20;
            else {
                const aw = a.split(' ').filter(Boolean);
                const tw = new Set(at.split(' ').filter(Boolean));
                let hits = 0;
                for (const w of aw) if (tw.has(w)) hits++;
                artistScore += (hits / Math.max(1, aw.length)) * 15;
            }
        }

        return { score: titleScore + artistScore, titleScore, artistScore };
    }

    function txtsongAddParams(url) {
        try {
            const u = new URL(url, 'https://txtsong.ru/');
            if (u.hostname !== 'txtsong-ru.translate.goog') {
                return `${TXTSONG_PROXY}${u.pathname}${u.search}`;
            }
            if (!u.searchParams.has('_x_tr_sl')) u.searchParams.set('_x_tr_sl', 'ru');
            if (!u.searchParams.has('_x_tr_tl')) u.searchParams.set('_x_tr_tl', 'en');
            if (!u.searchParams.has('_x_tr_hl')) u.searchParams.set('_x_tr_hl', 'ru');
            return u.toString();
        } catch (_) {
            return url;
        }
    }

    const TXTSONG_TIMEOUT = 10000;

    function txtsongSleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function txtsongUrlVariants(url) {
        const list = [url];
        try {
            const u = new URL(url);
            if (!u.searchParams.has('_x_tr_pto')) {
                const w = new URL(u);
                w.searchParams.set('_x_tr_pto', 'wapp');
                list.push(w.toString());
            }
        } catch (_) {}
        return list;
    }

    async function txtsongTryFetch(url, signal) {
        const controller = new AbortController();
        const timer = setTimeout(() => {
            try { controller.abort(); } catch (_) {}
        }, TXTSONG_TIMEOUT);
        const onAbort = () => {
            try { controller.abort(); } catch (_) {}
        };

        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
            return await tryFetch(url, {}, controller.signal);
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }

    async function txtsongSearch(query, signal) {
        const url = txtsongAddParams(`${TXTSONG_PROXY}/?s=${encodeURIComponent(query)}`);

        for (const variant of txtsongUrlVariants(url)) {
            const r = await txtsongTryFetch(variant, signal);
            if (signal && signal.aborted) return [];
            if (!r || r._status !== 200 || !r.raw) {
                if (r && r._status === 429) await txtsongSleep(400);
                continue;
            }

            const doc = new DOMParser().parseFromString(r.raw, 'text/html');
            const out = [];

            for (const item of doc.querySelectorAll('.text__item')) {
                const link = item.querySelector('.text__item--title a');
                if (!link) continue;

                const href = txtsongAddParams(link.getAttribute('href'));
                if (!href) continue;

                const title = link.textContent.replace(/\s+/g, ' ').trim();
                if (!title) continue;

                const authorNode = item.querySelector('.text__item--author a');
                const author = authorNode ? authorNode.textContent.replace(/\s+/g, ' ').trim() : '';

                out.push({ href, title, author });
            }

            if (out.length) return out;
        }

        return [];
    }

    function parseTxtsongPage(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const block = doc.querySelector('.song-text-container.original-content')
            || doc.querySelector('[itemprop="text"]');
        if (!block) return null;

        const clone = block.cloneNode(true);
        clone.querySelectorAll('script, style, ins, .adsbygoogle').forEach(el => el.remove());

        let lyrics = htmlToPlainLyrics(clone);

        lyrics = normalizeLyricsText(decodeHTMLEntities(lyrics));

        if (!lyrics || lyrics.length < 20) return null;

        const h1 = doc.querySelector('h1');
        let label = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '';
        label = label.replace(/^Текст песни\s+/i, '').trim();

        return { lyrics, label };
    }

    async function txtsongFetchLyrics(href, signal) {
        const url = txtsongAddParams(href);

        for (const variant of txtsongUrlVariants(url)) {
            const r = await txtsongTryFetch(variant, signal);
            if (signal && signal.aborted) return null;
            if (!r || r._status !== 200 || !r.raw) {
                if (r && r._status === 429) await txtsongSleep(400);
                continue;
            }

            const page = parseTxtsongPage(r.raw);
            if (page) return page;
        }

        return null;
    }

    async function fetchTxtsong(artist, title, signal) {
        const rawTitle = String(title || '').trim();
        const cleanTitle = cleanString(title);
        const rawArtist = String(artist || '').trim();

        const titleVariants = [rawTitle];
        if (cleanTitle && cleanTitle !== rawTitle) titleVariants.push(cleanTitle);

        const searchLists = await Promise.all(
            titleVariants.slice(0, 2).map(query => txtsongSearch(query, signal))
        );
        if (signal && signal.aborted) return [];

        const artistAliases = new Set();
        const addAlias = (value) => {
            const norm = txtsongNorm(value);
            if (norm) artistAliases.add(norm);
        };
        addAlias(rawArtist);

        if (dockSourceStates && typeof dockSourceStates.forEach === 'function') {
            dockSourceStates.forEach(st => {
                if (!st || !Array.isArray(st.candidates)) return;
                for (const c of st.candidates) {
                    if (!c || !c.label) continue;
                    const parts = String(c.label).split(/\s+[\u2014\u2013-]\s+/);
                    if (parts.length >= 2) addAlias(parts[0]);
                }
            });
        }

        const candidates = [];
        const seen = new Set();
        const wantedSlug = txtsongSlug(rawTitle);
        const wantedArtistSlug = txtsongSlug(rawArtist);

        for (const items of searchLists) {
            for (const item of items) {
                if (seen.has(item.href)) continue;
                seen.add(item.href);

                let path = '';
                try { path = new URL(item.href).pathname.toLowerCase(); } catch (_) {}

                let titleScore = 0;
                for (const wantedTitle of titleVariants) {
                    const s = txtsongScore(wantedTitle, rawArtist, item.title, item.author);
                    titleScore = Math.max(titleScore, s.titleScore);
                }

                let artistScore = 0;
                for (const wantedArtist of artistAliases) {
                    const s = txtsongScore(rawTitle, wantedArtist, item.title, item.author);
                    artistScore = Math.max(artistScore, s.artistScore);
                }

                const titleSlugBonus = wantedSlug && path.includes(wantedSlug) ? 50 : 0;
                const artistSlugBonus = wantedArtistSlug && path.includes(wantedArtistSlug) ? 50 : 0;
                candidates.push({
                    ...item,
                    score: titleScore + artistScore + titleSlugBonus + artistSlugBonus,
                    titleScore,
                    artistScore,
                    titleSlugBonus,
                    artistSlugBonus,
                });
            }
        }

        const good = candidates.filter(c => {
            if (rawTitle && c.titleScore !== 100) return false;
            if (rawArtist && c.artistScore !== 30) return false;
            return true;
        });
        if (!good.length) return [];

        good.sort((a, b) => b.score - a.score);

        const candidate = good[0];
        const page = await txtsongFetchLyrics(candidate.href, signal);
        if (signal && signal.aborted) return [];
        if (!page) return [];

        const label = page.label || `${candidate.author || rawArtist} - ${candidate.title || rawTitle}`;
        return [{
            source: 'txtsong',
            type: 'plain',
            text: page.lyrics,
            label,
        }];
    }

    // ---------- Genius ----------
    async function fetchGenius(artist, title, signal) {
        const query = `${artist} ${title}`.trim();
        const searchApi = `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`;
        const sr = await tryFetch(searchApi, {}, signal);
        if (signal && signal.aborted) return [];
        if (!sr) return [];

        let json = sr.data;
        if (!json && sr.raw) { try { json = JSON.parse(sr.raw); } catch (_) {} }
        if (!json || !json.response || !Array.isArray(json.response.sections)) return [];

        const songSection = json.response.sections.find(s => s && s.type === 'song');
        const hits = (songSection && songSection.hits) || [];
        if (!hits.length) return [];

        const wanted = (artist + ' ' + title).toLowerCase();
        let best = hits[0].result;
        let bestScore = -1;
        for (const h of hits) {
            const r = h && h.result;
            if (!r) continue;
            const hay = ((r.title || '') + ' ' + (r.primary_artist?.name || '')).toLowerCase();
            const words = wanted.split(/\s+/).filter(Boolean);
            let score = 0;
            for (const w of words) if (w.length > 2 && hay.includes(w)) score++;
            if (score > bestScore) { bestScore = score; best = r; }
        }
        if (!best || !best.url) return [];

        const pr = await tryFetch(best.url, {}, signal);
        if (signal && signal.aborted) return [];
        if (!pr || !pr.raw) return [];

        const doc = new DOMParser().parseFromString(pr.raw, 'text/html');

        doc.querySelectorAll('[data-lyrics-container="true"] [data-exclude-from-selection="true"]').forEach(el => el.remove());
        doc.querySelectorAll('[data-lyrics-container="true"] [class*="LyricsHeader"]').forEach(el => el.remove());
        doc.querySelectorAll('[data-lyrics-container="true"] [class*="Lyrics__Header"]').forEach(el => el.remove());
        doc.querySelectorAll('[data-lyrics-container="true"] script').forEach(el => el.remove());

        const containers = doc.querySelectorAll('[data-lyrics-container="true"]');
        if (!containers.length) return [];

        let lyrics = Array.from(containers).map(el =>
            el.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
        ).join('\n');

        lyrics = decodeHTMLEntities(lyrics);

        lyrics = lyrics
            .split('\n')
            .filter(line => {
                const t = line.trim();
                if (!t) return true;
                if (/^\d+\s+Contributors?$/i.test(t)) return false;
                if (/^Translations?$/i.test(t)) return false;
                if (/^Read More\s*$/i.test(t)) return false;
                if (/^\[?\s*Текст\s+песни\s+[«"']/i.test(t)) return false;
                if (/Lyrics$/i.test(t) && t.length < 120) return false;
                return true;
            })
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        if (!lyrics || lyrics.length < 20) return [];

        const bestArtist = (best.primary_artist && best.primary_artist.name) || artist;
        return [{
            source: 'Genius',
            type: 'plain',
            text: lyrics,
            label: best.title ? `${bestArtist} - ${best.title}` : undefined,
        }];
    }

    // ---------- lyrics.ovh ----------
    const LYRICS_OVH_TIMEOUT = 8000;

    async function lyricsOvhRequest(artist, title, signal) {
        const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
        const r = await tryFetchWithTimeout(url, {}, signal, LYRICS_OVH_TIMEOUT);
        if (signal && signal.aborted) return null;
        if (!r) return null;
        if (r._status !== 200) return null;
        if (!r.data || typeof r.data.lyrics !== 'string') return null;
        const text = r.data.lyrics.replace(/\r\n/g, '\n').trim();
        if (!text || text.length < 10) return null;
        return { source: 'lyrics.ovh', type: 'plain', text };
    }

    async function fetchLyricsOvh(artist, title, signal) {
        const transA = translit(artist);
        const transT = translit(title);

        const requests = [lyricsOvhRequest(artist, title, signal)];
        if (transA !== artist || transT !== title) {
            requests.push(lyricsOvhRequest(transA, transT, signal));
        }

        const found = await firstResult(requests);
        if (signal && signal.aborted) return [];
        return found ? [found] : [];
    }

    // ================== ОРКЕСТРАЦИЯ ==================
    function getSources() {
        return [
            { id: 'Genius',     fn: fetchGenius },
            { id: 'LRCLIB',     fn: fetchLrclib },
            { id: 'txtsong',    fn: fetchTxtsong },
            { id: 'lyrics.ovh', short: 'ovh', fn: fetchLyricsOvh },
        ];
    }

    // ================== SYNC ==================
    function stopSync() {
        if (syncTimerId) { clearInterval(syncTimerId); syncTimerId = null; }
        syncLines = null;
    }

    function getPlayerTime() {
        const audio = document.querySelector('audio');
        if (audio && isFinite(audio.currentTime)) return audio.currentTime;
        return null;
    }

    function startSync(lrc) {
        stopSync();
        syncLines = parseLRC(lrc);
        if (!syncLines.length) return false;

        const textEl = document.querySelector('.ps-native-lyrics-dock .ps-dock-text');
        if (!textEl) return false;
        textEl.innerHTML = '';
        const lineEls = syncLines.map((l) => {
            const d = document.createElement('div');
            d.className = 'ps-sync-line';
            d.textContent = l.text;
            textEl.appendChild(d);
            return d;
        });

        let lastActive = -1;
        const tick = () => {
            const t = getPlayerTime();
            if (t == null) return;
            let active = -1;
            for (let i = 0; i < syncLines.length; i++) {
                if (syncLines[i].time <= t) active = i; else break;
            }
            if (active === lastActive) return;
            lastActive = active;
            lineEls.forEach((el, i) => el.classList.toggle('active', i === active));
            if (active >= 0 && lineEls[active]) {
                lineEls[active].scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        };
        tick();
        syncTimerId = setInterval(tick, 250);
        return true;
    }

    // ================== РЕНДЕР ==================
    function getSourceState(id) {
        if (!dockSourceStates.has(id)) {
            dockSourceStates.set(id, { candidates: [], index: 0, status: 'idle' });
        }
        return dockSourceStates.get(id);
    }

    function renderSourceButtons() {
        const wrap = document.querySelector('.ps-native-lyrics-dock .ps-dock-sources');
        if (!wrap) return;

        wrap.innerHTML = '';
        for (const src of getSources()) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ps-dock-source-btn';
            btn.dataset.source = src.id;
            btn.textContent = src.short || src.id;
            btn.title = src.id;
            btn.onclick = () => { onSourceButtonClick(src.id); };
            wrap.appendChild(btn);
        }

        const customBtn = document.createElement('button');
        customBtn.type = 'button';
        customBtn.className = 'ps-dock-source-btn ps-dock-source-custom';
        customBtn.dataset.source = 'custom';
        customBtn.title = 'Свой текст для этого трека';
        customBtn.textContent = 'свой текст';
        customBtn.onclick = () => { onSourceButtonClick('custom'); };
        wrap.appendChild(customBtn);

        const tools = document.createElement('div');
        tools.className = 'ps-dock-source-tools';

        const reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.className = 'ps-dock-source-btn ps-dock-source-reload';
        reloadBtn.dataset.source = '__reload';
        reloadBtn.title = 'Обновить текст';
        reloadBtn.setAttribute('aria-label', 'Обновить текст');
        reloadBtn.innerHTML =
            '<svg viewBox="0 0 512 512" fill="none" aria-hidden="true">' +
            '<g transform="translate(64 64)" fill="currentColor" fill-rule="evenodd">' +
            '<path d="M234.666667,149.333333 L234.666667,106.666667 L314.564847,106.664112 C287.579138,67.9778918 242.745446,42.6666667 192,42.6666667 C109.525477,42.6666667 42.6666667,109.525477 42.6666667,192 C42.6666667,274.474523 109.525477,341.333333 192,341.333333 C268.201293,341.333333 331.072074,284.258623 340.195444,210.526102 L382.537159,215.817985 C370.807686,310.617565 289.973536,384 192,384 C85.961328,384 1.42108547e-14,298.038672 1.42108547e-14,192 C1.42108547e-14,85.961328 85.961328,1.42108547e-14 192,1.42108547e-14 C252.316171,1.42108547e-14 306.136355,27.8126321 341.335366,71.3127128 L341.333333,1.42108547e-14 L384,1.42108547e-14 L384,149.333333 L234.666667,149.333333 Z"/>' +
            '</g>' +
            '</svg>';
        reloadBtn.onclick = () => { reloadCurrentText(); };
        tools.appendChild(reloadBtn);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'ps-dock-source-btn ps-dock-source-edit';
        editBtn.dataset.source = '__edit';
        editBtn.title = 'Редактировать текст';
        editBtn.setAttribute('aria-label', 'Редактировать текст');
        editBtn.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
            '<path fill-rule="evenodd" clip-rule="evenodd" d="M15.8787 3.70705C17.0503 2.53547 18.9498 2.53548 20.1213 3.70705L20.2929 3.87862C21.4645 5.05019 21.4645 6.94969 20.2929 8.12126L18.5556 9.85857L8.70713 19.7071C8.57897 19.8352 8.41839 19.9261 8.24256 19.9701L4.24256 20.9701C3.90178 21.0553 3.54129 20.9554 3.29291 20.7071C3.04453 20.4587 2.94468 20.0982 3.02988 19.7574L4.02988 15.7574C4.07384 15.5816 4.16476 15.421 4.29291 15.2928L14.1989 5.38685L15.8787 3.70705ZM18.7071 5.12126C18.3166 4.73074 17.6834 4.73074 17.2929 5.12126L16.3068 6.10738L17.8622 7.72357L18.8787 6.70705C19.2692 6.31653 19.2692 5.68336 18.8787 5.29283L18.7071 5.12126ZM16.4477 9.13804L14.8923 7.52185L5.90299 16.5112L5.37439 18.6256L7.48877 18.097L16.4477 9.13804Z" fill="currentColor"/>' +
            '</svg>';
        editBtn.onclick = () => { openCustomEditor(); };
        tools.appendChild(editBtn);

        wrap.appendChild(tools);

        syncSourceButtons();
    }

    function syncSourceButtons() {
        const wrap = document.querySelector('.ps-native-lyrics-dock .ps-dock-sources');
        if (!wrap) return;

        const buttons = wrap.querySelectorAll('.ps-dock-source-btn');
        for (const btn of buttons) {
            const id = btn.dataset.source;
            const st = dockSourceStates.get(id);
            btn.classList.toggle('active', dockActiveSource === id);
            btn.classList.toggle('busy', !!st && st.status === 'loading');
            btn.classList.toggle('empty', !!st && st.status === 'empty');
        }
    }

    function renderCandidate(candidate, opts) {
        if (!candidate) return;

        dockActiveSource = candidate.source;

        stopSync();
        setSource(`Source: ${candidate.source}${candidate.label ? ' · ' + candidate.label : ''}`);

        if (candidate.type === 'synced') {
            const ok = startSync(candidate.text);
            if (!ok) setSidebarText(stripLRC(candidate.text));
            else setStatus('');
        } else {
            setSidebarText(candidate.source === 'txtsong' ? normalizeLyricsText(candidate.text) : candidate.text);
        }

        if (!(opts && opts.save === false)) {
            saveDockCache();
        }

        syncSourceButtons();
    }

    function saveDockCache() {
        if (!dockTrack) return;

        const emptySources = [];
        dockSourceStates.forEach((st, id) => {
            if (st.status === 'empty') emptySources.push(id);
        });

        let candidate = null;
        if (dockActiveSource) {
            const st = dockSourceStates.get(dockActiveSource);
            if (st && st.candidates.length) {
                candidate = st.candidates[st.index] || st.candidates[0];
            }
        }

        saveCacheEntry(dockTrack.artist, dockTrack.title, { candidate, emptySources });
    }

    function editorHasChanges() {
        const editor = document.querySelector('.ps-native-lyrics-dock .ps-dock-editor');
        const textarea = document.querySelector('.ps-native-lyrics-dock .ps-dock-editor-text');
        if (!editor || editor.hidden || !textarea) return false;
        return textarea.value !== (editor.dataset.initial || '');
    }

    function getDisplayedLyricsText() {
        const textEl = document.querySelector('.ps-native-lyrics-dock .ps-dock-text');
        if (!textEl) return '';

        const syncLines = textEl.querySelectorAll('.ps-sync-line');
        if (syncLines.length) {
            return Array.from(syncLines).map(el => el.textContent).join('\n');
        }

        const text = textEl.textContent || '';
        if (text.includes('Текст не найден')) return '';
        return text;
    }

    function showCustomLyrics(entry) {
        closeCustomEditor();
        stopSync();
        dockActiveSource = 'custom';
        setStatus('');
        setSource('Source: свой текст');
        setSidebarText(normalizeLyricsText(entry.text));
        syncSourceButtons();
    }

    function showCustomEmpty() {
        closeCustomEditor();
        stopSync();
        dockActiveSource = 'custom';
        setStatus('');
        setSource('Source: свой текст');
        setSidebarHTML(
            '<div class="ps-dock-custom-empty">' +
            '<div>Свой текст для этого трека пока не добавлен.</div>' +
            '<div class="ps-dock-custom-empty-hint">Нажми карандаш рядом с «свой текст», чтобы вставить или отредактировать свой текст.</div>' +
            '<div class="ps-dock-custom-empty-hint">Этим же карандашом можно править текст, загруженный из разных источников - он сохранится как результат выбранного источника.</div>' +
            '</div>'
        );
        syncSourceButtons();
    }

    function openCustomEditor() {
        if (!dockTrack) return;

        abortDockSearch();

        const dock = document.querySelector('.ps-native-lyrics-dock');
        const editor = dock && dock.querySelector('.ps-dock-editor');
        if (!editor) return;

        if (!editor.hidden) {
            const ta = editor.querySelector('.ps-dock-editor-text');
            if (ta) ta.focus();
            return;
        }

        const textarea = editor.querySelector('.ps-dock-editor-text');
        textarea.readOnly = false;
        textarea.disabled = false;

        const editingSource = dockActiveSource && dockActiveSource !== 'custom' ? dockActiveSource : null;
        const existing = getCustomLyrics(dockTrack.artist, dockTrack.title);

        let initialText = getDisplayedLyricsText();
        if (!initialText && editingSource) {
            const st = getSourceState(editingSource);
            const current = st.candidates[st.index] || st.candidates[0];
            if (current && current.text) initialText = current.text;
        }

        const initial = (dockActiveSource === 'custom' && !existing)
            ? ''
            : initialText;

        textarea.value = initial || '';
        editor.dataset.initial = initial || '';
        editor.dataset.editingSource = editingSource || '';

        const hint = editor.querySelector('.ps-dock-editor-hint');
        if (hint) {
            hint.textContent = editingSource
                ? `Этот текст сохранится как результат источника «${editingSource}» для этого трека. Пустое поле не сохраняется.`
                : 'Свой текст хранится отдельно для этого трека и не пропадёт при смене источника. Пустое поле не удаляет сохранённый текст.';
        }

        editor.querySelector('.ps-dock-editor-delete').hidden = !(editingSource || existing);
        editor.hidden = false;
        dock.classList.add('ps-editing');

        const body = dock.querySelector('.ps-dock-body');
        if (body) body.scrollTop = 0;

        setStatus('');
        textarea.focus();
        textarea.setSelectionRange(0, 0);
        textarea.scrollTop = 0;
    }

    function closeCustomEditor() {
        const dock = document.querySelector('.ps-native-lyrics-dock');
        if (!dock) return;

        const editor = dock.querySelector('.ps-dock-editor');
        if (!editor) return;

        editor.hidden = true;
        dock.classList.remove('ps-editing');
    }

    function saveCustomEditor() {
        if (!dockTrack) return;

        const dock = document.querySelector('.ps-native-lyrics-dock');
        const editor = dock && dock.querySelector('.ps-dock-editor');
        const textarea = editor && editor.querySelector('.ps-dock-editor-text');
        if (!editor || !textarea) return;

        const editingSource = editor.dataset.editingSource || '';
        const text = editingSource && editingSource !== 'txtsong'
            ? textarea.value.replace(/\r\n/g, '\n').trim()
            : normalizeLyricsText(textarea.value);
        if (!text) {
            setStatus('Пустой текст не сохранён.');
            return;
        }

        if (editingSource) {
            const st = getSourceState(editingSource);
            const current = st.candidates.length ? st.candidates[st.index] : null;
            const candidate = {
                source: editingSource,
                type: 'plain',
                text,
                label: current && current.label ? current.label : undefined,
            };

            st.candidates = [candidate];
            st.index = 0;
            st.status = 'ready';

            dockActiveSource = editingSource;
            closeCustomEditor();
            saveDockCache();
            renderCandidate(candidate, { save: false });
            setStatusTimed(`Сохранено как ${editingSource}`, 1500);
            return;
        }

        if (!saveCustomLyrics(dockTrack.artist, dockTrack.title, text)) {
            setStatus('Не удалось сохранить текст: хранилище переполнено.');
            return;
        }

        closeCustomEditor();
        showCustomLyrics({ text });
        setStatusTimed('Свой текст сохранён', 1500);
    }

    let activeConfirm = null;

    function showConfirm(message, opts) {
        const options = opts || {};
        const confirmLabel = options.confirmLabel || 'OK';
        const cancelLabel = options.cancelLabel || 'Отмена';
        const danger = !!options.danger;

        return new Promise(resolve => {
            if (activeConfirm) activeConfirm(false);

            const dock = document.querySelector('.ps-native-lyrics-dock');
            const overlay = document.createElement('div');
            overlay.className = 'ps-confirm-overlay' + (dock ? '' : ' ps-confirm-fixed');

            const card = document.createElement('div');
            card.className = 'ps-confirm-card';
            card.setAttribute('role', 'dialog');
            card.setAttribute('aria-modal', 'true');
            card.setAttribute('aria-label', message);

            const messageEl = document.createElement('div');
            messageEl.className = 'ps-confirm-message';
            messageEl.textContent = message;
            card.appendChild(messageEl);

            const actions = document.createElement('div');
            actions.className = 'ps-confirm-actions';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'ps-confirm-btn ps-confirm-cancel';
            cancelBtn.textContent = cancelLabel;

            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'ps-confirm-btn ps-confirm-ok' + (danger ? ' ps-confirm-danger' : '');
            okBtn.textContent = confirmLabel;

            actions.appendChild(cancelBtn);
            actions.appendChild(okBtn);
            card.appendChild(actions);
            overlay.appendChild(card);

            const onKey = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    finish(false);
                    return;
                }
                if (e.key === 'Tab') {
                    const buttons = [cancelBtn, okBtn];
                    const idx = buttons.indexOf(document.activeElement);
                    e.preventDefault();
                    let next;
                    if (e.shiftKey) {
                        next = idx <= 0 ? buttons[buttons.length - 1] : buttons[idx - 1];
                    } else {
                        next = idx === -1 || idx === buttons.length - 1 ? buttons[0] : buttons[idx + 1];
                    }
                    next.focus();
                }
            };

            const finish = (value) => {
                if (!overlay.isConnected) return;
                overlay.remove();
                document.removeEventListener('keydown', onKey, true);
                if (activeConfirm === finish) activeConfirm = null;
                resolve(value);
            };

            activeConfirm = finish;

            cancelBtn.onclick = () => finish(false);
            okBtn.onclick = () => finish(true);
            overlay.addEventListener('mousedown', (e) => {
                if (e.target === overlay) finish(false);
            });

            (dock || document.body).appendChild(overlay);
            document.addEventListener('keydown', onKey, true);

            if (danger) cancelBtn.focus();
            else okBtn.focus();
        });
    }

    async function deleteCustomEditor() {
        if (!dockTrack) return;

        const dock = document.querySelector('.ps-native-lyrics-dock');
        const editor = dock && dock.querySelector('.ps-dock-editor');
        const editingSource = editor && editor.dataset.editingSource ? editor.dataset.editingSource : '';

        if (editingSource) {
            const st = getSourceState(editingSource);
            if (!st.candidates.length) return;
            if (!(await showConfirm(`Удалить сохранённый текст источника «${editingSource}»?`, {
                confirmLabel: 'Удалить',
                danger: true,
            }))) return;

            st.candidates = [];
            st.index = 0;
            st.status = 'idle';

            const cached = getCacheEntry(dockTrack.artist, dockTrack.title);
            if (cached && cached.candidate && cached.candidate.source === editingSource) {
                clearCacheEntry(dockTrack.artist, dockTrack.title);
            }

            closeCustomEditor();
            dockActiveSource = null;
            setSource('');
            setStatusTimed('Текст источника удалён', 1500);
            setSidebarText('Текст источника удалён. Нажми «Обновить», чтобы загрузить его снова.');
            syncSourceButtons();
            return;
        }

        const existing = getCustomLyrics(dockTrack.artist, dockTrack.title);
        if (!existing) return;
        if (!(await showConfirm('Удалить свой текст для этого трека?', {
            confirmLabel: 'Удалить',
            danger: true,
        }))) return;

        removeCustomLyrics(dockTrack.artist, dockTrack.title);
        closeCustomEditor();

        if (dockActiveSource === 'custom') {
            dockActiveSource = null;
            loadLyricsForDock(dockTrack, false);
        }
    }

    function abortDockSearch() {
        if (dockAbort) {
            try { dockAbort.abort(); } catch (_) {}
            dockAbort = null;
        }
        if (dockSourceStates && typeof dockSourceStates.forEach === 'function') {
            dockSourceStates.forEach(st => {
                if (st.status === 'loading') st.status = 'idle';
            });
        }
        syncSourceButtons();
    }

    async function reloadCurrentText() {
        if (!dockTrack) return;

        if (editorHasChanges() && !(await showConfirm('Обновить текст? Несохранённые изменения пропадут.', {
            confirmLabel: 'Обновить',
            danger: true,
        }))) {
            return;
        }

        closeCustomEditor();

        if (dockActiveSource && dockActiveSource !== 'custom') {
            onSourceButtonClick(dockActiveSource, true);
            return;
        }

        if (dockActiveSource === 'custom') {
            const custom = getCustomLyrics(dockTrack.artist, dockTrack.title);
            if (custom && custom.text) showCustomLyrics(custom);
            else showCustomEmpty();
            return;
        }

        loadLyricsForDock(dockTrack, true);
    }

    async function onSourceButtonClick(id, forceFresh) {
        if (!dockTrack) return;

        if (id === 'custom') {
            if (editorHasChanges() && !(await showConfirm('Есть несохранённые изменения текста. Переключить вкладку?', {
                confirmLabel: 'Переключить',
            }))) {
                return;
            }

            abortDockSearch();
            closeCustomEditor();

            const custom = getCustomLyrics(dockTrack.artist, dockTrack.title);
            if (custom && custom.text) showCustomLyrics(custom);
            else showCustomEmpty();
            return;
        }

        if (editorHasChanges() && !(await showConfirm('Есть несохранённые изменения текста. Переключить источник?', {
            confirmLabel: 'Переключить',
        }))) {
            return;
        }

        closeCustomEditor();

        const st = getSourceState(id);
        if (st.status === 'loading') return;

        const src = getSources().find(s => s.id === id);
        if (!src) return;

        abortDockSearch();

        if (!forceFresh && st.candidates.length) {
            if (dockActiveSource === id) {
                st.index = (st.index + 1) % st.candidates.length;
            }
            setStatus('');
            renderCandidate(st.candidates[st.index], { save: true });
            return;
        }

        const generation = loadGeneration;
        const controller = new AbortController();
        dockAbort = controller;

        st.candidates = [];
        st.index = 0;
        st.status = 'loading';
        syncSourceButtons();

        let list = [];
        try { list = await fetchSourceCandidates(src, dockTrack, controller.signal); }
        catch (_) {}
        finally { if (dockAbort === controller) dockAbort = null; }

        if (generation !== loadGeneration || controller.signal.aborted) return;

        if (!list.length) {
            st.status = 'empty';
            setStatusTimed(`В ${id} не найдено`, 1500);
            syncSourceButtons();
            saveDockCache();
            return;
        }

        st.candidates = list;
        st.index = 0;
        st.status = 'ready';
        setStatus('');
        renderCandidate(list[0], { save: true });
    }

    function markAllSourcesEmptyWhenNoResult() {
        for (const src of getSources()) {
            const st = getSourceState(src.id);
            if (!st.candidates.length) st.status = 'empty';
        }
        syncSourceButtons();
    }

    function renderNoResult(track) {
        markAllSourcesEmptyWhenNoResult();
        setSource('');
        setSidebarHTML(
            '<b>Текст не найден.</b><br><br>' +
            'Пробовали: ' + getSources().map(s => s.id).join(', ') + '.<br><br>' +
            '<button class="ps-retry-btn" type="button">Повторить</button>'
        );
        const btn = document.querySelector('.ps-native-lyrics-dock .ps-retry-btn');
        if (btn) {
            btn.onclick = async () => {
                clearCacheEntry(track.artist, track.title);
                await loadLyricsForDock(track, true);
            };
        }
    }

    // ================== ОВЕРЛЕЙ ==================
    function getOrCreateOverlay() {
        let ov = document.getElementById('ps-lyrics-btn-overlay');
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'ps-lyrics-btn-overlay';
            ov.style.cssText = [
                'position:fixed',
                'z-index:2147483000',
                'cursor:pointer',
                'background:transparent',
                'display:none',
            ].join(';');
            ov.addEventListener('click', onOverlayClick, true);

            ['mousedown','mouseup','pointerdown','pointerup'].forEach(t =>
                ov.addEventListener(t, e => { e.stopPropagation(); }, true)
            );

            ov.addEventListener('mouseenter', () => setHover(true));
            ov.addEventListener('mouseleave', () => {
                if (!ovPressed) setHover(false);
            });
            ov.addEventListener('pointerdown', () => {
                ovPressed = true;
                setHover(true);
            });

            document.body.appendChild(ov);
        }
        return ov;
    }

    function setHover(on) {
        const b = getNativeLyricsBtn();
        if (!b) return;
        b.classList.toggle('ps-force-hover', !!on);
    }

    function hideOverlay() {
        const ov = document.getElementById('ps-lyrics-btn-overlay');
        if (ov) ov.style.display = 'none';
        ovPressed = false;
        setHover(false);
    }

    function onOverlayClick(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!currentTrack) return;
        toggleDock(currentTrack);
    }

    async function fetchSourceCandidates(src, track, signal) {
        setStatus(`Ищем в ${src.id}...`);
        let list = [];
        try {
            list = await src.fn(track.artist, track.title, signal) || [];
        } catch (_) {}
        if (signal && signal.aborted) return [];
        return Array.isArray(list) ? list : [];
    }

    async function loadLyricsForDock(track, forceFresh) {
        const generation = ++loadGeneration;

        abortDockSearch();

        dockTrack = track;
        dockSourceStates = new Map();
        dockActiveSource = null;
        setStatus('');
        setSource('');
        setSidebarText('');
        renderSourceButtons();
        closeCustomEditor();

        let cached = null;
        if (!forceFresh) {
            cached = getCacheEntry(track.artist, track.title);
            if (cached) {
                if (Array.isArray(cached.emptySources)) {
                    for (const id of cached.emptySources) {
                        getSourceState(id).status = 'empty';
                    }
                }

                if (cached.candidate && cached.candidate.text) {
                    const st = getSourceState(cached.candidate.source);
                    st.candidates = [cached.candidate];
                    st.index = 0;
                    st.status = 'ready';
                }
            }
        }

        const custom = getCustomLyrics(track.artist, track.title);
        if (custom && custom.text) {
            showCustomLyrics(custom);
            return;
        }

        if (cached) {
            if (cached.candidate && cached.candidate.text) {
                renderCandidate(cached.candidate, { save: false });
            } else {
                syncSourceButtons();
                renderNoResult(track);
            }
            return;
        }

        const controller = new AbortController();
        dockAbort = controller;
        setStatus('Поиск...');

        const sources = getSources();

        for (const src of sources) {
            if (generation !== loadGeneration || controller.signal.aborted) return;

            const st = getSourceState(src.id);
            st.status = 'loading';
            syncSourceButtons();

            const list = await fetchSourceCandidates(src, track, controller.signal);
            if (generation !== loadGeneration || controller.signal.aborted) return;

            if (list.length) {
                st.candidates = list;
                st.index = 0;
                st.status = 'ready';
                if (dockAbort === controller) dockAbort = null;
                setStatus('');
                renderCandidate(list[0], { save: true });
                return;
            }

            st.status = 'empty';
            syncSourceButtons();
        }

        if (dockAbort === controller) dockAbort = null;
        setStatus('');
        renderNoResult(track);
    }

    async function toggleDock(track) {
        const existing = document.querySelector('.ps-native-lyrics-dock');
        if (existing) {
            if (editorHasChanges() && !(await showConfirm('Закрыть без сохранения изменений текста?', {
                confirmLabel: 'Закрыть',
                danger: true,
            }))) return;
            closeDock(existing);
            setTimeout(() => {
                ovPressed = false;
                const ov = document.getElementById('ps-lyrics-btn-overlay');
                if (!(ov && ov.matches(':hover'))) setHover(false);
            }, 0);
            return;
        }

        stopSync();
        openSidebar(track.title, track.artist);
        await loadLyricsForDock(track, false);
    }

    function positionOverlay() {
        const btn = getNativeLyricsBtn();

        if (!ourModeActive || !btn || !isNativeDisabled(btn)) {
            hideOverlay();
            return;
        }

        const r = btn.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight) {
            hideOverlay();
            return;
        }

        const ov = getOrCreateOverlay();
        ov.style.display = 'block';
        ov.style.left   = r.left   + 'px';
        ov.style.top    = r.top    + 'px';
        ov.style.width  = r.width  + 'px';
        ov.style.height = r.height + 'px';
    }

    function forceEnabledLook(btn) {
        if (!btn) return;

        btn.dataset.psForceStyled = '1';
        btn.classList.add('ps-force-enabled');

        btn.style.setProperty(
            'color',
            'var(--ym-controls-color-secondary-text-enabled, inherit)',
            'important'
        );
        btn.style.setProperty('opacity', '1', 'important');
        btn.style.setProperty('filter', 'none', 'important');
        btn.style.setProperty('cursor', 'pointer', 'important');
        btn.style.setProperty('pointer-events', 'auto', 'important');

        const svg = btn.querySelector('svg');
        if (svg) {
            svg.style.setProperty('color', 'inherit', 'important');
            svg.style.setProperty('fill', 'currentColor', 'important');
            svg.style.setProperty('opacity', '1', 'important');
        }
    }

    function restoreLook(btn) {
        if (!btn) return;

        btn.classList.remove('ps-force-enabled', 'ps-force-hover');
        if (btn.dataset) {
            delete btn.dataset.psAddedClasses;
            delete btn.dataset.psForceStyled;
        }

        ['color','opacity','filter','cursor','pointer-events'].forEach(p =>
            btn.style.removeProperty(p)
        );
        const svg = btn.querySelector('svg');
        if (svg) {
            ['color','fill','opacity'].forEach(p => svg.style.removeProperty(p));
        }
    }

    // ================== ДОЛГОЕ НАЖАТИЕ ==================
    function clearPress() {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        pressState = null;
    }

    function isEventOnNativeBtn(e, btn) {
        if (!btn) return false;
        const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
        if (path && path.indexOf(btn) !== -1) return true;
        const r = btn.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right &&
               e.clientY >= r.top  && e.clientY <= r.bottom;
    }

    window.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (!currentTrack) return;

        const btn = getNativeLyricsBtn();
        if (!btn || isNativeDisabled(btn)) return;
        if (!isEventOnNativeBtn(e, btn)) return;

        clearPress();
        pressState = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, fired: false };

        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            if (!pressState) return;
            pressState.fired = true;
            if (currentTrack) toggleDock(currentTrack);
        }, Math.max(250, Number(S.longPressMs) || 800));
    }, true);

    window.addEventListener('pointermove', (e) => {
        if (!pressState) return;
        if (pressState.pointerId !== undefined && e.pointerId !== pressState.pointerId) return;
        if (pressState.fired) return;
        const dx = e.clientX - pressState.x;
        const dy = e.clientY - pressState.y;
        if (dx * dx + dy * dy > 144) clearPress();
    }, true);

    function endPress(e) {
        if (!pressState) return;
        if (e && pressState.pointerId !== undefined && e.pointerId !== undefined &&
            e.pointerId !== pressState.pointerId) return;

        const fired = pressState.fired;
        clearPress();

        if (fired) {
            suppressNextClick = true;
            setTimeout(() => { suppressNextClick = false; }, 400);
        }
    }

    window.addEventListener('pointerup', endPress, true);
    window.addEventListener('pointercancel', endPress, true);

    window.addEventListener('click', (e) => {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }, true);

    window.addEventListener('contextmenu', (e) => {
        if (!pressState) return;
        const btn = getNativeLyricsBtn();
        if (btn && isEventOnNativeBtn(e, btn)) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // ================== ФОЛБЭК-КНОПКА (ВЕБ) ==================
    function getLauncher() {
        let el = document.getElementById('ps-fallback-launcher');
        if (el) return el;

        el = document.createElement('button');
        el.id = 'ps-fallback-launcher';
        el.type = 'button';
        el.textContent = 'Текст';
        el.style.cssText = [
            'position:fixed',
            'right:16px',
            'bottom:96px',
            'z-index:2147483000',
            'padding:10px 16px',
            'border-radius:999px',
            'border:1px solid rgba(255,255,255,.16)',
            'background:rgba(18,18,22,.92)',
            'color:#fff',
            'font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif',
            'cursor:pointer',
            'box-shadow:0 8px 24px rgba(0,0,0,.35)',
        ].join(';');

        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (currentTrack) toggleDock(currentTrack);
        });

        document.body.appendChild(el);
        return el;
    }

    function updateLauncher(btn) {
        const need = !!currentTrack && !btn;
        const existing = document.getElementById('ps-fallback-launcher');

        if (!need) {
            if (existing) existing.style.display = 'none';
            return;
        }

        const el = existing || getLauncher();
        el.style.display = 'block';
    }

    // ================== ЦИКЛ ==================
    function checkLoop() {
        const track = getActiveTrackData();

        if (!track || !track.title) {
            ourModeActive = false;
            currentTrackKey = '';
            currentTrack = null;
            clearPress();
            hideOverlay();
            stopSync();
            const dock = document.querySelector('.ps-native-lyrics-dock');
            if (dock) closeDock(dock);
            return;
        }

        const key = `${track.artist} - ${track.title}`;

        if (key !== currentTrackKey) {
            const prevBtn = getNativeLyricsBtn();
            restoreLook(prevBtn);

            currentTrackKey = key;
            currentTrack = track;
            ourModeActive = false;
            hideOverlay();
            clearPress();
            stopSync();
            const dock = document.querySelector('.ps-native-lyrics-dock');
            if (dock) closeDock(dock);
        } else {
            currentTrack = track;
        }

        const btn = getNativeLyricsBtn();

        if (btn && isNativeDisabled(btn)) {
            ourModeActive = true;
            forceEnabledLook(btn);
        } else {
            ourModeActive = false;
            hideOverlay();
            if (btn && (btn.classList.contains('ps-force-enabled') || btn.dataset.psForceStyled)) {
                restoreLook(btn);
            }
        }

        updateLauncher(btn);
        positionOverlay();
    }

    setInterval(checkLoop, 300);
    checkLoop();

    window.addEventListener('resize', positionOverlay, true);
    window.addEventListener('scroll', positionOverlay, true);

})();
