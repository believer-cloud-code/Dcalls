/**
 * Central URL config linking the React app ↔ Dcalls marketing site ↔ help docs.
 * Set in .env.local (must use VITE_ prefix for Vite).
 */

const trimSlash = (url: string) => url.replace(/\/+$/, '');

const isDevHost = (host: string) =>
  host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');

/** Primary web app (this React/Vite project) */
export function getAppUrl(): string {
  const fromEnv = import.meta.env.VITE_APP_URL as string | undefined;
  if (fromEnv) return trimSlash(fromEnv);

  if (typeof window !== 'undefined') {
    return trimSlash(window.location.origin);
  }

  return 'http://localhost:3000';
}


/** URLs for the future separately hosted Dcalls website. */
export function getMarketingUrl(): string | null {
  const value = import.meta.env.VITE_MARKETING_URL as string | undefined;
  return value?.trim() ? trimSlash(value.trim()) : null;
}

export function getHelpUrl(): string | null {
  const value = import.meta.env.VITE_HELP_URL as string | undefined;
  return value?.trim() ? trimSlash(value.trim()) : null;
}

export function getPrivacyUrl(): string | null {
  const value = import.meta.env.VITE_PRIVACY_URL as string | undefined;
  return value?.trim() ? trimSlash(value.trim()) : null;
}


export function openApp(path = '') {
  const base = getAppUrl();
  const url = path ? `${base}${path.startsWith('/') ? path : `/${path}`}` : base;
  window.location.href = url;
}


export function openMarketing(path = '') {
  const base = getMarketingUrl();

  if (!base) {
    window.alert('The Dcalls website is coming soon.');
    return;
  }

  const url = path
    ? `${base}${path.startsWith('/') ? path : `/${path}`}`
    : base;

  window.open(url, '_blank', 'noopener,noreferrer');
}

export function openHelp() {
  const base = getHelpUrl();

  if (!base) {
    window.alert('The Dcalls Help Center will be available when the Dcalls website is hosted.');
    return;
  }

  window.open(base, '_blank', 'noopener,noreferrer');
}

