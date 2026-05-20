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

/** Marketing / landing site (Dcalls web folder) */
export function getMarketingUrl(): string {
  const fromEnv = import.meta.env.VITE_MARKETING_URL as string | undefined;
  if (fromEnv) return trimSlash(fromEnv);

  if (typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location;
    if (isDevHost(hostname)) {
      return `${protocol}//${hostname}${port ? `:${port}` : ''}/welcome.html`;
    }
    return 'https://dcalls.com';
  }

  return 'https://dcalls.com';
}

export function getHelpUrl(): string {
  const fromEnv = import.meta.env.VITE_HELP_URL as string | undefined;
  if (fromEnv) return trimSlash(fromEnv);

  if (typeof window !== 'undefined') {
    return `${trimSlash(window.location.origin)}/help.html`;
  }

  return `${getMarketingUrl()}/help.html`;
}

export function getPrivacyUrl(): string {
  return (import.meta.env.VITE_PRIVACY_URL as string) || 'https://dcalls.com/privacy';
}

export function openApp(path = '') {
  const base = getAppUrl();
  const url = path ? `${base}${path.startsWith('/') ? path : `/${path}`}` : base;
  window.location.href = url;
}

export function openMarketing(path = '') {
  const base = getMarketingUrl();
  const url = path ? `${base}${path.startsWith('/') ? path : `/${path}`}` : base;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function openHelp() {
  window.open(getHelpUrl(), '_blank', 'noopener,noreferrer');
}
