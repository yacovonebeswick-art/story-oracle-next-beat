// ============================================================================
// 故事神谕 · 下一拍建议（配套扩展，独立文件，不改动 story-oracle 原版任何代码）
// v1.2.0 —— 新增：魔法棒菜单入口 + 可视化窗口
//
// v1.1.0 修的两处真实 bug 保留：
//   1) StoryOracleAPI.run(messages, opts)：messages 必须是 [{role, content}] 数组。
//   2) "story-oracle-ready" 事件在 document 上派发，要在 document 上监听。
//
// 新增（v1.2.0）：
//   - 输入框旁 🪄 魔法棒菜单里多一项「🧭 下一拍建议」，点开是一个独立小窗口：
//       · 开关：正文生成后要不要自动弹建议
//       · 显示最近一次生成的建议（就算把弹窗关掉了也能回来看）
//       · 「使用」按钮：填进输入框
//       · 「重新生成」按钮：针对最新一条 AI 回复手动再跑一次（不用等下一条新回复）
//   - 原有的自动弹出悬浮卡片（右下角 toast）保留不变。
// ============================================================================

(function () {
  'use strict';

  const MODULE_ID = 'story-oracle-next-beat';
  const DEFAULTS = { enabled: true };
  let lastSuggestion = '';

  function getCtx() {
    return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
      ? SillyTavern.getContext()
      : null;
  }

  function loadSettings() {
    const ctx = getCtx();
    if (!ctx) return { ...DEFAULTS };
    ctx.extensionSettings[MODULE_ID] = Object.assign(
      {},
      DEFAULTS,
      ctx.extensionSettings[MODULE_ID] || {},
    );
    return ctx.extensionSettings[MODULE_ID];
  }

  function saveSettings() {
    const ctx = getCtx();
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
      ctx.saveSettingsDebounced();
    }
  }

  // ---- 剥出“正文” --------------------------------------------------------
  function stripStructure(raw) {
    if (!raw) return '';
    let text = raw;

    const wrap = text.match(/<(content|正文|gametxt|narrative)>([\s\S]*?)<\/\1>/i);
    if (wrap) text = wrap[2];

    text = text
      .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
      .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
      .replace(/<JSONPatch[^>]*>[\s\S]*?<\/JSONPatch>/gi, '')
      .replace(/<update>[\s\S]*?<\/update>/gi, '')
      .replace(/<StoryPlan>[\s\S]*?<\/StoryPlan>/gi, '')
      .replace(/\[IMG_GEN\][\s\S]*?\[\/IMG_GEN\]/gi, '')
      .replace(/<[a-zA-Z!][^>]*>/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text;
  }

  // ---- 调用一次 API --------------------------------------------------------
  async function requestNextBeatOption(narrativeText) {
    const api = window.StoryOracleAPI;
    if (!api || typeof api.run !== 'function') {
      console.warn(`[${MODULE_ID}] 未检测到可用的 StoryOracleAPI.run，跳过本次建议`);
      return null;
    }

    const promptText =
      '下面是主线剧情刚刚写出的一段正文（已尽量去除状态栏/变量等结构内容），' +
      '只把它当参考，不要复述或评论它：\n\n' +
      '"""\n' + narrativeText.slice(-4000) + '\n"""\n\n' +
      '请只给出一句话：这句话是“玩家”接下来最适合发送给 AI 的指令或发言，' +
      '要能让剧情顺着刚才这段正文的走向，自然过渡到下一拍。' +
      '直接写出这句话本身（可以是角色的行动、台词，也可以是简短的旁白式指令），' +
      '不要解释、不要加引号、不要编号、不要任何前后缀说明。';

    const messages = [{ role: 'user', content: promptText }];

    try {
      const result = await api.run(messages, { stream: false, maxTokens: 300 });
      let text = '';
      if (typeof result === 'string') {
        text = result;
      } else if (result && typeof result === 'object') {
        text =
          result.text ||
          result.content ||
          result.reply ||
          (result.choices && result.choices[0] &&
            (result.choices[0].message?.content || result.choices[0].text)) ||
          '';
      }
      text = String(text || '').trim();
      text = text.replace(/^["“'「]+/, '').replace(/["”'」]+$/, '').trim();
      return text || null;
    } catch (err) {
      console.error(`[${MODULE_ID}] 调用失败：`, err);
      return null;
    }
  }

  function fillInput(text) {
    const el = document.getElementById('send_textarea');
    if (el) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
    }
  }

  // ---- 自动弹出的悬浮卡片（右下角 toast） ---------------------------------
  function ensureToastContainer() {
    let el = document.getElementById('so-next-beat-toast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'so-next-beat-toast';
    document.body.appendChild(el);
    return el;
  }

  function showSuggestionToast(suggestionText) {
    const el = ensureToastContainer();
    el.innerHTML = '';
    el.classList.remove('so-next-beat-hide');

    const label = document.createElement('div');
    label.className = 'so-next-beat-label';
    label.textContent = '🧭 下一拍建议';
    el.appendChild(label);

    const body = document.createElement('div');
    body.className = 'so-next-beat-body';
    body.textContent = suggestionText;
    el.appendChild(body);

    const row = document.createElement('div');
    row.className = 'so-next-beat-row';

    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.className = 'so-next-beat-btn so-next-beat-use';
    useBtn.textContent = '使用';
    useBtn.addEventListener('click', () => {
      fillInput(suggestionText);
      hideSuggestionToast();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'so-next-beat-btn so-next-beat-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', hideSuggestionToast);

    row.appendChild(useBtn);
    row.appendChild(closeBtn);
    el.appendChild(row);

    el.classList.add('so-next-beat-show');
  }

  function hideSuggestionToast() {
    const el = document.getElementById('so-next-beat-toast');
    if (el) el.classList.remove('so-next-beat-show');
  }

  // ---- 可视化窗口（魔法棒菜单点开的那个） ---------------------------------
  let panelEl = null;

  function ensurePanel() {
    if (panelEl) return panelEl;
    const settings = loadSettings();

    panelEl = document.createElement('div');
    panelEl.id = 'so-next-beat-panel';
    panelEl.innerHTML = `
      <div class="so-nb-panel-header">
        <span>🧭 下一拍建议</span>
        <span class="so-nb-panel-close" title="关闭">×</span>
      </div>
      <div class="so-nb-panel-body">
        <label class="checkbox_label so-nb-toggle-row">
          <input type="checkbox" id="so-nb-panel-enabled" ${settings.enabled ? 'checked' : ''}>
          正文生成后自动弹出建议
        </label>
        <div class="so-nb-panel-label">最近一次建议：</div>
        <div class="so-nb-panel-suggestion" id="so-nb-panel-suggestion">
          ${lastSuggestion ? '' : '（暂无，等一条新的正文回复，或点下面「针对最新回复生成」）'}
        </div>
        <div class="so-nb-panel-row">
          <button type="button" id="so-nb-panel-use" class="so-next-beat-btn so-next-beat-use">使用这句</button>
          <button type="button" id="so-nb-panel-regen" class="so-next-beat-btn">针对最新回复生成</button>
        </div>
      </div>
    `;
    document.body.appendChild(panelEl);

    panelEl.querySelector('.so-nb-panel-close').addEventListener('click', () => togglePanel(false));

    panelEl.querySelector('#so-nb-panel-enabled').addEventListener('change', function () {
      const s = loadSettings();
      s.enabled = this.checked;
      saveSettings();
      // 与设置面板里的勾选框保持同步
      const other = document.getElementById('so_next_beat_enabled');
      if (other) other.checked = this.checked;
    });

    panelEl.querySelector('#so-nb-panel-use').addEventListener('click', () => {
      if (lastSuggestion) {
        fillInput(lastSuggestion);
        togglePanel(false);
      }
    });

    panelEl.querySelector('#so-nb-panel-regen').addEventListener('click', async () => {
      const ctx = getCtx();
      if (!ctx || !ctx.chat || !ctx.chat.length) return;
      let idx = -1;
      for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m && !m.is_user && !m.is_system) { idx = i; break; }
      }
      if (idx === -1) return;

      const btn = panelEl.querySelector('#so-nb-panel-regen');
      const original = btn.textContent;
      btn.textContent = '生成中…';
      btn.disabled = true;

      const narrative = stripStructure(ctx.chat[idx].mes);
      const suggestion = narrative ? await requestNextBeatOption(narrative) : null;

      btn.textContent = original;
      btn.disabled = false;

      if (suggestion) {
        setLastSuggestion(suggestion);
        showSuggestionToast(suggestion);
      } else {
        panelEl.querySelector('#so-nb-panel-suggestion').textContent = '（这次没能生成，看看浏览器控制台里的报错）';
      }
    });

    return panelEl;
  }

  function setLastSuggestion(text) {
    lastSuggestion = text || '';
    if (panelEl) {
      panelEl.querySelector('#so-nb-panel-suggestion').textContent =
        lastSuggestion || '（暂无，等一条新的正文回复，或点下面「针对最新回复生成」）';
    }
  }

  function togglePanel(forceShow) {
    const el = ensurePanel();
    const show = forceShow !== undefined ? forceShow : !el.classList.contains('so-nb-panel-show');
    el.classList.toggle('so-nb-panel-show', show);
  }

  // ---- 魔法棒菜单入口 -------------------------------------------------------
  function injectWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    if (document.getElementById('so-next-beat-wand-button')) return;

    const item = document.createElement('div');
    item.id = 'so-next-beat-wand-button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<i class="fa-solid fa-compass"></i><span>下一拍建议</span>`;
    item.addEventListener('click', () => togglePanel(true));
    menu.appendChild(item);
  }

  // ---- 事件绑定：主聊天每来一条新的 AI 回复就跑一次 -----------------------
  const processedKeys = new Set();

  function shouldProcessMessage(ctx, messageId) {
    const msg = ctx.chat && ctx.chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return false;
    return true;
  }

  async function onCharacterMessageRendered(messageId) {
    const settings = loadSettings();
    if (!settings.enabled) return;

    const ctx = getCtx();
    if (!ctx || !shouldProcessMessage(ctx, messageId)) return;

    const msg = ctx.chat[messageId];
    const swipeId = msg.swipe_id || 0;
    const key = `${ctx.chatId || ''}:${messageId}:${swipeId}`;
    if (processedKeys.has(key)) return;
    processedKeys.add(key);

    hideSuggestionToast();

    const narrative = stripStructure(msg.mes);
    if (!narrative || narrative.length < 10) return;

    const suggestion = await requestNextBeatOption(narrative);
    if (suggestion) {
      setLastSuggestion(suggestion);
      showSuggestionToast(suggestion);
    }
  }

  function bindEvents() {
    const ctx = getCtx();
    if (!ctx || !ctx.eventSource || !ctx.event_types) {
      setTimeout(bindEvents, 500);
      return;
    }
    ctx.eventSource.on(ctx.event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
  }

  // ---- 扩展设置面板（原有的那个勾选框，保留） -------------------------------
  function addSettingsUI() {
    const settings = loadSettings();
    const html = `
      <div class="so-next-beat-settings">
        <h4>🧭 下一拍建议（配套故事神谕，独立扩展）</h4>
        <label class="checkbox_label">
          <input id="so_next_beat_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
          正文生成后自动弹出一句“下一拍”的玩家指令建议
        </label>
        <p style="opacity:0.7; font-size:0.85em;">也可以点输入框旁 🪄 菜单里的「下一拍建议」打开小窗口。</p>
      </div>
    `;
    const container = document.querySelector('#extensions_settings2, #extensions_settings');
    if (container) {
      container.insertAdjacentHTML('beforeend', html);
      document.getElementById('so_next_beat_enabled').addEventListener('change', function () {
        const s = loadSettings();
        s.enabled = this.checked;
        saveSettings();
        const other = document.getElementById('so-nb-panel-enabled');
        if (other) other.checked = this.checked;
      });
    }
  }

  // ---- 等 story-oracle 就绪 -----------------------------------------------
  function waitForStoryOracle(callback) {
    if (window.StoryOracleAPI) {
      callback();
      return;
    }
    document.addEventListener('story-oracle-ready', callback, { once: true });
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (window.StoryOracleAPI) {
        clearInterval(timer);
        callback();
      } else if (tries > 20) {
        clearInterval(timer);
      }
    }, 500);
  }

  jQuery(async () => {
    waitForStoryOracle(() => {
      const api = window.StoryOracleAPI;
      if (!api) {
        console.warn(`[${MODULE_ID}] 没有检测到故事神谕（StoryOracleAPI），本扩展不生效`);
        return;
      }
      if (typeof api.isCompatible === 'function' && !api.isCompatible(1)) {
        console.warn(`[${MODULE_ID}] 故事神谕接口版本不兼容，本扩展跳过`);
        return;
      }
      addSettingsUI();
      bindEvents();
      injectWandButton();
      // 魔杖菜单偶尔会被主题/其它扩展重绘，定时确保入口还在（开销很小）。
      setInterval(injectWandButton, 3000);
      console.log(`[${MODULE_ID}] 已加载（v1.2.0）`);
    });
  });
})();
