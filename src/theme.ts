/* Synchronous head bootstrap (classic script, loaded before first paint) following the defuss-shadcn persisted preference format. */
(() => {
  type Theme = 'dark' | 'light';
  const key = 'defuss-shadcn-theme';
  const root = document.documentElement;
  const os = window.matchMedia('(prefers-color-scheme: dark)');
  function preference(): Theme | null {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) as string);
      const value =
        (saved as { format?: string } | null)?.format === 'defuss-store' ? (saved as { value: unknown }).value : saved;
      return value === 'dark' || value === 'light' ? value : null;
    } catch {
      return null;
    }
  }
  function apply(value: Theme | null): void {
    const dark = (value || (os.matches ? 'dark' : 'light')) === 'dark';
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#161819' : '#f8f8f5';
    for (const b of document.querySelectorAll<HTMLElement>('[data-portal-theme-toggle]')) {
      b.setAttribute('aria-pressed', String(dark));
      b.title = dark ? 'Use light appearance' : 'Use dark appearance';
    }
  }
  apply(preference());
  os.addEventListener('change', () => apply(preference()));
  window.addEventListener('storage', (event) => {
    if (event.key === key) apply(preference());
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply(preference());
    for (const b of document.querySelectorAll('[data-portal-theme-toggle]')) {
      b.addEventListener('click', () => {
        const value = root.classList.contains('dark') ? 'light' : 'dark';
        try {
          localStorage.setItem(key, JSON.stringify({ format: 'defuss-store', value }));
        } catch {
          /* storage unavailable: the choice lasts for this page */
        }
        apply(value);
      });
    }
    const deck = document.getElementById('presentation-frame') as HTMLIFrameElement | null;
    if (!deck) return;
    window.addEventListener('message', (event: MessageEvent<{ type?: string; height?: number } | null>) => {
      if (
        event.origin !== location.origin ||
        event.source !== deck.contentWindow ||
        event.data?.type !== 'agm:deck-size' ||
        !Number.isFinite(event.data.height)
      )
        return;
      deck.style.minHeight = '0';
      deck.style.height = Math.max(280, Math.min(1800, Math.ceil(event.data.height as number))) + 'px';
    });
  });
})();
