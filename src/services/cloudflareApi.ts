import { auth } from '../firebase';

const normalizeBaseUrl = (value?: string) => {
  if (!value) return '';
  return value.trim().replace(/\/+$/, '');
};

export const getWorkerBaseUrl = () => {
  return normalizeBaseUrl(
    import.meta.env.VITE_CLOUDFLARE_WORKER_URL || import.meta.env.VITE_API_BASE_URL || ''
  );
};

export const callWorkerJson = async (path: string, init: RequestInit = {}) => {
  const baseUrl = getWorkerBaseUrl();
  if (!baseUrl) {
    throw new Error('Cloudflare Worker is not configured. Set VITE_CLOUDFLARE_WORKER_URL or VITE_API_BASE_URL.');
  }

  const headers = new Headers(init.headers || {});
  if (auth.currentUser && !headers.has('Authorization')) {
    const token = await auth.currentUser.getIdToken();
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();

    const error = new Error(
      `Worker API error: ${response.status} ${text}`
    ) as Error & { status?: number };

    error.status = response.status;

    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
};
