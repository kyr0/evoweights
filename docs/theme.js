"use strict";
/* Synchronous head bootstrap (classic script, loaded before first paint) following the defuss-shadcn persisted preference format. */
(() => {
    const key = 'defuss-shadcn-theme';
    const root = document.documentElement;
    const os = window.matchMedia('(prefers-color-scheme: dark)');
    function preference() {
        try {
            const saved = JSON.parse(localStorage.getItem(key));
            const value = saved?.format === 'defuss-store' ? saved.value : saved;
            return value === 'dark' || value === 'light' ? value : null;
        }
        catch {
            return null;
        }
    }
    function apply(value) {
        const dark = (value || (os.matches ? 'dark' : 'light')) === 'dark';
        root.classList.toggle('dark', dark);
        root.style.colorScheme = dark ? 'dark' : 'light';
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta)
            meta.content = dark ? '#161819' : '#f8f8f5';
        for (const b of document.querySelectorAll('[data-portal-theme-toggle]')) {
            b.setAttribute('aria-pressed', String(dark));
            b.title = dark ? 'Use light appearance' : 'Use dark appearance';
        }
    }
    apply(preference());
    os.addEventListener('change', () => apply(preference()));
    window.addEventListener('storage', (event) => {
        if (event.key === key)
            apply(preference());
    });
    document.addEventListener('DOMContentLoaded', () => {
        apply(preference());
        for (const b of document.querySelectorAll('[data-portal-theme-toggle]')) {
            b.addEventListener('click', () => {
                const value = root.classList.contains('dark') ? 'light' : 'dark';
                try {
                    localStorage.setItem(key, JSON.stringify({ format: 'defuss-store', value }));
                }
                catch {
                    /* storage unavailable: the choice lasts for this page */
                }
                apply(value);
            });
        }
        const deck = document.getElementById('presentation-frame');
        if (!deck)
            return;
        window.addEventListener('message', (event) => {
            if (event.origin !== location.origin ||
                event.source !== deck.contentWindow ||
                event.data?.type !== 'agm:deck-size' ||
                !Number.isFinite(event.data.height))
                return;
            deck.style.minHeight = '0';
            deck.style.height = Math.max(280, Math.min(1800, Math.ceil(event.data.height))) + 'px';
        });
    });
})();
