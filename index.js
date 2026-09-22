// ============================================================================
// 故事神谕 · 下一拍建议（独立插件，不改 story-oracle 任何代码）
// v3.7.0（含 API 报错处理 + 上下文上限 + 醒目设置图标 + 扩展设置可折叠
//        + 选项填入时带人名前缀）
// ============================================================================

(function () {
  'use strict';

  const MODULE_ID = 'story-oracle-next-beat';
  const VERSION = '3.7.0';
  const CFG_VERSION = 11;

  const DEFAULTS = {
    enabled: false,
    showChip: true,
    showToast: false,
    showFloat: false,
    useOwnConnection: false,
    connEndpoint: '',
    connApiKey: '',
    connModel: '',
    connDirectViaBackend: false,
    connDirectRawUrl: false,
    connModelList: [],
    customOptionTemplate: '',
    maxNarrativeChars: 4000,
  };

  const MIN_OUTPUT_TOKENS = 4096;
  const REQUEST_TIMEOUT_MS = 240000;
  const MIN_NARRATIVE_LEN = 10;
  const MIN_NARRATIVE_CHARS = 100;
  const MAX_NARRATIVE_CHARS = 20000;

  const DONE_META_KEY = MODULE_ID + '_done';
  const DONE_KEEP_MAX = 400;

  const LBL_USER = '我';
  const LBL_TIME = '时间';

  let lastByChat = {};
  let panelEl = null;
  let floatEl = null;
  let floatCollapsed = true;
  let floatFresh = false;
  let currentAbort = null;
  let lastRequestKey = null;
  let settingsEl = null;

  function getCtx() {
    return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
      ? SillyTavern.getContext()
      : null;
  }

  function chatKey() {
    const ctx = getCtx();
    if (!ctx) return '::';
    return String(ctx.groupId || '') + '::' + String(ctx.chatId || '');
  }

  function migrateSettings(s) {
    if (s._v === CFG_VERSION) return;
    s.enabled = false;
    if (!s.showFloat) s.showFloat = true;
    if (!Number.isFinite(Number(s.maxNarrativeChars))) s.maxNarrativeChars = 4000;
    s._v = CFG_VERSION;
    saveSettings();
    console.log('[next-beat] 已迁移设置到 v' + CFG_VERSION);
  }

  function loadSettings() {
    const ctx = getCtx();
    if (!ctx) return { ...DEFAULTS };
    ctx.extensionSettings[MODULE_ID] = Object.assign(
      {},
      DEFAULTS,
      ctx.extensionSettings[MODULE_ID] || {},
    );
    const s = ctx.extensionSettings[MODULE_ID];
    migrateSettings(s);
    return s;
  }

  function saveSettings() {
    const ctx = getCtx();
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
      ctx.saveSettingsDebounced();
    }
  }

  function clampNarrativeChars(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 4000;
    return Math.max(MIN_NARRATIVE_CHARS, Math.min(MAX_NARRATIVE_CHARS, Math.round(n)));
  }

  function readDoneSet() {
    const ctx = getCtx();
    const md = ctx && ctx.chatMetadata;
    if (!md) return new Set();
    const arr = Array.isArray(md[DONE_META_KEY]) ? md[DONE_META_KEY] : [];
    return new Set(arr);
  }

  function markDone(key) {
    const ctx = getCtx();
    const md = ctx && ctx.chatMetadata;
    if (!md) return;
    const arr = Array.isArray(md[DONE_META_KEY]) ? md[DONE_META_KEY].slice() : [];
    if (!arr.includes(key)) arr.push(key);
    while (arr.length > DONE_KEEP_MAX) arr.shift();
    md[DONE_META_KEY] = arr;
    try {
      const save = ctx.saveMetadataDebounced || ctx.saveMetadata;
      if (typeof save === 'function') save.call(ctx);
    } catch (e) { /* ignore */ }
  }

  function isDone(key) { return readDoneSet().has(key); }

  function apiSafeEval(expr, fallback) {
    const api = window.StoryOracleAPI;
    if (!api || !api.unsafe || typeof api.unsafe.eval !== 'function') return fallback;
    try {
      const v = api.unsafe.eval(expr);
      return (v === undefined) ? fallback : v;
    } catch (e) {
      console.warn('[next-beat] unsafe.eval 失败：', e);
      return fallback;
    }
  }

  function cleanNarrative(raw) {
    const text = String(raw == null ? '' : raw);
    if (!text) return '';
    const cleaned = apiSafeEval(
      '(function(t){' +
      '  var a = (typeof stripMechanismBlocks === "function") ? stripMechanismBlocks(t) : t;' +
      '  var b = (typeof stripReasoningTags === "function") ? stripReasoningTags(a) : a;' +
      '  return b;' +
      '})(' + JSON.stringify(text) + ')',
      text,
    );
    return String(cleaned == null ? text : cleaned);
  }

  function getActiveBeatInfo() {
    const seq = apiSafeEval('(typeof getSeq === "function" ? getSeq() : null)', null);
    if (!seq || !Array.isArray(seq.beats) || !seq.beats.length) return null;
    const active = apiSafeEval('(typeof seqActiveBeat === "function" ? seqActiveBeat(getSeq()) : null)', null);
    const beat = active || seq.beats[seq.cursor] || null;
    if (!beat) return null;
    return {
      seqTitle: String(seq.title || ''),
      progress: `${(seq.cursor | 0) + 1} / ${seq.beats.length}`,
      cursor: seq.cursor | 0,
      total: seq.beats.length,
      beatTitle: String(beat.title || ''),
      goal: String(beat.goal || ''),
      seed: String(beat.seed || ''),
      why: String(beat.why || ''),
    };
  }

  function extractHttpStatus(err) {
    if (!err) return null;
    const cands = [
      err.status, err.statusCode,
      err.response && err.response.status,
      err.cause && err.cause.status,
    ];
    for (const c of cands) {
      const n = Number(c);
      if (Number.isInteger(n) && n >= 100 && n < 600) return n;
    }
    const m = String(err.message || '').match(/\bHTTP\s+(\d{3})\b/i)
      || String(err.message || '').match(/\b(\d{3})\s+(?:Too Many|Internal|Service|Unauthorized|Forbidden|Not Found|Bad Request|Request Entity|Gateway|Request Timeout)/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 100 && n < 600) return n;
    }
    return null;
  }

  function statusInfo(code) {
    switch (code) {
      case 400: return { title: '请求无效（400）', hint: '参数错误或上下文超长——可缩小「上下文最高字数」，或换一个模型。', retriable: false };
      case 401: return { title: '密钥无效（401）', hint: 'API 密钥错误或已失效——到 ⛭ 设置里检查端点与密钥。', retriable: false };
      case 403: return { title: '拒绝访问（403）', hint: '密钥无权访问该模型，或账号被限制——检查密钥权限。', retriable: false };
      case 404: return { title: '端点/模型不存在（404）', hint: '端点 URL 或模型名不对——到 ⛭ 设置里核对，或重新「拉取模型列表」。', retriable: false };
      case 408: return { title: '请求超时（408）', hint: '服务端等待超时——稍后重试。', retriable: true };
      case 413: return { title: '请求体过大（413）', hint: '上下文太长——把「上下文最高字数」调小再试。', retriable: false };
      case 429: return { title: '限速（429 Too Many Requests）', hint: '请求过于频繁或额度耗尽——稍后再试，或换一个 key / 模型。', retriable: true };
      case 500: return { title: '服务端错误（500）', hint: '上游服务器出错——稍后重试，或换一个端点。', retriable: true };
      case 502: return { title: '网关错误（502）', hint: '中转网关出错——稍后重试，或换一个端点。', retriable: true };
      case 503: return { title: '服务不可用（503）', hint: '服务过载或维护中——稍后重试，或换一个端点。', retriable: true };
      case 504: return { title: '网关超时（504）', hint: '中转网关超时——稍后重试，或换一个端点。', retriable: true };
      default:
        if (code >= 500) return { title: `服务端错误（${code}）`, hint: '上游服务器出错——稍后重试。', retriable: true };
        if (code >= 400) return { title: `请求错误（${code}）`, hint: '请求被拒绝——检查端点 / 密钥 / 模型。', retriable: false };
        return { title: `HTTP ${code}`, hint: '服务端返回了错误——请检查配置。', retriable: false };
    }
  }

  function classifyApiError(err) {
    if (!err) return { kind: 'unknown', title: '未知错误', hint: '', retriable: false, raw: '' };
    if (err.name === 'AbortError') {
      return { kind: 'abort', title: '', hint: '', retriable: false, raw: '' };
    }
    const raw = String((err && err.message) || err || '');
    if (/Failed to fetch|NetworkError|ERR_NETWORK|ERR_CONNECTION|CORS|Access-Control/i.test(raw)) {
      return {
        kind: 'cors',
        title: '网络 / 跨域被拦',
        hint: '浏览器直连被跨域（CORS）拦下——到 ⛭ 设置里勾上「经酒馆后端转发」，或换一个支持浏览器直连的端点。',
        retriable: false,
        raw,
      };
    }
    const code = extractHttpStatus(err);
    if (code) {
      const info = statusInfo(code);
      return { kind: 'http', title: info.title, hint: info.hint, retriable: info.retriable, raw, status: code };
    }
    if (/请先|未配置|不可用|缺少/.test(raw)) {
      return { kind: 'config', title: '配置未完成', hint: raw, retriable: false, raw };
    }
    return { kind: 'unknown', title: '未知错误', hint: raw.slice(0, 200), retriable: false, raw };
  }

  function notifyError(kind, message) {
    try {
      if (!window.toastr) return;
      if (window.toastr.error) {
        window.toastr.error(message, '🧭 下一拍建议 · ' + kind, { timeOut: 8000, extendedTimeOut: 4000 });
      }
    } catch (e) { /* ignore */ }
  }

  const SYSTEM_PROMPT =
    '你是一个为角色扮演游戏生成「玩家下一步可发送指令」候选的助手。' +
    '用户会给你：当前剧情的最后一段正文，以及（如果有）当前正在引导的剧情序列中的某一拍目标。' +
    '你需要生成 3~6 条候选，每条都能作为「玩家」接下来直接发送给 AI 的指令。' +
    '\n' +
    '输出格式（严格遵守）：每条一行，行首固定为「**标签** 」加一个空格，然后接具体内容。' +
    '标签只允许以下三类：' +
    '  1) **我**      —— 玩家自己（第一人称「我」）的动作/台词；' +
    '  2) **角色X**   —— 最近正文里【在场的其他角色】的动作/台词，' +
    'X 用正文里对这个人物的称呼替换（例如「胡一菲」）；' +
    '若模型无法确定具体是谁，则保留 **角色A** / **角色B** / **角色C**；' +
    '不要凭空发明正文里没出现过的人物。' +
    '  3) **时间**    —— 时间推进 / 换场；只有在满足下述条件时才使用。' +
    '\n' +
    '内容要求：' +
    '  · 每条 1~2 句，具体到可以立刻发送（带动作/台词/场景细节之一）；' +
    '  · 【紧跟上文】：不要凭空跳跃时间或地点；上一句若是对话/问句，' +
    '    大部分候选应当是【立即】的回应或行动，而不是「几小时后……」。' +
    '  · 前 3 条必须是 **我**（三个不同角度的合理应对：直接回应 / 另一角度 / 更主动的做法）。' +
    '  · 第 4~5 条：使用 **角色X**。' +
    '    ⚠ 硬约束：第 4 条与第 5 条【必须是不同的角色】——不允许同一角色换角度写两条。' +
    '    如果最近正文里【只有一个】其他角色在场：只给第 4 条，不给第 5 条。' +
    '    如果最近正文里【没有】其他角色在场：不给第 4~5 条，只给前 3 条。' +
    '  · 只有当【本拍目标】明确暗示需要换场/换时间（例如目标里含「次日」「翌日」' +
    '    「数日后」「转场」「到了……」等）时，才在最后追加一条 **时间** 选项；' +
    '    否则不给 **时间** 选项。' +
    '  · 行内不要出现 MBTI 分析、不要出现「（动作）」这类标注、不要引号外的解释。' +
    '  · 不要使用 Markdown 列表符号（- / *），只用上面规定的「**标签** 内容」格式。' +
    '\n' +
    '示例（仅示范格式；实际人物/场景由你根据正文判断）：' +
    '**我** 我站起身，走到门口把帘子拉下。\n' +
    '**我** 我把杯子里的水一口喝掉，沉默了两秒。\n' +
    '**我** 我回头看了一眼，低声说：「我们换个地方谈。」\n' +
    '**角色A** 他靠在墙边，抱着胳膊没说话。\n' +
    '**角色B** 她放下手里的笔，抬头看向我。\n' +
    '**时间** 半小时后，天色完全暗了下来。\n' +
    '（⚠ 错误示范，禁止照抄：两条都写成 **角色A** 只是角度不同——那样是同一个角色，不允许。）';

  function buildUserPrompt(narrativeText, beatInfo) {
    const s = loadSettings();
    const maxChars = clampNarrativeChars(s.maxNarrativeChars);
    const trimmed = narrativeText.length > maxChars
      ? narrativeText.slice(-maxChars)
      : narrativeText;

    const parts = [];
    if (beatInfo && beatInfo.goal) {
      parts.push('【当前引导序列】' + (beatInfo.seqTitle || '(未命名)') +
        '（第 ' + beatInfo.progress + ' 拍）');
      if (beatInfo.beatTitle) parts.push('本拍标题：' + beatInfo.beatTitle);
      parts.push('本拍目标（这拍要让故事走向的结果）：' + beatInfo.goal);
      if (beatInfo.seed) parts.push('本拍起始迹象：' + beatInfo.seed);
      if (beatInfo.why) parts.push('为什么这样安排：' + beatInfo.why);
      parts.push('');
    }
    parts.push('【刚写完的正文（仅供参考，不要复述）】');
    parts.push('"""');
    parts.push(trimmed);
    parts.push('"""');
    parts.push('');
    if (beatInfo && beatInfo.goal) {
      parts.push('请按系统提示规定的格式，生成 3~6 条候选。' +
        '所有候选的最终目标，都要能自然把剧情推向上面那个【本拍目标】；' +
        '其中至少一条应当是【紧接着上一句正文】的即时回应/行动，' +
        '不要一上来就跨时间。');
    } else {
      parts.push('请按系统提示规定的格式，生成 3~6 条候选。' +
        '所有候选都要能顺着刚才这段正文自然展开下一步；' +
        '其中至少一条应当是【紧接着上一句正文】的即时回应/行动。');
    }

    const tpl = String(s.customOptionTemplate || '').trim();
    if (tpl) {
      parts.push('');
      parts.push('【用户自定义选项模板 —— 以本模板为准】');
      parts.push('用户要求你按下面这个模板产出选项。选项数量、每个选项的主导方向、');
      parts.push('格式与结构，都以下面的模板为准（当与系统提示词里默认的输出格式冲突时，');
      parts.push('以本模板为准；但「衔接上下文」「所有候选最终要推向本拍目标」「不同角色必须是');
      parts.push('不同的人」这些根本要求不变）：');
      parts.push('"""');
      parts.push(tpl);
      parts.push('"""');
      parts.push('请严格按这个模板产出选项。');
    }

    return parts.join('\n');
  }

  function parseOptions(text) {
    const src = String(text || '');
    const out = [];

    const reLabeled = /^\s*\*\*([^*\n]+?)\*\*\s+(.+?)\s*$/;
    for (const line of src.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(reLabeled);
      if (!m) continue;
      const label = m[1].trim();
      const content = m[2].trim();
      if (!label || !content) continue;
      out.push({ label, content, raw: line.trim() });
    }
    if (out.length) return dedupOptions(out);

    const rePlain = /^\s*(?:([A-Za-z]|\d{1,2})[\.\)、）\s]|[-*•·])\s*(.+?)\s*$/;
    for (const line of src.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (/^```/.test(t)) continue;
      if (/^<\/?(?:branches|details|summary)\b/i.test(t)) continue;
      const m = t.match(rePlain);
      if (!m) continue;
      const content = m[2].trim();
      if (!content || content.length < 4) continue;
      out.push({ label: '选项', content, raw: t });
    }

    return out.length ? dedupOptions(out) : null;
  }

  function dedupOptions(list) {
    const seen = new Set();
    const dedup = [];
    for (const o of list) {
      const k = o.label + '\u0001' + o.content;
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(o);
    }
    return dedup.length ? dedup : null;
  }

  async function requestNextBeatOptions(narrativeText, beatInfo) {
    const api = window.StoryOracleAPI;
    if (!api) {
      throw new Error('未检测到故事神谕（StoryOracleAPI）');
    }

    const s = loadSettings();

    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) { /* ignore */ }
    }
    const ctl = new AbortController();
    currentAbort = ctl;
    const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, REQUEST_TIMEOUT_MS);

    let userMax = 0;
    try {
      if (typeof api.getSettings === 'function') {
        const os = api.getSettings();
        if (os && Number.isFinite(Number(os.maxTokens))) userMax = Number(os.maxTokens);
      }
    } catch (e) { /* ignore */ }
    const maxTokens = Math.max(userMax, MIN_OUTPUT_TOKENS);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(narrativeText, beatInfo) },
    ];

    try {
      let text = '';
      if (!s.useOwnConnection) {
        if (typeof api.run !== 'function') throw new Error('StoryOracleAPI.run 不可用');
        const result = await api.run(messages, { stream: false, maxTokens, signal: ctl.signal });
        text = pickText(result);
      } else {
        text = await sendWithOwnConnection(messages, maxTokens, s, ctl.signal);
      }
      text = String(text || '').trim();
      return parseOptions(text);
    } finally {
      clearTimeout(timer);
      if (currentAbort === ctl) currentAbort = null;
    }
  }

  function pickText(result) {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
      return result.text || result.content || result.reply || '';
    }
    return '';
  }

  async function sendWithOwnConnection(messages, maxTokens, s, signal) {
    if (!s.connEndpoint) throw new Error('请先填写端点 URL');
    if (!s.connModel) throw new Error('请先「拉取模型列表」并从下拉选择模型');

    const url = normalizeUrl(s.connEndpoint, s.connDirectRawUrl);
    const body = { model: s.connModel, messages, max_tokens: maxTokens };
    const headers = { 'Content-Type': 'application/json' };
    if (s.connApiKey) headers['Authorization'] = 'Bearer ' + s.connApiKey;

    if (s.connDirectViaBackend) return await sendViaSTBackend(url, headers, body, signal);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, stream: false }),
        signal,
      });
    } catch (netErr) {
      throw netErr;
    }
    if (!res.ok) {
      let t = '';
      try { t = await res.text(); } catch (e) { /* ignore */ }
      const e = new Error(`HTTP ${res.status} ${res.statusText} ${String(t).slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    return data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
      ? data.choices[0].message.content
      : '';
  }

  async function sendViaSTBackend(url, headers, body, signal) {
    const ctx = getCtx();
    if (!ctx || !ctx.ChatCompletionService || typeof ctx.ChatCompletionService.processRequest !== 'function') {
      throw new Error('此 ST 版本缺少 ChatCompletionService，无法经后端转发');
    }
    const customUrl = String(url || '').replace(/\/chat\/completions\/?$/, '');
    const { model, messages, max_tokens, stream: _drop, ...rest } = body || {};
    const payload = {
      chat_completion_source: 'custom',
      custom_url: customUrl,
      custom_include_headers: JSON.stringify(headers || {}),
      model, messages, max_tokens,
      stream: false,
    };
    for (const k in rest) payload[k] = rest[k];
    const result = await ctx.ChatCompletionService.processRequest(payload, { presetName: undefined }, true, signal);
    return result && result.content ? result.content : '';
  }

  function normalizeUrl(u, raw) {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/.test(u)) return u;
    if (/\/v\d+$/.test(u)) return u + '/chat/completions';
    if (raw) return u + '/chat/completions';
    return u + '/v1/chat/completions';
  }

  function modelsUrl(u, raw) {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/.test(u)) return u.replace(/\/chat\/completions$/, '/models');
    if (/\/models$/.test(u)) return u;
    if (/\/v\d+$/.test(u)) return u + '/models';
    if (raw) return u + '/models';
    return u + '/v1/models';
  }

  async function fetchModelList() {
    const s = loadSettings();
    if (!s.connEndpoint) throw new Error('请先填写端点 URL');
    const url = modelsUrl(s.connEndpoint, s.connDirectRawUrl);
    const headers = {};
    if (s.connApiKey) headers['Authorization'] = 'Bearer ' + s.connApiKey;
    const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(20000) : undefined;
    const res = await fetch(url, { method: 'GET', headers, signal });
    if (!res.ok) {
      let t = '';
      try { t = await res.text(); } catch (e) { /* ignore */ }
      const e = new Error(`HTTP ${res.status} ${res.statusText} ${String(t).slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    const list = Array.isArray(data && data.data) ? data.data
      : Array.isArray(data) ? data
      : Array.isArray(data && data.models) ? data.models
      : [];
    const ids = [];
    const seen = new Set();
    for (const m of list) {
      const id = (typeof m === 'string') ? m : (m && (m.id || m.name));
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    ids.sort(function (a, b) { return String(a).localeCompare(String(b)); });
    return ids;
  }

  function fillInput(text) {
    const el = document.getElementById('send_textarea');
    if (!el) return false;
    el.value = String(text == null ? '' : text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    try { el.focus(); } catch (e) { /* ignore */ }
    return true;
  }

  function labelClass(label) {
    if (label === LBL_USER) return 'so-nb-lbl-user';
    if (label === LBL_TIME) return 'so-nb-lbl-time';
    return 'so-nb-lbl-role';
  }

  // 把选项转成「填进输入框」的文本：
  //   · 我 / 时间 → 不加前缀（原文本身已是自然形式）
  //   · 其它标签（角色名 / 角色X / 选项）→ 加「标签：」前缀
  // chip 里显示的 [标签] 是视觉标签，不进入输入框。
  function formatOptionForInput(opt) {
    const label = String((opt && opt.label) || '').trim();
    const content = String((opt && opt.content) || '').trim();
    if (!label || !content) return content;
    if (label === LBL_USER || label === LBL_TIME) return content;
    return label + '：' + content;
  }

  function buildOptionsList(options, opts) {
    const list = document.createElement('div');
    list.className = 'so-nb-options';
    if (!Array.isArray(options) || !options.length) {
      const empty = document.createElement('div');
      empty.className = 'so-nb-empty';
      empty.textContent = '（暂无候选）';
      list.appendChild(empty);
      return list;
    }
    for (const o of options) {
      const row = document.createElement('div');
      row.className = 'so-nb-option-row';
      row.title = '点一下：把这一条填入输入框';
      const tag = document.createElement('span');
      tag.className = 'so-nb-option-tag ' + labelClass(o.label);
      tag.textContent = '[' + o.label + ']';
      const txt = document.createElement('span');
      txt.className = 'so-nb-option-text';
      txt.textContent = o.content;
      row.appendChild(tag);
      row.appendChild(txt);
      row.addEventListener('click', function () {
        if (opts && typeof opts.onPick === 'function') opts.onPick(formatOptionForInput(o));
      });
      list.appendChild(row);
    }
    return list;
  }

  function chipIdFor(messageId) { return 'so-next-beat-chip-' + messageId; }
  function removeChip(id) { const el = document.getElementById(chipIdFor(id)); if (el) el.remove(); }
  function removeAllChips() { document.querySelectorAll('.so-next-beat-chip').forEach(function (el) { el.remove(); }); }

  function renderChipIdle(messageId, beatInfo) {
    const s = loadSettings();
    if (!s.showChip) return;
    const mesEl = document.querySelector('.mes[mesid="' + messageId + '"]');
    if (!mesEl) return;
    removeChip(messageId);

    const chip = document.createElement('div');
    chip.id = chipIdFor(messageId);
    chip.className = 'so-next-beat-chip so-next-beat-chip-idle';

    const label = document.createElement('span');
    label.className = 'so-next-beat-chip-label';
    label.textContent = (beatInfo && beatInfo.goal)
      ? ('🧭 下一拍建议 · 第 ' + beatInfo.progress + ' 拍')
      : '🧭 下一拍建议';
    chip.appendChild(label);

    if (beatInfo && beatInfo.goal) {
      const g = document.createElement('div');
      g.className = 'so-next-beat-chip-goal';
      g.textContent = '目标：' + beatInfo.goal;
      chip.appendChild(g);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'so-next-beat-chip-btn';
    btn.textContent = '生成建议';
    btn.addEventListener('click', function (e) { e.stopPropagation(); triggerGenerateForMessage(messageId); });
    chip.appendChild(btn);

    const anchor = mesEl.querySelector('.mes_text');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(chip, anchor.nextSibling);
    else mesEl.appendChild(chip);
  }

  function renderChipError(messageId, beatInfo, errInfo, retryCb) {
    const s = loadSettings();
    if (!s.showChip) return;
    const mesEl = document.querySelector('.mes[mesid="' + messageId + '"]');
    if (!mesEl) return;
    removeChip(messageId);

    const chip = document.createElement('div');
    chip.id = chipIdFor(messageId);
    chip.className = 'so-next-beat-chip so-next-beat-chip-idle so-next-beat-chip-error';

    const label = document.createElement('span');
    label.className = 'so-next-beat-chip-label';
    label.textContent = (beatInfo && beatInfo.goal)
      ? ('🧭 下一拍建议 · 第 ' + beatInfo.progress + ' 拍')
      : '🧭 下一拍建议';
    chip.appendChild(label);

    if (beatInfo && beatInfo.goal) {
      const g = document.createElement('div');
      g.className = 'so-next-beat-chip-goal';
      g.textContent = '目标：' + beatInfo.goal;
      chip.appendChild(g);
    }

    const errBox = document.createElement('div');
    errBox.className = 'so-next-beat-chip-err';
    const titleEl = document.createElement('div');
    titleEl.className = 'so-nb-err-title';
    titleEl.textContent = '⚠ ' + (errInfo.title || '生成失败');
    errBox.appendChild(titleEl);
    if (errInfo.hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'so-nb-err-hint';
      hintEl.textContent = errInfo.hint;
      errBox.appendChild(hintEl);
    }
    chip.appendChild(errBox);

    const foot = document.createElement('div');
    foot.className = 'so-next-beat-chip-foot';

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'so-next-beat-chip-btn';
    retry.textContent = '↻ 重试';
    retry.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof retryCb === 'function') retryCb();
      else triggerGenerateForMessage(messageId);
    });
    foot.appendChild(retry);

    if (errInfo.retriable) {
      const note = document.createElement('span');
      note.className = 'so-nb-err-note';
      note.textContent = '可稍后重试';
      foot.appendChild(note);
    }

    chip.appendChild(foot);

    const anchor = mesEl.querySelector('.mes_text');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(chip, anchor.nextSibling);
    else mesEl.appendChild(chip);
  }

  function renderChipWithOptions(messageId, options, beatInfo) {
    const s = loadSettings();
    if (!s.showChip) return;
    const mesEl = document.querySelector('.mes[mesid="' + messageId + '"]');
    if (!mesEl) return;
    removeChip(messageId);

    const chip = document.createElement('div');
    chip.id = chipIdFor(messageId);
    chip.className = 'so-next-beat-chip';

    const label = document.createElement('span');
    label.className = 'so-next-beat-chip-label';
    label.textContent = (beatInfo && beatInfo.goal)
      ? ('🧭 下一拍建议 · 第 ' + beatInfo.progress + ' 拍')
      : '🧭 下一拍建议';
    chip.appendChild(label);

    if (beatInfo && beatInfo.goal) {
      const g = document.createElement('div');
      g.className = 'so-next-beat-chip-goal';
      g.textContent = '目标：' + beatInfo.goal;
      chip.appendChild(g);
    }

    chip.appendChild(buildOptionsList(options, { onPick: function (c) { fillInput(c); } }));

    const foot = document.createElement('div');
    foot.className = 'so-next-beat-chip-foot';

    const regen = document.createElement('button');
    regen.type = 'button';
    regen.className = 'so-next-beat-chip-btn so-next-beat-chip-btn-minor';
    regen.textContent = '重新生成';
    regen.addEventListener('click', function (e) { e.stopPropagation(); triggerGenerateForMessage(messageId); });
    foot.appendChild(regen);

    const fillAll = document.createElement('button');
    fillAll.type = 'button';
    fillAll.className = 'so-next-beat-chip-btn so-next-beat-chip-btn-minor';
    fillAll.textContent = '填入整段';
    fillAll.title = '把全部候选按行填入输入框';
    fillAll.addEventListener('click', function (e) {
      e.stopPropagation();
      const all = options.map(function (o) { return formatOptionForInput(o); }).join('\n');
      fillInput(all);
    });
    foot.appendChild(fillAll);

    chip.appendChild(foot);

    const anchor = mesEl.querySelector('.mes_text');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(chip, anchor.nextSibling);
    else mesEl.appendChild(chip);
  }

  function rehangChips() {
    const key = chatKey();
    const entry = lastByChat[key];
    if (!entry || entry.messageId == null) return;
    if (Array.isArray(entry.options) && entry.options.length) {
      renderChipWithOptions(entry.messageId, entry.options, entry.beatInfo || null);
    }
  }

  function refreshChips() {
    removeAllChips();
    rehangChips();
    updatePanel();
  }

  function ensureToastContainer() {
    let el = document.getElementById('so-next-beat-toast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'so-next-beat-toast';
    document.body.appendChild(el);
    return el;
  }

  function hideSuggestionToast() {
    const el = document.getElementById('so-next-beat-toast');
    if (el) el.classList.remove('so-next-beat-show');
  }

  function showSuggestionToast(options) {
    const s = loadSettings();
    if (!s.showToast) return;
    const el = ensureToastContainer();
    el.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'so-next-beat-label';
    label.textContent = '🧭 下一拍建议';
    el.appendChild(label);

    el.appendChild(buildOptionsList(options, { onPick: function (c) { fillInput(c); hideSuggestionToast(); } }));

    const row = document.createElement('div');
    row.className = 'so-next-beat-row';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'so-next-beat-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', hideSuggestionToast);
    row.appendChild(closeBtn);
    el.appendChild(row);
    el.classList.add('so-next-beat-show');
  }

  function setLast(entry) {
    const key = chatKey();
    lastByChat[key] = Object.assign({ at: Date.now() }, entry || {});
    const keys = Object.keys(lastByChat);
    if (keys.length > 30) {
      keys.sort(function (a, b) { return (lastByChat[a].at || 0) - (lastByChat[b].at || 0); });
      for (let i = 0; i < keys.length - 30; i++) delete lastByChat[keys[i]];
    }
    updatePanel();
  }

  function getLast() { return lastByChat[chatKey()] || null; }

  async function generateOptionsForMessage(messageId) {
    const ctx = getCtx();
    if (!ctx || !ctx.chat) return null;
    const m = ctx.chat[messageId];
    if (!m || m.is_user || m.is_system) return null;
    if (typeof m.mes !== 'string' || m.mes.trim().length < MIN_NARRATIVE_LEN) return null;

    const narrative = cleanNarrative(m.mes);
    if (!narrative || narrative.length < MIN_NARRATIVE_LEN) return null;

    const beatInfo = getActiveBeatInfo();
    const options = await requestNextBeatOptions(narrative, beatInfo);
    return { options: options, beatInfo: beatInfo, messageId: messageId };
  }

  async function triggerGenerateForMessage(messageId) {
    const ctx = getCtx();
    if (!ctx || !ctx.chat) return;
    const m = ctx.chat[messageId];
    if (!m || m.is_user || m.is_system) return;

    const chip = document.getElementById(chipIdFor(messageId));
    if (chip) {
      const btn = chip.querySelector('.so-next-beat-chip-btn');
      if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    }
    const busyToast = showBusyToast();

    const myKey = chatKey() + ':' + messageId + ':' + ((m.swipe_id || 0));
    lastRequestKey = myKey;

    let out = null;
    let caughtErr = null;
    try { out = await generateOptionsForMessage(messageId); }
    catch (e) { caughtErr = e; }
    finally { dismissToast(busyToast); }

    if (lastRequestKey !== myKey) return;
    const cur = ctx.chat[messageId];
    if (!cur || ((cur.swipe_id || 0) !== (m.swipe_id || 0))) return;

    if (out && out.options && out.options.length) {
      setLast({ options: out.options, beatInfo: out.beatInfo, messageId: messageId });
      renderChipWithOptions(messageId, out.options, out.beatInfo);
      showSuggestionToast(out.options);
      notifyFloatNewOptions();
      markDone(myKey);
      return;
    }

    const info = classifyApiError(caughtErr || new Error('模型没有返回可解析的候选'));
    if (info.kind === 'abort') return;

    if (!caughtErr) {
      info.title = '模型没有返回可解析的候选';
      info.hint = '模型可能返回了空 / 纯文本 / 不符合格式的内容——可「↻ 重试」，或到 ⛭ 设置里填「选项模板 DIY」明确格式。';
      info.retriable = true;
    }

    console.error('[next-beat] 生成失败：', caughtErr || '(空候选)', info);

    notifyError(info.title || '生成失败', info.hint || '请到浏览器控制台查看详情');

    renderChipError(messageId, getActiveBeatInfo(), info, function () { triggerGenerateForMessage(messageId); });
  }

  function showBusyToast() {
    try {
      if (window.toastr && window.toastr.info) {
        return window.toastr.info('正在生成候选…', '🧭 下一拍建议', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function dismissToast(h) {
    try { if (h && window.toastr && window.toastr.clear) window.toastr.clear(h); } catch (e) { /* ignore */ }
  }

  function isAiMessage(ctx, messageId) {
    const m = ctx && ctx.chat && ctx.chat[messageId];
    if (!m || m.is_user || m.is_system) return false;
    return typeof m.mes === 'string' && m.mes.trim().length > 0;
  }

  async function onMessageRendered(messageId) {
    const s = loadSettings();
    if (!s.enabled) return;
    const ctx = getCtx();
    if (!ctx || !isAiMessage(ctx, messageId)) return;
    const m = ctx.chat[messageId];
    const swipeId = m.swipe_id || 0;
    const key = chatKey() + ':' + messageId + ':' + swipeId;
    if (isDone(key)) return;
    await triggerGenerateForMessage(messageId);
  }

  const SETTINGS_POS_KEY = MODULE_ID + '_settings_pos';

  function loadSettingsPos() {
    try {
      const raw = localStorage.getItem(SETTINGS_POS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (Number.isFinite(o.left) && Number.isFinite(o.top)) return o;
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveSettingsPos(left, top) {
    try { localStorage.setItem(SETTINGS_POS_KEY, JSON.stringify({ left: left, top: top })); } catch (e) { /* ignore */ }
  }
  function clearSettingsPos() {
    try { localStorage.removeItem(SETTINGS_POS_KEY); } catch (e) { /* ignore */ }
  }

  function renderSettingsModelSelect() {
    if (!settingsEl || !settingsEl.isConnected) return;
    const sel = settingsEl.querySelector('#so-nb-set-model-select');
    if (!sel) return;
    const s = loadSettings();
    const list = Array.isArray(s.connModelList) ? s.connModelList : [];
    sel.innerHTML = '';
    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（请先点「拉取模型列表」）';
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '（选择模型）';
    sel.appendChild(ph);
    for (const id of list) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    }
    sel.disabled = false;
    if (s.connModel && list.indexOf(s.connModel) >= 0) sel.value = s.connModel;
    else sel.value = '';
  }

  function applySettingsConnVisibility() {
    if (!settingsEl || !settingsEl.isConnected) return;
    const s = loadSettings();
    const ownBox = settingsEl.querySelector('#so-nb-set-own');
    if (ownBox) ownBox.style.display = s.useOwnConnection ? '' : 'none';
  }

  function openSettings() {
    const el = ensureSettings();
    el.classList.add('so-nb-set-show');
    applySettingsConnVisibility();
    renderSettingsModelSelect();
  }
  function closeSettings() {
    if (settingsEl) settingsEl.classList.remove('so-nb-set-show');
  }

  function ensureSettings() {
    if (settingsEl && settingsEl.isConnected) return settingsEl;
    const s = loadSettings();

    settingsEl = document.createElement('div');
    settingsEl.id = 'so-nb-settings';
    settingsEl.innerHTML =
      '<div class="so-nb-set-header" id="so-nb-set-drag-handle" title="按住可拖动">' +
        '<span>⛭ 设置</span>' +
        '<span class="so-nb-set-reset" id="so-nb-set-reset" title="重置到默认位置">⌖</span>' +
        '<span class="so-nb-set-close" id="so-nb-set-close" title="关闭">×</span>' +
      '</div>' +
      '<div class="so-nb-set-body">' +

        '<details class="so-nb-set-group" open>' +
          '<summary>连接设置（建议专用）</summary>' +
          '<div class="so-nb-set-group-body">' +
            '<label class="checkbox_label so-nb-toggle-row">' +
              '<input type="radio" name="so-nb-set-conn-mode" id="so-nb-set-use-sy" ' + (!s.useOwnConnection ? 'checked' : '') + '>' +
              '使用故事神谕的连接（默认）' +
            '</label>' +
            '<label class="checkbox_label so-nb-toggle-row">' +
              '<input type="radio" name="so-nb-set-conn-mode" id="so-nb-set-use-own" ' + (s.useOwnConnection ? 'checked' : '') + '>' +
              '使用我自己的连接' +
            '</label>' +
            '<div id="so-nb-set-own" style="display:none;">' +
              '<label class="so-nb-field">' +
                '<span>端点 URL</span>' +
                '<input type="text" id="so-nb-set-endpoint" value="' + escapeAttr(s.connEndpoint) + '" placeholder="https://your-proxy.com/v1">' +
              '</label>' +
              '<label class="so-nb-field">' +
                '<span>API 密钥</span>' +
                '<input type="password" id="so-nb-set-apikey" value="' + escapeAttr(s.connApiKey) + '" placeholder="sk-...">' +
              '</label>' +
              '<div class="so-nb-conn-row">' +
                '<button type="button" id="so-nb-set-fetch" class="so-next-beat-btn so-next-beat-use">🔍 拉取模型列表</button>' +
                '<span class="so-nb-conn-status" id="so-nb-set-status"></span>' +
              '</div>' +
              '<label class="so-nb-field">' +
                '<span>模型（从拉取结果中选择）</span>' +
                '<select id="so-nb-set-model-select"></select>' +
              '</label>' +
              '<label class="checkbox_label so-nb-toggle-row">' +
                '<input type="checkbox" id="so-nb-set-backend" ' + (s.connDirectViaBackend ? 'checked' : '') + '>' +
                '经酒馆后端转发（避免浏览器跨域 CORS）' +
              '</label>' +
              '<label class="checkbox_label so-nb-toggle-row">' +
                '<input type="checkbox" id="so-nb-set-rawurl" ' + (s.connDirectRawUrl ? 'checked' : '') + '>' +
                '地址原样使用（不自动补 /v1）' +
              '</label>' +
            '</div>' +
          '</div>' +
        '</details>' +

        '<details class="so-nb-set-group">' +
          '<summary>生成设置</summary>' +
          '<div class="so-nb-set-group-body">' +
            '<label class="so-nb-field">' +
              '<span>上下文最高字数（喂给模型的最新正文最多截取多少字；越大越准但越贵）</span>' +
              '<input type="number" id="so-nb-set-maxchars" value="' + clampNarrativeChars(s.maxNarrativeChars) + '" min="' + MIN_NARRATIVE_CHARS + '" max="' + MAX_NARRATIVE_CHARS + '" step="100">' +
            '</label>' +
            '<p class="so-nb-panel-label-hint" style="margin-left:0;">' +
              '范围 ' + MIN_NARRATIVE_CHARS + '~' + MAX_NARRATIVE_CHARS + ' 字；默认 4000。<br>' +
              '只作用于「最新一条 AI 回复的正文」；拍目标、模板等不占这个上限。' +
            '</p>' +
          '</div>' +
        '</details>' +

        '<details class="so-nb-set-group">' +
          '<summary>选项模板 DIY（可选）</summary>' +
          '<div class="so-nb-set-group-body">' +
            '<p class="so-nb-panel-label-hint" style="margin-left:0;">' +
              '留空 = 使用插件内置的「**标签** 内容」格式。<br>' +
              '填写后会把你的模板作为额外要求发给模型，让模型按模板产出选项。<br>' +
              '你可以自定义选项数量、每条选项的主导方向、格式与结构。' +
            '</p>' +
            '<textarea id="so-nb-set-tpl" rows="10" placeholder="例如：&#10;&lt;branches&gt;&#10;&lt;details&gt;&#10;  &lt;summary&gt;🍬外向思维&lt;/summary&gt;&#10;&#10;A.xxx（以Ne功能为主导的选项）&#10;B.xxx（以Fe功能为主导的选项）&#10;C.xxx（以Se功能为主导的选项）&#10;D.xxx（以Te功能为主导的选项）&#10;&lt;/details&gt;&#10;&lt;/branches&gt;">' + escapeText(s.customOptionTemplate) + '</textarea>' +
            '<p class="so-nb-panel-label-hint" style="margin-left:0;">' +
              'ℹ 衔接上下文（本拍目标 + 最近正文）与「所有候选最终要推向本拍目标」的根本要求锁定，不因模板而改变。' +
            '</p>' +
          '</div>' +
        '</details>' +

        '<details class="so-nb-set-group">' +
          '<summary>提示词（只读展示）</summary>' +
          '<div class="so-nb-set-group-body">' +
            '<p class="so-nb-panel-label-hint" style="margin-left:0;">' +
              '这是插件内置的系统提示词。衔接上下文的部分由系统自动处理，不可修改；<br>' +
              '如需自定义选项的数量 / 主导方向 / 格式，请使用上面的「选项模板 DIY」。' +
            '</p>' +
            '<textarea id="so-nb-set-sysprompt" rows="12" readonly></textarea>' +
          '</div>' +
        '</details>' +

      '</div>';
    document.body.appendChild(settingsEl);

    (function applyStoredPos() {
      const p = loadSettingsPos();
      if (!p) return;
      settingsEl.style.left = p.left + 'px';
      settingsEl.style.top = p.top + 'px';
      settingsEl.style.transform = 'none';
    })();

    settingsEl.querySelector('#so-nb-set-reset').addEventListener('click', function (e) {
      e.stopPropagation();
      clearSettingsPos();
      settingsEl.style.left = '';
      settingsEl.style.top = '';
      settingsEl.style.transform = '';
    });
    settingsEl.querySelector('#so-nb-set-close').addEventListener('click', closeSettings);

    (function wireDrag() {
      const handle = settingsEl.querySelector('#so-nb-set-drag-handle');
      let sx = 0, sy = 0, sl = 0, st = 0, pid = null, moved = false;
      handle.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.so-nb-set-close') || e.target.closest('.so-nb-set-reset')) return;
        if (e.button != null && e.button > 0) return;
        pid = e.pointerId;
        moved = false;
        const r = settingsEl.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        settingsEl.style.left = sl + 'px';
        settingsEl.style.top = st + 'px';
        settingsEl.style.transform = 'none';
        settingsEl.classList.add('so-nb-set-dragging');
        try { handle.setPointerCapture(pid); } catch (_) { /* ignore */ }
      });
      handle.addEventListener('pointermove', function (e) {
        if (e.pointerId !== pid) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const w = settingsEl.offsetWidth, h = settingsEl.offsetHeight;
        const vw = window.innerWidth, vh = window.innerHeight;
        const nx = Math.max(60 - w, Math.min(vw - 60, sl + dx));
        const ny = Math.max(0, Math.min(vh - 40, st + dy));
        settingsEl.style.left = nx + 'px';
        settingsEl.style.top = ny + 'px';
      });
      function end(e) {
        if (pid == null || (e && e.pointerId !== pid)) return;
        try { handle.releasePointerCapture(pid); } catch (_) { /* ignore */ }
        pid = null;
        settingsEl.classList.remove('so-nb-set-dragging');
        if (moved) {
          const r = settingsEl.getBoundingClientRect();
          saveSettingsPos(Math.round(r.left), Math.round(r.top));
        }
      }
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    })();

    settingsEl.querySelector('#so-nb-set-use-sy').addEventListener('change', function () {
      if (!this.checked) return;
      const st = loadSettings();
      st.useOwnConnection = false;
      saveSettings();
      applySettingsConnVisibility();
    });
    settingsEl.querySelector('#so-nb-set-use-own').addEventListener('change', function () {
      if (!this.checked) return;
      const st = loadSettings();
      st.useOwnConnection = true;
      saveSettings();
      applySettingsConnVisibility();
    });

    function bindInput(id, key) {
      const el = settingsEl.querySelector(id);
      el.addEventListener('input', function () {
        const st = loadSettings();
        st[key] = this.value;
        saveSettings();
      });
    }
    bindInput('#so-nb-set-endpoint', 'connEndpoint');
    bindInput('#so-nb-set-apikey', 'connApiKey');
    bindInput('#so-nb-set-tpl', 'customOptionTemplate');

    const maxCharsEl = settingsEl.querySelector('#so-nb-set-maxchars');
    maxCharsEl.addEventListener('input', function () {
      const st = loadSettings();
      st.maxNarrativeChars = this.value;
      saveSettings();
    });
    maxCharsEl.addEventListener('change', function () {
      const v = clampNarrativeChars(this.value);
      this.value = String(v);
      const st = loadSettings();
      st.maxNarrativeChars = v;
      saveSettings();
    });

    function bindToggle(id, key) {
      const el = settingsEl.querySelector(id);
      el.addEventListener('change', function () {
        const st = loadSettings();
        st[key] = this.checked;
        saveSettings();
      });
    }
    bindToggle('#so-nb-set-backend', 'connDirectViaBackend');
    bindToggle('#so-nb-set-rawurl', 'connDirectRawUrl');

    settingsEl.querySelector('#so-nb-set-fetch').addEventListener('click', async function () {
      const btn = settingsEl.querySelector('#so-nb-set-fetch');
      const status = settingsEl.querySelector('#so-nb-set-status');
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '拉取中…';
      status.textContent = '';
      status.classList.remove('so-nb-conn-status-err');
      try {
        const list = await fetchModelList();
        if (!list.length) {
          status.textContent = '服务商没有返回任何模型';
          status.classList.add('so-nb-conn-status-err');
          return;
        }
        const st = loadSettings();
        st.connModelList = list;
        if (list.indexOf(st.connModel) < 0) st.connModel = '';
        saveSettings();
        renderSettingsModelSelect();
        status.textContent = '✓ 拉取到 ' + list.length + ' 个模型';
      } catch (err) {
        const info = classifyApiError(err);
        status.textContent = '拉取失败：' + (info.title || err.message || err) + (info.hint ? '——' + info.hint : '');
        status.classList.add('so-nb-conn-status-err');
        console.error('[next-beat] 拉取模型失败：', err);
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });

    settingsEl.querySelector('#so-nb-set-model-select').addEventListener('change', function () {
      const st = loadSettings();
      st.connModel = this.value;
      saveSettings();
    });

    settingsEl.querySelector('#so-nb-set-sysprompt').value = SYSTEM_PROMPT;

    return settingsEl;
  }

  const PANEL_POS_KEY = MODULE_ID + '_panel_pos';

  function loadPanelPos() {
    try {
      const raw = localStorage.getItem(PANEL_POS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (Number.isFinite(o.left) && Number.isFinite(o.top)) return o;
    } catch (e) { /* ignore */ }
    return null;
  }
  function savePanelPos(left, top) {
    try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left: left, top: top })); } catch (e) { /* ignore */ }
  }
  function clearPanelPos() {
    try { localStorage.removeItem(PANEL_POS_KEY); } catch (e) { /* ignore */ }
  }

  function ensurePanel() {
    if (panelEl && panelEl.isConnected) return panelEl;
    const s = loadSettings();

    panelEl = document.createElement('div');
    panelEl.id = 'so-next-beat-panel';
    panelEl.innerHTML =
      '<div class="so-nb-panel-header" id="so-nb-panel-drag-handle" title="按住可拖动此窗口">' +
        '<span>🧭 下一拍建议</span>' +
        '<span class="so-nb-panel-gear" id="so-nb-panel-gear" title="设置"><i class="fa-solid fa-gear"></i></span>' +
        '<span class="so-nb-panel-reset" id="so-nb-panel-reset" title="重置到默认位置">⌖</span>' +
        '<span class="so-nb-panel-close" title="关闭">×</span>' +
      '</div>' +
      '<div class="so-nb-panel-body">' +
        '<label class="checkbox_label so-nb-toggle-row">' +
          '<input type="checkbox" id="so-nb-panel-enabled" ' + (s.enabled ? 'checked' : '') + '>' +
          '每条新回复自动生成（默认关；手动点更省 API）' +
        '</label>' +
        '<label class="checkbox_label so-nb-toggle-row">' +
          '<input type="checkbox" id="so-nb-panel-chip" ' + (s.showChip ? 'checked' : '') + '>' +
          '在回复下方显示（结果展示位）' +
        '</label>' +
        '<label class="checkbox_label so-nb-toggle-row">' +
          '<input type="checkbox" id="so-nb-panel-toast" ' + (s.showToast ? 'checked' : '') + '>' +
          '额外用右下角浮窗提示' +
        '</label>' +
        '<label class="checkbox_label so-nb-toggle-row">' +
          '<input type="checkbox" id="so-nb-panel-float" ' + (s.showFloat ? 'checked' : '') + '>' +
          '悬浮窗常驻（折叠成 🧭 圆标）' +
        '</label>' +
        '<p class="so-nb-panel-label-hint">连接 / 模板 / 提示词 / 上下文上限都在 ⛭ 设置里。</p>' +
        '<div class="so-nb-panel-label">当前拍：</div>' +
        '<div class="so-nb-panel-beat" id="so-nb-panel-beat">（未在引导序列中）</div>' +
        '<div class="so-nb-panel-label">最近一次生成：</div>' +
        '<div class="so-nb-panel-suggestion" id="so-nb-panel-suggestion">（暂无 —— 点下方按钮生成）</div>' +
        '<div class="so-nb-panel-row">' +
          '<button type="button" id="so-nb-panel-regen" class="so-next-beat-btn so-next-beat-use">针对最新回复生成</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panelEl);

    (function applyStoredPos() {
      const p = loadPanelPos();
      if (!p) return;
      panelEl.style.left = p.left + 'px';
      panelEl.style.top = p.top + 'px';
      panelEl.style.transform = 'scale(0.96)';
    })();

    panelEl.querySelector('#so-nb-panel-reset').addEventListener('click', function (e) {
      e.stopPropagation();
      clearPanelPos();
      panelEl.style.left = '';
      panelEl.style.top = '';
      panelEl.style.transform = '';
    });

    panelEl.querySelector('#so-nb-panel-gear').addEventListener('click', function (e) {
      e.stopPropagation();
      openSettings();
    });

    (function wireDrag() {
      const handle = panelEl.querySelector('#so-nb-panel-drag-handle');
      let sx = 0, sy = 0, sl = 0, st = 0, pid = null, moved = false;
      handle.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.so-nb-panel-close') || e.target.closest('.so-nb-panel-reset') || e.target.closest('.so-nb-panel-gear')) return;
        if (e.button != null && e.button > 0) return;
        pid = e.pointerId;
        moved = false;
        const r = panelEl.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        panelEl.style.left = sl + 'px';
        panelEl.style.top = st + 'px';
        panelEl.style.transform = '';
        panelEl.classList.add('so-nb-dragging');
        try { handle.setPointerCapture(pid); } catch (_) { /* ignore */ }
      });
      handle.addEventListener('pointermove', function (e) {
        if (e.pointerId !== pid) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const w = panelEl.offsetWidth, h = panelEl.offsetHeight;
        const vw = window.innerWidth, vh = window.innerHeight;
        const nx = Math.max(80 - w, Math.min(vw - 80, sl + dx));
        const ny = Math.max(0, Math.min(vh - 40, st + dy));
        panelEl.style.left = nx + 'px';
        panelEl.style.top = ny + 'px';
      });
      function end(e) {
        if (pid == null || (e && e.pointerId !== pid)) return;
        try { handle.releasePointerCapture(pid); } catch (_) { /* ignore */ }
        pid = null;
        panelEl.classList.remove('so-nb-dragging');
        if (moved) {
          const r = panelEl.getBoundingClientRect();
          savePanelPos(Math.round(r.left), Math.round(r.top));
        }
      }
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    })();

    panelEl.querySelector('.so-nb-panel-close').addEventListener('click', function () { togglePanel(false); });

    function bindToggle(id, key) {
      const el = panelEl.querySelector(id);
      el.addEventListener('change', function () {
        const st = loadSettings();
        st[key] = this.checked;
        saveSettings();
        syncSettingsUI();
        if (key === 'showChip') refreshChips();
        if (key === 'showFloat') applyFloatVisibility();
      });
    }
    bindToggle('#so-nb-panel-enabled', 'enabled');
    bindToggle('#so-nb-panel-chip', 'showChip');
    bindToggle('#so-nb-panel-toast', 'showToast');
    bindToggle('#so-nb-panel-float', 'showFloat');

    panelEl.querySelector('#so-nb-panel-regen').addEventListener('click', async function () {
      const ctx = getCtx();
      if (!ctx || !ctx.chat || !ctx.chat.length) return;
      let idx = -1;
      for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) { idx = i; break; }
      }
      if (idx === -1) { setPanelSuggestion(null); return; }
      togglePanel(false);
      await triggerGenerateForMessage(idx);
    });

    return panelEl;
  }

  function setPanelSuggestion(options) {
    if (!panelEl || !panelEl.isConnected) return;
    const host = panelEl.querySelector('#so-nb-panel-suggestion');
    if (!host) return;
    host.innerHTML = '';
    if (!Array.isArray(options) || !options.length) {
      host.textContent = '（暂无 —— 点下方按钮生成）';
      return;
    }
    host.textContent = '✓ 已生成 ' + options.length + ' 条候选 —— 请到对应楼层下方查看 / 点选';
  }

  function setPanelBeat(text) {
    if (!panelEl || !panelEl.isConnected) return;
    const el = panelEl.querySelector('#so-nb-panel-beat');
    if (el) el.textContent = text;
  }

  function updatePanel() {
    if (!panelEl || !panelEl.isConnected) return;
    const entry = getLast();
    if (entry && Array.isArray(entry.options) && entry.options.length) {
      setPanelSuggestion(entry.options);
      const b = entry.beatInfo;
      if (b && b.goal) setPanelBeat('第 ' + b.progress + ' 拍' + (b.beatTitle ? ' · ' + b.beatTitle : '') + '\n目标：' + b.goal);
      else setPanelBeat('（未在引导序列中）');
    } else {
      setPanelSuggestion(null);
      const b = getActiveBeatInfo();
      if (b && b.goal) setPanelBeat('第 ' + b.progress + ' 拍' + (b.beatTitle ? ' · ' + b.beatTitle : '') + '\n目标：' + b.goal);
      else setPanelBeat('（未在引导序列中）');
    }
  }

  function togglePanel(forceShow) {
    const el = ensurePanel();
    const show = forceShow !== undefined ? forceShow : !el.classList.contains('so-nb-panel-show');
    el.classList.toggle('so-nb-panel-show', show);
    if (show) updatePanel();
  }

  const FLOAT_ID = 'so-nb-float';
  const FLOAT_POS_KEY = MODULE_ID + '_float_pos';

  function loadFloatPos() {
    try {
      const raw = localStorage.getItem(FLOAT_POS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (Number.isFinite(o.left) && Number.isFinite(o.top)) return o;
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveFloatPos(left, top) {
    try { localStorage.setItem(FLOAT_POS_KEY, JSON.stringify({ left: left, top: top })); } catch (e) { /* ignore */ }
  }

  function ensureFloat() {
    if (floatEl && floatEl.isConnected) return floatEl;

    floatEl = document.createElement('div');
    floatEl.id = FLOAT_ID;
    floatEl.className = 'so-nb-float-hidden so-nb-float-collapsed';
    floatEl.innerHTML =
      '<div class="so-nb-float-badge" title="🧭 下一拍建议（点开 / 折叠）">🧭</div>' +
      '<div class="so-nb-float-body">' +
        '<div class="so-nb-float-head" id="so-nb-float-drag-handle">' +
          '<span class="so-nb-float-title">🧭 下一拍建议</span>' +
          '<span class="so-nb-float-icon-btn" id="so-nb-float-close" title="收起卡片（圆标会保留）">×</span>' +
        '</div>' +
        '<div class="so-nb-float-content" id="so-nb-float-content">（点击下方按钮生成候选）</div>' +
        '<div class="so-nb-float-actions">' +
          '<button type="button" class="so-next-beat-btn so-next-beat-use" id="so-nb-float-regen">生成 / 重新生成</button>' +
          '<button type="button" class="so-next-beat-btn" id="so-nb-float-jump">跳到最新候选</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(floatEl);

    const p = loadFloatPos();
    if (p) {
      floatEl.style.left = p.left + 'px';
      floatEl.style.top = p.top + 'px';
      floatEl.style.right = 'auto';
    }

    floatEl.querySelector('.so-nb-float-badge').addEventListener('click', function () {
      setFloatCollapsed(!floatCollapsed);
    });
    floatEl.querySelector('#so-nb-float-close').addEventListener('click', function () { setFloatCollapsed(true); });

    floatEl.querySelector('#so-nb-float-regen').addEventListener('click', async function () {
      const ctx = getCtx();
      if (!ctx || !ctx.chat || !ctx.chat.length) { setFloatContent('（找不到聊天）'); return; }
      let idx = -1;
      for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) { idx = i; break; }
      }
      if (idx === -1) { setFloatContent('（找不到可用的 AI 回复）'); return; }
      setFloatCollapsed(true);
      await triggerGenerateForMessage(idx);
    });

    floatEl.querySelector('#so-nb-float-jump').addEventListener('click', function () {
      jumpToLatestChip();
    });

    wireFloatDrag();
    return floatEl;
  }

  function jumpToLatestChip() {
    const chips = document.querySelectorAll('.so-next-beat-chip');
    if (!chips.length) {
      setFloatContent('（还没有候选 —— 先点「生成 / 重新生成」）');
      return;
    }
    const last = chips[chips.length - 1];
    try { last.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (e) { try { last.scrollIntoView(); } catch (_) { /* ignore */ } }
    last.classList.add('so-nb-flash');
    setTimeout(function () { last.classList.remove('so-nb-flash'); }, 1200);
  }

  function wireFloatDrag() {
    const badge = floatEl.querySelector('.so-nb-float-badge');
    const handle = floatEl.querySelector('#so-nb-float-drag-handle');
    function makeDrag(el) {
      let sx = 0, sy = 0, sl = 0, st = 0, pid = null, moved = false;
      el.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.so-nb-float-icon-btn')) return;
        if (e.button != null && e.button > 0) return;
        pid = e.pointerId;
        moved = false;
        const r = floatEl.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        floatEl.style.left = sl + 'px';
        floatEl.style.top = st + 'px';
        floatEl.style.right = 'auto';
        try { el.setPointerCapture(pid); } catch (_) { /* ignore */ }
      });
      el.addEventListener('pointermove', function (e) {
        if (e.pointerId !== pid) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const w = floatEl.offsetWidth, h = floatEl.offsetHeight;
        const vw = window.innerWidth, vh = window.innerHeight;
        const nx = Math.max(0, Math.min(vw - w, sl + dx));
        const ny = Math.max(0, Math.min(vh - h, st + dy));
        floatEl.style.left = nx + 'px';
        floatEl.style.top = ny + 'px';
      });
      function end(e) {
        if (pid == null || (e && e.pointerId !== pid)) return;
        try { el.releasePointerCapture(pid); } catch (_) { /* ignore */ }
        pid = null;
        if (moved) {
          const r = floatEl.getBoundingClientRect();
          saveFloatPos(Math.round(r.left), Math.round(r.top));
          function swallow(ev) { ev.stopPropagation(); ev.preventDefault(); }
          floatEl.addEventListener('click', swallow, { capture: true, once: true });
          setTimeout(function () { floatEl.removeEventListener('click', swallow, { capture: true }); }, 300);
        }
      }
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }
    makeDrag(badge);
    makeDrag(handle);
  }

  function setFloatCollapsed(collapsed) {
    if (!floatEl) return;
    floatCollapsed = !!collapsed;
    floatEl.classList.toggle('so-nb-float-collapsed', floatCollapsed);
    if (floatCollapsed) {
      floatEl.classList.remove('so-nb-float-fresh');
      floatFresh = false;
    }
  }

  function setFloatContent(text) {
    if (!floatEl) return;
    const host = floatEl.querySelector('#so-nb-float-content');
    if (!host) return;
    host.textContent = typeof text === 'string' ? text : '（点击下方按钮生成候选）';
  }

  function applyFloatVisibility() {
    const s = loadSettings();
    if (!s.showFloat) {
      if (floatEl) floatEl.classList.add('so-nb-float-hidden');
      return;
    }
    const el = ensureFloat();
    el.classList.remove('so-nb-float-hidden');
    setFloatCollapsed(true);
    updateFloatStatus();
  }

  function updateFloatStatus() {
    const entry = getLast();
    if (entry && Array.isArray(entry.options) && entry.options.length) {
      setFloatContent('✓ 已生成 ' + entry.options.length + ' 条候选（在楼层下方）');
    } else {
      setFloatContent('（点击下方按钮生成候选）');
    }
  }

  function notifyFloatNewOptions() {
    const s = loadSettings();
    if (!s.showFloat) return;
    const el = ensureFloat();
    el.classList.remove('so-nb-float-hidden');
    setFloatCollapsed(true);
    updateFloatStatus();
    floatFresh = true;
    el.classList.add('so-nb-float-fresh');
  }

  function bindEvents() {
    const ctx = getCtx();
    if (!ctx || !ctx.eventSource || !ctx.event_types) {
      setTimeout(bindEvents, 500);
      return;
    }
    const et = ctx.event_types;
    function on(ev, fn) { try { ctx.eventSource.on(ev, fn); } catch (e) { /* ignore */ } }

    on(et.CHARACTER_MESSAGE_RENDERED, function (id) {
      Promise.resolve(onMessageRendered(id)).catch(function (e) { console.warn('[next-beat] 处理失败：', e); });
      setTimeout(refreshChips, 50);
    });
    ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED'].forEach(function (name) {
      if (et[name]) on(et[name], function () { setTimeout(refreshChips, 30); });
    });
    if (et.CHAT_CHANGED) on(et.CHAT_CHANGED, function () {
      removeAllChips();
      setTimeout(rehangChips, 100);
      updatePanel();
      applyFloatVisibility();
    });
  }

  const WAND_ID = 'so-next-beat-wand-button';

  function injectWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById(WAND_ID) && menu.contains(document.getElementById(WAND_ID))) return true;
    const old = document.getElementById(WAND_ID);
    if (old) old.remove();

    const item = document.createElement('div');
    item.id = WAND_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<i class="fa-solid fa-compass"></i><span>下一拍建议</span>';
    item.addEventListener('click', function () {
      const st = loadSettings();
      if (!st.showFloat) { st.showFloat = true; saveSettings(); syncSettingsUI(); applyFloatVisibility(); }
      togglePanel(true);
    });
    menu.appendChild(item);
    return true;
  }

  function watchWandMenu() {
    if (!injectWandButton()) {
      const mo = new MutationObserver(function () { if (injectWandButton()) mo.disconnect(); });
      mo.observe(document.body, { childList: true, subtree: true });
      return;
    }
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
      const mo = new MutationObserver(function () { injectWandButton(); });
      mo.observe(menu, { childList: true, subtree: true });
    }
  }

  function syncSettingsUI() {
    const s = loadSettings();
    function set(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }
    set('so_next_beat_enabled', s.enabled);
    set('so_next_beat_chip', s.showChip);
    set('so_next_beat_toast', s.showToast);
    set('so_next_beat_float', s.showFloat);
    if (panelEl && panelEl.isConnected) {
      set('so-nb-panel-enabled', s.enabled);
      set('so-nb-panel-chip', s.showChip);
      set('so-nb-panel-toast', s.showToast);
      set('so-nb-panel-float', s.showFloat);
    }
  }

  function addSettingsUI() {
    if (document.getElementById('so-next-beat-settings')) return;
    const container = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!container) return;

    const div = document.createElement('div');
    div.id = 'so-next-beat-settings';
    div.className = 'so-next-beat-settings inline-drawer';
    div.innerHTML =
      '<div class="inline-drawer-toggle inline-drawer-header">' +
        '<b>🧭 下一拍建议（配套故事神谕，独立扩展 v' + VERSION + '）</b>' +
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down ui-widget-content"></div>' +
      '</div>' +
      '<div class="inline-drawer-content" style="display:none;">' +
        '<label class="checkbox_label">' +
          '<input id="so_next_beat_enabled" type="checkbox">' +
          '每条新回复自动生成（默认关；手动点更省 API）' +
        '</label>' +
        '<label class="checkbox_label">' +
          '<input id="so_next_beat_chip" type="checkbox">' +
          '在对应回复下方显示建议（结果展示位）' +
        '</label>' +
        '<label class="checkbox_label">' +
          '<input id="so_next_beat_toast" type="checkbox">' +
          '额外用右下角浮窗提示' +
        '</label>' +
        '<label class="checkbox_label">' +
          '<input id="so_next_beat_float" type="checkbox">' +
          '悬浮窗常驻（折叠成 🧭 圆标）' +
        '</label>' +
        '<p style="opacity:0.7; font-size:0.85em;">' +
          '连接 / 模板 / 提示词 / 上下文上限都在 🧭 面板里的 ⛭ 设置中。' +
        '</p>' +
      '</div>';
    container.appendChild(div);
    syncSettingsUI();

    const toggle = div.querySelector('.inline-drawer-toggle');
    const content = div.querySelector('.inline-drawer-content');
    if (toggle && content) {
      toggle.addEventListener('click', function () {
        const opened = content.style.display !== 'none';
        content.style.display = opened ? 'none' : '';
        toggle.classList.toggle('open', !opened);
      });
    }

    function bindToggle(id, key) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function () {
        const s = loadSettings();
        s[key] = this.checked;
        saveSettings();
        syncSettingsUI();
        if (key === 'showChip') refreshChips();
        if (key === 'showFloat') applyFloatVisibility();
      });
    }
    bindToggle('so_next_beat_enabled', 'enabled');
    bindToggle('so_next_beat_chip', 'showChip');
    bindToggle('so_next_beat_toast', 'showToast');
    bindToggle('so_next_beat_float', 'showFloat');
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function waitForStoryOracle(callback) {
    if (window.StoryOracleAPI) { callback(); return; }
    document.addEventListener('story-oracle-ready', callback, { once: true });
    let tries = 0;
    const timer = setInterval(function () {
      tries += 1;
      if (window.StoryOracleAPI) { clearInterval(timer); callback(); }
      else if (tries > 30) { clearInterval(timer); console.warn('[next-beat] 等待故事神谕超时'); }
    }, 500);
  }

  jQuery(async function () {
    waitForStoryOracle(function () {
      const api = window.StoryOracleAPI;
      if (!api) {
        console.warn('[next-beat] 没有检测到故事神谕（StoryOracleAPI），本扩展不生效');
        return;
      }
      if (typeof api.isCompatible === 'function' && !api.isCompatible(1)) {
        console.warn('[next-beat] 故事神谕接口版本不兼容，本扩展跳过');
        return;
      }
      addSettingsUI();
      bindEvents();
      watchWandMenu();
      refreshChips();
      applyFloatVisibility();
      console.log('[next-beat] 已加载（v' + VERSION + '）');
    });
  });
})();
