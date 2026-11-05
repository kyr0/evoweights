"use strict";
// Service worker (classic script, served from the site root so its scope covers the page).
// Apply isolation to this lab's documents and dedicated workers on static hosts.
// Everything else, including models and downloads, follows the ordinary network path.
{
    const worker = self;
    worker.addEventListener('install', (event) => event.waitUntil(worker.skipWaiting()));
    worker.addEventListener('activate', (event) => event.waitUntil(worker.clients.claim()));
    worker.addEventListener('fetch', (event) => {
        const request = event.request;
        if (request.method !== 'GET' || new URL(request.url).origin !== worker.location.origin)
            return;
        if (request.mode !== 'navigate' && !['worker', 'sharedworker'].includes(request.destination))
            return;
        event.respondWith((async () => {
            const response = await fetch(request);
            if (!response.ok || response.redirected)
                return response;
            const headers = new Headers(response.headers);
            headers.set('Cross-Origin-Opener-Policy', 'same-origin');
            headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
            headers.set('Cross-Origin-Resource-Policy', 'same-origin');
            return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        })());
    });
}
