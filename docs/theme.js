"use strict";
/* Synchronous head bootstrap (classic script, loaded before first paint) using the fixed light appearance. */
(() => {
    const root = document.documentElement;
    root.classList.remove('dark');
    root.style.colorScheme = 'light';
    document.addEventListener('DOMContentLoaded', () => {
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
