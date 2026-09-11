import {
  handleSendOtp,
  handleVerifyOtp,
} from './auth';

export interface Env {
  BUCKET: R2Bucket;
  PUBLIC_URL?: string;
  FIREBASE_WEB_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_API_URL?: string;
  ALLOWED_ORIGINS?: string;

  VONAGE_API_KEY?: string;
  VONAGE_API_SECRET?: string;
  VONAGE_BRAND?: string;

  FIREBASE_SERVICE_ACCOUNT_EMAIL?: string;
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;

  AUTH_TRANSACTION_SECRET?: string;
  FIREBASE_PROJECT_ID?: string;
}

function getAllowedOrigins(env: Env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function applyCorsHeaders(request: Request, env: Env) {
  const origin = request.headers.get('Origin');

  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });

  if (origin && getAllowedOrigins(env).includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }

  return headers;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function requireFirebaseUser(request: Request, env: Env) {
  const authorization = request.headers.get('Authorization');

  if (!authorization || !authorization.startsWith('Bearer ')) {
    throw new HttpError(
      401,
      'Authentication required. Send a Firebase ID token in the Authorization header.'
    );
  }

  const firebaseApiKey = env.FIREBASE_WEB_API_KEY;

  if (!firebaseApiKey) {
    throw new HttpError(
      500,
      'Worker config is missing FIREBASE_WEB_API_KEY.'
    );
  }

  const token = authorization.replace('Bearer ', '').trim();

  const lookupRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idToken: token,
      }),
    }
  );

  if (!lookupRes.ok) {
    throw new HttpError(
      401,
      'Invalid or expired Firebase authentication token.'
    );
  }

  const lookupJson = await lookupRes.json().catch(() => ({} as any));
  const uid = lookupJson?.users?.[0]?.localId;

  if (!uid) {
    throw new HttpError(401, 'Firebase user lookup failed.');
  }

  return { uid };
}

async function callDeepseek(
  endpoint: string,
  body: any,
  apiKey: string
) {
  const res = await fetch(`https://api.deepseek.com${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DeepSeek error ${res.status}: ${txt}`);
  }

  return res.json();
}

async function callGemini(
  endpoint: string,
  body: any,
  apiKey: string,
  baseUrl: string
) {
  // Generic caller for Gemini-style endpoints. The exact payload shape
  // depends on the provider; we pass the body through and attempt to
  // parse common response shapes.
  const url = baseUrl.replace(/\/+$/, '') + endpoint;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini error ${res.status}: ${txt}`);
  }

  return res.json();
}

function extractTextFromAiResponse(data: any) {
  // Try common response shapes (OpenRouter, DeepSeek, Gemini-like)
  if (!data) return null;
  // OpenRouter-like: choices[0].message.content
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length) return c.join('\n');

  // OpenAI-like: choices[0].text
  if (typeof data?.choices?.[0]?.text === 'string') return data.choices[0].text;

  // Deepseek-like: data.text
  if (typeof data?.text === 'string') return data.text;

  // Gemini/Vertex-like: output[0].content[0].text
  const vertex = data?.output?.[0]?.content?.[0]?.text;
  if (typeof vertex === 'string') return vertex;

  // Candidates: candidates[0].content[0].text
  const cand = data?.candidates?.[0]?.content?.[0]?.text;
  if (typeof cand === 'string') return cand;

  return null;
}

async function callOpenRouter(
  endpoint: string,
  body: any,
  apiKey: string
) {
  const res = await fetch(`https://openrouter.ai${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://dcalls.workers.dev',
      'X-Title': 'Dcalls Damai',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${txt}`);
  }

  return res.json();
}

/**
 * AI CHAT
 *
 * Provider priority: Gemini -> OpenRouter -> DeepSeek
 */
async function generateChatResponse(
  messages: any[],
  env: Env
) {
  const errors: string[] = [];

  // 1) Gemini (primary) — requires GEMINI_API_KEY and GEMINI_API_URL
  if (env.GEMINI_API_KEY && env.GEMINI_API_URL) {
    try {
      console.log('AI provider: Gemini');
      const data = await callGemini('/v1/chat/completions', { messages }, env.GEMINI_API_KEY, env.GEMINI_API_URL);
      const response = extractTextFromAiResponse(data);
      if (response) return response;
      errors.push('Gemini returned an empty response.');
    } catch (error: any) {
      console.error('Gemini chat failed:', error);
      errors.push(error?.message || String(error));
    }
  }

  // 2) OpenRouter
  if (env.OPENROUTER_API_KEY) {
    try {
      console.log('AI provider: OpenRouter');
      const data = await callOpenRouter(
        '/api/v1/chat/completions',
        {
          model: 'google/gemini-3.5-flash',
          messages,
        },
        env.OPENROUTER_API_KEY
      );
      const response = extractTextFromAiResponse(data);
      if (response) return response;
      errors.push('OpenRouter returned an empty response.');
    } catch (error: any) {
      console.error('OpenRouter chat failed:', error);
      errors.push(error?.message || String(error));
    }
  }

  // 3) DeepSeek fallback
  if (env.DEEPSEEK_API_KEY) {
    try {
      console.log('AI provider fallback: DeepSeek');
      const data = await callDeepseek(
        '/chat/completions',
        {
          model: 'deepseek-chat',
          messages,
        },
        env.DEEPSEEK_API_KEY
      );
      const response = extractTextFromAiResponse(data);
      if (response) return response;
      errors.push('DeepSeek returned an empty response.');
    } catch (error: any) {
      console.error('DeepSeek chat failed:', error);
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(
    `All AI providers failed. ${errors.join(' | ')}`
  );
}

/**
 * AI SUMMARY
 *
 * OpenRouter is primary.
 * DeepSeek is fallback.
 */
async function generateSummary(
  text: string,
  env: Env
) {
  const messages = [
    {
      role: 'system',
      content:
        'You are an expert summarizer. Provide a clear, concise and structured summary.',
    },
    {
      role: 'user',
      content: text,
    },
  ];
  const errors: string[] = [];

  // Try Gemini first
  if (env.GEMINI_API_KEY && env.GEMINI_API_URL) {
    try {
      console.log('Summary provider: Gemini');
      const data = await callGemini('/v1/chat/completions', { messages }, env.GEMINI_API_KEY, env.GEMINI_API_URL);
      const summary = extractTextFromAiResponse(data);
      if (summary) return summary;
      errors.push('Gemini returned empty summary.');
    } catch (error: any) {
      console.error('Gemini summary failed:', error);
      errors.push(error?.message || String(error));
    }
  }

  // OpenRouter
  if (env.OPENROUTER_API_KEY) {
    try {
      console.log('Summary provider: OpenRouter');
      const data = await callOpenRouter(
        '/api/v1/chat/completions',
        {
          model: 'google/gemini-3.5-flash',
          messages,
        },
        env.OPENROUTER_API_KEY
      );
      const summary = extractTextFromAiResponse(data);
      if (summary) return summary;
      errors.push('OpenRouter returned an empty summary.');
    } catch (error: any) {
      console.error('OpenRouter summary failed:', error);
      errors.push(error?.message || String(error));
    }
  }

  if (env.DEEPSEEK_API_KEY) {
    try {
      console.log('Summary provider fallback: DeepSeek');
      const data = await callDeepseek(
        '/chat/completions',
        {
          model: 'deepseek-chat',
          messages,
        },
        env.DEEPSEEK_API_KEY
      );
      const summary = extractTextFromAiResponse(data);
      if (summary) return summary;
      errors.push('DeepSeek returned an empty summary.');
    } catch (error: any) {
      console.error('DeepSeek summary failed:', error);
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(
    `All summary providers failed. ${errors.join(' | ')}`
  );
}

async function handleAiRequest(
  request: Request,
  env: Env
) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: applyCorsHeaders(request, env),
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: applyCorsHeaders(request, env),
    });
  }

  try {
    await requireFirebaseUser(request, env);
  } catch (err: any) {
    return Response.json(
      {
        error: err.message || 'Authentication failed',
      },
      {
        status: err.status || 401,
        headers: applyCorsHeaders(request, env),
      }
    );
  }

  const {
    action,
    prompt,
    context,
    text,
    audio,
  } = await request.json().catch(() => ({}));

  if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY && !env.DEEPSEEK_API_KEY) {
    return Response.json(
      {
        error:
          'No AI provider configured on the Worker.',
      },
      {
        status: 500,
        headers: applyCorsHeaders(request, env),
      }
    );
  }

  try {
    if (action === 'chat') {
      const messages = [
        {
          role: 'system',
          content:
            'You are Damai, a helpful and personalized AI assistant.',
        },
        {
          role: 'user',
          content:
            `Context:\n${context || ''}\n\nUser says:\n${prompt || ''}`,
        },
      ];

      const response = await generateChatResponse(
        messages,
        env
      );

      return Response.json(
        { response },
        {
          headers: applyCorsHeaders(request, env),
        }
      );
    }

    if (action === 'summary') {
      if (!text) {
        return Response.json(
          { error: 'Missing text to summarize.' },
          {
            status: 400,
            headers: applyCorsHeaders(request, env),
          }
        );
      }

      const summary = await generateSummary(
        text,
        env
      );

      return Response.json(
        { summary },
        {
          headers: applyCorsHeaders(request, env),
        }
      );
    }

    if (action === 'transcribe') {
      if (!audio) {
        return Response.json(
          { error: 'Missing audio' },
          {
            status: 400,
            headers: applyCorsHeaders(request, env),
          }
        );
      }

      if (env.DEEPSEEK_API_KEY) {
        try {
          const data = await callDeepseek(
            '/speech/transcribe',
            {
              model: 'deepseek-audio',
              audio,
            },
            env.DEEPSEEK_API_KEY
          );

          return Response.json(
            {
              transcript: data?.text ?? null,
            },
            {
              headers: applyCorsHeaders(request, env),
            }
          );
        } catch (error: any) {
          console.error(
            'DeepSeek transcription failed:',
            error
          );
        }
      }

      return Response.json(
        {
          error:
            'Transcription requires a configured transcription provider.',
        },
        {
          status: 501,
          headers: applyCorsHeaders(request, env),
        }
      );
    }

    if (action === 'tts') {
      return Response.json(
        {
          error:
            'TTS is not configured on this Worker yet.',
        },
        {
          status: 501,
          headers: applyCorsHeaders(request, env),
        }
      );
    }

    return Response.json(
      { error: 'Unknown action' },
      {
        status: 400,
        headers: applyCorsHeaders(request, env),
      }
    );
  } catch (err: any) {
    console.error('AI proxy error:', err);

    return Response.json(
      {
        error:
          err?.message || 'Internal AI error',
      },
      {
        status: 500,
        headers: applyCorsHeaders(request, env),
      }
    );
  }
}

async function handleUploadRequest(
  request: Request,
  env: Env
) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: applyCorsHeaders(request, env),
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: applyCorsHeaders(request, env),
    });
  }

  try {
    await requireFirebaseUser(request, env);
  } catch (err: any) {
    return Response.json(
      {
        error:
          err.message || 'Authentication failed',
      },
      {
        status: err.status || 401,
        headers: applyCorsHeaders(request, env),
      }
    );
  }

  const formData = await request.formData();
  const path = String(
    formData.get('path') || ''
  );
  const file = formData.get('file');

  if (!path || !(file instanceof File)) {
    return Response.json(
      {
        error: 'Missing file or path',
      },
      {
        status: 400,
        headers: applyCorsHeaders(request, env),
      }
    );
  }

  const key = path.replace(/^\/+/, '');

  const object = await env.BUCKET.put(
    key,
    file,
    {
      httpMetadata: {
        contentType:
          file.type ||
          'application/octet-stream',
      },
    }
  );

  const publicUrl = env.PUBLIC_URL
    ? `${env.PUBLIC_URL.replace(/\/+$/, '')}/${key}`
    : null;

  return Response.json(
    {
      url: publicUrl || null,
      fileUrl: publicUrl || null,
      downloadURL: publicUrl || null,
      key,
      etag: object?.httpEtag || null,
    },
    {
      headers: applyCorsHeaders(request, env),
    }
  );
}

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight globally before any route-specific handler.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: applyCorsHeaders(request, env),
      });
    }

    if (
      url.pathname === '/auth/send-otp'
    ) {
      try {
        return await handleSendOtp(
          request,
          env
        );
      } catch (error: any) {
        console.error(
          'Send OTP error:',
          error
        );

        return Response.json(
          {
            error:
              error?.message ||
              'Unable to send verification code.',
          },
          {
            status:
              error?.status || 500,
            headers:
              applyCorsHeaders(
                request,
                env
              ),
          }
        );
      }
    }

    if (
      url.pathname === '/auth/verify-otp'
    ) {
      try {
        return await handleVerifyOtp(
          request,
          env
        );
      } catch (error: any) {
        console.error(
          'Verify OTP error:',
          error
        );

        return Response.json(
          {
            error:
              error?.message ||
              'Unable to verify code.',
          },
          {
            status:
              error?.status || 500,
            headers:
              applyCorsHeaders(
                request,
                env
              ),
          }
        );
      }
    }

    if (url.pathname === '/ai') {
      return handleAiRequest(
        request,
        env
      );
    }

    if (url.pathname === '/upload') {
      return handleUploadRequest(
        request,
        env
      );
    }

    return new Response('Not Found', {
      status: 404,
      headers: applyCorsHeaders(request, env),
    });
  },
};
