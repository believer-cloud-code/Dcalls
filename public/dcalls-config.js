/**
 * Shared URL config for static Dcalls marketing pages (welcome.html, help.html, etc.)
 * Loaded before page scripts. React app uses src/config/urls.ts with the same env names.
 */
(function (global) {
  const trimSlash = (url) => url.replace(/\/+$/, '');

  const isDevHost = (host) =>
    host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');

  const isFirebaseHosting = (host) =>
    host.endsWith('.web.app') || host.endsWith('.firebaseapp.com');

  function getAppUrl() {
    if (global.__DCALLS_APP_URL__) return trimSlash(global.__DCALLS_APP_URL__);

    const host = global.location?.hostname || '';
    const protocol = global.location?.protocol || 'https:';

    if (isDevHost(host)) {
      return 'http://localhost:3000';
    }

    // Firebase default hosting — SPA lives at project root
    if (isFirebaseHosting(host)) {
      return trimSlash(`${protocol}//${host}`);
    }

    // Production: dedicated app subdomain (see help.html)
    return 'https://app.dcalls.com';
  }

  function getMarketingUrl() {
    if (global.__DCALLS_MARKETING_URL__) return trimSlash(global.__DCALLS_MARKETING_URL__);

    const host = global.location?.hostname || '';
    const protocol = global.location?.protocol || 'https:';
    const port = global.location?.port ? `:${global.location.port}` : '';

    if (isDevHost(host)) {
      return `${protocol}//${host}${port}/welcome.html`;
    }

    if (isFirebaseHosting(host)) {
      return `${protocol}//${host}${port}/welcome.html`;
    }

    return 'https://dcalls.com';
  }

  function getHelpUrl() {
    const host = global.location?.hostname || '';
    const protocol = global.location?.protocol || 'https:';
    const port = global.location?.port ? `:${global.location.port}` : '';

    if (isDevHost(host) || isFirebaseHosting(host)) {
      return `${protocol}//${host}${port}/help.html`;
    }

    return 'https://dcalls.com/help.html';
  }

  function openWebApp(sameTab) {
    const url = getAppUrl();
    if (sameTab) {
      global.location.href = url;
    } else {
      global.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  global.DcallsUrls = {
    getAppUrl,
    getMarketingUrl,
    getHelpUrl,
    openWebApp,
  };
})(typeof window !== 'undefined' ? window : globalThis);
