// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  // ── Screen routing ────────────────────────────────────────────────────────
  function showScreen(name) {
    app.dataset.screen = name;
    if (name === 'chat') {
      requestAnimationFrame(() => scrollToBottom());
    }
  }

  // ── Config refs ───────────────────────────────────────────────────────────
  const cfgForm       = /** @type {HTMLFormElement}  */ (q('#config-form'));
  const cfgProvider   = /** @type {HTMLSelectElement}*/ (q('#cfg-provider'));
  const cfgApiKey     = /** @type {HTMLInputElement} */ (q('#cfg-apikey'));
  const cfgApikeyRow  = q('#cfg-apikey-field');
  const cfgBaseurl    = /** @type {HTMLInputElement} */ (q('#cfg-baseurl'));
  const cfgBaseurlRow = q('#cfg-baseurl-field');
  const cfgModel      = /** @type {HTMLInputElement} */ (q('#cfg-model'));
  const cfgModelHint  = q('#cfg-model-hint');
  const cfgOpenRouterModelField = q('#cfg-openrouter-model-field');
  const cfgOpenRouterModel = /** @type {HTMLSelectElement} */ (q('#cfg-openrouter-model'));
  const cfgOpenRouterModelHint = q('#cfg-openrouter-model-hint');
  const cfgStyle      = /** @type {HTMLSelectElement}*/ (q('#cfg-style'));
  const cfgToolMode   = /** @type {HTMLSelectElement}*/ (q('#cfg-tool-mode'));
  const cfgCommandRunner = /** @type {HTMLSelectElement}*/ (q('#cfg-command-runner'));
  const cfgError      = q('#cfg-error');
  const cfgSaveBtn    = /** @type {HTMLButtonElement}*/ (q('#cfg-save-btn'));
  const toggleKey     = q('#toggle-key');

  // ── Setup refs ────────────────────────────────────────────────────────────
  const setupForm     = /** @type {HTMLFormElement}  */ (q('#setup-form'));
  const goalInput     = /** @type {HTMLTextAreaElement}*/(q('#goal-input'));
  const langInput     = /** @type {HTMLInputElement} */ (q('#lang-input'));
  const openSettingsBtn = q('#open-settings-btn');
  const configureKeyBtn = q('#configure-key-btn');
  const setupConfigNotice = q('#setup-config-notice');
  const setupStartBtn = /** @type {HTMLButtonElement} */ (q('#setup-start-btn'));
  const setupCheckCodeBtn = q('#setup-check-code-btn');

  // ── Chat refs ─────────────────────────────────────────────────────────────
  const messages      = q('#messages');
  const chatInput     = /** @type {HTMLTextAreaElement}*/(q('#chat-input'));
  const sendBtn       = q('#send-btn');
  const checkCodeBtn  = q('#check-code-btn');
  const settingsBtn   = q('#settings-btn');
  const newSessionBtn = q('#new-session-btn');
  const typingDots    = q('#typing-dots');
  const goalLabel     = q('#project-goal-label');
  const langBadge     = q('#project-lang-badge');
  const quickToolMode = /** @type {HTMLSelectElement} */ (q('#quick-tool-mode'));
  const toolTray      = /** @type {HTMLDetailsElement} */ (q('#tool-tray'));
  const toolTrayTitle = q('#tool-tray-title');
  const toolTrayStatus = q('#tool-tray-status');
  const toolTrayDetail = q('#tool-tray-detail');

  let isTyping = false;
  let streamEl = /** @type {HTMLElement|null} */ (null);
  let streamBuf = '';
  let settingsFrom = 'setup';
  let needsConfig = false;
  let openRouterModelsLoaded = false;
  let openRouterModelsLoading = false;
  let openRouterModels = [];
  let toolEvents = [];

  // ── Provider UI ───────────────────────────────────────────────────────────
  const modelDefaults = {
    anthropic: 'claude-sonnet-4-6',
    openai: 'gpt-4o',
    openrouter: 'qwen/qwen3-next-80b-a3b-instruct:free',
    ollama: 'llama3.1',
    'openai-compatible': '',
  };

  function updateProviderFields() {
    const previousProvider = cfgProvider.dataset.previousProvider || '';
    const p = cfgProvider.value;
    const showsKey = p === 'anthropic' || p === 'openai' || p === 'openrouter' || p === 'openai-compatible';
    const needsUrl = p === 'ollama' || p === 'openai-compatible';
    toggle(cfgApikeyRow, showsKey);
    toggle(cfgBaseurlRow, needsUrl);
    toggle(cfgOpenRouterModelField, p === 'openrouter');
    if (needsUrl && !cfgBaseurl.value) cfgBaseurl.value = 'http://localhost:11434/v1';
    const def = modelDefaults[p];
    cfgModelHint.textContent = def ? `Default: ${def}` : 'Enter the model name for your endpoint.';
    if (p === 'openrouter' && previousProvider && previousProvider !== 'openrouter') {
      const current = cfgModel.value.trim();
      if (!current || current === modelDefaults[previousProvider]) {
        cfgModel.value = modelDefaults.openrouter;
      }
    }
    cfgProvider.dataset.previousProvider = p;
    if (p === 'openrouter') loadOpenRouterModels();
  }

  cfgProvider.addEventListener('change', updateProviderFields);

  cfgOpenRouterModel.addEventListener('change', () => {
    const selected = openRouterModels.find(model => model.id === cfgOpenRouterModel.value);
    if (!selected) return;
    cfgModel.value = selected.id;
    cfgOpenRouterModelHint.textContent = `${selected.detail} - ${selected.label}`;
  });

  toggleKey.addEventListener('click', () => {
    const hidden = cfgApiKey.type === 'password';
    cfgApiKey.type = hidden ? 'text' : 'password';
    toggleKey.innerHTML = hidden ? '&#128584;' : '&#128065;';
  });

  // ── Config form ───────────────────────────────────────────────────────────
  cfgForm.addEventListener('submit', e => {
    e.preventDefault();
    cfgError.classList.add('hidden');
    const p = cfgProvider.value;
    const key = cfgApiKey.value.trim();
    const url = cfgBaseurl.value.trim();
    if ((p === 'anthropic' || p === 'openai' || p === 'openrouter') && !key) {
      return showCfgError('An API key is required for this provider.');
    }
    if ((p === 'ollama' || p === 'openai-compatible') && !url) {
      return showCfgError('A base URL is required for this provider.');
    }
    cfgSaveBtn.disabled = true;
    cfgSaveBtn.textContent = 'Saving...';
    vscode.postMessage({ type: 'saveConfig', provider: p, apiKey: key,
      baseUrl: url, model: cfgModel.value.trim(), teachingStyle: cfgStyle.value, toolMode: cfgToolMode.value, commandRunner: cfgCommandRunner.value });
  });

  function showCfgError(msg) {
    cfgError.textContent = msg;
    cfgError.classList.remove('hidden');
  }

  // ── Setup form ────────────────────────────────────────────────────────────
  setupForm.addEventListener('submit', e => {
    e.preventDefault();
    if (needsConfig) {
      settingsFrom = 'setup';
      showScreen('config');
      return;
    }
    const goal = goalInput.value.trim();
    const lang = langInput.value.trim();
    if (!goal || !lang) return;
    goalLabel.textContent = goal;
    langBadge.textContent = lang;
    showScreen('chat');
    vscode.postMessage({ type: 'startProject', goal, language: lang });
  });

  openSettingsBtn.addEventListener('click', () => { settingsFrom = 'setup'; showScreen('config'); });
  configureKeyBtn.addEventListener('click', () => { settingsFrom = 'setup'; showScreen('config'); });
  setupCheckCodeBtn.addEventListener('click', () => {
    if (needsConfig) {
      settingsFrom = 'setup';
      showScreen('config');
      return;
    }
    vscode.postMessage({ type: 'checkCode' });
  });
  settingsBtn.addEventListener('click',     () => { settingsFrom = 'chat';  showScreen('config'); });

  quickToolMode.addEventListener('change', () => {
    cfgToolMode.value = quickToolMode.value;
    vscode.postMessage({ type: 'updateToolMode', toolMode: quickToolMode.value });
  });

  newSessionBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearSession' });
  });

  // ── Chat input ────────────────────────────────────────────────────────────
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  chatInput.addEventListener('input', () => autoGrow(chatInput));
  sendBtn.addEventListener('click', sendMessage);
  checkCodeBtn.addEventListener('click', () => vscode.postMessage({ type: 'checkCode' }));

  function sendMessage() {
    if (isTyping) return;
    const text = chatInput.value.trim();
    if (!text) return;
    appendMsg('user', text);
    chatInput.value = '';
    autoGrow(chatInput);
    vscode.postMessage({ type: 'chat', text });
  }

  // ── Extension messages ────────────────────────────────────────────────────
  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'loadConfig':
        applyConfig(msg.config);
        setSetupBlocked(Boolean(msg.needsSetup));
        showScreen('setup');
        break;

      case 'openRouterModels':
        openRouterModelsLoading = false;
        openRouterModelsLoaded = true;
        openRouterModels = msg.models || [];
        populateOpenRouterModels();
        break;

      case 'openRouterModelsError':
        openRouterModelsLoading = false;
        cfgOpenRouterModel.innerHTML = '<option value="">Could not load models</option>';
        cfgOpenRouterModelHint.textContent = msg.message || 'OpenRouter model list could not be loaded.';
        break;

      case 'configSaved':
        cfgSaveBtn.disabled = false;
        cfgSaveBtn.textContent = 'Save & Continue';
        setSetupBlocked(false);
        showScreen(settingsFrom);
        break;

      case 'configError':
        cfgSaveBtn.disabled = false;
        cfgSaveBtn.textContent = 'Save & Continue';
        showCfgError(msg.message);
        break;

      case 'agentTyping':
        setTyping(true);
        resetToolTray();
        streamEl = startStream();
        streamBuf = '';
        break;

      case 'stream':
        if (streamEl) {
          streamBuf += msg.delta;
          streamEl.innerHTML = md(streamBuf);
          scrollToBottom();
        }
        break;

      case 'done':
        setTyping(false);
        if (streamEl) {
          streamEl.classList.remove('streaming');
          streamEl.innerHTML = md(msg.content);
          streamEl = null;
        }
        scrollToBottom();
        break;

      case 'error':
        setTyping(false);
        if (streamEl) { streamEl.closest('.msg')?.remove(); streamEl = null; }
        appendError(msg.message);
        break;

      case 'toolEvent':
        appendToolEvent(msg.event);
        break;

      case 'commandApprovalRequested':
        showCommandApproval(msg.id, msg.request);
        break;

      case 'cleared':
        messages.innerHTML = '';
        resetToolTray();
        goalInput.value = '';
        langInput.value = '';
        showScreen('setup');
        break;
    }
  });

  // ── Config hydration ──────────────────────────────────────────────────────
  function applyConfig(cfg) {
    cfgProvider.value    = cfg.provider      || 'anthropic';
    cfgApiKey.value      = cfg.apiKey        || '';
    cfgBaseurl.value     = cfg.baseUrl       || '';
    cfgModel.value       = cfg.model         || '';
    cfgStyle.value       = cfg.teachingStyle || 'socratic';
    cfgToolMode.value    = cfg.toolMode      || 'guided';
    quickToolMode.value  = cfg.toolMode      || 'guided';
    cfgCommandRunner.value = cfg.commandRunner || 'background';
    updateProviderFields();
  }

  function loadOpenRouterModels() {
    if (openRouterModelsLoaded || openRouterModelsLoading) {
      populateOpenRouterModels();
      return;
    }

    openRouterModelsLoading = true;
    cfgOpenRouterModel.innerHTML = '<option value="">Loading OpenRouter models...</option>';
    cfgOpenRouterModelHint.textContent = 'Fetching model list and pricing from OpenRouter.';
    vscode.postMessage({ type: 'getOpenRouterModels' });
  }

  function populateOpenRouterModels() {
    if (cfgProvider.value !== 'openrouter') return;

    if (!openRouterModels.length) {
      cfgOpenRouterModel.innerHTML = '<option value="">No models returned</option>';
      cfgOpenRouterModelHint.textContent = 'You can still enter a model ID manually above.';
      return;
    }

    const current = cfgModel.value.trim();
    const options = ['<option value="">Choose a model...</option>'];
    for (const model of openRouterModels) {
      options.push(`<option value="${escAttr(model.id)}">${esc(model.label)}</option>`);
    }
    cfgOpenRouterModel.innerHTML = options.join('');
    cfgOpenRouterModel.value = current;

    const selected = openRouterModels.find(model => model.id === current);
    cfgOpenRouterModelHint.textContent = selected
      ? `${selected.detail} - ${selected.label}`
      : 'Select a model to fill the model ID above, or type one manually.';
  }

  function setSetupBlocked(blocked) {
    needsConfig = blocked;
    setupForm.classList.toggle('blocked', blocked);
    setupConfigNotice.classList.toggle('hidden', !blocked);
    goalInput.disabled = blocked;
    langInput.disabled = blocked;
    setupStartBtn.disabled = blocked;
  }

  // ── Message helpers ───────────────────────────────────────────────────────
  function appendMsg(role, text) {
    const wrap = el('div', `msg ${role}`);
    const label = el('div', 'msg-label');
    label.textContent = role === 'user' ? 'You' : 'BruteCoding';
    const body = el('div', 'msg-body');
    body.innerHTML = role === 'user' ? esc(text).replace(/\n/g, '<br>') : md(text);
    wrap.appendChild(label);
    wrap.appendChild(body);
    messages.appendChild(wrap);
    scrollToBottom();
    return body;
  }

  function startStream() {
    typingDots.classList.add('hidden');
    const wrap = el('div', 'msg assistant');
    const label = el('div', 'msg-label');
    label.textContent = 'BruteCoding';
    const body = el('div', 'msg-body streaming');
    wrap.appendChild(label);
    wrap.appendChild(body);
    messages.appendChild(wrap);
    scrollToBottom();
    return body;
  }

  function appendError(text) {
    const d = el('div', 'err-toast');
    d.textContent = `Error: ${text}`;
    messages.appendChild(d);
    scrollToBottom();
  }

  function appendToolEvent(event) {
    toolEvents.push(event);
    toolTray.classList.remove('hidden', 'completed', 'blocked');
    toolTray.classList.add(event.status);
    toolTray.open = false;
    toolTrayTitle.textContent = toolEvents.length === 1
      ? event.title
      : `${event.title} (${toolEvents.length} tools this turn)`;
    toolTrayStatus.textContent = event.status === 'completed' ? 'Completed' : 'Blocked';
    toolTrayDetail.innerHTML = toolEvents.map((toolEvent, index) => {
      const status = toolEvent.status === 'completed' ? 'Completed' : 'Blocked';
      return `<section class="tool-tray-item ${toolEvent.status}">
        <div class="tool-tray-item-head">
          <span>${index + 1}. ${esc(toolEvent.title)}</span>
          <span>${status}</span>
        </div>
        <div class="tool-tray-item-detail">${md(toolEvent.detail)}</div>
      </section>`;
    }).join('');
  }

  function resetToolTray() {
    toolEvents = [];
    toolTray.classList.add('hidden');
    toolTray.classList.remove('completed', 'blocked');
    toolTray.open = false;
    toolTrayTitle.textContent = '';
    toolTrayStatus.textContent = '';
    toolTrayDetail.innerHTML = '';
  }

  function showCommandApproval(id, request) {
    toolTray.classList.remove('hidden', 'completed', 'blocked');
    toolTray.classList.add('blocked');
    toolTray.open = true;
    toolTrayTitle.textContent = 'Approve command';
    toolTrayStatus.textContent = 'Waiting';
    toolTrayDetail.innerHTML = `
      <section class="command-approval">
        <div class="command-approval-command"><code>${esc(request.command)}</code></div>
        <div class="command-approval-meta">in <code>${esc(request.cwd)}</code></div>
        <p>${esc(request.reason)}</p>
        <div class="command-approval-actions">
          <button type="button" class="btn-primary" data-approval="run">Run</button>
          <button type="button" class="btn-secondary" data-approval="cancel">Cancel</button>
        </div>
      </section>`;

    toolTrayDetail.querySelector('[data-approval="run"]')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'commandApprovalResult', id, approved: true });
      toolTrayTitle.textContent = 'Command approved';
      toolTrayStatus.textContent = 'Running';
      toolTray.open = false;
    });
    toolTrayDetail.querySelector('[data-approval="cancel"]')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'commandApprovalResult', id, approved: false });
      toolTrayTitle.textContent = 'Command cancelled';
      toolTrayStatus.textContent = 'Blocked';
      toolTray.open = false;
    });
  }

  function setTyping(on) {
    isTyping = on;
    typingDots.classList.toggle('hidden', !on);
    sendBtn.disabled = on;
    checkCodeBtn.disabled = on;
    chatInput.disabled = on;
    if (!on) typingDots.classList.add('hidden');
  }

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function q(sel) { return /** @type {HTMLElement} */ (document.querySelector(sel)); }
  function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
  function toggle(node, show) { node.classList.toggle('hidden', !show); }
  function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }
  function esc(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(t) { return esc(t).replace(/"/g, '&quot;'); }

  // ── Markdown renderer ─────────────────────────────────────────────────────
  function md(text) {
    const lines = text.split('\n');
    let out = '', inPre = false, preLang = '', preBuf = '', inUl = false, inOl = false;

    const closeList = () => {
      if (inUl) { out += '</ul>'; inUl = false; }
      if (inOl) { out += '</ol>'; inOl = false; }
    };
    const closePre = () => {
      out += `<pre><code>${esc(preBuf)}</code></pre>`;
      preBuf = ''; preLang = ''; inPre = false;
    };
    const inline = t => {
      t = esc(t);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
      return t;
    };

    for (const line of lines) {
      if (/^```/.test(line)) {
        if (inPre) { closePre(); } else { closeList(); inPre = true; preLang = line.slice(3).trim(); }
        continue;
      }
      if (inPre) { preBuf += (preBuf ? '\n' : '') + line; continue; }

      const h = line.match(/^(#{1,3}) (.+)/);
      if (h) { closeList(); out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }

      if (/^> /.test(line)) { closeList(); out += `<blockquote>${inline(line.slice(2))}</blockquote>`; continue; }

      const ul = line.match(/^[-*] (.+)/);
      if (ul) {
        if (inOl) { out += '</ol>'; inOl = false; }
        if (!inUl) { out += '<ul>'; inUl = true; }
        out += `<li>${inline(ul[1])}</li>`; continue;
      }
      const ol = line.match(/^\d+\. (.+)/);
      if (ol) {
        if (inUl) { out += '</ul>'; inUl = false; }
        if (!inOl) { out += '<ol>'; inOl = true; }
        out += `<li>${inline(ol[1])}</li>`; continue;
      }
      closeList();
      out += line.trim() === '' ? '<p></p>' : `<p>${inline(line)}</p>`;
    }
    if (inPre) closePre();
    closeList();
    return out.replace(/(<p><\/p>){2,}/g, '<p></p>');
  }

  vscode.postMessage({ type: 'ready' });
})();
