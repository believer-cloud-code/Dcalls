export interface AuthEnv {
  VONAGE_API_KEY?: string;
  VONAGE_API_SECRET?: string;
  VONAGE_BRAND?: string;

  FIREBASE_WEB_API_KEY?: string;
  FIREBASE_SERVICE_ACCOUNT_EMAIL?: string;
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;

  AUTH_TRANSACTION_SECRET?: string;
  FIREBASE_PROJECT_ID?: string;
}

class AuthHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const encoder = new TextEncoder();

function base64UrlEncode(value: ArrayBuffer | Uint8Array | string) {
  const bytes =
    typeof value === 'string'
      ? encoder.encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);

  let binary = '';

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string) {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const padded =
    normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function pemToArrayBuffer(pem: string) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(value)
  );

  const bytes = new Uint8Array(digest);

  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSign(
  payload: string,
  secret: string
) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );

  return base64UrlEncode(signature);
}

async function hmacVerify(
  payload: string,
  signature: string,
  secret: string
) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['verify']
  );

  return crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlDecode(signature),
    encoder.encode(payload)
  );
}

async function createTransactionToken(
  data: {
    requestId: string;
    phoneNumber: string;
    expiresAt: number;
  },
  secret: string
) {
  const payload = base64UrlEncode(
    JSON.stringify(data)
  );

  const signature = await hmacSign(payload, secret);

  return `${payload}.${signature}`;
}

async function verifyTransactionToken(
  token: string,
  secret: string
) {
  const parts = token.split('.');

  if (parts.length !== 2) {
    throw new AuthHttpError(
      400,
      'Invalid verification transaction.'
    );
  }

  const [payload, signature] = parts;

  const valid = await hmacVerify(
    payload,
    signature,
    secret
  );

  if (!valid) {
    throw new AuthHttpError(
      401,
      'Invalid verification transaction.'
    );
  }

  let data: {
    requestId: string;
    phoneNumber: string;
    expiresAt: number;
  };

  try {
    data = JSON.parse(
      new TextDecoder().decode(
        base64UrlDecode(payload)
      )
    );
  } catch {
    throw new AuthHttpError(
      400,
      'Invalid verification transaction.'
    );
  }

  if (
    !data.requestId ||
    !data.phoneNumber ||
    !data.expiresAt ||
    Date.now() > data.expiresAt
  ) {
    throw new AuthHttpError(
      410,
      'Verification transaction expired. Please request a new code.'
    );
  }

  return data;
}

function normalizePhone(value: unknown) {
  const phone = String(value || '').trim();

  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new AuthHttpError(
      400,
      'Phone number must be in international E.164 format.'
    );
  }

  return phone;
}

function requireEnv(
  value: string | undefined,
  name: string
) {
  if (!value) {
    throw new AuthHttpError(
      500,
      `Worker authentication configuration is missing ${name}.`
    );
  }

  return value;
}

async function vonageRequest(
  url: string,
  env: AuthEnv,
  init: RequestInit
) {
  const apiKey = requireEnv(
    env.VONAGE_API_KEY,
    'VONAGE_API_KEY'
  );

  const apiSecret = requireEnv(
    env.VONAGE_API_SECRET,
    'VONAGE_API_SECRET'
  );

  const credentials = btoa(
    `${apiKey}:${apiSecret}`
  );

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  const text = await response.text();

  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    console.error(
      'Vonage Verify error:',
      response.status,
      data
    );

    throw new AuthHttpError(
      response.status === 429
        ? 429
        : response.status === 409
          ? 409
          : 502,
      data?.title ||
        data?.detail ||
        data?.error_text ||
        'Unable to process phone verification.'
    );
  }

  return data;
}

export async function handleSendOtp(
  request: Request,
  env: AuthEnv
) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
    });
  }

  if (request.method !== 'POST') {
    throw new AuthHttpError(
      405,
      'Method Not Allowed'
    );
  }

  const body = await request.json().catch(() => null);

  if (!body) {
    throw new AuthHttpError(
      400,
      'Invalid JSON request.'
    );
  }

  const phoneNumber = normalizePhone(
    body.phoneNumber
  );

  const brand = requireEnv(
    env.VONAGE_BRAND,
    'VONAGE_BRAND'
  );

  if (brand.length > 18) {
    throw new AuthHttpError(
      500,
      'VONAGE_BRAND must be 18 characters or fewer.'
    );
  }

  const result = await vonageRequest(
    'https://api.nexmo.com/v2/verify',
    env,
    {
      method: 'POST',
      body: JSON.stringify({
        brand,
        code_length: 6,
        channel_timeout: 180,
        workflow: [
          {
            channel: 'sms',
            to: phoneNumber.replace('+', ''),
          },
        ],
      }),
    }
  );

  if (!result?.request_id) {
    throw new AuthHttpError(
      502,
      'Vonage did not return a verification request ID.'
    );
  }

  const transactionSecret = requireEnv(
    env.AUTH_TRANSACTION_SECRET,
    'AUTH_TRANSACTION_SECRET'
  );

  const transaction =
    await createTransactionToken(
      {
        requestId: result.request_id,
        phoneNumber,
        expiresAt:
          Date.now() + 10 * 60 * 1000,
      },
      transactionSecret
    );

  return Response.json({
    ok: true,
    transaction,
    phoneNumber,
    expiresIn: 600,
  });
}

async function createFirebaseCustomToken(
  uid: string,
  env: AuthEnv,
  phoneNumber: string
) {
  const serviceAccountEmail =
    requireEnv(
      env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
      'FIREBASE_SERVICE_ACCOUNT_EMAIL'
    );

  const privateKeyPem =
    requireEnv(
      env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY,
      'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY'
    );

  const now = Math.floor(Date.now() / 1000);

  const header = base64UrlEncode(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT',
    })
  );

  const payload = base64UrlEncode(
    JSON.stringify({
      iss: serviceAccountEmail,
      sub: serviceAccountEmail,
      aud:
        'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iat: now,
      exp: now + 3600,
      uid,
      claims: {
        phone_verified: true,
        phone_number: phoneNumber,
      },
    })
  );

  const unsignedToken =
    `${header}.${payload}`;

  const privateKey =
    await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(privateKeyPem),
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );

  const signature =
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      encoder.encode(unsignedToken)
    );

  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

async function exchangeCustomToken(
  customToken: string,
  env: AuthEnv
) {
  const apiKey = requireEnv(
    env.FIREBASE_WEB_API_KEY,
    'FIREBASE_WEB_API_KEY'
  );

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: customToken,
        returnSecureToken: true,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      'Firebase custom token exchange failed:',
      errorText
    );

    throw new AuthHttpError(
      502,
      'Firebase authentication failed.'
    );
  }

  return response.json();
}

export async function handleVerifyOtp(
  request: Request,
  env: AuthEnv
) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
    });
  }

  if (request.method !== 'POST') {
    throw new AuthHttpError(
      405,
      'Method Not Allowed'
    );
  }

  const body = await request.json().catch(() => null);

  if (!body) {
    throw new AuthHttpError(
      400,
      'Invalid JSON request.'
    );
  }

  const transaction = String(
    body.transaction || ''
  );

  const code = String(
    body.code || ''
  ).replace(/\D/g, '');

  if (!transaction) {
    throw new AuthHttpError(
      400,
      'Missing verification transaction.'
    );
  }

  if (code.length < 4 || code.length > 10) {
    throw new AuthHttpError(
      400,
      'Invalid verification code.'
    );
  }

  const transactionSecret = requireEnv(
    env.AUTH_TRANSACTION_SECRET,
    'AUTH_TRANSACTION_SECRET'
  );

  const verification =
    await verifyTransactionToken(
      transaction,
      transactionSecret
    );

  const result = await vonageRequest(
    `https://api.nexmo.com/v2/verify/${encodeURIComponent(verification.requestId)}`,
    env,
    {
      method: 'POST',
      body: JSON.stringify({
        code,
      }),
    }
  );

  if (
    result?.status !== 'completed'
  ) {
    throw new AuthHttpError(
      401,
      'Invalid verification code.'
    );
  }

  const projectId = requireEnv(
    env.FIREBASE_PROJECT_ID,
    'FIREBASE_PROJECT_ID'
  );

  const uidHash = await sha256Hex(
    `${projectId}:dcalls-phone:${verification.phoneNumber}`
  );

  const uid = `phone_${uidHash.slice(0, 40)}`;

  const customToken =
    await createFirebaseCustomToken(
      uid,
      env,
      verification.phoneNumber
    );

  const firebaseSession =
    await exchangeCustomToken(
      customToken,
      env
    );

  return Response.json({
    ok: true,
    customToken,
    idToken: firebaseSession.idToken,
    refreshToken: firebaseSession.refreshToken,
    expiresIn: firebaseSession.expiresIn,
    uid,
    phoneNumber: verification.phoneNumber,
  });
}
