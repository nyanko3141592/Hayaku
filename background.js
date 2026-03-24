// Hayaku Translate - Background Service Worker
// デュアルモード: Google認証 (Worker経由) / APIキー直接
// 高速化v2: preflight OPTIONS事前キャッシュ + 短縮プロンプト + speculative翻訳

// =====================================================
// Auth State
// =====================================================
let authState = { authenticated: false, token: null, user: null };

trysilentAuth();

async function trysilentAuth() {
  const settings = await getSettings();
  if (!settings.workerUrl) return;
  try {
    const token = await getGoogleToken(false);
    if (token) {
      const user = await verifyWithWorker(token, settings.workerUrl);
      if (user) {
        authState = { authenticated: true, token, user };
        broadcastAuthState();
      }
    }
  } catch {}
}

function getGoogleToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

async function verifyWithWorker(token, workerUrl) {
  const res = await fetch(`${workerUrl.replace(/\/+$/, '')}/api/auth/verify`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.authenticated ? data : null;
}

function broadcastAuthState() {
  chrome.runtime.sendMessage({
    action: 'auth-state-changed',
    authState: {
      authenticated: authState.authenticated,
      email: authState.user?.email,
      name: authState.user?.name,
      picture: authState.user?.picture
    }
  }).catch(() => {});
}

// =====================================================
// Aggressive Preflight Warmup
// nani-translate方式: OPTIONSプリフライト事前キャッシュ
// + 実際のストリーミングエンドポイントでTLS/TCP warm
// =====================================================
const WARMUP_INTERVAL_MS = 5 * 60 * 1000; // 5分（より攻撃的）

async function warmupConnection() {
  const settings = await getSettings();

  if (authState.authenticated && settings.workerUrl) {
    const base = settings.workerUrl.replace(/\/+$/, '');
    // Worker: auth verify + OPTIONSプリフライト事前送信
    await Promise.allSettled([
      fetch(`${base}/api/auth/verify`, {
        headers: { 'Authorization': `Bearer ${authState.token}` }
      }),
      // ストリーミングエンドポイントへのOPTIONS事前送信
      fetch(`${base}/api/translate/stream`, { method: 'OPTIONS' }),
      fetch(`${base}/api/translate`, { method: 'OPTIONS' }),
    ]);
  } else {
    const apiKey = await getApiKey();
    if (!apiKey) return;
    // 直接モード: 実際のストリーミングエンドポイントでwarm
    // countTokensではなくstreamGenerateContentでTLS+DNS+TCPをwarm
    const model = 'gemini-3.1-flash-lite-preview';
    const gwUrl = settings.gatewayUrl;
    const streamUrl = buildApiUrl(model, 'streamGenerateContent', apiKey, gwUrl) + '&alt=sse';
    const nonStreamUrl = buildApiUrl(model, 'generateContent', apiKey, gwUrl);
    try {
      // 極小リクエストで接続をwarm（空翻訳）
      await fetch(streamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: '.' }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 1 }
        })
      });
    } catch {}
  }
}

warmupConnection();
setInterval(warmupConnection, WARMUP_INTERVAL_MS);

// =====================================================
// L1 In-Memory Cache (instant, ~0ms lookup)
// =====================================================
const memCache = new Map();
const MEM_CACHE_MAX = 200;

function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  memCache.delete(key);
  memCache.set(key, entry);
  return entry;
}

function memSet(key, value) {
  if (memCache.size >= MEM_CACHE_MAX) {
    const firstKey = memCache.keys().next().value;
    memCache.delete(firstKey);
  }
  memCache.set(key, value);
}

// =====================================================
// L2 Translation Cache (IndexedDB)
// =====================================================
const CACHE_DB_NAME = 'hayaku-cache';
const CACHE_STORE = 'translations';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

let cachedDB = null;

async function openCacheDB() {
  if (cachedDB) return cachedDB;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        const store = db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp');
      }
    };
    req.onsuccess = () => { cachedDB = req.result; resolve(cachedDB); };
    req.onerror = () => reject(req.error);
  });
}

function makeCacheKey(text, targetLang, mode) {
  const raw = `${mode}:${targetLang}:${text}`;
  if (raw.length < 500) return raw;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `${mode}:${targetLang}:hash:${hash}:${text.length}:${text.slice(0, 100)}`;
}

async function getCached(text, targetLang, mode) {
  const key = makeCacheKey(text, targetLang, mode);
  const mem = memGet(key);
  if (mem) return mem;
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const store = tx.objectStore(CACHE_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (entry && (Date.now() - entry.timestamp) < CACHE_MAX_AGE_MS) {
          memSet(key, entry.translation);
          resolve(entry.translation);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function setCache(text, targetLang, mode, translation) {
  const key = makeCacheKey(text, targetLang, mode);
  memSet(key, translation);
  try {
    const db = await openCacheDB();
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    const store = tx.objectStore(CACHE_STORE);
    store.put({ key, text, targetLang, mode, translation, timestamp: Date.now() });
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result > CACHE_MAX_ENTRIES) {
        const idx = store.index('timestamp');
        const deleteCount = countReq.result - CACHE_MAX_ENTRIES;
        let deleted = 0;
        const cursor = idx.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c && deleted < deleteCount) { c.delete(); deleted++; c.continue(); }
        };
      }
    };
  } catch {}
}

// =====================================================
// Smart Model Selection
// =====================================================
function selectModel(text, userModel) {
  if (userModel && (userModel.includes('pro') || userModel.includes('3-flash'))) return userModel;
  const len = text.length;
  if (len <= 200) return 'gemini-3.1-flash-lite-preview';
  if (len <= 2000) return userModel || 'gemini-3.1-flash-lite-preview';
  return userModel || 'gemini-2.5-flash';
}

// =====================================================
// Adaptive maxOutputTokens
// =====================================================
function calcMaxTokens(text, mode) {
  if (mode === 'reply') return 4096;
  const len = text.length;
  if (len <= 100) return 256;   // さらに絞る: 短文は256で十分
  if (len <= 300) return 512;
  if (len <= 1000) return 1024;
  if (len <= 3000) return 2048;
  if (len <= 5000) return 4096;
  return 8192;
}

// =====================================================
// Request deduplication
// =====================================================
const inflightRequests = new Map();

// =====================================================
// Speculative pre-translation
// テキスト選択時点でバックグラウンドに通知 → キャッシュに先行投入
// =====================================================
const speculativeResults = new Map();
const SPECULATIVE_MAX = 10;
const SPECULATIVE_TTL = 60000; // 1min

// =====================================================
// Context menu & shortcuts
// =====================================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'hyk-translate',
    title: 'Hayaku 翻訳',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'hyk-translate' && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, { action: 'translate-selection', text: info.selectionText });
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  chrome.tabs.sendMessage(tab.id, { action: command });
});

// =====================================================
// Message handler
// =====================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'call-gemini') {
    callGemini(request.text, request.targetLang, request.mode)
      .then(result => sendResponse({ success: true, translation: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'call-gemini-batch') {
    callGeminiBatch(request.items, request.targetLang, request.mode)
      .then(results => sendResponse({ success: true, results }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Speculative pre-translation: content scriptがテキスト選択時に送信
  if (request.action === 'speculative-translate') {
    speculativeTranslate(request.text, request.targetLang);
    return false;
  }

  if (request.action === 'get-auth-state') {
    sendResponse({
      authenticated: authState.authenticated,
      email: authState.user?.email,
      name: authState.user?.name,
      picture: authState.user?.picture
    });
    return false;
  }

  if (request.action === 'google-login') {
    handleGoogleLogin().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'google-logout') {
    handleGoogleLogout().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// Speculative: バックグラウンドで先行翻訳してキャッシュに入れる
async function speculativeTranslate(text, targetLang) {
  if (!text || text.length > 500) return; // 短文のみ投機的に翻訳
  const key = makeCacheKey(text, targetLang, 'selection');
  if (memGet(key)) return; // 既にキャッシュにある
  if (speculativeResults.has(key)) return; // 既にinflight

  // Evict old speculative entries
  if (speculativeResults.size >= SPECULATIVE_MAX) {
    const firstKey = speculativeResults.keys().next().value;
    speculativeResults.delete(firstKey);
  }
  speculativeResults.set(key, Date.now());

  try {
    // キャッシュチェック (IndexedDB)
    const cached = await getCached(text, targetLang, 'selection');
    if (cached) { speculativeResults.delete(key); return; }

    // 先行翻訳リクエスト
    const settings = await getSettings();
    const model = selectModel(text, settings.model);
    const systemPrompt = buildSystemPrompt(targetLang, 'selection');
    const maxOutputTokens = calcMaxTokens(text, 'selection');

    let data;
    if (authState.authenticated && settings.workerUrl) {
      const workerUrl = `${settings.workerUrl.replace(/\/+$/, '')}/api/translate`;
      const response = await fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authState.token}`
        },
        body: JSON.stringify({ model, systemPrompt, contents: [{ parts: [{ text }] }], temperature: 0.1, maxOutputTokens })
      });
      if (!response.ok) { speculativeResults.delete(key); return; }
      data = await response.json();
    } else {
      const apiKey = await getApiKey();
      if (!apiKey) { speculativeResults.delete(key); return; }
      const url = buildApiUrl(model, 'generateContent', apiKey, settings.gatewayUrl);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens }
        })
      });
      if (!response.ok) { speculativeResults.delete(key); return; }
      data = await response.json();
    }

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (result) setCache(text, targetLang, 'selection', result);
  } catch {}
  speculativeResults.delete(key);
}

async function handleGoogleLogin() {
  const settings = await getSettings();
  if (!settings.workerUrl) return { error: 'Worker URLが設定されていません' };
  const token = await getGoogleToken(true);
  const user = await verifyWithWorker(token, settings.workerUrl);
  if (!user) {
    chrome.identity.removeCachedAuthToken({ token });
    return { error: '認証に失敗しました。許可されたドメインのアカウントでログインしてください。' };
  }
  authState = { authenticated: true, token, user };
  broadcastAuthState();
  return { authenticated: true, email: user.email, name: user.name, picture: user.picture };
}

async function handleGoogleLogout() {
  if (authState.token) chrome.identity.removeCachedAuthToken({ token: authState.token });
  authState = { authenticated: false, token: null, user: null };
  broadcastAuthState();
  return { authenticated: false };
}

// =====================================================
// Streaming translation (dual mode)
// =====================================================
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gemini-stream') return;

  port.onMessage.addListener(async (request) => {
    try {
      // Cache check (skip for reply)
      if (request.mode !== 'reply') {
        const cached = await getCached(request.text, request.targetLang, request.mode);
        if (cached) {
          port.postMessage({ type: 'chunk', text: cached });
          port.postMessage({ type: 'done', cached: true });
          return;
        }
      }

      // Fetch settings + apiKey in parallel
      const [settings, apiKey] = await Promise.all([
        getSettings(),
        authState.authenticated ? Promise.resolve(null) : getApiKey()
      ]);

      const systemPrompt = request.mode === 'reply'
        ? buildReplyPrompt(request.replyLang)
        : buildSystemPrompt(request.targetLang, request.mode);
      const contents = request.mode === 'reply'
        ? buildReplyContents(request.originalText, request.translatedText, request.replyHistory, request.text)
        : [{ parts: [{ text: request.text }] }];
      const model = selectModel(request.text, settings.model);
      const temperature = request.mode === 'reply' ? 0.4 : 0.1;
      const maxOutputTokens = calcMaxTokens(request.text, request.mode);

      let response;

      if (authState.authenticated && settings.workerUrl) {
        const workerUrl = `${settings.workerUrl.replace(/\/+$/, '')}/api/translate/stream`;
        response = await fetch(workerUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authState.token}`
          },
          body: JSON.stringify({ model, systemPrompt, contents, temperature, maxOutputTokens })
        });
      } else {
        if (!apiKey) {
          port.postMessage({ type: 'error', error: 'APIキーが設定されていません。Googleログインするか、APIキーを設定してください。' });
          return;
        }
        const url = buildApiUrl(model, 'streamGenerateContent', apiKey, settings.gatewayUrl) + '&alt=sse';
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { temperature, maxOutputTokens }
          })
        });
      }

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 401 && authState.authenticated) {
          authState = { authenticated: false, token: null, user: null };
          broadcastAuthState();
          port.postMessage({ type: 'error', error: '認証が期限切れです。再ログインしてください。' });
          return;
        }
        port.postMessage({ type: 'error', error: `API Error (${response.status}): ${errText}` });
        return;
      }

      // Parse SSE stream — optimized line processing
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);

          if (line.length < 7 || line.charCodeAt(0) !== 100) continue;
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6);
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const data = JSON.parse(jsonStr);
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              fullText += text;
              port.postMessage({ type: 'chunk', text });
            }
          } catch {}
        }
      }

      port.postMessage({ type: 'done' });

      if (request.mode !== 'reply' && fullText) {
        setCache(request.text, request.targetLang, request.mode, fullText);
      }
    } catch (err) {
      port.postMessage({ type: 'error', error: err.message });
    }
  });
});

// =====================================================
// Non-streaming call (page translation) with dedup
// =====================================================
async function callGemini(text, targetLang, mode) {
  const cacheKey = makeCacheKey(text, targetLang, mode);
  const cached = await getCached(text, targetLang, mode);
  if (cached) return cached;

  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const promise = _callGeminiImpl(text, targetLang, mode);
  inflightRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

async function _callGeminiImpl(text, targetLang, mode) {
  const settings = await getSettings();
  const model = selectModel(text, settings.model);
  const systemPrompt = buildSystemPrompt(targetLang, mode);
  const maxOutputTokens = calcMaxTokens(text, mode);

  let data;

  if (authState.authenticated && settings.workerUrl) {
    const workerUrl = `${settings.workerUrl.replace(/\/+$/, '')}/api/translate`;
    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authState.token}`
      },
      body: JSON.stringify({ model, systemPrompt, contents: [{ parts: [{ text }] }], temperature: 0.1, maxOutputTokens })
    });
    if (!response.ok) throw new Error(`API Error (${response.status}): ${await response.text()}`);
    data = await response.json();
  } else {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('APIキーが設定されていません。');
    const url = buildApiUrl(model, 'generateContent', apiKey, settings.gatewayUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens }
      })
    });
    if (!response.ok) throw new Error(`API Error (${response.status}): ${await response.text()}`);
    data = await response.json();
  }

  const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (result) setCache(text, targetLang, mode, result);
  return result;
}

// =====================================================
// Batch translation (parallel, for page translation)
// =====================================================
async function callGeminiBatch(items, targetLang, mode) {
  const CONCURRENCY = 4;
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await callGemini(items[i], targetLang, mode);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// =====================================================
// Prompt builders (短縮版: 入力トークン削減 → TTFT短縮)
// =====================================================
const LANG_NAMES = { ja:'日本語',en:'English',zh:'中文',ko:'한국어',es:'Español',fr:'Français',de:'Deutsch',pt:'Português',ru:'Русский',ar:'العربية',hi:'हिन्दी',it:'Italiano' };

function buildSystemPrompt(targetLang, mode) {
  const lang = LANG_NAMES[targetLang] || targetLang;
  if (mode === 'page') {
    return `Translate to ${lang}. Preserve HTML tags/attributes. Keep code/URLs/proper nouns. Output only translated text. Be natural, not literal.`;
  }
  return `Translate to ${lang}. Output only the translation. Keep code/URLs/proper nouns. Be natural, not literal. Match original tone.`;
}

function buildReplyPrompt(replyLang) {
  const lang = LANG_NAMES[replyLang] || replyLang;
  return `You compose replies in ${lang}. The user received a message in ${lang} and wants to reply. Turn their intent into a polished ${lang} reply. ALWAYS write in ${lang}. Match tone/formality of original. Output ONLY the reply text.`;
}

function buildReplyContents(originalText, translatedText, replyHistory, userIntent) {
  const contents = [
    { role: 'user', parts: [{ text: `[Original]\n${originalText}\n\n[Translation]\n${translatedText}` }] },
    { role: 'model', parts: [{ text: 'Ready. What should I reply?' }] }
  ];
  if (replyHistory?.length > 0) {
    for (const turn of replyHistory) {
      contents.push({ role: 'user', parts: [{ text: turn.intent }] });
      contents.push({ role: 'model', parts: [{ text: turn.reply }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: userIntent }] });
  return contents;
}

// =====================================================
// Storage & URL helpers (with aggressive caching)
// =====================================================
let settingsCache = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 10000; // 10s

let apiKeyCache = null;
let apiKeyCacheTime = 0;

async function getApiKey() {
  const now = Date.now();
  if (apiKeyCache && (now - apiKeyCacheTime) < SETTINGS_CACHE_TTL) {
    return apiKeyCache;
  }
  const result = await chrome.storage.sync.get('geminiApiKey');
  apiKeyCache = result.geminiApiKey;
  apiKeyCacheTime = now;
  return apiKeyCache;
}

async function getSettings() {
  const now = Date.now();
  if (settingsCache && (now - settingsCacheTime) < SETTINGS_CACHE_TTL) {
    return settingsCache;
  }
  const result = await chrome.storage.sync.get('settings');
  settingsCache = result.settings || {};
  settingsCacheTime = now;
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    settingsCache = changes.settings.newValue || {};
    settingsCacheTime = Date.now();
  }
  if (changes.geminiApiKey) {
    apiKeyCache = changes.geminiApiKey.newValue;
    apiKeyCacheTime = Date.now();
  }
});

function buildApiUrl(model, method, apiKey, gatewayUrl) {
  if (gatewayUrl) {
    const base = gatewayUrl.replace(/\/+$/, '');
    return `${base}/google-ai-studio/v1beta/models/${model}:${method}?key=${apiKey}`;
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}?key=${apiKey}`;
}
