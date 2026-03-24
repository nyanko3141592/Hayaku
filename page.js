// Hayaku Translate - Full Page Script

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// === Elements ===
const inputText = $('#inputText');
const resultArea = $('#resultArea');
const resultActions = $('#resultActions');
const translateBtn = $('#translateBtn');
const copyResultBtn = $('#copyResultBtn');
const replyBtn = $('#replyBtn');
const clearBtn = $('#clearBtn');
const swapBtn = $('#swapBtn');
const sourceLang = $('#sourceLang');
const targetLang = $('#targetLang');
const timerDisplay = $('#timerDisplay');
const loadingSpinner = $('#loadingSpinner');

const replySection = $('#replySection');
const replyThread = $('#replyThread');
const replyInput = $('#replyInput');
const replySend = $('#replySend');
const closeReply = $('#closeReply');

const settingsToggle = $('#settingsToggle');
const settingsPanel = $('#settingsPanel');
const apiKeyInput = $('#apiKey');
const toggleKeyBtn = $('#toggleKey');
const modelSelect = $('#modelSelect');
const defaultTargetLang = $('#defaultTargetLang');
const gatewayUrlInput = $('#gatewayUrl');
const workerUrlInput = $('#workerUrl');
const statusToast = $('#statusToast');

const authInfo = $('#authInfo');
const authAvatar = $('#authAvatar');
const authEmail = $('#authEmail');
const loginBtn = $('#loginBtn');
const logoutBtn = $('#logoutBtn');

// === State ===
let currentOriginalText = '';
let currentTranslatedText = '';
let replyHistory = [];
let currentPort = null;

// === Auth ===
function updateAuthUI(state) {
  if (state.authenticated) {
    authInfo.style.display = 'flex';
    loginBtn.style.display = 'none';
    authEmail.textContent = state.email;
    if (state.picture) authAvatar.src = state.picture;
  } else {
    authInfo.style.display = 'none';
    loginBtn.style.display = workerUrlInput.value.trim() ? 'flex' : 'none';
  }
}

chrome.runtime.sendMessage({ action: 'get-auth-state' }, (state) => {
  if (state) updateAuthUI(state);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'auth-state-changed') updateAuthUI(msg.authState);
});

loginBtn.addEventListener('click', () => {
  loginBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'google-login' }, (result) => {
    loginBtn.disabled = false;
    if (result?.error) showToast(result.error, 'error');
    else if (result?.authenticated) {
      updateAuthUI(result);
      showToast('ログインしました', 'success');
    }
  });
});

logoutBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'google-logout' }, (result) => {
    updateAuthUI(result);
    showToast('ログアウトしました', 'success');
  });
});

// === Init: Load settings ===
chrome.storage.sync.get(['geminiApiKey', 'settings'], (result) => {
  if (result.geminiApiKey) apiKeyInput.value = result.geminiApiKey;
  const s = result.settings || {};
  if (s.model) modelSelect.value = s.model;
  if (s.targetLang) {
    targetLang.value = s.targetLang;
    defaultTargetLang.value = s.targetLang;
  }
  if (s.sourceLang) sourceLang.value = s.sourceLang;
  if (s.gatewayUrl) gatewayUrlInput.value = s.gatewayUrl;
  if (s.workerUrl) workerUrlInput.value = s.workerUrl;

  // If no API key, auto-open settings
  if (!result.geminiApiKey) {
    settingsPanel.classList.add('visible');
    settingsToggle.classList.add('open');
  }
});

// === Settings ===
settingsToggle.addEventListener('click', () => {
  settingsToggle.classList.toggle('open');
  settingsPanel.classList.toggle('visible');
});

toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleKeyBtn.textContent = isPassword ? '隠す' : '表示';
});

apiKeyInput.addEventListener('change', () => {
  chrome.storage.sync.set({ geminiApiKey: apiKeyInput.value.trim() }, () => {
    showToast('APIキーを保存しました', 'success');
  });
});

function saveSettings() {
  const settings = {
    model: modelSelect.value,
    targetLang: targetLang.value,
    sourceLang: sourceLang.value,
    gatewayUrl: gatewayUrlInput.value.trim() || undefined,
    workerUrl: workerUrlInput.value.trim() || undefined
  };
  chrome.storage.sync.set({ settings });
}

modelSelect.addEventListener('change', saveSettings);
targetLang.addEventListener('change', saveSettings);
sourceLang.addEventListener('change', saveSettings);
gatewayUrlInput.addEventListener('change', saveSettings);
workerUrlInput.addEventListener('change', () => {
  saveSettings();
  loginBtn.style.display = workerUrlInput.value.trim() ? 'flex' : 'none';
});
defaultTargetLang.addEventListener('change', () => {
  targetLang.value = defaultTargetLang.value;
  saveSettings();
});

// === Swap languages ===
swapBtn.addEventListener('click', () => {
  const src = sourceLang.value;
  const tgt = targetLang.value;
  if (src === 'auto') return;
  sourceLang.value = tgt;
  targetLang.value = src;
  saveSettings();

  // Swap texts too
  if (currentTranslatedText && inputText.value.trim()) {
    inputText.value = currentTranslatedText;
    resultArea.textContent = '';
    resultActions.style.display = 'none';
    currentTranslatedText = '';
    hideReplySection();
  }
});

// === Clear ===
clearBtn.addEventListener('click', () => {
  inputText.value = '';
  resultArea.textContent = '';
  resultActions.style.display = 'none';
  timerDisplay.textContent = '';
  currentOriginalText = '';
  currentTranslatedText = '';
  hideReplySection();
  inputText.focus();
});

// === Translate ===
translateBtn.addEventListener('click', doTranslate);
inputText.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    doTranslate();
  }
});

function doTranslate() {
  const text = inputText.value.trim();
  if (!text) return;

  // Reset
  disconnectPort();
  resultActions.style.display = 'none';
  timerDisplay.textContent = '';
  hideReplySection();
  translateBtn.disabled = true;
  loadingSpinner.style.display = '';

  currentOriginalText = text;
  currentTranslatedText = '';
  let firstChunkReceived = false;

  // スケルトン表示
  resultArea.innerHTML = '<div class="skeleton"><div class="skeleton-line" style="width:90%"></div><div class="skeleton-line" style="width:75%"></div><div class="skeleton-line" style="width:55%"></div></div>';

  const startTime = performance.now();
  const timerInterval = setInterval(() => {
    timerDisplay.textContent = `${((performance.now() - startTime) / 1000).toFixed(1)}s`;
  }, 100);

  // リクエスト即時発火
  const port = chrome.runtime.connect({ name: 'gemini-stream' });
  currentPort = port;

  port.postMessage({
    text,
    targetLang: targetLang.value,
    mode: 'selection'
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'chunk') {
      if (!firstChunkReceived) {
        firstChunkReceived = true;
        resultArea.textContent = '';
      }
      currentTranslatedText += msg.text;
      resultArea.textContent = currentTranslatedText;
    }
    if (msg.type === 'done') {
      clearInterval(timerInterval);
      timerDisplay.textContent = msg.cached ? 'cached' : `${((performance.now() - startTime) / 1000).toFixed(1)}s`;
      loadingSpinner.style.display = 'none';
      translateBtn.disabled = false;
      resultActions.style.display = 'flex';
      currentPort = null;
    }
    if (msg.type === 'error') {
      clearInterval(timerInterval);
      resultArea.innerHTML = `<span class="error">${escapeHtml(msg.error)}</span>`;
      loadingSpinner.style.display = 'none';
      translateBtn.disabled = false;
      currentPort = null;
    }
  });
}

// === Copy result ===
copyResultBtn.addEventListener('click', () => {
  if (!currentTranslatedText) return;
  navigator.clipboard.writeText(currentTranslatedText);
  copyResultBtn.textContent = 'コピー済み ✓';
  setTimeout(() => { copyResultBtn.textContent = 'コピー'; }, 1500);
});

// === Reply Section ===
replyBtn.addEventListener('click', () => {
  replySection.classList.add('visible');
  replyHistory = [];
  replyThread.innerHTML = '';
  replyInput.value = '';
  replyInput.focus();
  replySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

closeReply.addEventListener('click', hideReplySection);

function hideReplySection() {
  replySection.classList.remove('visible');
  replyHistory = [];
  replyThread.innerHTML = '';
  replyInput.value = '';
}

replySend.addEventListener('click', doReply);
replyInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    doReply();
  }
});

// Auto-resize reply input
replyInput.addEventListener('input', () => {
  replyInput.style.height = 'auto';
  replyInput.style.height = Math.min(replyInput.scrollHeight, 160) + 'px';
});

function doReply() {
  const intent = replyInput.value.trim();
  if (!intent) return;

  replyInput.value = '';
  replyInput.style.height = '';
  replyInput.disabled = true;
  replySend.disabled = true;

  // User bubble
  const userBubble = document.createElement('div');
  userBubble.className = 'reply-bubble reply-user';
  userBubble.textContent = intent;
  replyThread.appendChild(userBubble);

  // AI bubble (loading)
  const aiBubble = document.createElement('div');
  aiBubble.className = 'reply-bubble reply-ai';
  aiBubble.innerHTML = '<span class="spinner spinner-purple"></span>';
  replyThread.appendChild(aiBubble);
  replyThread.scrollTop = replyThread.scrollHeight;

  // Detect reply language
  const replyLang = detectLang(currentOriginalText);

  const port = chrome.runtime.connect({ name: 'gemini-stream' });
  let replyText = '';

  port.onMessage.addListener((msg) => {
    if (msg.type === 'chunk') {
      replyText += msg.text;
      aiBubble.textContent = replyText;
      replyThread.scrollTop = replyThread.scrollHeight;
    }
    if (msg.type === 'done') {
      // Add actions
      const actions = document.createElement('div');
      actions.className = 'reply-ai-actions';

      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'コピー';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(replyText);
        copyBtn.textContent = 'コピー済み ✓';
        setTimeout(() => { copyBtn.textContent = 'コピー'; }, 1500);
      });

      const retryBtn = document.createElement('button');
      retryBtn.textContent = 'リトライ';
      retryBtn.addEventListener('click', () => {
        aiBubble.remove();
        userBubble.remove();
        replyInput.value = intent;
        replyInput.disabled = false;
        replySend.disabled = false;
        replyInput.focus();
      });

      actions.appendChild(copyBtn);
      actions.appendChild(retryBtn);
      aiBubble.appendChild(actions);

      replyHistory.push({ intent, reply: replyText });
      replyInput.disabled = false;
      replySend.disabled = false;
      replyInput.placeholder = '修正や続きを入力...';
      replyInput.focus();
      replyThread.scrollTop = replyThread.scrollHeight;
    }
    if (msg.type === 'error') {
      aiBubble.innerHTML = `<span class="error">${escapeHtml(msg.error)}</span>`;
      replyInput.disabled = false;
      replySend.disabled = false;
    }
  });

  port.postMessage({
    text: intent,
    originalText: currentOriginalText,
    translatedText: currentTranslatedText,
    replyHistory,
    replyLang,
    mode: 'reply'
  });
}

// === Helpers ===
function detectLang(text) {
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(text) && !/[\u3040-\u309f]/.test(text)) return 'zh';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u0900-\u097f]/.test(text)) return 'hi';
  return 'en';
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function disconnectPort() {
  if (currentPort) {
    try { currentPort.disconnect(); } catch {}
    currentPort = null;
  }
}

function showToast(msg, type) {
  statusToast.textContent = msg;
  statusToast.className = `status-toast ${type} show`;
  setTimeout(() => {
    statusToast.classList.remove('show');
  }, 2500);
}

// === Focus ===
inputText.focus();
