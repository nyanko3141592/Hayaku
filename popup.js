// Hayaku Translate - Popup Script

const $ = (sel) => document.querySelector(sel);

// Elements
const apiKeyInput = $('#apiKey');
const gatewayUrlInput = $('#gatewayUrl');
const workerUrlInput = $('#workerUrl');
const toggleKeyBtn = $('#toggleKey');
const modelSelect = $('#modelSelect');
const targetLangSelect = $('#targetLang');
const sourceLangSelect = $('#sourceLang');
const dblclickToggle = $('#dblclickToggle');
const translateBtn = $('#translateBtn');
const inputText = $('#inputText');
const resultArea = $('#resultArea');
const swapBtn = $('#swapBtn');
const statusMsg = $('#statusMsg');

const authBanner = $('#authBanner');
const loginBanner = $('#loginBanner');
const loginBtn = $('#loginBtn');
const logoutBtn = $('#logoutBtn');
const authEmail = $('#authEmail');
const authAvatar = $('#authAvatar');

// === Auth State ===
function updateAuthUI(state) {
  if (state.authenticated) {
    authBanner.style.display = 'flex';
    loginBanner.style.display = 'none';
    authEmail.textContent = state.email;
    if (state.picture) authAvatar.src = state.picture;
    // 認証済みならAPIキー欄をグレーアウト
    apiKeyInput.placeholder = '認証済み（不要）';
    apiKeyInput.disabled = true;
  } else {
    authBanner.style.display = 'none';
    // Worker URLが設定されていればログインバナー表示
    const hasWorkerUrl = workerUrlInput.value.trim();
    loginBanner.style.display = hasWorkerUrl ? 'flex' : 'none';
    apiKeyInput.placeholder = 'Gemini APIキー';
    apiKeyInput.disabled = false;
  }
}

// 起動時に認証状態を取得
chrome.runtime.sendMessage({ action: 'get-auth-state' }, (state) => {
  if (state) updateAuthUI(state);
});

// 認証状態変更の通知を受け取る
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'auth-state-changed') {
    updateAuthUI(msg.authState);
  }
});

loginBtn.addEventListener('click', () => {
  loginBtn.disabled = true;
  loginBtn.textContent = 'ログイン中...';
  chrome.runtime.sendMessage({ action: 'google-login' }, (result) => {
    loginBtn.disabled = false;
    loginBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Googleでログイン';
    if (result?.error) {
      showStatus(result.error, 'error');
    } else if (result?.authenticated) {
      updateAuthUI(result);
      showStatus('ログインしました', 'success');
    }
  });
});

logoutBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'google-logout' }, (result) => {
    updateAuthUI(result);
    showStatus('ログアウトしました', 'success');
  });
});

// === Load saved settings ===
chrome.storage.sync.get(['geminiApiKey', 'settings'], (result) => {
  if (result.geminiApiKey) apiKeyInput.value = result.geminiApiKey;
  const s = result.settings || {};
  if (s.model) modelSelect.value = s.model;
  if (s.targetLang) targetLangSelect.value = s.targetLang;
  if (s.sourceLang) sourceLangSelect.value = s.sourceLang;
  if (s.dblclickTranslate) dblclickToggle.checked = true;
  if (s.gatewayUrl) gatewayUrlInput.value = s.gatewayUrl;
  if (s.workerUrl) workerUrlInput.value = s.workerUrl;

  // Worker URLがあれば認証状態に応じてバナー表示
  if (s.workerUrl) {
    chrome.runtime.sendMessage({ action: 'get-auth-state' }, (state) => {
      if (state) updateAuthUI(state);
    });
  }
});

// Save API key on change
apiKeyInput.addEventListener('change', () => {
  const key = apiKeyInput.value.trim();
  chrome.storage.sync.set({ geminiApiKey: key }, () => {
    showStatus('APIキーを保存しました', 'success');
  });
});

// Toggle API key visibility
toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyBtn.textContent = isPassword ? '隠す' : '表示';
});

// Save settings on change
function saveSettings() {
  const settings = {
    model: modelSelect.value,
    targetLang: targetLangSelect.value,
    sourceLang: sourceLangSelect.value,
    dblclickTranslate: dblclickToggle.checked,
    gatewayUrl: gatewayUrlInput.value.trim() || undefined,
    workerUrl: workerUrlInput.value.trim() || undefined
  };
  chrome.storage.sync.set({ settings });
}

modelSelect.addEventListener('change', saveSettings);
targetLangSelect.addEventListener('change', saveSettings);
sourceLangSelect.addEventListener('change', saveSettings);
dblclickToggle.addEventListener('change', saveSettings);
gatewayUrlInput.addEventListener('change', saveSettings);
workerUrlInput.addEventListener('change', () => {
  saveSettings();
  // Worker URL変更時にログインバナー表示を更新
  const hasUrl = workerUrlInput.value.trim();
  loginBanner.style.display = hasUrl ? 'flex' : 'none';
});

// Swap languages
swapBtn.addEventListener('click', () => {
  const src = sourceLangSelect.value;
  const tgt = targetLangSelect.value;
  if (src === 'auto') return;
  sourceLangSelect.value = tgt;
  targetLangSelect.value = src;
  saveSettings();

  const resultText = resultArea.textContent.trim();
  if (resultText && inputText.value.trim()) {
    inputText.value = resultText;
    resultArea.textContent = '';
    resultArea.classList.remove('visible');
  }
});

// Translate
translateBtn.addEventListener('click', () => doTranslate());
inputText.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    doTranslate();
  }
});

async function doTranslate() {
  const text = inputText.value.trim();
  if (!text) return;

  translateBtn.disabled = true;
  translateBtn.textContent = '...';
  resultArea.classList.add('visible');
  resultArea.textContent = '';

  const startTime = performance.now();

  try {
    const port = chrome.runtime.connect({ name: 'gemini-stream' });
    let result = '';

    port.onMessage.addListener((msg) => {
      if (msg.type === 'chunk') {
        result += msg.text;
        resultArea.textContent = result;
      }
      if (msg.type === 'done') {
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        const timer = document.createElement('div');
        timer.className = 'timer';
        timer.textContent = msg.cached ? 'cached' : `${elapsed}s`;
        resultArea.appendChild(timer);
        translateBtn.disabled = false;
        translateBtn.textContent = '翻訳';
      }
      if (msg.type === 'error') {
        resultArea.innerHTML = `<span class="error">${msg.error}</span>`;
        translateBtn.disabled = false;
        translateBtn.textContent = '翻訳';
      }
    });

    port.postMessage({
      text,
      targetLang: targetLangSelect.value,
      mode: 'selection'
    });
  } catch (err) {
    resultArea.innerHTML = `<span class="error">${err.message}</span>`;
    translateBtn.disabled = false;
    translateBtn.textContent = '翻訳';
  }
}

function showStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.className = `status ${type}`;
  setTimeout(() => { statusMsg.className = 'status'; }, 2000);
}

// Open full page
$('#openPageBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('page.html') });
  window.close();
});

// Focus input on open
inputText.focus();
