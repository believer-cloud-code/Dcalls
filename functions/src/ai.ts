import { onRequest } from 'firebase-functions/https';

async function callDeepseek(endpoint: string, body: any, apiKey: string) {
  const res = await fetch(`https://api.deepseek.com${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Deepseek error ${res.status}: ${txt}`);
  }

  return res.json();
}

async function callOpenRouter(endpoint: string, body: any, apiKey: string) {
  const res = await fetch(`https://openrouter.ai${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${txt}`);
  }

  return res.json();
}

export const ai = onRequest(async (req, res) => {
  try {
    // Allow CORS for browsers
    res.set('Access-Control-Allow-Origin', req.get('origin') || '*');
    res.set('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
      res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    const { action, prompt, context, text, audio } = req.body || {};

    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

    if (!DEEPSEEK_API_KEY && !OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'No AI provider configured on server.' });
    }

    if (action === 'chat') {
      const body = {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: `You are Damai, a helpful assistant.` },
          { role: 'user', content: `Context: ${context || ''}\nUser says: ${prompt}` }
        ]
      };

      if (DEEPSEEK_API_KEY) {
        const data = await callDeepseek('/chat/completions', body, DEEPSEEK_API_KEY);
        return res.json({ response: data?.choices?.[0]?.message?.content ?? null });
      }

      const orData = await callOpenRouter('/api/v1/chat/completions', { model: 'google/gemini-pro-1.5', messages: body.messages }, OPENROUTER_API_KEY!);
      return res.json({ response: orData?.choices?.[0]?.message?.content ?? null });
    }

    if (action === 'summary') {
      const body = {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are an expert summarizer. Provide structured summary.' },
          { role: 'user', content: text }
        ]
      };

      if (DEEPSEEK_API_KEY) {
        const data = await callDeepseek('/chat/completions', body, DEEPSEEK_API_KEY);
        return res.json({ summary: data?.choices?.[0]?.message?.content ?? null });
      }

      const orData = await callOpenRouter('/api/v1/chat/completions', { model: 'google/gemini-1.5', messages: body.messages }, OPENROUTER_API_KEY!);
      return res.json({ summary: orData?.choices?.[0]?.message?.content ?? null });
    }

    if (action === 'transcribe') {
      // Transcription support depends on provider; attempt DeepSeek first if available
      if (!audio) return res.status(400).json({ error: 'Missing audio' });

      if (DEEPSEEK_API_KEY) {
        const body = { model: 'deepseek-audio', audio: audio };
        const data = await callDeepseek('/speech/transcribe', body, DEEPSEEK_API_KEY);
        return res.json({ transcript: data?.text ?? null });
      }

      return res.status(501).json({ error: 'Transcription not supported by configured providers.' });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err: any) {
    console.error('AI proxy error', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});
