// Hayaku Translator - Content Script
// 高速化v2: speculative pre-translation + DNS preconnect

(() => {
  let tooltip = null;
  let currentStream = null;
  let isPageTranslated = false;
  let originalTexts = new Map();

  // DNS Preconnect: Gemini APIドメインへのTLS/TCPを事前確立
  (() => {
    const domains = ['generativelanguage.googleapis.com', 'gateway.ai.cloudflare.com'];
    for (const domain of domains) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = `https://${domain}`;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }
  })();

  // Settings cache
  let cachedSettings = { targetLang: 'ja', model: 'gemini-3.1-flash-lite-preview' };
  chrome.storage.sync.get('settings', (r) => {
    if (r.settings) cachedSettings = { ...cachedSettings, ...r.settings };
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) cachedSettings = { ...cachedSettings, ...changes.settings.newValue };
  });

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'translate-selection') {
      const text = msg.text || window.getSelection().toString().trim();
      if (text) translateAndShow(text);
    }
    if (msg.action === 'translate-page') {
      togglePageTranslation();
    }
  });

  // Double-click to translate (when enabled)
  document.addEventListener('dblclick', () => {
    if (!cachedSettings.dblclickTranslate) return;
    const text = window.getSelection().toString().trim();
    if (text && text.length > 0 && text.length < 5000) {
      translateAndShow(text);
    }
  });

  // Speculative pre-translation: テキスト選択時にバックグラウンドへ先行送信
  let lastSpeculativeText = '';
  let speculativeDebounce = null;

  // Show tooltip on text selection + keyboard shortcut or button
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('.hyk-tooltip')) return;

    const text = window.getSelection().toString().trim();
    if (text && text.length > 1 && text.length < 10000) {
      showMiniButton(e.clientX, e.clientY, text);

      // Speculative: 選択した瞬間にバックグラウンドで先行翻訳開始
      // ボタンを押す前にキャッシュに入る → ボタン押下時は即座にcachedで返る
      if (text.length <= 500 && text !== lastSpeculativeText) {
        lastSpeculativeText = text;
        clearTimeout(speculativeDebounce);
        speculativeDebounce = setTimeout(() => {
          chrome.runtime.sendMessage({
            action: 'speculative-translate',
            text,
            targetLang: detectTargetLang(text)
          });
        }, 150); // 150msデバウンス: 素早い再選択をフィルタ
      }
    }
  });

  // Close tooltip on click outside
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.hyk-tooltip') && !e.target.closest('.hyk-mini-btn')) {
      removeTooltip();
      removeMiniButton();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      removeTooltip();
      removeMiniButton();
    }
  });

  function showMiniButton(x, y, text) {
    removeMiniButton();
    const btn = document.createElement('div');
    btn.className = 'hyk-mini-btn';
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>`;
    btn.title = 'Hayaku 翻訳 (Alt+T)';

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    btn.style.left = `${x + scrollX + 8}px`;
    btn.style.top = `${y + scrollY - 32}px`;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeMiniButton();
      translateAndShow(text);
    });

    document.body.appendChild(btn);
  }

  function removeMiniButton() {
    document.querySelectorAll('.hyk-mini-btn').forEach(el => el.remove());
  }

  async function translateAndShow(text) {
    removeTooltip();
    if (currentStream) {
      try { currentStream.disconnect(); } catch {}
      currentStream = null;
    }

    // === 高速化: リクエストを即時発火（UI構築と並行） ===
    const port = chrome.runtime.connect({ name: 'gemini-stream' });
    currentStream = port;
    const startTime = performance.now();
    let translatedText = '';
    let firstChunkReceived = false;

    // リクエストを先に飛ばす
    port.postMessage({
      text,
      targetLang: detectTargetLang(text),
      mode: 'selection'
    });

    // UI構築（リクエストと並行）
    const sel = window.getSelection();
    let rect;
    if (sel.rangeCount > 0) {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    }

    // 選択範囲の情報を保存（Replace用）
    const selectionContext = captureSelection(sel);

    tooltip = createTooltip(rect);
    tooltip._originalText = text;
    tooltip._selectionContext = selectionContext;
    document.body.appendChild(tooltip);

    const contentEl = tooltip.querySelector('.hyk-content');
    const timerEl = tooltip.querySelector('.hyk-timer');

    // スケルトン表示（TTFT前の体感速度向上）
    contentEl.innerHTML = '<div class="hyk-skeleton"><div class="hyk-skeleton-line" style="width:90%"></div><div class="hyk-skeleton-line" style="width:70%"></div><div class="hyk-skeleton-line" style="width:50%"></div></div>';

    const timerInterval = setInterval(() => {
      timerEl.textContent = `${((performance.now() - startTime) / 1000).toFixed(1)}s`;
    }, 100);

    port.onMessage.addListener((msg) => {
      if (msg.type === 'chunk') {
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          contentEl.textContent = ''; // スケルトンをクリア
        }
        translatedText += msg.text;
        contentEl.textContent = translatedText;
        adjustTooltipPosition(tooltip);
      }
      if (msg.type === 'done') {
        clearInterval(timerInterval);
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        // キャッシュヒット時は "cached" を表示
        timerEl.textContent = msg.cached ? 'cached' : `${elapsed}s`;
        tooltip.querySelector('.hyk-loading').style.display = 'none';
        addCopyButton(tooltip, translatedText);
        currentStream = null;
      }
      if (msg.type === 'error') {
        clearInterval(timerInterval);
        contentEl.innerHTML = `<span class="hyk-error">${escapeHtml(msg.error)}</span>`;
        tooltip.querySelector('.hyk-loading').style.display = 'none';
        currentStream = null;
      }
    });
  }

  function detectTargetLang(text) {
    // If text contains mostly Japanese/CJK → translate to English
    // Otherwise → translate to user's preferred target lang
    const cjkRatio = (text.match(/[\u3000-\u9fff\uf900-\ufaff]/g) || []).length / text.length;
    if (cjkRatio > 0.3) return 'en';
    return cachedSettings.targetLang || 'ja';
  }

  function createTooltip(rect) {
    const el = document.createElement('div');
    el.className = 'hyk-tooltip';
    el.innerHTML = `
      <div class="hyk-header">
        <div class="hyk-brand">
          <span class="hyk-logo">翻</span>
          <span class="hyk-title">Hayaku</span>
        </div>
        <div class="hyk-actions">
          <span class="hyk-timer">0.0s</span>
          <span class="hyk-loading"><span class="hyk-spinner"></span></span>
          <button class="hyk-close" title="閉じる (Esc)">✕</button>
        </div>
      </div>
      <div class="hyk-body">
        <div class="hyk-content"></div>
      </div>
    `;

    el.querySelector('.hyk-close').addEventListener('click', removeTooltip);

    // Position
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    if (rect) {
      let top = rect.bottom + scrollY + 8;
      let left = rect.left + scrollX;

      // Keep within viewport
      if (left + 380 > window.innerWidth + scrollX) {
        left = window.innerWidth + scrollX - 390;
      }
      if (left < scrollX + 10) left = scrollX + 10;

      // If below viewport, show above
      if (rect.bottom + 200 > window.innerHeight) {
        top = rect.top + scrollY - 8;
        el.classList.add('hyk-above');
      }

      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    } else {
      el.style.right = '20px';
      el.style.top = `${scrollY + 80}px`;
    }

    return el;
  }

  function adjustTooltipPosition(el) {
    const body = el.querySelector('.hyk-body');
    if (body.scrollHeight > 400) {
      body.style.maxHeight = '400px';
      body.style.overflowY = 'auto';
    }
  }

  // === Selection capture for Replace ===
  function captureSelection(sel) {
    if (!sel || sel.rangeCount === 0) return null;

    const activeEl = document.activeElement;

    // textarea / input
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || (activeEl.tagName === 'INPUT' && activeEl.type === 'text'))) {
      return {
        type: 'input',
        element: activeEl,
        start: activeEl.selectionStart,
        end: activeEl.selectionEnd,
      };
    }

    // contenteditable
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const editable = container.nodeType === 1
      ? container.closest('[contenteditable="true"]')
      : container.parentElement?.closest('[contenteditable="true"]');

    if (editable) {
      return {
        type: 'contenteditable',
        range: range.cloneRange(),
      };
    }

    return null;
  }

  function replaceSelection(ctx, newText) {
    if (!ctx) return false;

    if (ctx.type === 'input') {
      const el = ctx.element;
      const before = el.value.slice(0, ctx.start);
      const after = el.value.slice(ctx.end);
      el.value = before + newText + after;
      // カーソルを置換テキストの末尾に
      el.selectionStart = el.selectionEnd = ctx.start + newText.length;
      el.focus();
      // inputイベントを発火（Reactなどのフレームワーク対応）
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    if (ctx.type === 'contenteditable') {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(ctx.range);
      // execCommandはdeprecatedだが、contenteditableでundo対応する最良の方法
      document.execCommand('insertText', false, newText);
      return true;
    }

    return false;
  }

  function addCopyButton(el, text) {
    const actionsEl = el.querySelector('.hyk-actions');
    const closeBtn = el.querySelector('.hyk-close');

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'hyk-copy';
    copyBtn.textContent = 'コピー';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text);
      copyBtn.textContent = 'コピー済み ✓';
      setTimeout(() => { copyBtn.textContent = 'コピー'; }, 1500);
    });
    actionsEl.insertBefore(copyBtn, closeBtn);

    // Replace button (テキスト入力欄の選択時のみ表示)
    const ctx = el._selectionContext;
    if (ctx) {
      const replaceBtn = document.createElement('button');
      replaceBtn.className = 'hyk-replace-btn';
      replaceBtn.textContent = '置換';
      replaceBtn.addEventListener('click', () => {
        const ok = replaceSelection(ctx, text);
        if (ok) {
          replaceBtn.textContent = '置換済み ✓';
          setTimeout(() => removeTooltip(), 600);
        }
      });
      actionsEl.insertBefore(replaceBtn, closeBtn);
    }

    // Reply button
    const replyBtn = document.createElement('button');
    replyBtn.className = 'hyk-reply-btn';
    replyBtn.textContent = '返信';
    replyBtn.addEventListener('click', () => {
      replyBtn.remove();
      showReplyComposer(el, el._originalText, text);
    });
    actionsEl.insertBefore(replyBtn, closeBtn);
  }

  // === Reply Composer ===
  function showReplyComposer(el, originalText, translatedText) {
    const replyHistory = [];
    const body = el.querySelector('.hyk-body');

    const composer = document.createElement('div');
    composer.className = 'hyk-reply-composer';
    composer.innerHTML = `
      <div class="hyk-reply-divider">
        <span class="hyk-reply-divider-text">返信を作成</span>
      </div>
      <div class="hyk-reply-thread"></div>
      <div class="hyk-reply-input-row">
        <textarea class="hyk-reply-input" placeholder="返信の内容を入力（日本語OK）..." rows="2"></textarea>
        <button class="hyk-reply-send" title="送信 (Cmd+Enter)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>
        </button>
      </div>
    `;

    body.appendChild(composer);

    const input = composer.querySelector('.hyk-reply-input');
    const sendBtn = composer.querySelector('.hyk-reply-send');
    const thread = composer.querySelector('.hyk-reply-thread');

    input.focus();

    const doSend = () => {
      const intent = input.value.trim();
      if (!intent) return;
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;
      generateReply(el, originalText, translatedText, replyHistory, intent, thread, input, sendBtn);
    };

    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        doSend();
      }
    });

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    adjustTooltipPosition(el);
  }

  function generateReply(el, originalText, translatedText, replyHistory, intent, thread, input, sendBtn) {
    // Show user intent in thread
    const intentBubble = document.createElement('div');
    intentBubble.className = 'hyk-reply-bubble hyk-reply-user';
    intentBubble.textContent = intent;
    thread.appendChild(intentBubble);

    // Show reply bubble with loading
    const replyBubble = document.createElement('div');
    replyBubble.className = 'hyk-reply-bubble hyk-reply-ai';
    replyBubble.innerHTML = '<span class="hyk-spinner"></span>';
    thread.appendChild(replyBubble);

    // Scroll to bottom
    const body = el.querySelector('.hyk-body');
    body.scrollTop = body.scrollHeight;

    // Detect reply language (same as original text)
    const cjkRatio = (originalText.match(/[\u3000-\u9fff\uf900-\ufaff]/g) || []).length / originalText.length;
    const replyLang = cjkRatio > 0.3 ? 'ja' : detectOriginalLang(originalText);

    // Stream reply
    const port = chrome.runtime.connect({ name: 'gemini-stream' });
    let replyText = '';

    port.onMessage.addListener((msg) => {
      if (msg.type === 'chunk') {
        replyText += msg.text;
        replyBubble.textContent = replyText;
        body.scrollTop = body.scrollHeight;
        adjustTooltipPosition(el);
      }
      if (msg.type === 'done') {
        // Add action buttons to reply bubble
        const actions = document.createElement('div');
        actions.className = 'hyk-reply-actions';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'hyk-reply-action-btn';
        copyBtn.textContent = 'コピー';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(replyText);
          copyBtn.textContent = 'コピー済み ✓';
          setTimeout(() => { copyBtn.textContent = 'コピー'; }, 1500);
        });

        const retryBtn = document.createElement('button');
        retryBtn.className = 'hyk-reply-action-btn';
        retryBtn.textContent = 'リトライ';
        retryBtn.addEventListener('click', () => {
          replyBubble.remove();
          intentBubble.remove();
          input.value = intent;
          input.disabled = false;
          sendBtn.disabled = false;
          input.focus();
        });

        actions.appendChild(copyBtn);
        actions.appendChild(retryBtn);
        replyBubble.appendChild(actions);

        // Save to history for multi-turn context
        replyHistory.push({ intent, reply: replyText });

        input.disabled = false;
        sendBtn.disabled = false;
        input.placeholder = '修正や続きを入力...';
        input.focus();
        body.scrollTop = body.scrollHeight;
      }
      if (msg.type === 'error') {
        replyBubble.innerHTML = `<span class="hyk-error">${escapeHtml(msg.error)}</span>`;
        input.disabled = false;
        sendBtn.disabled = false;
      }
    });

    port.postMessage({
      text: intent,
      originalText,
      translatedText,
      replyHistory,
      replyLang,
      mode: 'reply'
    });
  }

  function detectOriginalLang(text) {
    // Simple heuristic for common languages
    if (/[\u3000-\u9fff]/.test(text)) return 'ja';
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
    if (/[\u0600-\u06ff]/.test(text)) return 'ar';
    if (/[\u0900-\u097f]/.test(text)) return 'hi';
    // Default to English for Latin scripts
    return 'en';
  }

  function removeTooltip() {
    if (currentStream) {
      try { currentStream.disconnect(); } catch {}
      currentStream = null;
    }
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
  }

  // === Page Translation (parallel batches for speed) ===
  async function togglePageTranslation() {
    if (isPageTranslated) {
      restoreOriginalPage();
      return;
    }

    const textNodes = getTranslatableNodes();
    if (textNodes.length === 0) return;

    const progress = showPageProgress();
    const batchSize = 20;
    const CONCURRENCY = 4;
    let translated = 0;

    // Build all batches upfront
    const batches = [];
    for (let i = 0; i < textNodes.length; i += batchSize) {
      batches.push(textNodes.slice(i, i + batchSize));
    }

    let batchIdx = 0;

    async function worker() {
      while (batchIdx < batches.length) {
        const myIdx = batchIdx++;
        const batch = batches[myIdx];
        const texts = batch.map(n => n.textContent.trim()).filter(t => t.length > 1);
        if (texts.length === 0) {
          translated += batch.length;
          updatePageProgress(progress, translated / textNodes.length);
          continue;
        }

        const combined = texts.join('\n---SPLIT---\n');

        try {
          const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
              action: 'call-gemini',
              text: combined,
              targetLang: cachedSettings.targetLang || 'ja',
              mode: 'page'
            }, (r) => {
              if (r.success) resolve(r.translation);
              else reject(new Error(r.error));
            });
          });

          const parts = response.split(/---SPLIT---/);
          batch.forEach((node, idx) => {
            if (parts[idx] && node.textContent.trim().length > 1) {
              originalTexts.set(node, node.textContent);
              node.textContent = parts[idx].trim();
            }
          });
        } catch (err) {
          console.error('Hayaku page translation error:', err);
        }

        translated += batch.length;
        updatePageProgress(progress, translated / textNodes.length);
      }
    }

    // Launch parallel workers
    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, batches.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    isPageTranslated = true;
    removePageProgress(progress);
  }

  function getTranslatableNodes() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT'].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest('.hyk-tooltip, .hyk-mini-btn')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.textContent.trim().length < 2) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function restoreOriginalPage() {
    originalTexts.forEach((text, node) => {
      node.textContent = text;
    });
    originalTexts.clear();
    isPageTranslated = false;
  }

  function showPageProgress() {
    const bar = document.createElement('div');
    bar.className = 'hyk-page-progress';
    bar.innerHTML = `
      <div class="hyk-page-progress-inner">
        <span class="hyk-logo">翻</span>
        <span>Hayaku ページ翻訳中...</span>
        <div class="hyk-progress-bar"><div class="hyk-progress-fill"></div></div>
      </div>
    `;
    document.body.appendChild(bar);
    return bar;
  }

  function updatePageProgress(bar, ratio) {
    const fill = bar.querySelector('.hyk-progress-fill');
    if (fill) fill.style.width = `${Math.round(ratio * 100)}%`;
  }

  function removePageProgress(bar) {
    if (bar) {
      bar.classList.add('hyk-fade-out');
      setTimeout(() => bar.remove(), 500);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
