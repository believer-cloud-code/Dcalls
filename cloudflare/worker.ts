import {
  acknowledgeTrustedLinkSecrets,
  acceptTrustedLinkSession,
  cancelTrustedLinkSession,
  completeTrustedLinkJoin,
  createTrustedLinkSession,
  inspectTrustedLinkSession,
  joinTrustedLinkSession,
  readTrustedLinkMessageForJoiner,
  sendTrustedLinkSecrets,
  verifyTrustedLinkCompletion,
  DeviceAuthorizationError,
  acknowledgeTrustedDeviceEvents,
  claimTrustedOneTimeKey,
  enrollMatrixDevice,
  getTrustedDeviceKeyStats,
  listTrustedDeviceEvents,
  listTrustedDevices,
  publishTrustedDeviceKeys,
  queryTrustedDeviceKeys,
  sendTrustedDeviceEvent,
  verifyAndConsumeDeviceRequest,
} from './deviceAuth';
export interface Env {
  BUCKET: R2Bucket;
  DEVICE_DB: D1Database;
  PUBLIC_URL?: string;
  FIREBASE_WEB_API_KEY?: string;
  FIREBASE_PROJECT_ID?: string;
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_API_URL?: string;
  ALLOWED_ORIGINS?: string;

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

  return { uid, token };
}

async function requireChatParticipants(
  env: Env,
  firebaseToken: string,
  chatId: string,
  requiredUids: string[],
): Promise<void> {
  if (!env.FIREBASE_PROJECT_ID) {
    throw new DeviceAuthorizationError(503, 'Firebase project configuration is missing.');
  }
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/chats/${encodeURIComponent(chatId)}`,
    { headers: { Authorization: `Bearer ${firebaseToken}` } },
  );
  if (!response.ok) {
    throw new DeviceAuthorizationError(403, 'The chat does not exist or the caller cannot access it.');
  }
  const document = await response.json().catch(() => ({} as any));
  const participants = document?.fields?.participants?.arrayValue?.values ?? [];
  const participantUids = new Set(participants.map((entry: any) => entry?.stringValue).filter(Boolean));
  if (requiredUids.some((uid) => !participantUids.has(uid))) {
    throw new DeviceAuthorizationError(403, 'Both accounts must belong to the requested chat.');
  }
}

async function handleTrustedDeviceRequest(request: Request, env: Env, pathname: string) {
  const headers = applyCorsHeaders(request, env);
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers });
  }
  if (!env.DEVICE_DB) {
    return Response.json({ error: 'Trusted device database is not configured.' }, { status: 503, headers });
  }

  try {
    const contentLength = Number(request.headers.get('Content-Length') ?? '0');
    if (contentLength > 1_000_000) {
      throw new DeviceAuthorizationError(413, 'Trusted device request body is too large.');
    }
    const user = await requireFirebaseUser(request, env);
    const body = await request.json().catch(() => null) as Record<string, any> | null;
    if (!body || typeof body !== 'object') {
      throw new DeviceAuthorizationError(400, 'A JSON request body is required.');
    }

    if (pathname === '/device/enroll') {
      const result = await enrollMatrixDevice(env.DEVICE_DB, user.uid, {
        masterKey: body.masterKey,
        selfSigningKey: body.selfSigningKey,
        userSigningKey: body.userSigningKey,
        deviceKeys: body.deviceKeys,
      });
      return Response.json({ ok: true, ...result }, { headers });
    }

    if (pathname === '/device/link/create' ||
        pathname === '/device/link/inspect' ||
        pathname === '/device/link/accept' ||
        pathname === '/device/link/verify' ||
        pathname === '/device/link/cancel' ||
        pathname === '/device/link/secrets/send') {
      const requestData = body.request;
      const signaturesJson = JSON.stringify(body.signatures ?? {});
      const actionByPath: Record<string, string> = {
        '/device/link/create': 'device.link.create',
        '/device/link/inspect': 'device.link.inspect',
        '/device/link/accept': 'device.link.accept',
        '/device/link/verify': 'device.link.verify',
        '/device/link/cancel': 'device.link.cancel',
        '/device/link/secrets/send': 'device.link.secrets.send',
      };
      if (!requestData || requestData.action !== actionByPath[pathname]) {
        throw new DeviceAuthorizationError(400, 'A matching signed device-link request is required.');
      }
      if (pathname === '/device/link/create') {
        await createTrustedLinkSession({ DB: env.DEVICE_DB }, user.uid, requestData, signaturesJson);
        return Response.json({ ok: true }, { headers });
      }
      if (pathname === '/device/link/inspect') {
        const result = await inspectTrustedLinkSession({ DB: env.DEVICE_DB }, user.uid, requestData, signaturesJson);
        return Response.json({ ok: true, ...result }, { headers });
      }
      if (pathname === '/device/link/accept') {
        await acceptTrustedLinkSession({ DB: env.DEVICE_DB }, user.uid, requestData, signaturesJson);
        return Response.json({ ok: true }, { headers });
      }
      if (pathname === '/device/link/verify') {
        await verifyTrustedLinkCompletion({ DB: env.DEVICE_DB }, user.uid, requestData, signaturesJson);
        return Response.json({ ok: true }, { headers });
      }
      if (pathname === '/device/link/cancel') {
        await cancelTrustedLinkSession({ DB: env.DEVICE_DB }, user.uid, requestData, signaturesJson);
        return Response.json({ ok: true }, { headers });
      }
      await sendTrustedLinkSecrets({ DB: env.DEVICE_DB }, user.uid, requestData, signaturesJson);
      return Response.json({ ok: true }, { headers });
    }

    if (pathname === '/device/link/join') {
      await joinTrustedLinkSession({ DB: env.DEVICE_DB }, user.uid, {
        sessionId: body.sessionId,
        deviceId: body.deviceId,
        hpkePublicKey: body.hpkePublicKey,
        ciphertext: body.ciphertext,
      });
      return Response.json({ ok: true }, { headers });
    }

    if (pathname === '/device/link/complete') {
      await completeTrustedLinkJoin({ DB: env.DEVICE_DB }, user.uid, {
        sessionId: body.sessionId,
        deviceId: body.deviceId,
        ciphertext: body.ciphertext,
      });
      return Response.json({ ok: true }, { headers });
    }

    if (pathname === '/device/link/secrets/read') {
      const result = await readTrustedLinkMessageForJoiner({ DB: env.DEVICE_DB }, user.uid, {
        sessionId: body.sessionId,
        deviceId: body.deviceId,
        messageId: 'secrets',
      });
      return Response.json({ ok: true, message: result }, { headers });
    }

    if (pathname === '/device/link/secrets/ack') {
      await acknowledgeTrustedLinkSecrets({ DB: env.DEVICE_DB }, user.uid, {
        sessionId: body.sessionId,
        deviceId: body.deviceId,
        ciphertext: body.ciphertext,
      });
      return Response.json({ ok: true }, { headers });
    }

    if (pathname === '/device/link/accept/read') {
      const result = await readTrustedLinkMessageForJoiner({ DB: env.DEVICE_DB }, user.uid, {
        sessionId: body.sessionId,
        deviceId: body.deviceId,
        messageId: 'accept',
      });
      return Response.json({ ok: true, message: result }, { headers });
    }

    if (pathname === '/device/list') {
      const requestData = body.request;
      if (!requestData || requestData.action !== 'device.list') {
        throw new DeviceAuthorizationError(400, 'A signed device.list request is required.');
      }
      const devices = await listTrustedDevices(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      return Response.json({ ok: true, devices }, { headers });
    }

    if (pathname === '/device/inbox/send') {
      const requestData = body.request;
      const recipientUid = requestData?.payload?.recipientUid;
      const chatId = requestData?.payload?.chatId;
      if (!requestData || requestData.action !== 'device.inbox.send' ||
          typeof recipientUid !== 'string' || typeof chatId !== 'string') {
        throw new DeviceAuthorizationError(400, 'A signed device.inbox.send request is required.');
      }
      await requireChatParticipants(env, user.token, chatId, [user.uid, recipientUid]);
      await sendTrustedDeviceEvent(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      return Response.json({ ok: true }, { headers });
    }

    if (pathname === '/device/inbox/list') {
      const requestData = body.request;
      const chatId = requestData?.payload?.chatId;
      if (!requestData || requestData.action !== 'device.inbox.list' || typeof chatId !== 'string') {
        throw new DeviceAuthorizationError(400, 'A signed device.inbox.list request is required.');
      }
      await requireChatParticipants(env, user.token, chatId, [user.uid]);
      const events = await listTrustedDeviceEvents(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      return Response.json({ ok: true, events }, { headers });
    }

    if (pathname === '/device/inbox/ack') {
      const requestData = body.request;
      const chatId = requestData?.payload?.chatId;
      if (!requestData || requestData.action !== 'device.inbox.ack' || typeof chatId !== 'string') {
        throw new DeviceAuthorizationError(400, 'A signed device.inbox.ack request is required.');
      }
      await requireChatParticipants(env, user.token, chatId, [user.uid]);
      const acknowledged = await acknowledgeTrustedDeviceEvents(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      return Response.json({ ok: true, acknowledged }, { headers });
    }

    if (pathname === '/device/keys/counts') {
      const requestData = body.request;
      if (!requestData || requestData.action !== 'device.keys.counts') {
        throw new DeviceAuthorizationError(400, 'A signed device.keys.counts request is required.');
      }
      const stats = await getTrustedDeviceKeyStats(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      return Response.json({ ok: true, ...stats }, { headers });
    }

    if (pathname === '/device/keys/query') {
      const requestData = body.request;
      const chatId = requestData?.payload?.chatId;
      const peerUids = requestData?.payload?.peerUids;
      if (!requestData || requestData.action !== 'device.keys.query' ||
          typeof chatId !== 'string' || !Array.isArray(peerUids) ||
          peerUids.some((value: unknown) => typeof value !== 'string')) {
        throw new DeviceAuthorizationError(400, 'A signed device.keys.query request is required.');
      }
      await requireChatParticipants(env, user.token, chatId, [user.uid, ...peerUids]);
      const keys = await queryTrustedDeviceKeys(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      return Response.json({ ok: true, ...keys }, { headers });
    }

    if (pathname === '/device/keys/claim') {
      const requestData = body.request;
      if (!requestData || requestData.action !== 'device.keys.claim') {
        throw new DeviceAuthorizationError(400, 'A signed device.keys.claim request is required.');
      }
      const recipientUid = requestData.payload?.recipientUid;
      const chatId = requestData.payload?.chatId;
      if (typeof recipientUid !== 'string' || typeof chatId !== 'string') {
        throw new DeviceAuthorizationError(400, 'The recipient and chat are required.');
      }
      await requireChatParticipants(env, user.token, chatId, [user.uid, recipientUid]);
      const result = await claimTrustedOneTimeKey(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      return Response.json({ ok: true, result }, { headers });
    }

    if (pathname === '/device/keys/publish') {
      const requestData = body.request;
      if (!requestData || requestData.action !== 'device.keys.publish') {
        throw new DeviceAuthorizationError(400, 'A signed device.keys.publish request is required.');
      }
      await verifyAndConsumeDeviceRequest(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      const result = await publishTrustedDeviceKeys(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      return Response.json({ ok: true, ...result }, { headers });
    }

    if (pathname === '/device/revoke') {
      const requestData = body.request;
      if (!requestData || requestData.action !== 'device.revoke' ||
          typeof requestData.payload?.targetDeviceId !== 'string') {
        throw new DeviceAuthorizationError(400, 'A signed device.revoke request is required.');
      }
      await verifyAndConsumeDeviceRequest(
        { DB: env.DEVICE_DB },
        user.uid,
        requestData,
        JSON.stringify(body.signatures ?? {}),
      );
      const now = Date.now();
      const result = await env.DEVICE_DB.prepare(
        `UPDATE device_credentials
            SET status = 'revoked', revoked_at = ?1, updated_at = ?1
          WHERE uid = ?2 AND device_id = ?3 AND status = 'active'`,
      ).bind(now, user.uid, requestData.payload.targetDeviceId).run();
      if ((result.meta?.changes ?? 0) !== 1) {
        throw new DeviceAuthorizationError(404, 'The target device is not active or does not exist.');
      }
      return Response.json({ ok: true, revokedDeviceId: requestData.payload.targetDeviceId }, { headers });
    }

    return Response.json({ error: 'Unknown trusted device operation.' }, { status: 404, headers });
  } catch (error: any) {
    const status = error instanceof DeviceAuthorizationError ? error.status : (error.status || 500);
    return Response.json(
      { error: error?.message || 'Trusted device operation failed.' },
      { status, headers },
    );
  }
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

  let authenticatedUser: { uid: string; token: string };
  try {
    authenticatedUser = await requireFirebaseUser(request, env);
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
  const match = /^chats\/([A-Za-z0-9_-]{1,128})\/media\/([A-Za-z0-9_-]{1,128}\.bin)$/.exec(key);
  if (!match) {
    return Response.json(
      { error: 'Only encrypted chat attachment uploads are supported.' },
      { status: 403, headers: applyCorsHeaders(request, env) }
    );
  }

  if (file.type !== 'application/octet-stream' || file.size > 25 * 1024 * 1024) {
    return Response.json(
      { error: 'Chat attachments must be encrypted binary files no larger than 25 MB.' },
      { status: 400, headers: applyCorsHeaders(request, env) }
    );
  }

  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    return Response.json(
      { error: 'Worker config is missing FIREBASE_PROJECT_ID.' },
      { status: 500, headers: applyCorsHeaders(request, env) }
    );
  }

  const chatResponse = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/chats/${encodeURIComponent(match[1])}`,
    { headers: { Authorization: `Bearer ${authenticatedUser.token}` } },
  );
  if (!chatResponse.ok) {
    return Response.json(
      { error: 'Chat not found or access denied.' },
      { status: 403, headers: applyCorsHeaders(request, env) }
    );
  }

  const chatDocument = await chatResponse.json().catch(() => ({} as any));
  const participants = chatDocument?.fields?.participants?.arrayValue?.values ?? [];
  const isParticipant = participants.some((entry: any) => entry?.stringValue === authenticatedUser.uid);
  if (!isParticipant) {
    return Response.json(
      { error: 'Only chat participants may upload attachments.' },
      { status: 403, headers: applyCorsHeaders(request, env) }
    );
  }

  // Attachment object keys are immutable: retries or malicious requests
  // must not replace ciphertext already referenced by a chat message.
  const object = await env.BUCKET.put(
    key,
    file,
    {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: {
        contentType: 'application/octet-stream',
      },
    }
  );

  if (!object) {
    return Response.json(
      { error: 'An attachment already exists at this path; choose a new file ID.' },
      { status: 409, headers: applyCorsHeaders(request, env) }
    );
  }

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

    if (url.pathname.startsWith('/device/')) {
      return handleTrustedDeviceRequest(request, env, url.pathname);
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
