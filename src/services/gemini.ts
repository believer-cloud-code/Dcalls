import { callWorkerJson, getWorkerBaseUrl } from './cloudflareApi';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const WORKER_BASE = getWorkerBaseUrl();

if (!WORKER_BASE && !API_BASE) {
  console.warn('Cloudflare Worker and legacy backend are not configured. AI features will be disabled until VITE_CLOUDFLARE_WORKER_URL or VITE_API_BASE_URL is set.');
}

async function callAiBackend(action: string, body: Record<string, unknown>) {
  const workerBase = getWorkerBaseUrl();
  const endpoint = workerBase ? `${workerBase}/ai` : `${API_BASE}/ai`;

  if (!workerBase && !API_BASE) {
    throw new Error('AI backend not configured: set VITE_CLOUDFLARE_WORKER_URL or VITE_API_BASE_URL');
  }

  if (workerBase) {
    return callWorkerJson('/ai', {
      method: 'POST',
      body: JSON.stringify({ action, ...body }),
    });
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
    credentials: 'include'
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI backend error: ${res.status} ${text}`);
  }

  return res.json();
}

export const getDamaiResponse = async (prompt: string, context?: string) => {
  const data = await callAiBackend('chat', { prompt, context });
  return data?.response || null;
};

export const getFastSummary = async (text: string) => {
  const data = await callAiBackend('summary', { text });
  return data?.summary || null;
};

export const transcribeAudio = async (base64Audio: string) => {
  const data = await callAiBackend('transcribe', { audio: base64Audio });
  return data?.transcript || null;
};

export const getTTS = async (text: string, voice = 'Aoede') => {
  const data = await callAiBackend('tts', { text, voice });
  return data?.audioBase64 || null;
};
