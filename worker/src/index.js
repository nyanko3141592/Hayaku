// Hayaku Translate - Cloudflare Worker (Auth Proxy)
//
// Google認証済みユーザーのリクエストをGemini APIにプロキシ。
// APIキーはWorker側のシークレットに保管。

// Google token verification cache (in-memory, per isolate)
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5分

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    try {
      // Auth verification endpoint
      if (url.pathname === '/api/auth/verify') {
        return corsResponse(await handleAuthVerify(request, env));
      }

      // Translation proxy (streaming)
      if (url.pathname === '/api/translate/stream') {
        return corsResponse(await handleTranslateStream(request, env));
      }

      // Translation proxy (non-streaming, for page translation)
      if (url.pathname === '/api/translate') {
        return corsResponse(await handleTranslate(request, env));
      }

      return corsResponse(new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }));
    } catch (err) {
      return corsResponse(new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }));
    }
  }
};

// =====================================================
// Auth verification
// =====================================================
async function handleAuthVerify(request, env) {
  const user = await verifyGoogleToken(request, env);
  if (!user) {
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({
    authenticated: true,
    email: user.email,
    name: user.name,
    picture: user.picture
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// =====================================================
// Streaming translation proxy
// =====================================================
async function handleTranslateStream(request, env) {
  const user = await verifyGoogleToken(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const body = await request.json();
  const { model, systemPrompt, contents, temperature, maxOutputTokens } = body;

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const geminiUrl = buildGeminiUrl(model, 'streamGenerateContent', apiKey, env.AI_GATEWAY_URL) + '&alt=sse';

  const geminiResponse = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: temperature ?? 0.1,
        maxOutputTokens: maxOutputTokens ?? 8192
      }
    })
  });

  if (!geminiResponse.ok) {
    const errText = await geminiResponse.text();
    return new Response(JSON.stringify({ error: `Gemini API Error (${geminiResponse.status}): ${errText}` }), {
      status: geminiResponse.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // SSEストリームをそのままパススルー
  return new Response(geminiResponse.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}

// =====================================================
// Non-streaming translation proxy
// =====================================================
async function handleTranslate(request, env) {
  const user = await verifyGoogleToken(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const body = await request.json();
  const { model, systemPrompt, contents, temperature, maxOutputTokens } = body;

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const geminiUrl = buildGeminiUrl(model, 'generateContent', apiKey, env.AI_GATEWAY_URL);

  const geminiResponse = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: temperature ?? 0.1,
        maxOutputTokens: maxOutputTokens ?? 8192
      }
    })
  });

  if (!geminiResponse.ok) {
    const errText = await geminiResponse.text();
    return new Response(JSON.stringify({ error: `Gemini API Error (${geminiResponse.status}): ${errText}` }), {
      status: geminiResponse.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const data = await geminiResponse.json();
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// =====================================================
// Google OAuth token verification
// =====================================================
async function verifyGoogleToken(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  // Check cache
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL) {
    return cached.user;
  }

  // Verify with Google
  try {
    const res = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) return null;

    const user = await res.json();
    if (!user.email || !user.email_verified) return null;

    // Domain check
    const allowedDomains = (env.ALLOWED_DOMAINS || '').split(',').map(d => d.trim()).filter(Boolean);
    if (allowedDomains.length > 0) {
      const domain = user.email.split('@')[1];
      if (!allowedDomains.includes(domain)) return null;
    }

    // Cache
    tokenCache.set(token, { user, timestamp: Date.now() });

    // Evict old cache entries
    if (tokenCache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of tokenCache) {
        if (now - v.timestamp > TOKEN_CACHE_TTL) tokenCache.delete(k);
      }
    }

    return user;
  } catch {
    return null;
  }
}

// =====================================================
// URL builder
// =====================================================
function buildGeminiUrl(model, method, apiKey, gatewayUrl) {
  if (gatewayUrl) {
    const base = gatewayUrl.replace(/\/+$/, '');
    return `${base}/google-ai-studio/v1beta/models/${model}:${method}?key=${apiKey}`;
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}?key=${apiKey}`;
}

// =====================================================
// CORS
// =====================================================
function corsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
