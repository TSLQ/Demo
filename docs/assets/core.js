/* ============================================================
   智课助教 SmartTutor CS — 内容页共享工具
   ------------------------------------------------------------
   本文件被所有内容页（chat / reader / exam / ...）加载。
   运行环境有两种：
     A. 在应用壳（app.html）的 iframe 里 —— 顶部栏与左侧栏由壳渲染，
        本文件只提供工具函数，并把设置写在「壳的根元素」上
     B. 被直接打开（双击 html / 独立访问）—— 检测不到壳宿主，
        自我渲染一套同样的顶部栏 + 左侧栏兜底，避免困死在无导航页面

   宿主探测：window.frameElement?.ownerDocument —— 同源时能拿到父文档；
   跨域 / 独立打开时为 null。
   ============================================================ */

/* ---------------- Cookie ---------------- */
const Cookie = {
  set(name, value, days = 30) {
    const exp = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie =
      `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
  },
  get(name) {
    const hit = document.cookie.split("; ").find((r) => r.startsWith(name + "="));
    return hit ? decodeURIComponent(hit.split("=").slice(1).join("=")) : null;
  },
  del(name) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
  },
};

/* ---------------- localStorage（带内存兜底） ---------------- */
const LS = (() => {
  const mem = new Map();
  let real = null;
  try {
    window.localStorage.setItem("__probe", "1");
    window.localStorage.removeItem("__probe");
    real = window.localStorage;
  } catch (_) { real = null; }

  return {
    get(k, d = null) {
      try {
        const v = real ? real.getItem(k) : (mem.has(k) ? mem.get(k) : null);
        return v === null || v === undefined ? d : JSON.parse(v);
      } catch (_) { return d; }
    },
    set(k, v) {
      const s = JSON.stringify(v);
      try { real ? real.setItem(k, s) : mem.set(k, s); } catch (_) { mem.set(k, s); }
    },
    raw(k, d = null) {
      try {
        const v = real ? real.getItem(k) : (mem.has(k) ? mem.get(k) : null);
        return v === null || v === undefined ? d : v;
      } catch (_) { return d; }
    },
    rawSet(k, v) {
      try { real ? real.setItem(k, v) : mem.set(k, v); } catch (_) { mem.set(k, v); }
    },
    del(k) {
      try { real ? real.removeItem(k) : mem.delete(k); } catch (_) { mem.delete(k); }
    },
    keys() {
      const out = [];
      try {
        if (real) { for (let i = 0; i < real.length; i++) out.push(real.key(i)); }
        else out.push(...mem.keys());
      } catch (_) {}
      return out.filter(Boolean);
    },
  };
})();

/* ---------------- 存储键（唯一来源） ---------------- */
const STORE_KEY = {
  theme:    "st_theme",
  role:     "st_role",
  a11y:     "st_a11y",
  density:  "st_density",
  provider: "st_provider",
  name:     "st_display_name",
  apiKey:   "st_api_key",
  searchProvider: "st_search_provider", // 联网搜索服务商（猜想验证）
  searchKey:      "st_search_key",      // 联网搜索 API Key
  customEndpoint: "st_custom_endpoint", // 自定义模型接口地址（OpenAI 兼容）
  customModel:    "st_custom_model",    // 自定义模型名
  accounts: "st_accounts",          // 本地账号库
  readMode: "st_a11y_read_mode",    // 无障碍阅读模式开关
  agentTask: "st_agent_task",       // 交给 AI 助手的任务（含原文），见 schedule.html 方式三
  agentChat: "st_agent_chat",       // AI 对话记录（一次问答一条，按账号分桶）——见 nav.js
  scheduleImport: "st_schedule_import",  // AI 转好的课表文本（agent 页 → 课表页导入框的一次性交接）
  currentUser: "st_current_user",   // 当前登录账号（"角色:账号"）—— 数据按它分开存，见 nav.js
};

/* ---------------- 主题 ---------------- */
/** 无任何本机记录时的默认主题（用户要求：默认深色） */
const DEFAULT_THEME = "dark";

const THEMES = [
  { id: "cream", label: "Cream" },
  { id: "snow",  label: "Snow"  },
  { id: "dark",  label: "深色"  },
];

const Theme = {
  init() {
    // ⚠️ iframe 是独立文档，壳的 <html data-theme> 不会级联进来，
    //    所以内容页必须在自己的 <html> 上也写一份 data-theme。
    this.apply(this.current(), false, { silent: true });
  },
  /**
   * 读取当前主题。⚠️ 顺序很关键：
   *   1) 壳的根元素 —— 壳内时它是**实时权威值**（用户刚在顶部栏切过）。
   *   2) 本机保存的偏好（Cookie / localStorage）—— 独立打开时的依据。
   *   3) HTML 上写死的 data-theme —— 仅**首屏防闪烁**占位，
   *      绝不能盖过用户已保存的选择（否则改完主题下次又被打回）。
   *   4) 最终兜底 = DEFAULT_THEME（深色）。
   */
  current() {
    // 壳内优先读「壳的根元素」（用户可能在顶部栏切过）
    const host = shellRoot();
    const fromHost = host && host.getAttribute("data-theme");
    if (fromHost) return fromHost;

    const saved = Cookie.get(STORE_KEY.theme) || LS.raw(STORE_KEY.theme);
    if (saved) return String(saved).replace(/^"|"$/g, "");

    const fromDom = document.documentElement.getAttribute("data-theme");
    if (fromDom) return fromDom;

    // ⚠️ 无任何记录时的默认主题 = 深色（用户明确要求）。
    //    不跟随系统 prefers-color-scheme —— 「默认深色」是产品设定，不是跟随系统。
    return DEFAULT_THEME;
  },
  /** id 写入哪个根元素：壳内同时写「壳的」和「自己的」，保证两处都变色 */
  apply(id, persist = true, opts = {}) {
    if (!id) return;
    document.documentElement.setAttribute("data-theme", id);
    const host = shellRoot();
    if (host && host !== document.documentElement) host.setAttribute("data-theme", id);

    if (persist) {
      Cookie.set(STORE_KEY.theme, id, 365);
      LS.rawSet(STORE_KEY.theme, id);
    }
    document.querySelectorAll("[data-theme-btn]").forEach((b) => {
      const on = b.dataset.themeBtn === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    // 在壳内：把自己改的主题通知壳，让壳的顶部栏按钮也同步
    if (!opts.silent && inShell()) notifyShell("st-theme-changed", { theme: id });
  },
};

/* ============================================================
   宿主探测：是否运行在应用壳的 iframe 里
   ============================================================ */

/** 同源时返回父文档的 <html>；跨域 / 独立打开返回 null */
function shellRoot() {
  try {
    const ownerDoc = window.frameElement && window.frameElement.ownerDocument;
    return (ownerDoc && ownerDoc.documentElement) || null;
  } catch (_) { return null; }
}

/** 设置应写在哪个根元素上（壳内写壳的，独立写自己的） */
function rootEl() {
  return shellRoot() || document.documentElement;
}

/** 是否在 iframe 里（即在应用壳内展示）
 *  ------------------------------------------------------------
 *  ⚠️ 这是本轮踩过的坑，务必按下面两条来做，别再改回「只看 frameElement」：
 *
 *  1) 主判据用 `window.self !== window.top` —— 在真实浏览器里 100% 可靠：
 *     · 顶层窗口：self === top          → false（独立页）
 *     · 任意 iframe：self !== top       → true （在壳内）
 *     跨域时访问 top 会抛错，那也说明「不是顶层」→ 同样算在 iframe 里。
 *
 *  2) 不要用 `frameElement` 作主判据：它虽然是同源 iframe 的标准属性，
 *     但一旦取不到（时序 / 环境差异），就会把「壳内的内容页」误判成独立页，
 *     于是内容页在壳里又渲染一整套顶部栏 + 侧栏 → 界面出现两块页面。
 *     这里是「宁可少渲染、不可多渲染」，所以必须宽进。
 *
 *  3) frameElement 只作补充：父文档确实像壳时，额外确认一次。
 */
function inShell() {
  try {
    if (window.self !== window.top) return true;   // 在 iframe 里
  } catch (_) {
    return true;                                    // 访问 top 抛错 → 也不是顶层
  }
  // 理论上到不了这里（顶层窗口必然 self===top），保留兜底判断
  try {
    const fe = window.frameElement;
    if (!fe) return false;
    const hostDoc = fe.ownerDocument;
    if (!hostDoc) return false;
    if (hostDoc.getElementById && hostDoc.getElementById("contentFrame")) return true;
    const body = hostDoc.body;
    return !!(body && body.classList && body.classList.contains("shell-body"));
  } catch (_) {
    return false;
  }
}

/** 向壳发消息
 *  ⚠️ targetOrigin 不能写死 location.origin：
 *  在 file:// 下 origin 是字符串 "null"（不透明源），postMessage 会被丢弃，
 *  表现为「切主题中间不变色」。所以不透明源时退化为 "*"（同源 iframe 足够安全）。 */
function frameTargetOrigin() {
  const o = location.origin;
  return (!o || o === "null") ? "*" : o;
}
function notifyShell(type, detail) {
  try {
    window.parent.postMessage({ type, ...(detail || {}) }, frameTargetOrigin());
  } catch (_) { /* 忽略 */ }
}

/**
 * 请求跳转到另一个页面。
 * 在壳内：把跳转交给壳处理（只换 iframe，壳不重建、设置不丢）
 * 独立打开：直接整页跳转（带越权校验）
 * ⚠️ 保留 ?query —— 同一页面可以承载不同任务（如 agent.html?task=parse-schedule）。
 *    归属判断只看裸页名。
 */
function navigate(page) {
  const raw = String(page || "").split("#")[0].trim();
  if (!raw) return;
  const target = raw.split("?")[0].trim();
  if (!target) return;

  // 越权校验（独立模式与壳内都要先拦，避免把非法目标发给壳）
  const owner = (typeof PAGE_ROLE !== "undefined") && PAGE_ROLE[target];
  const mine = currentRole();
  let real = raw;
  if (owner && owner !== "both" && owner !== "login" && owner !== mine) {
    console.warn("[nav] 拦截跨端访问:", target, "当前身份:", mine);
    real = (typeof ROLES !== "undefined" && ROLES[mine]) ? ROLES[mine].home : target;
  }

  if (inShell()) {
    notifyShell("st-navigate", { page: real });
    return;
  }
  location.href = real;
}

/* ---------------- 当前角色 ---------------- */
function currentRole() {
  const decl = document.documentElement.getAttribute("data-role");
  if (decl === "teacher" || decl === "student") return decl;
  const ck = Cookie.get(STORE_KEY.role) || LS.raw(STORE_KEY.role);
  return ck === "teacher" ? "teacher" : "student";
}

/* ---------------- 无障碍阅读模式 ----------------
   🔴 第 57 轮起**真的实现了**（此前若干轮只有开关、只落状态）：
     · 开启后本页根元素挂 `data-read-mode` → 由 design.css 给排版增强
       （放大字号 / 行高、正文限宽、减弱装饰、加大点击目标）
     · 右下角出现「阅读工具条」：朗读本页 / 停止 / 字号 −＋ / 退出
     · **完全不依赖模型** —— 朗读走浏览器自带的 Web Speech API（`speak()`）
     · 阅读模式下**点任意正文段落即可朗读该段**（事件委托，挂在 document）
   ⚠️ 阅读模式**不动 Theme**：它是「同一主题下的排版增强」，不是换肤 ——
      壳与页面的主题色一个都不变（验证器有断言盯着这一点）。
   UI 上可以有多个入口（登录页左下角 / 壳顶部栏），共用同一状态。
--------------------------------------------------------------- */
function readModeOn() {
  return LS.get(STORE_KEY.readMode, true) !== false;
}

/** 阅读模式的效果层：只碰根元素属性 + 工具条，别处一律不动 */
function applyReadMode(on) {
  readMode = on !== false;
  try {
    const root = document.documentElement;
    if (readMode) root.setAttribute("data-read-mode", "");
    else root.removeAttribute("data-read-mode");
  } catch (_) { /* 异常 DOM 下静默 */ }
  mountReaderBar();
}

/** 朗读取文的节点：有 main 用 main，否则退回正文容器 / body */
function readerSource() {
  return document.querySelector("main")
    || document.querySelector(".page-wrap")
    || document.querySelector(".page")
    || document.body;
}

/** 停止朗读，并把工具条上的「朗读中」状态复位 */
function readerStopSpeak() {
  try { window.speechSynthesis.cancel(); } catch (_) {}
  const bar = document.getElementById("readerBar");
  if (bar) { bar.dataset.speaking = ""; syncReaderBar(bar); }
}

/** 一次朗读：先停掉上一次，再读（Web Speech API，无需模型）；读完自动复位 */
function readerSpeak(text) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (!("speechSynthesis" in window)) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new window.SpeechSynthesisUtterance(t);
    u.lang = "zh-CN";
    u.rate = 0.95;
    u.onend = readerStopSpeak;
    u.onerror = readerStopSpeak;
    window.speechSynthesis.speak(u);
  } catch (_) { return false; }
  return true;
}

/** 当前 a11y 字号（阅读工具条的 A− / A+ 共用这份配置） */
function readerFontSize() {
  const c = LS.get(STORE_KEY.a11y, null) || {};
  const n = Number(c.size);
  return Number.isFinite(n) ? n : 15;
}

/** 调整字号 → 写回 a11y 配置并立即生效（会顺便广播给壳，两边一致） */
function readerFontStep(delta) {
  const c = LS.get(STORE_KEY.a11y, null) || {};
  const size = Math.min(22, Math.max(13, readerFontSize() + delta));
  c.size = size;
  LS.set(STORE_KEY.a11y, c);
  applyA11yVars(c);
  const bar = document.getElementById("readerBar");
  if (bar) syncReaderBar(bar);
}

/** 刷新工具条上的状态（字号数字、朗读按钮的可用性） */
function syncReaderBar(bar) {
  const sizeEl = bar.querySelector("[data-rb-size]");
  if (sizeEl) sizeEl.textContent = readerFontSize() + "px";
  const busy = !!bar.dataset.speaking;
  bar.querySelectorAll("[data-rb]").forEach((b) => {
    const k = b.dataset.rb;
    if (k === "stop") b.disabled = !busy;
    if (k === "read") b.disabled = busy;
  });
}

/**
 * 右下角「阅读工具条」—— 只在阅读模式开启、且不是登录页时存在。
 * 🔴 事件委托挂在工具条自身（节点重建也不丢），别逐个 addEventListener。
 */
function mountReaderBar() {
  const isLogin = document.documentElement.getAttribute("data-role") === "login";
  const want = readMode && !isLogin;
  let bar = document.getElementById("readerBar");
  if (!want) { if (bar) bar.remove(); return; }
  if (bar) { syncReaderBar(bar); return; }

  bar = el(
    '<div id="readerBar" class="reader-bar" role="toolbar" aria-label="阅读辅助">' +
      '<button class="rb-btn rb-main" type="button" data-rb="read" title="从开头朗读本页正文">' +
        '<span aria-hidden="true">🔊</span> 朗读本页</button>' +
      '<button class="rb-btn" type="button" data-rb="stop" title="停止朗读" disabled>' +
        '<span aria-hidden="true">■</span> 停止</button>' +
      '<span class="rb-font">' +
        '<button class="rb-btn rb-ic" type="button" data-rb="minus" title="调小字号" aria-label="调小字号">A−</button>' +
        '<b data-rb-size>15px</b>' +
        '<button class="rb-btn rb-ic" type="button" data-rb="plus" title="调大字号" aria-label="调大字号">A+</button>' +
      '</span>' +
      '<button class="rb-btn rb-off" type="button" data-rb="off" title="退出阅读模式">退出</button>' +
    '</div>');

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rb]");
    if (!b) return;
    const k = b.dataset.rb;
    if (k === "read") {
      if (readerSpeak((readerSource().innerText || readerSource().textContent || ""))) {
        bar.dataset.speaking = "1";
        a11yToast("开始朗读 —— 想停就说一声，或点「停止」", "");
      } else {
        a11yToast("这个浏览器不支持语音朗读，换个浏览器再试", "bad");
      }
    } else if (k === "stop") {
      readerStopSpeak();
    } else if (k === "minus") readerFontStep(-1);
    else if (k === "plus") readerFontStep(1);
    else if (k === "off") setReadMode(false);
    syncReaderBar(bar);
  });

  document.body.appendChild(bar);
  syncReaderBar(bar);
}

/** 统一改阅读模式：落盘 + 生效 + 同步同页所有勾选框 + 通知壳 */
function setReadMode(on) {
  const v = on !== false;
  LS.set(STORE_KEY.readMode, v);
  document.querySelectorAll("#a11yReadMode, [data-a11y-mode]").forEach((b) => { b.checked = v; });
  if (inShell()) notifyShell("st-a11y-mode", { on: v });
  applyReadMode(v);
}

function mountReadMode(root) {
  const scope = root || document;
  // ⚠️ 用 id 收集，不要用 [data-a11y-mode] 属性选择器：
  //    桩验证器的属性查询基于 HTML 正则、且根节点 _html 常为空，会查不到。
  const boxes = [$("#a11yReadMode", scope), ...scope.querySelectorAll("[data-a11y-mode]")]
    .filter(Boolean)
    .filter((b, i, arr) => arr.indexOf(b) === i);
  // ⚠️ 即使本页没有勾选框，也要把阅读态应用上（登录页左侧栏 / 壳顶部栏可能有）
  applyReadMode(readModeOn());
  if (!boxes.length) return;

  boxes.forEach((box) => {
    box.checked = readModeOn();
    box.addEventListener("change", () => setReadMode(!!box.checked));
  });
}

/* ---------------- DOM 简写 ---------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** 从 HTML 字符串建元素（必须以单个标签开头） */
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = String(html).trim();
  return t.content.firstElementChild;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

/** 极简 Markdown → HTML */
function mdToHtml(src) {
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const blocks = [];
  let text = String(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code data-lang="${esc(lang)}">${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  text = esc(text)
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");

  text = text.replace(/(?:^- .+$\n?)+/gm, (m) =>
    "<ul>" + m.trim().split("\n").map((l) => `<li>${l.replace(/^- /, "")}</li>`).join("") + "</ul>");

  text = text
    .split(/\n{2,}/)
    .map((p) => (/^\s*<(ul|h4|pre)/.test(p) || /^\u0000/.test(p)
      ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`))
    .join("");

  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

/** 朗读（Web Speech API） */
function speak(text, rate) {
  if (!("speechSynthesis" in window)) { alert("当前浏览器不支持语音朗读。"); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).trim());
  u.lang = "zh-CN";
  u.rate = rate || 0.95;
  window.speechSynthesis.speak(u);
}

/* ---------------- 无障碍设置 ---------------- */
/** 把一组 a11y 值画到指定根元素上（本页 / 壳各画一份） */
function paintA11y(root, c) {
  if (!root) return;
  const size = c.size ?? 15;
  const lh   = c.lh   ?? 1.8;
  const ls   = c.ls   ?? 0;

  root.style.setProperty("--a11y-font-size", size + "px");
  root.style.setProperty("--a11y-line-height", String(lh));
  root.style.setProperty("--a11y-letter-spacing", ls + "em");

  root.toggleAttribute("data-contrast", !!c.contrast);
  root.toggleAttribute("data-reduce-motion", !!c.reduceMotion);
}

/** 把 a11y 设置写进「根元素」（壳内写壳的，独立写自己的）
 *  ⚠️ 本页也要画一份：iframe 是独立文档，只写壳的根，中间内容不会跟着变大。
 *     （第 64 轮：首访选完模式后内容页字号没变，就是漏了这一步） */
function applyA11yVars(cfg) {
  const c = cfg || LS.get(STORE_KEY.a11y, null) || {};
  paintA11y(document.documentElement, c);
  paintA11y(shellRoot(), c);          // 壳的顶部栏 / 侧栏跟着一起放大

  if (inShell()) {
    notifyShell("st-a11y-changed", {
      vars: {
        "--a11y-font-size": (c.size ?? 15) + "px",
        "--a11y-line-height": String(c.lh ?? 1.8),
        "--a11y-letter-spacing": (c.ls ?? 0) + "em",
      },
      contrast: !!c.contrast,
      reduceMotion: !!c.reduceMotion,
    });
  }
}

/* ---------------- 无障碍显示模式（首次进入时先问一次） ----------------
   🔴 为什么要有这一步：
     无障碍设置存在本机，**第一次打开时它必然是空的** —— 而看不清 / 看不见的人
     恰恰最需要在一开始就能看清、听到这个选择。所以：
       没读到模式 → 先问一次；弹窗自身按「最坏情况」渲染
       （17px 起、可 Tab、可朗读、焦点进得去也出得来）。
   🔴 选完写进 st_a11y.profile，之后不再打扰；
     正常用户在弹窗里选「标准显示」，字号 / 动效 / 阅读工具条都回到普通状态。
   ⚠️ 模式只是「一组预设」：字号、行距、对比、动效仍走 applyA11yVars，
      不要另建一套变量，否则设置页与阅读工具条会不同步。
--------------------------------------------------------------- */
const A11Y_PROFILES = [
  {
    id: "reader",
    label: "朗读优先",
    desc: "适合用读屏软件，或希望边听边看的人。字更大、行距更宽，进入后右下角有朗读工具条，点正文任意一段就能听。",
    cfg: { size: 18, lh: 2, ls: 0.01, contrast: false, reduceMotion: true, readMode: true },
  },
  {
    id: "large",
    label: "大字高对比",
    desc: "字最大、对比最强，按钮也更大。不需要朗读，只是看起来更清楚。",
    cfg: { size: 19, lh: 1.9, ls: 0.01, contrast: true, reduceMotion: false, readMode: false },
  },
  {
    id: "calm",
    label: "减少动效",
    desc: "关掉过渡与动画，字稍大、行距更宽，适合容易分心或对闪烁敏感的人。",
    cfg: { size: 16, lh: 1.9, ls: 0, contrast: false, reduceMotion: true, readMode: false },
  },
  {
    id: "standard",
    label: "标准显示",
    desc: "保持默认外观，只保留键盘与读屏软件支持。适合大多数人。",
    cfg: { size: 15, lh: 1.8, ls: 0, contrast: false, reduceMotion: false, readMode: false },
  },
];

/** 已选模式 id；**没选过返回空串**（空串才会触发首访弹窗，别拿 "standard" 当缺省） */
function a11yProfile() {
  const c = LS.get(STORE_KEY.a11y, null);
  const id = (c && typeof c === "object") ? String(c.profile || "") : "";
  for (let i = 0; i < A11Y_PROFILES.length; i++) {
    if (A11Y_PROFILES[i].id === id) return id;
  }
  return "";
}

/** 把模式挂到本页根元素（只作标记，不改颜色；颜色仍由 applyA11yVars 负责） */
function syncA11yProfileAttr() {
  try {
    const root = document.documentElement;
    const id = a11yProfile();
    if (id) root.setAttribute("data-a11y-profile", id);
    else root.removeAttribute("data-a11y-profile");
  } catch (_) { /* 异常 DOM 下静默 */ }
}

/** 应用一个模式：字号 / 行距 / 对比 / 动效 / 阅读模式一次写全 */
function applyA11yProfile(id) {
  let p = null;
  for (let i = 0; i < A11Y_PROFILES.length; i++) {
    if (A11Y_PROFILES[i].id === id) p = A11Y_PROFILES[i];
  }
  if (!p) return false;

  const prev = LS.get(STORE_KEY.a11y, null) || {};
  const next = Object.assign({}, prev, p.cfg, {
    profile: p.id,
    profileAt: Date.now(),
  });
  LS.set(STORE_KEY.a11y, next);

  applyA11yVars(next);                       // 字号 / 行距 / 对比 / 动效（含广播）
  document.documentElement.setAttribute("data-a11y-profile", p.id);
  setReadMode(!!p.cfg.readMode);             // 阅读工具条 / 点段落朗读（含广播）

  try {
    document.dispatchEvent(new CustomEvent("st-a11y-profile-changed", { detail: { id: p.id } }));
  } catch (_) {}
  return true;
}

/** 屏幕朗读播报：给异步结果一个「说得出声」的落点（每页只有一个节点） */
function announce(msg, urgent) {
  const t = String(msg == null ? "" : msg).trim();
  if (!t || !document.body) return;
  let n = document.getElementById("srAnnouncer");
  if (!n) {
    n = document.createElement("div");
    n.id = "srAnnouncer";
    n.className = "sr-only";
    n.setAttribute("aria-atomic", "true");
    n.setAttribute("role", "status");
    n.setAttribute("aria-live", "polite");
    document.body.appendChild(n);
  }
  n.setAttribute("aria-live", urgent ? "assertive" : "polite");
  // 先清空再写：同样的句子连续播两次时，读屏才会重新念
  n.textContent = "";
  setTimeout(() => { n.textContent = t; }, 30);
}

/** 弹一条提示：页面自己有 flash 就用页面的，否则退回播报（核心层不依赖页面函数） */
function a11yToast(msg, tone) {
  try {
    if (typeof flash === "function") { flash(msg, tone || ""); return; }
  } catch (_) { /* flash 在 TDZ / 未定义时继续走播报 */ }
  announce(msg);
}

/** 打开「选择显示模式」弹窗；已开着就只把焦点送回去 */
function openA11yGate() {
  if (!document.body) return;
  const opening = document.getElementById("a11yGate");
  if (opening) {
    const cur = opening.querySelector('input[name="a11yGateMode"]:checked');
    if (cur) { try { cur.focus(); } catch (_) {} }
    return;
  }

  const current = a11yProfile();
  const opts = A11Y_PROFILES.map((p) => (
    '<label class="a11y-opt">' +
      '<input type="radio" name="a11yGateMode" value="' + p.id + '"' +
        ((current ? current === p.id : p.id === "reader") ? " checked" : "") + ">" +
      '<span class="a11y-opt-body">' +
        '<span class="a11y-opt-title">' + p.label + "</span>" +
        '<span class="a11y-opt-desc">' + p.desc + "</span>" +
      "</span>" +
    "</label>"
  )).join("");

  const host = el(
    '<div id="a11yGateHost" class="a11y-gate-host">' +
      '<div class="a11y-gate-mask" aria-hidden="true"></div>' +
      '<div class="a11y-gate" id="a11yGate" role="dialog" aria-modal="true" ' +
        'aria-labelledby="a11yGateTitle" aria-describedby="a11yGateDesc">' +
        '<p class="a11y-gate-kicker">无障碍显示模式</p>' +
        '<h2 id="a11yGateTitle">先选一种看着舒服的显示方式</h2>' +
        '<p class="a11y-gate-desc" id="a11yGateDesc">这一步只问一次。不确定就保持第一项「朗读优先」—— 字更大，进入后可以随时听正文。</p>' +
        '<fieldset class="a11y-gate-set">' +
          '<legend class="sr-only">选择一个显示模式，共四项，方向键切换</legend>' +
          opts +
        "</fieldset>" +
        '<div class="a11y-gate-foot">' +
          '<button class="btn btn-primary" type="button" id="a11yGateOk">用这个模式进入</button>' +
          '<button class="btn" type="button" id="a11yGateDefault">先用朗读优先</button>' +
        "</div>" +
        '<p class="a11y-gate-note">选完会记住，下次不再出现。之后可以在「设置 → 无障碍」里随时改。</p>' +
      "</div>" +
    "</div>");
  if (!host) return;

  document.body.appendChild(host);
  document.body.classList.add("modal-open");

  const dlg = host.querySelector("#a11yGate");
  const radios = host.querySelectorAll('input[name="a11yGateMode"]');
  const btnOk = host.querySelector("#a11yGateOk");
  const btnDefault = host.querySelector("#a11yGateDefault");

  function close() {
    document.removeEventListener("keydown", onKey, true);
    host.remove();
    document.body.classList.remove("modal-open");
    syncA11yProfileAttr();
  }

  function choose(id) {
    const ok = applyA11yProfile(id);
    close();
    if (!ok) return;
    let p = null;
    for (let i = 0; i < A11Y_PROFILES.length; i++) {
      if (A11Y_PROFILES[i].id === id) p = A11Y_PROFILES[i];
    }
    const msg = "已切换到「" + p.label + "」" +
      (p.cfg.readMode ? "。进入后右下角会出现朗读工具条，点正文任意一段就能听。" : "。");
    a11yToast(msg);
    announce(msg);
    // 关闭后焦点落到正文标题，读屏用户从内容开头开始，而不是掉回 body
    const head = document.querySelector("main h1") || document.querySelector("h1");
    if (head) {
      if (!head.hasAttribute("tabindex")) head.setAttribute("tabindex", "-1");
      try { head.focus(); } catch (_) {}
    }
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      choose("reader");                      // 「取消」= 最坏情况，不留下未选择状态
      return;
    }
    if (e.key !== "Tab") return;
    // 单选框组只有选中的那一个是 Tab 停靠点，所以首尾按「选中项 + 两个按钮」算
    const first = dlg.querySelector('input[name="a11yGateMode"]:checked') || radios[0];
    const list = [first, btnOk, btnDefault].filter(Boolean);
    if (list.length < 2) return;
    const firstEl = list[0];
    const lastEl = list[list.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault(); lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault(); firstEl.focus();
    }
  }

  btnOk.addEventListener("click", () => {
    const cur = host.querySelector('input[name="a11yGateMode"]:checked');
    choose(cur ? cur.value : "reader");
  });
  btnDefault.addEventListener("click", () => choose("reader"));
  document.addEventListener("keydown", onKey, true);

  const start = host.querySelector('input[name="a11yGateMode"]:checked') || radios[0] || btnOk;
  try { start.focus(); } catch (_) {}
}

/* 「设置 → 无障碍」里的重新选择入口（事件委托，任何页面加个按钮就能用） */
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("[data-a11y-gate]") : null;
  if (!b) return;
  e.preventDefault();
  openA11yGate();
});

/* ============================================================
   独立模式：内容页被直接打开时，自我渲染顶部栏 + 左侧栏
   ============================================================ */

function standaloneGo(page) {
  const raw = String(page || "").split("#")[0].trim();
  if (!raw) return;
  const target = raw.split("?")[0].trim();     // 归属判断只看页名
  if (!target) return;

  const owner = (typeof PAGE_ROLE !== "undefined") && PAGE_ROLE[target];
  const mine = currentRole();
  if (owner && owner !== "both" && owner !== "login" && owner !== mine) {
    console.warn("[nav] 拦截跨端访问:", target, "当前身份:", mine);
    location.href = (typeof ROLES !== "undefined" && ROLES[mine]) ? ROLES[mine].home : target;
    return;
  }
  location.href = raw;                          // 保留 ?query：同页区分不同对象
}

function currentFileName() {
  const m = location.pathname.match(/([^/]+\.html?)$/i);
  return m ? m[1] : "";
}

/**
 * 独立模式下的「当前目标」= 文件名 + 查询串。
 * 多个班级共用 class.html，靠 ?cls=xxx 区分；不带查询串就用裸页名。
 * 侧栏高亮与它比对，否则点一个班会让所有班一起亮。
 */
function currentTarget() {
  return currentFileName() + (location.search || "");
}

function mountStandaloneTop() {
  if (!document.body) return;
  if (document.querySelector(".standalone-top")) return;

  const role = currentRole();
  const meta = (typeof ROLES !== "undefined" && ROLES[role]) || { label: "教师", name: "用户" };
  const name = LS.get(STORE_KEY.name, "") || meta.name;

  const bar = el(`<header class="shell-top standalone-top" id="standaloneTop" role="banner">
    <div class="shell-top-left">
      <div class="shell-brand">
        <span class="shell-mark">智</span>
        <span class="shell-brand-name">智课助教</span>
        <span class="shell-brand-role">${meta.label}端</span>
      </div>
    </div>
    <div class="shell-top-right">
      <div class="shell-theme" role="group" aria-label="切换主题">
        ${THEMES.map((t) =>
          `<button class="theme-btn" type="button" data-theme-btn="${t.id}">${t.label}</button>`
        ).join("")}
      </div>
      <div class="shell-user">
        <button class="shell-user-btn" type="button" id="saUserBtn" aria-haspopup="menu" aria-expanded="false">
          <span class="shell-avatar">${name.slice(0, 1)}</span>
          <span class="shell-user-name">${name}</span>
          <span class="shell-caret" aria-hidden="true"></span>
        </button>
        <div class="shell-menu" id="saUserMenu" role="menu" hidden>
          <div class="shell-menu-head">
            <b>${name}</b>
            <span>${meta.label}身份</span>
          </div>
          <button class="shell-menu-item" role="menuitem" data-page="settings.html">
            <span class="mi-ico">设</span>偏好设置
          </button>
          <button class="shell-menu-item" role="menuitem" data-page="index.html">
            <span class="mi-ico">换</span>切换身份
          </button>
          <div class="shell-menu-sep"></div>
          <button class="shell-menu-item danger" role="menuitem" id="saLogout">
            <span class="mi-ico">退</span>退出登录
          </button>
        </div>
      </div>
    </div>
  </header>`);

  bar.querySelectorAll("[data-theme-btn]").forEach((b) => {
    b.addEventListener("click", () => Theme.apply(b.dataset.themeBtn));
  });

  const btn = bar.querySelector("#saUserBtn");
  const menu = bar.querySelector("#saUserMenu");
  const closeMenu = () => { if (menu) menu.hidden = true; btn?.setAttribute("aria-expanded", "false"); };
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  menu?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closeMenu);

  menu?.querySelectorAll("[data-page]").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.dataset.page;
      closeMenu();
      if (t === "index.html") {
        Cookie.del(STORE_KEY.role);
        LS.del(STORE_KEY.role);
      }
      standaloneGo(t);
    });
  });

  bar.querySelector("#saLogout")?.addEventListener("click", () => {
    Cookie.del(STORE_KEY.role);
    LS.del(STORE_KEY.role);
    location.href = "index.html";
  });

  document.body.prepend(bar);
}

function mountStandaloneSide() {
  if (!document.body) return;
  if (typeof NAV === "undefined") return;
  if (document.querySelector(".standalone-side")) return;

  const role = currentRole();
  const groups = NAV[role] || [];
  const here = currentTarget();
  const userName = LS.get(STORE_KEY.name, "") || (ROLES[role] || {}).name || "";

  // 先算出「哪一项是当前项」（规则见 nav.js currentIndex），再按同一顺序渲染
  const targets = groups.reduce((acc, g) =>
    acc.concat((g.items || []).map((it) => (it.page ? navTarget(it) : ""))), []);
  const activeIdx = (typeof currentIndex === "function") ? currentIndex(targets, here) : -1;
  let k = -1;

  const side = el(`<nav class="shell-side standalone-side" id="saSide" aria-label="主导航">
    <div class="side-nav">
    ${groups.map((g) => {
      // 与 shell.js 的 mountSide() 保持一致：加号由 nav.js 的 GROUP_ACTIONS 驱动
      const act = (typeof GROUP_ACTIONS !== "undefined" && g.action && GROUP_ACTIONS[g.action]) || null;
      return `
      <div class="side-group">
        <h4>
          <span>${g.title}</span>
          ${act ? `
            <button class="side-add" type="button" id="${act.id}"
                    data-action="${g.action}"
                    aria-label="${act.label}" title="${act.label}">
              <span aria-hidden="true">＋</span>
            </button>` : ""}
        </h4>
        ${g.items.map((it) => {
          const dis = !it.page;
          const target = (typeof navTarget === "function") ? navTarget(it) : (it.page || "");
          k += 1;
          const on = !dis && k === activeIdx;
          const item = `<button class="side-item${dis ? " disabled" : ""}${it.dim ? " dim" : ""}${on ? " active" : ""}"
                          type="button" data-page="${target}"
                          ${dis ? 'aria-disabled="true"' : ""}
                          ${on ? 'aria-current="page"' : ""}>
            <span class="side-dot"${it.dot ? "" : ' style="opacity:0"'}></span>
            <span class="side-label">${it.label}</span>
            ${it.badge ? `<span class="side-badge">${it.badge}</span>` : ""}
          </button>`;
          // 与 shell.js 的 mountSide() 保持一致：课程项带「⋯」
          //   教师端（addCourse）→ 改信息 / 查看邀请码 / 删除课程
          //   学生端（joinCourse）→ 退出课堂
          // ⚠️ 放在 .side-item 外面（button 不能嵌 button），包一层 .side-row
          // ⚠️ data-more-kind 告诉点击处理「是哪一端」——两端都用课程 id，不能只看 key
          const more = ((g.action === "addCourse" || g.action === "joinCourse") && it.key)
            ? `<button class="side-more" type="button" data-more="${it.key}" data-more-kind="${g.action}"
                       aria-label="${it.label} 的更多操作" aria-haspopup="menu" aria-expanded="false">
                 <span aria-hidden="true">⋯</span>
               </button>`
            : "";
          return more ? `<div class="side-row">${item}${more}</div>` : item;
        }).join("")}
      </div>`;
    }).join("")}
    </div>
    <div class="side-foot">
      <div class="side-user">
        <span class="side-avatar">${userName.slice(0, 1)}</span>
        <div class="side-user-body">
          <b>${userName}</b>
          <span>${(ROLES[role] || {}).label || ""}身份</span>
        </div>
      </div>
    </div>
  </nav>`);

  side.querySelectorAll(".side-item").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.classList.contains("disabled")) return;
      standaloneGo(b.dataset.page);
    });
  });

  // 课程项右侧的「⋯」→ 课程操作菜单（与壳内行为一致）
  side.querySelectorAll(".side-more").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openCourseMenu(b, b.dataset.more, b.dataset.moreKind);
    });
  });

  // 分组标题的「＋」→ 打开对应的添加弹窗（与壳内行为一致）
  side.querySelectorAll(".side-add").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.action === "addClass") openAddClass();
      else if (b.dataset.action === "joinCourse") openJoinCourse();
      else openAddCourse();
    });
  });

  // 独立模式：有 `.shell-main` 就挂进它（与 app.html 同构），否则退回 body
  const host = document.querySelector(".standalone-main") || document.body;
  host.prepend(side);
}

/**
 * 重挂独立模式的侧栏。
 * ⚠️ mountStandaloneSide() 开头有 `if (document.querySelector(".standalone-side")) return;`
 *    的短路 —— 直接再调一次是**无效**的。必须先把旧的摘掉。
 *    壳（shell.js）那边不存在这个问题：mountSide() 是整块 innerHTML 重写。
 */
function remountStandaloneSide() {
  const old = document.querySelector(".standalone-side");
  if (old) old.remove();
  mountStandaloneSide();
}

/* ============================================================
   课程目录变更 —— 收口在一处
   ------------------------------------------------------------
   🔴 壳与内容页**各持一份 `COURSES`**（nav.js 在每个文档里各执行一次）。
      在壳里新建课程，只更新了壳自己那一份 —— 不广播的话，iframe 里的
      教案页课程下拉会一直停在旧列表上：左边刚建完的课，右边选不到。
   ============================================================ */

/** 通知「当前页面」：课程目录变了，相关 UI 自己去重渲染 */
function notifyCoursesChanged() {
  try { document.dispatchEvent(new CustomEvent("st:courses-changed")); }
  catch (_) { /* 没有 CustomEvent 构造器就算了，不影响主流程 */ }
}

/**
 * 班级目录变了（第 55 轮）。
 * · 在壳内：把新列表交给壳 —— 侧栏归壳渲染，不广播的话「班级管理」里看不到新班
 * · 独立模式：侧栏归自己渲染，重挂一次就够
 */
function notifyClassesChanged() {
  if (inShell()) { notifyShell("st-classes-changed", { classes: CLASSES }); return; }
  if (document.querySelector(".standalone-side")) remountStandaloneSide();
  try { document.dispatchEvent(new CustomEvent("st:classes-changed")); }
  catch (_) { /* 没有 CustomEvent 构造器就算了，不影响主流程 */ }
}

/* ============================================================
   实训活动变更通知（第 31 轮）
   ------------------------------------------------------------
   方向与课程**相反**：课程是「壳里建课 → 通知 iframe」，
   实训是「内容页里改活动 → 通知壳」（因为侧栏的所有者是壳）。
   侧栏「实训管理」的徽标 = 待教师确认的学生发起活动数，
   不通知的话，页面里刚发布/归档一条，侧栏徽标还是旧数字。
   ============================================================ */
function notifyActivitiesChanged() {
  // 壳在 → 把最新列表交给壳（带数据，别让它自己去读盘：
  //   file:// / 隐私模式下读不到存档会回落种子，反而把刚建的活动抹掉）
  if (inShell()) { notifyShell("st-activities-changed", { activities: ACTIVITIES }); return; }
  // 独立模式 → 侧栏归自己渲染，重挂一次就够（数据层已经刷过徽标）
  if (document.querySelector(".standalone-side")) remountStandaloneSide();
}

/**
 * 收到壳的 `st-courses-changed`：更新目录并通知页面。
 * 消息带 `courses` 就直接采用（壳是权威，也不必再读盘）；
 * 没带才自己重新读一次本机存档。
 */
function applyCoursesChanged(courses) {
  if (Array.isArray(courses) && courses.length) {
    COURSES = courses;
    refreshCourseNav();
  } else {
    let hasStore = false;
    // ⚠️ 用**当前账号的**存档键（课程按账号分开存），不能用基名
    try { hasStore = !!window.localStorage.getItem(courseStoreKey()); } catch (_) {}
    // ⚠️ 读不到存档时 loadCourses() 会回落种子 —— 那种情况下
    //    不能用种子覆盖内存里已有的目录（会把刚建的课抹掉）
    if (hasStore) { COURSES = loadCourses(); refreshCourseNav(); }
  }
  if (document.querySelector(".standalone-side")) remountStandaloneSide();
  notifyCoursesChanged();
}

/* ============================================================
   添加课程弹窗（独立模式版）
   ------------------------------------------------------------
   与壳内 shell.js 的同名弹窗保持同一套交互与视觉。
   保存走 nav.js 的 createCourse()，两边共用同一份实现。
   ============================================================ */
/* 学期 / 周次的候选值在 nav.js（termSuggestions() / COURSE_WEEKS）——
   🔴 别在这里再声明一份：nav.js 已用 var 声明过同名全局，
      这里再 `const` 会直接抛 "Identifier has already been declared"。 */


/* ============================================================
   内容页通用弹窗挂载点
   ------------------------------------------------------------
   🔴 内容页**不能**直接用壳的 #modalHost —— 那个节点在壳的文档里，
      从 iframe 内部的 document.getElementById() 取不到（返回 null）。
      所以内容页需要自己的挂载点：没有就按需创建、挂到自己的 body。
      弹窗用 position:fixed，正好覆盖 iframe 视口（= 内容区），外观与壳内一致。
   ============================================================ */
function pageModalHost() {
  let host = document.getElementById("modalHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "modalHost";
    host.hidden = true;
    document.body.appendChild(host);
  }
  return host;
}

/** 关闭内容页弹窗：清空内容 + 解除滚动锁 + 摘掉 Esc 监听 */
function closePageModal() {
  const host = document.getElementById("modalHost");
  if (!host) return;
  host.hidden = true;
  host.innerHTML = "";
  document.body.classList.remove("modal-open");
  document.removeEventListener("keydown", pageModalEsc);
}

/** 内容页弹窗共用的 Esc 处理 */
function pageModalEsc(e) {
  if (e.key === "Escape") closePageModal();
}

/** 独立模式取/建弹窗挂载点（与 pageModalHost 同一实现，名字保留兼容） */
function standaloneModalHost() {
  return pageModalHost();
}

/** HTML 转义 —— 课程表单预填用户输入时用（与 shell.js 同一实现，名字不同避免混淆） */
/**
 * 把一组「结果行」渲染成 HTML —— 代码块与 Markdown 表格要合并处理，逐行 mdToHtml 会散架。
 * 🔴 **唯一实现**：AI 助手两页与工作台都调它（以前 agent 两页各写了一份一模一样的）。
 */
function renderLines(lines) {
  const out = [];
  let i = 0;
  const arr = lines || [];
  while (i < arr.length) {
    const l = String(arr[i]);
    if (/^\s*```/.test(l)) {
      const buf = [];
      i++;
      while (i < arr.length && !/^\s*```/.test(String(arr[i]))) { buf.push(String(arr[i])); i++; }
      i++;
      out.push("<pre><code>" + escHtml(buf.join("\n")) + "</code></pre>");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < arr.length && /^\s*\|.*\|\s*$/.test(String(arr[i]))) {
        const cells = String(arr[i]).trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); });
        if (!cells.every(function (c) { return /^-{2,}$/.test(c) || c === ""; })) rows.push(cells);
        i++;
      }
      if (rows.length) {
        const head = rows.shift();
        out.push('<div class="table-wrap"><table class="data"><thead><tr>' +
          head.map(function (c) { return "<th>" + mdToHtml(c) + "</th>"; }).join("") + "</tr></thead><tbody>" +
          rows.map(function (r) {
            return "<tr>" + r.map(function (c) { return "<td>" + mdToHtml(c) + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table></div>");
      }
      continue;
    }
    out.push(mdToHtml(l));
    i++;
  }
  return out.join("");
}

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ============================================================
   图表（ECharts）—— 第 62 轮
   ------------------------------------------------------------
   技能返回 `chart: {option}`，结果卡里那块 `[data-chart]` 由这里接管。
   🔴 三条硬要求：
     ① **按需加载**：只有真出现图表才去拉 echarts，首屏不为它付代价
     ② **拉不到不装没事**：离线 / CDN 被拦时如实说一句，并保留原始数据
     ③ **主题跟随**：ECharts 默认配色是给白底的，深色页必须把文字与网格线改浅
   ⚠️ ECharts 已本地化：`assets/echarts.min.js`（5.5.1，约 1 MB）随交付物走，
      断网也能画；本地缺失时自动退回 CDN。
   ============================================================ */

/* 🔴 本地优先：`assets/echarts.min.js`（Apache ECharts 5.5.1，Apache-2.0）已随交付物一起放好，
   断网 / 内网 / 比赛现场都能画。本地拿不到（文件漏拷、路径不对）才退回 CDN ——
   **降级顺序不能反**：先 CDN 的话，离线时每次都要白等一次超时才落到本地。 */
var ECHARTS_SRC = "assets/echarts.min.js";
var ECHARTS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.0/echarts.min.js";
var echartsLoading = null;

function loadScriptOnce(src) {
  return new Promise(function (resolve) {
    if (typeof document === "undefined") return resolve(false);
    var s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = function () { resolve(!!window.echarts); };
    s.onerror = function () { resolve(false); };
    document.head.appendChild(s);
  });
}

function ensureEcharts() {
  if (typeof window === "undefined" || typeof document === "undefined") return Promise.resolve(false);
  if (window.echarts) return Promise.resolve(true);
  if (echartsLoading) return echartsLoading;
  echartsLoading = loadScriptOnce(ECHARTS_SRC)
    .then(function (ok) { return ok ? true : loadScriptOnce(ECHARTS_CDN); })
    .then(function (ok) {
      // 两条都失败 → 置空，允许用户下次点「重试」或下一张图再试一次
      if (!ok) echartsLoading = null;
      return ok;
    });
  return echartsLoading;
}

/** 深色页把轴标签 / 网格线 / 标题 / 图例改成浅色；背景一律透明（跟着卡片走） */
function chartTheme(option) {
  var dark = String(document.documentElement.getAttribute("data-theme") || "") === "dark";
  var fg = dark ? "#D3D1C7" : "#444441";
  var grid = dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)";
  var o = JSON.parse(JSON.stringify(option || {}));

  function paintAxis(a) {
    if (!a || typeof a !== "object") return;
    a.axisLabel = Object.assign({ color: fg }, a.axisLabel || {});
    a.axisLine = Object.assign({ lineStyle: { color: grid } }, a.axisLine || {});
    a.splitLine = Object.assign({ lineStyle: { color: grid } }, a.splitLine || {});
    if (a.nameTextStyle) a.nameTextStyle = Object.assign({ color: fg }, a.nameTextStyle);
  }

  o.textStyle = Object.assign({ color: fg }, o.textStyle || {});
  ["xAxis", "yAxis"].forEach(function (k) {
    var ax = o[k];
    if (!ax || typeof ax !== "object") return;
    if (Array.isArray(ax)) ax.forEach(paintAxis); else paintAxis(ax);
  });
  if (o.legend && !o.legend.textStyle) o.legend.textStyle = { color: fg };
  if (o.title && !o.title.textStyle) o.title.textStyle = { color: fg, fontSize: 13 };
  o.backgroundColor = "transparent";
  return o;
}

/** 把 `[data-chart]` 里的 option 真的渲染出来；返回渲染了几个 */
function mountCharts(root) {
  var host = root || document;
  var boxes = Array.prototype.slice.call(host.querySelectorAll("[data-chart]"));
  if (!boxes.length) return Promise.resolve(0);
  return ensureEcharts().then(function (ok) {
    boxes.forEach(function (box) {
      var opt = box._chartOption;
      if (!opt || box._chartDone) return;
      box._chartDone = true;
      if (!ok || !window.echarts) {
        box.innerHTML = "";
        var tip = document.createElement("div");
        tip.className = "chart-fallback";
        tip.textContent = "图表没画出来：没能加载图表组件（断网时会这样）。数据还在，见下面的原始值。";
        box.appendChild(tip);
        var pre = document.createElement("pre");
        pre.className = "chart-raw";
        pre.textContent = JSON.stringify((opt && opt.series) || [], null, 2);
        box.appendChild(pre);
        return;
      }
      try {
        var inst = window.echarts.init(box, null, { renderer: "canvas" });
        inst.setOption(chartTheme(opt), true);
        box._chartInst = inst;
      } catch (e) {
        box.textContent = "图表渲染失败：" + ((e && e.message) || e);
      }
    });
    return boxes.length;
  });
}

/** 窗口变大变小时图表要跟着重算（ECharts 不会自己响应容器变化） */
if (typeof window !== "undefined") {
  window.addEventListener("resize", function () {
    Array.prototype.slice.call(document.querySelectorAll("[data-chart]")).forEach(function (box) {
      if (box._chartInst && typeof box._chartInst.resize === "function") {
        try { box._chartInst.resize(); } catch (_) { }
      }
    });
  });
}

/* ============================================================
   课程表单（独立模式版）—— 新建与「编辑信息」共用
   ------------------------------------------------------------
   · 不传参数 = 添加课程   · 传课程对象 = 编辑课程信息
   保存走 nav.js 的 createCourse() / updateCourse()（唯一实现）。
   🔴 与 shell.js 的同名弹窗是一对，改一处必须同步另一处。
   ============================================================ */
function openCourseForm(course) {
  const isEdit = !!(course && course.id);
  const c = course || {};
  const host = standaloneModalHost();
  if (!host) return;

  host.innerHTML = `
    <div class="modal-scrim" data-close="1"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div class="modal-head">
        <h3 id="modalTitle">${isEdit ? "编辑课程信息" : "添加课程"}</h3>
        <button class="modal-x" type="button" data-close="1" aria-label="关闭">✕</button>
      </div>

      <form class="modal-body" id="courseForm" novalidate>
        <div class="field">
          <label for="cName">课程名称 <span class="req">*</span></label>
          <input class="input" id="cName" type="text" placeholder="例如：数据结构与算法"
                 autocomplete="off" value="${escHtml(c.name)}">
        </div>

        <div class="field">
          <label for="cCode">课程代码</label>
          <input class="input" id="cCode" type="text" placeholder="例如：CS201"
                 autocomplete="off" autocapitalize="off" spellcheck="false" value="${escHtml(c.code)}">
        </div>

        <div class="modal-row">
          <div class="field">
            <label for="cTerm">开课学期</label>
            <input class="input" id="cTerm" type="text" list="cTermList"
                   placeholder="例如：2026 秋季、暑假小学期" autocomplete="off"
                   value="${escHtml(c.term)}">
          </div>
          <div class="field">
            <label for="cWeek">上课周次</label>
            <input class="input" id="cWeek" type="text" list="cWeekList"
                   placeholder="例如：1–16 周、单周、集中实践周" autocomplete="off"
                   value="${escHtml(c.weeks)}">
          </div>
        </div>
        <datalist id="cTermList">
          ${termSuggestions().map((t) => `<option value="${escHtml(t)}"></option>`).join("")}
        </datalist>
        <datalist id="cWeekList">
          ${COURSE_WEEKS.map((t) => `<option value="${escHtml(t)}"></option>`).join("")}
        </datalist>

        <div class="field">
          <label for="cDesc">课程简介</label>
          <textarea class="textarea" id="cDesc" rows="3"
                    placeholder="一句话说明这门课讲什么，AI 出题与答疑会参考它">${escHtml(c.desc)}</textarea>
        </div>

        <p class="login-error" id="courseError" role="alert" hidden></p>
      </form>

      <div class="modal-foot">
        <button class="btn" type="button" data-close="1">取消</button>
        <button class="btn btn-primary" type="button" id="courseSave">${isEdit ? "保存修改" : "保存课程"}</button>
      </div>
    </div>`;

  host.hidden = false;
  document.body.classList.add("modal-open");

  host.querySelectorAll("[data-close]").forEach((n) =>
    n.addEventListener("click", closeAddCourse));
  document.addEventListener("keydown", modalEsc);

  setTimeout(() => document.getElementById("cName")?.focus?.(), 0);

  // 保存：新建 / 改信息（与 shell.js 那份同逻辑，共用 nav.js 的 createCourse / updateCourse）
  document.getElementById("courseSave").addEventListener("click", () => {
    const err = document.getElementById("courseError");
    const data = {
      name: (document.getElementById("cName")?.value || "").trim(),
      code: (document.getElementById("cCode")?.value || "").trim(),
      term: document.getElementById("cTerm")?.value || "",
      weeks: document.getElementById("cWeek")?.value || "",
      desc: (document.getElementById("cDesc")?.value || "").trim(),
    };
    const r = isEdit ? updateCourse(c.id, data) : createCourse(data);
    if (!r.ok) {
      err.textContent = r.error;
      err.hidden = false;
      document.getElementById("cName")?.focus?.();
      return;
    }
    err.hidden = true;
    closeAddCourse();
    remountStandaloneSide();      // 重渲染 → 新课程 / 新名字出现在菜单里
    // 独立模式下内存里已是最新，不需要再读盘 —— 只通知页面重渲染
    notifyCoursesChanged();
  });
}

/** 侧栏「＋」→ 添加课程 */
function openAddCourse() { openCourseForm(null); }

/** 课程项的「⋯」→ 编辑信息 */
function openEditCourse(id) {
  const c = (COURSES || []).find((x) => x.id === id);
  if (c) openCourseForm(c);
}

/* ============================================================
   课程项的「⋯」菜单（独立模式版）—— 改信息 / 删除
   ⚠️ 菜单挂 body + position:fixed：.shell-side 是 overflow:hidden，放里面会被裁掉。
   🔴 与 shell.js 的同名实现是一对，改一处必须同步另一处。
   ============================================================ */
let courseMenuEl = null;

function closeCourseMenu() {
  if (!courseMenuEl) return;
  courseMenuEl.remove();
  courseMenuEl = null;
  document.querySelectorAll('.side-more[aria-expanded="true"]')
    .forEach((b) => b.setAttribute("aria-expanded", "false"));
  document.removeEventListener("click", onDocClickForCourseMenu);
  document.removeEventListener("keydown", onEscForCourseMenu);
}

function onDocClickForCourseMenu(e) {
  if (courseMenuEl && !courseMenuEl.contains(e.target)) closeCourseMenu();
}
function onEscForCourseMenu(e) {
  if (e.key === "Escape") closeCourseMenu();
}

/**
 * 「⋯」操作菜单。
 * 🔴 `kind` 来自渲染时的 `data-more-kind`，区分两端（**不能只看 courseId**：
 *    两端用的都是课程 id，会撞）：
 *      教师端 addCourse → 编辑课程信息 / 查看邀请码 / 删除课程
 *      学生端 joinCourse → 退出课堂
 */
function openCourseMenu(anchor, courseId, kind) {
  const isStudent = kind === "joinCourse";
  const wasOpen = anchor.getAttribute("aria-expanded") === "true";
  closeCourseMenu();
  if (wasOpen) return;

  const menu = document.createElement("div");
  menu.className = "side-menu";
  menu.id = "sideMenu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = isStudent
    ? `<button type="button" role="menuitem" data-act="leave" class="danger">退出课堂</button>`
    : `<button type="button" role="menuitem" data-act="edit">编辑课程信息</button>
       <button type="button" role="menuitem" data-act="code">查看邀请码</button>
       <button type="button" role="menuitem" data-act="delete" class="danger">删除课程</button>`;
  document.body.appendChild(menu);
  courseMenuEl = menu;

  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 150;
  const mh = menu.offsetHeight || 80;
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
  menu.style.top = Math.round(top) + "px";
  menu.style.left = Math.round(left) + "px";

  anchor.setAttribute("aria-expanded", "true");
  if (isStudent) {
    menu.querySelector('[data-act="leave"]').addEventListener("click", () => {
      closeCourseMenu();
      askLeaveCourse(courseId);
    });
  } else {
    menu.querySelector('[data-act="edit"]').addEventListener("click", () => {
      closeCourseMenu();
      openEditCourse(courseId);
    });
    menu.querySelector('[data-act="code"]').addEventListener("click", () => {
      closeCourseMenu();
      openJoinCode(courseId);
    });
    menu.querySelector('[data-act="delete"]').addEventListener("click", () => {
      closeCourseMenu();
      askDeleteCourse(courseId);
    });
  }

  setTimeout(() => {
    document.addEventListener("click", onDocClickForCourseMenu);
    document.addEventListener("keydown", onEscForCourseMenu);
  }, 0);
}

/** 删除课程：先讲清会连带删掉多少教案，再动手 */
function askDeleteCourse(courseId) {
  const course = (COURSES || []).find((c) => c.id === courseId);
  if (!course) return;
  const n = courseAssetCount(courseId);
  let msg = `确定删除课程「${course.name}」吗？`;
  if (n.lessons || n.hasSyllabus) {
    msg += `\n\n这门课下的教案会一起删除：${n.chapters} 章大纲、${n.lessons} 份课时教案。`;
  }
  msg += "\n\n删除后无法撤销。";
  if (!window.confirm(msg)) return;

  const r = deleteCourse(courseId);
  if (!r.ok) { window.alert(r.error); return; }
  remountStandaloneSide();
  notifyCoursesChanged();
}

function closeAddCourse() {
  const host = document.getElementById("modalHost");
  if (!host) return;
  host.hidden = true;
  host.innerHTML = "";
  document.body.classList.remove("modal-open");
  document.removeEventListener("keydown", modalEsc);
}

/* ============================================================
   添加班级弹窗（独立模式版）
   ------------------------------------------------------------
   与壳内 shell.js 的同名弹窗保持同一套交互与视觉。
   ⚠️ 同样只是「示例」——保存逻辑未实现。
   ============================================================ */
const CLASS_GRADES = ["2023 级", "2024 级", "2025 级"];
const CLASS_MAJORS = ["计算机科学与技术", "软件工程", "网络工程", "人工智能"];

/** 关联课程下拉项：直接取教师端真实存在的课程，避免两处各写一份课名 */
function classCourseOptions() {
  const groups = (typeof NAV !== "undefined" && NAV.teacher) || [];
  const names = groups
    .filter((g) => g.action === "addCourse")
    .reduce((acc, g) => acc.concat(g.items || []), [])
    .filter((i) => i.page)
    .map((i) => i.label);
  return names.concat(["暂不关联"]);
}

function openAddClass() {
  const host = standaloneModalHost();
  if (!host) return;

  host.innerHTML = `
    <div class="modal-scrim" data-close="1"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div class="modal-head">
        <h3 id="modalTitle">添加班级</h3>
        <button class="modal-x" type="button" data-close="1" aria-label="关闭">✕</button>
      </div>

      <form class="modal-body" id="classForm" novalidate>
        <div class="field">
          <label for="kName">班级名称 <span class="req">*</span></label>
          <input class="input" id="kName" type="text" placeholder="例如：计科 2301 班"
                 autocomplete="off">
        </div>

        <div class="modal-row">
          <div class="field">
            <label for="kMajor">所属专业</label>
            <select class="select" id="kMajor">
              ${CLASS_MAJORS.map((m) => `<option>${m}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="kGrade">年级</label>
            <select class="select" id="kGrade">
              ${CLASS_GRADES.map((g) => `<option>${g}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="modal-row">
          <div class="field">
            <label for="kCourse">关联课程</label>
            <select class="select" id="kCourse">
              ${classCourseOptions().map((c) => `<option>${c}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="kCount">学生人数</label>
            <input class="input" id="kCount" type="number" min="1" max="200"
                   placeholder="例如：45" inputmode="numeric">
          </div>
        </div>

        <p class="modal-hint">
          <span class="hint-mark" aria-hidden="true">i</span>
          <span>保存后可在左侧栏「班级管理」里点击切换。</span>
        </p>

        <p class="login-error" id="classError" role="alert" hidden></p>
      </form>

      <div class="modal-foot">
        <button class="btn" type="button" data-close="1">取消</button>
        <button class="btn btn-primary" type="button" id="classSave">保存班级</button>
      </div>
    </div>`;

  host.hidden = false;
  document.body.classList.add("modal-open");

  host.querySelectorAll("[data-close]").forEach((n) =>
    n.addEventListener("click", closeAddClass));
  document.addEventListener("keydown", modalEsc);

  setTimeout(() => document.getElementById("kName")?.focus?.(), 0);

  // 保存：**真的建班** —— 与 shell.js 那份同逻辑，共用 nav.js 的 createClass()
  document.getElementById("classSave").addEventListener("click", () => {
    const err = document.getElementById("classError");
    const r = createClass({
      label: (document.getElementById("kName")?.value || "").trim(),
      major: document.getElementById("kMajor")?.value || "",
      grade: document.getElementById("kGrade")?.value || "",
      course: document.getElementById("kCourse")?.value || "",
      count: document.getElementById("kCount")?.value || "",
    });
    if (!r.ok) {
      err.textContent = r.error;
      err.hidden = false;
      document.getElementById("kName")?.focus?.();
      return;
    }
    err.hidden = true;
    closeAddClass();
    remountStandaloneSide();      // 新班级立刻出现在「班级管理」里
    notifyClassesChanged();
  });
}

function closeAddClass() {
  const host = document.getElementById("modalHost");
  if (!host) return;
  host.hidden = true;
  host.innerHTML = "";
  document.body.classList.remove("modal-open");
  document.removeEventListener("keydown", modalEsc);
}

/** Esc 关闭：两个弹窗共用同一个处理，靠内容判断该关哪个 */
function modalEsc(e) {
  if (e.key !== "Escape") return;
  if (document.getElementById("classSave")) closeAddClass();
  else closeAddCourse();
}

/** 把页面正文包进 .standalone-content，配合独立模式布局 */
function mountStandaloneContent() {
  const wrap = document.querySelector(".page-wrap");
  if (!wrap || wrap.parentElement?.classList.contains("standalone-content")) return;
  const holder = document.createElement("div");
  holder.className = "shell-content standalone-content";
  wrap.parentNode.insertBefore(holder, wrap);
  holder.appendChild(wrap);
}

/** 独立模式总入口 */
function mountStandalone() {
  if (typeof NAV === "undefined" || typeof ROLES === "undefined") return;
  if (inShell()) return;                      // 双保险：绝不在壳内渲染
  document.body.classList.add("standalone-body");
  mountStandaloneTop();
  mountStandaloneSide();
  mountStandaloneContent();

  // 🔴 与 app.html 同构：侧栏 + 正文要放进 `.shell-main`（它是 `display:flex` 的横排容器）。
  //    只 `prepend(side)` 到 body 的话，body 是**竖排** flex → 232px 宽的侧栏变成顶部一条，
  //    顶栏被挤到页面中间、下面再跟正文（症状：首屏一大片空白，内容从中线才开始）。
  //    shell.css 里 `.standalone-body .shell-main{flex-direction:column}` 的窄屏规则也说明
  //    这个容器本来就该存在，只是之前没人建。
  let main = document.querySelector(".standalone-main");
  if (!main) {
    main = document.createElement("div");
    main.className = "shell-main standalone-main";
    document.body.appendChild(main);
  }
  const side = document.querySelector(".standalone-side");
  const content = document.querySelector(".standalone-content");
  if (side && side.parentElement !== main) main.appendChild(side);
  if (content && content.parentElement !== main) main.appendChild(content);
}

/**
 * 撤销独立模式渲染的导航。
 * 用途：万一把「壳内的内容页」误判成独立页，已经渲染出一整套导航，
 * 此时收到壳的 "st-shell-hello" 就能把它拆掉，避免界面出现两块页面。
 * 这是「检测失败」的兜底，宁可多写一层。
 */
function tearDownStandalone() {
  if (!document.body.classList.contains("standalone-body")) return;
  document.body.classList.remove("standalone-body");
  document.querySelectorAll(".standalone-top").forEach((n) => n.remove());
  const holder = document.querySelector(".standalone-content");
  const main = document.querySelector(".standalone-main");
  if (holder) {
    const wrap = holder.querySelector(".page-wrap");
    if (wrap) {
      // 正文先搬回 body（不能留在即将删除的 .shell-main 里）
      if (main && main.parentNode) main.parentNode.insertBefore(wrap, main);
      else if (holder.parentNode) holder.parentNode.insertBefore(wrap, holder);
    }
    holder.remove();
  }
  document.querySelectorAll(".standalone-side").forEach((n) => n.remove());
  if (main) main.remove();
}

/* ---------------- 初始化 ---------------- */
/**
 * 无障碍阅读模式的当前状态（由壳通过 st-a11y-mode 下发 / 本页开关切换）。
 * 第 57 轮起**有真实实现**：为真时根元素挂 `data-read-mode`，并挂出阅读工具条。
 * 想判断"现在是不是阅读态"，读这个变量或用 `document.documentElement.hasAttribute("data-read-mode")`。
 */
let readMode = true;

/* 阅读模式下：点正文里的段落 / 列表项 → 朗读这一段（Web Speech API，不走模型）
   🔴 事件委托挂 document：内容随数据重渲染也不会失效；
      链接、按钮、输入框等交互元素先排除掉，别抢它们的点击。 */
document.addEventListener("click", (e) => {
  if (!readMode) return;
  if (e.target.closest("a, button, input, textarea, select, label, summary, .btn, #readerBar")) return;
  const blk = e.target.closest("p, li, h1, h2, h3, h4, blockquote, .pre");
  if (!blk) return;
  const t = (blk.innerText || blk.textContent || "").trim();
  if (!t || t.length > 600) return;
  if (readerSpeak(t)) {
    const bar = document.getElementById("readerBar");
    if (bar) { bar.dataset.speaking = "1"; syncReaderBar(bar); }
  }
});

Theme.init();
applyA11yVars();
syncA11yProfileAttr();

/* 首访：没读到显示模式就先问一次（弹窗自身按最坏情况渲染） */
(function initA11yGate() {
  try {
    const start = () => {
      if (a11yProfile()) return;      // 读过 → 直接按模式生效，不再打扰
      openA11yGate();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  } catch (_) { /* 异常 DOM 下静默跳过 */ }
})();

/* 接收壳下发设置变更（壳改了主题/无障碍 → 内容页同步变色） */
window.addEventListener("message", (e) => {
  // 同源校验；某些浏览器 e.origin 为空（如 file://），此时也放行
  if (e.origin && e.origin !== "null" && e.origin !== location.origin) return;
  const d = e.data || {};

  // 壳自报家门：确认「我在壳内」→ 撤掉可能误渲染的独立导航
  if (d.type === "st-shell-hello") {
    tearDownStandalone();
    if (d.theme) Theme.apply(d.theme, false, { silent: true });
    return;
  }

  if (d.type === "st-theme-changed" && d.theme) {
    Theme.apply(d.theme, false, { silent: true });
  }
  // 壳那边新建了课程 → 本页更新目录（教案页的课程下拉要跟着多一项）
  if (d.type === "st-courses-changed") {
    applyCoursesChanged(d.courses);
  }
  // 壳顶栏「显示模式」→ 打开本页的选择弹窗（弹窗只此一份，不复制到壳里）
  if (d.type === "st-open-a11y-gate") {
    openA11yGate();
    notifyShell("st-a11y-gate-opened", {});
  }
  // 壳顶栏「指令」/ 在壳里长按 Alt → 打开本页的指令条（同样只实现一份）
  if (d.type === "st-open-deck") {
    deckOpen();
    notifyShell("st-deck-opened", {});
  }
  // 无障碍阅读模式：壳改了开关 → 本页立刻跟着切阅读态（视觉 + 工具条）
  if (d.type === "st-a11y-mode") {
    applyReadMode(d.on);
    document.querySelectorAll("#a11yReadMode, [data-a11y-mode]")
      .forEach((b) => { b.checked = readMode; });
  }
  if (d.type === "st-a11y-changed") {
    if (d.vars) {
      Object.entries(d.vars).forEach(([k, v]) =>
        document.documentElement.style.setProperty(k, v));
    }
    if (typeof d.contrast === "boolean")
      document.documentElement.toggleAttribute("data-contrast", d.contrast);
    if (typeof d.reduceMotion === "boolean")
      document.documentElement.toggleAttribute("data-reduce-motion", d.reduceMotion);
  }
});

(function initStandalone() {
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => mountReadMode());
    } else {
      mountReadMode();
    }
    if (document.documentElement.getAttribute("data-role") === "login") return;
    if (inShell()) return;                       // 在壳内则壳已提供导航
    if (typeof NAV === "undefined" || typeof ROLES === "undefined") return;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mountStandalone);
    } else {
      mountStandalone();
    }
  } catch (_) { /* 异常 DOM 下静默跳过 */ }
})();

/* ============================================================
   学生端：输入邀请码加入课堂（第 32 轮）
   ------------------------------------------------------------
   🔴 与 shell.js 的同名实现是一对，改一处必须同步另一处。
   校验 / 查课堂 / 落库全在 nav.js（findClassroom / enrollCourse）——
   这里只负责收集输入、提示错误、重渲染侧栏。
   ============================================================ */
function openJoinCourse() {
  const host = pageModalHost();
  if (!host) return;

  host.innerHTML = `
    <div class="modal-scrim" data-close="1"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="joinTitle">
      <div class="modal-head">
        <h3 id="joinTitle">加入课堂</h3>
        <button class="modal-x" type="button" data-close="1" aria-label="关闭">✕</button>
      </div>

      <form class="modal-body" id="joinForm" novalidate>
        <div class="field">
          <label for="joinCode">邀请码</label>
          <input class="input" id="joinCode" type="text" placeholder="例如：CS201-7K3M"
                 autocomplete="off" autocapitalize="characters" spellcheck="false">
        </div>
        <p class="field-hint">邀请码由老师提供 —— 老师在「我的课程」里点课程右侧的
          「⋯ → 查看邀请码」就能看到。输入不区分大小写，中间的横线漏掉也能识别。</p>
        <p class="login-error" id="joinError" role="alert" hidden></p>
      </form>

      <div class="modal-foot">
        <button class="btn" type="button" data-close="1">取消</button>
        <button class="btn btn-primary" type="button" id="joinSave">加入课堂</button>
      </div>
    </div>`;

  host.hidden = false;
  document.body.classList.add("modal-open");
  host.querySelectorAll("[data-close]").forEach((n) =>
    n.addEventListener("click", closePageModal));
  document.addEventListener("keydown", modalEsc);
  setTimeout(() => document.getElementById("joinCode")?.focus?.(), 0);

  document.getElementById("joinSave").addEventListener("click", () => {
    const err = document.getElementById("joinError");
    const raw = document.getElementById("joinCode")?.value || "";
    const hit = findClassroom(raw);
    if (!hit) {
      err.textContent = raw.trim()
        ? "这个邀请码没找到对应的课堂 —— 检查一下，或让老师再发一次"
        : "请先输入邀请码";
      err.hidden = false;
      document.getElementById("joinCode")?.focus?.();
      return;
    }
    const r = enrollCourse(hit.course, hit.owner);
    if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
    err.hidden = true;
    closePageModal();
    remountStandaloneSide();    // 侧栏里立刻出现这门课
    // 直接跳过去，让「加入」马上有反馈（学生端的课程页就是 AI 答疑）
    navigate("chat.html?course=" + encodeURIComponent(hit.course.id));
  });
}

/** 教师端：显示这门课的邀请码（学生凭它加入课堂） */
function openJoinCode(courseId) {
  const c = (COURSES || []).find((x) => x.id === courseId);
  if (!c) return;
  const host = pageModalHost();
  if (!host) return;
  const code = joinCodeOf(c);

  host.innerHTML = `
    <div class="modal-scrim" data-close="1"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="codeTitle">
      <div class="modal-head">
        <h3 id="codeTitle">课堂邀请码</h3>
        <button class="modal-x" type="button" data-close="1" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <p class="field-hint">把这串码报给同学，他们在左侧「我的课程 ＋」里输入就能加入课堂。</p>
        <p class="join-code" id="joinCodeText">${code}</p>
        <p class="field-hint">课程：${escHtml(c.name)}${c.code ? " · " + escHtml(c.code) : ""}</p>
        <p class="field-hint">邀请码由「课程代码 + 4 位校验位」确定性生成 ——
          同一门课永远是同一个码，不用发给每个人不同的码。</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" type="button" data-close="1">知道了</button>
      </div>
    </div>`;

  host.hidden = false;
  document.body.classList.add("modal-open");
  host.querySelectorAll("[data-close]").forEach((n) =>
    n.addEventListener("click", closePageModal));
  document.addEventListener("keydown", modalEsc);
}

/** 学生端：退出课堂（只删自己这条选课记录，老师的课与数据不受影响） */
function askLeaveCourse(courseId) {
  const e = enrolledOf(courseId);
  if (!e) return;
  const name = studentCourseName(courseId);
  let msg = `退出「${name}」课堂吗？\n\n只是把你从自己的课程表里移除，老师的课和其他人都不受影响。`;
  if (e.joinCode) msg += `\n\n想回来的时候，再输一次邀请码 ${e.joinCode} 就行。`;
  if (!window.confirm(msg)) return;

  const r = leaveCourse(courseId);
  if (!r.ok) { window.alert(r.error); return; }
  remountStandaloneSide();
}

/* ============================================================
   AI 指令条（长按 Alt 呼出）
   ------------------------------------------------------------
   要解决的问题：读屏用户找控件靠「翻」，键盘用户找功能靠「记」。
   指令条把这两件事压成一句话 —— 「把字放大一点」「去我的作业」。

   🔴 三条硬规则（改之前先读）：
   1) **只读的直接做，会改东西的一定先给 diff**：把「现在 → 将改为」
      列成表格，点「应用变更」才落库；Esc / 取消一律**不生效**。
   2) **动作只能来自白名单**（DECK_ACTIONS + 页面注册项）。模型最多
      挑一个 id，参数一律由本地解析；未知 id 直接拒。绝不执行模型
      自由生成的代码或参数。
   3) **没接模型就如实说**：本地规则命中就照做，命中不了就说「没听懂」，
      不编动作、不假装执行过。

   ⚠️ 语音输入走浏览器自带 SpeechRecognition（Chrome / Edge，需 https
      或 localhost）。不支持时按钮置灰并说明原因，不做假的「正在听」。
   ============================================================ */

const DECK_HOLD_MS = 550;

/** 页面级指令（含别名）。判断顺序在全局动作之后，避免「作业」抢走「字号」。 */
const DECK_PAGES = [
  { page: "homework.html",  label: "我的作业",     keys: ["交作业", "做作业", "我的作业"] },
  { page: "courseware.html", label: "发布课件作业", keys: ["发布作业", "布置作业", "发布课件", "发课件"] },
  { page: "reader.html",    label: "课件阅读",     keys: ["课件阅读", "看课件", "读课件"] },
  { page: "analysis.html",  label: "我的学情",     keys: ["学情", "成绩", "得分"] },
  { page: "exam.html",      label: "出题与组卷",   keys: ["出题", "组卷", "试卷"] },
  { page: "lesson.html",    label: "教案",         keys: ["教案", "备课"] },
  { page: "schedule.html",  label: "课表与事项",   keys: ["课表", "日程", "事项"] },
  { page: "stu.html",       label: "学生管理",     keys: ["学生管理", "学生名册"] },
  { page: "class.html",     label: "课程成员",     keys: ["课程成员", "我的课程", "班级", "成员"] },
  { page: "training.html",  studentPage: "training-student.html", label: "实训", keys: ["实训"] },
  { page: "agent.html",     studentPage: "agent-student.html",    label: "AI 助手", keys: ["ai 助手", "助手", "智能体"] },
  { page: "workbench.html", label: "工作台",       keys: ["工作台"] },
  { page: "chat.html",      label: "AI 答疑",      keys: ["答疑", "提问"] },
  { page: "settings.html",  label: "偏好设置",     keys: ["设置", "偏好"] },
];

/** 读当前无障碍配置（本地存储里的那一份，不做任何推断） */
function deckA11yCfg() {
  const c = LS.get(STORE_KEY.a11y, null);
  return (c && typeof c === "object") ? c : {};
}
function deckProfileById(id) {
  for (let i = 0; i < A11Y_PROFILES.length; i++) {
    if (A11Y_PROFILES[i].id === id) return A11Y_PROFILES[i];
  }
  return null;
}
function deckProfileName(id) {
  const p = deckProfileById(id);
  return p ? p.label : "";
}
function deckThemeName(id) {
  for (let i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i].label;
  return id || "默认";
}
function deckOnOff(v) { return v ? "开" : "关"; }

/** 写无障碍配置并立即生效（不换模式时只改一项） */
function deckPatchA11y(patch) {
  const prev = LS.get(STORE_KEY.a11y, null) || {};
  const next = Object.assign({}, prev, patch);
  LS.set(STORE_KEY.a11y, next);
  applyA11yVars(next);
  if (patch.profile) document.documentElement.setAttribute("data-a11y-profile", patch.profile);
  else syncA11yProfileAttr();
}

/* ---------------- 动作表（白名单） ----------------
   每个动作：
     id / label / sample      —— 给人看
     risk: "read" | "nav" | "write"
     match(text)              —— 命中就返回参数对象，不命中返回 null
     fallbackArgs()           —— 本地没命中、但模型认为该用它时的保守参数
     diff(args)               —— 仅 write：返回 [{label, from, to}]
     run(args)                —— 真执行
--------------------------------------------------- */
const DECK_ACTIONS = [
  {
    id: "help",
    label: "看它能做什么",
    sample: "你能做什么",
    risk: "read",
    match: function (t) {
      return /(你能做什么|能做什么|帮助|怎么用|有哪些指令|help)/i.test(t) ? {} : null;
    },
    run: function () { deckRenderHelp(true); deckSay("下面列了现在能做的事，点一条就填进输入框。"); },
  },
  {
    id: "read.page",
    label: "朗读当前页面",
    sample: "把这一页读给我听",
    risk: "read",
    match: function (t) {
      return /(朗读|念|读给|听).*(这一?页|本页|当前页|全文|正文)/.test(t) ? {} : null;
    },
    run: function () { deckReadPage(); },
  },
  {
    id: "a11y.gate",
    label: "重新选择显示模式",
    sample: "重新选一下显示模式",
    risk: "nav",
    leave: true,                                 // 先收起指令条，别把弹窗压在它下面
    match: function (t) {
      return /(重新选|换一个模式|选择显示模式|显示模式选择)/.test(t) ? {} : null;
    },
    run: function () { if (typeof openA11yGate === "function") openA11yGate(); },
  },
  {
    id: "a11y.profile",
    label: "换一种显示模式",
    sample: "换成大字高对比",
    risk: "write",
    match: function (t) {
      if (!/(朗读优先|大字高对比|大字模式|减少动效|标准显示|显示模式)/.test(t)) return null;
      if (/朗读/.test(t)) return { profile: "reader" };
      if (/大字|高对比/.test(t)) return { profile: "large" };
      if (/动效|动画|闪烁/.test(t)) return { profile: "calm" };
      if (/标准|普通|正常/.test(t)) return { profile: "standard" };
      return null;
    },
    fallbackArgs: function () { return { profile: "reader" }; },
    diff: function (a) {
      const p = deckProfileById(a.profile);
      const now = deckA11yCfg();
      if (!p) return [];
      const rows = [];
      if (String(now.profile || "") !== p.id) {
        rows.push({ label: "显示模式", from: deckProfileName(now.profile) || "还没选过", to: p.label });
      }
      const nowSize = Number(now.size) || 15;
      if (nowSize !== p.cfg.size) rows.push({ label: "正文字号", from: nowSize + "px", to: p.cfg.size + "px" });
      const nowLh = Number(now.lh) || 1.8;
      if (nowLh !== p.cfg.lh) rows.push({ label: "行距", from: nowLh.toFixed(1), to: p.cfg.lh.toFixed(1) });
      if (!!now.contrast !== !!p.cfg.contrast) {
        rows.push({ label: "高对比", from: deckOnOff(now.contrast), to: deckOnOff(p.cfg.contrast) });
      }
      if (!!now.reduceMotion !== !!p.cfg.reduceMotion) {
        rows.push({ label: "减少动效", from: deckOnOff(now.reduceMotion), to: deckOnOff(p.cfg.reduceMotion) });
      }
      if ((LS.get(STORE_KEY.readMode, true) !== false) !== !!p.cfg.readMode) {
        rows.push({ label: "朗读工具条", from: deckOnOff(LS.get(STORE_KEY.readMode, true) !== false), to: deckOnOff(p.cfg.readMode) });
      }
      return rows;
    },
    run: function (a) { applyA11yProfile(a.profile); },
  },
  {
    id: "a11y.font",
    label: "调整正文字号",
    sample: "把字放大一点",
    risk: "write",
    match: function (t) {
      // ⚠️ 口语里是「把字放大一点」，不是「放大字」——别只按书面语写正则
      if (!/(字号|字体|文字|字)(再|调|放|变|大|小|一点|太小)|看不清|放大|缩小|大字/.test(t)) return null;
      const now = Number(deckA11yCfg().size) || 15;
      const num = /(\d{2})\s*(?:px|号)?/.exec(t);
      if (num) return { size: Math.max(13, Math.min(24, Number(num[1]))) };
      if (/(最大|放到最大)/.test(t)) return { size: 24 };
      if (/(小一点|小些|缩小|调小|太大)/.test(t)) return { size: Math.max(13, now - 2) };
      return { size: Math.min(24, now + 2) };
    },
    fallbackArgs: function () {
      const now = Number(deckA11yCfg().size) || 15;
      return { size: Math.min(24, now + 2) };
    },
    diff: function (a) {
      const now = Number(deckA11yCfg().size) || 15;
      if (now === a.size) return [];
      return [{ label: "正文字号", from: now + "px", to: a.size + "px" }];
    },
    run: function (a) { deckPatchA11y({ size: a.size }); },
  },
  {
    id: "a11y.contrast",
    label: "开关高对比",
    sample: "把对比度调高",
    risk: "write",
    match: function (t) {
      if (!/(高对比|对比度|颜色太淡|看不清颜色)/.test(t)) return null;
      const now = !!deckA11yCfg().contrast;
      if (/(关|不要|取消|关掉)/.test(t)) return { on: false };
      if (/(开|高一点|加强|调高)/.test(t)) return { on: true };
      return { on: !now };
    },
    fallbackArgs: function () { return { on: true }; },
    diff: function (a) {
      const now = !!deckA11yCfg().contrast;
      if (now === a.on) return [];
      return [{ label: "高对比", from: deckOnOff(now), to: deckOnOff(a.on) }];
    },
    run: function (a) { deckPatchA11y({ contrast: a.on }); },
  },
  {
    id: "a11y.motion",
    label: "开关减少动效",
    sample: "把动画关掉",
    risk: "write",
    match: function (t) {
      if (!/(动效|动画|闪烁|晃眼)/.test(t)) return null;
      const now = !!deckA11yCfg().reduceMotion;
      if (/(关|不要|取消|停)/.test(t)) return { on: true };   // 「关动画」= 减少动效开
      if (/(开|打开|恢复)/.test(t)) return { on: false };
      return { on: !now };
    },
    fallbackArgs: function () { return { on: true }; },
    diff: function (a) {
      const now = !!deckA11yCfg().reduceMotion;
      if (now === a.on) return [];
      return [{ label: "减少动效", from: deckOnOff(now), to: deckOnOff(a.on) }];
    },
    run: function (a) { deckPatchA11y({ reduceMotion: a.on }); },
  },
  {
    id: "a11y.readmode",
    label: "开关朗读工具条",
    sample: "打开朗读模式",
    risk: "write",
    match: function (t) {
      if (!/(朗读模式|阅读模式|朗读工具条|点段落朗读)/.test(t)) return null;
      const now = LS.get(STORE_KEY.readMode, true) !== false;
      if (/(关|不要|取消|停)/.test(t)) return { on: false };
      if (/(开|打开|启用)/.test(t)) return { on: true };
      return { on: !now };
    },
    fallbackArgs: function () { return { on: true }; },
    diff: function (a) {
      const now = LS.get(STORE_KEY.readMode, true) !== false;
      if (now === a.on) return [];
      return [{ label: "朗读工具条", from: deckOnOff(now), to: deckOnOff(a.on) }];
    },
    run: function (a) { if (typeof setReadMode === "function") setReadMode(a.on); },
  },
  {
    id: "theme.set",
    label: "换一套配色",
    sample: "换成浅色主题",
    risk: "write",
    match: function (t) {
      if (!/(主题|配色|深色|浅色|暗色|亮色|cream|snow)/i.test(t)) return null;
      if (/深色|暗色|暗黑/i.test(t)) return { id: "dark" };
      if (/浅色|亮色|白底|snow/i.test(t)) return { id: "snow" };
      if (/cream|米色|奶油/i.test(t)) return { id: "cream" };
      return null;
    },
    diff: function (a) {
      const now = (typeof Theme !== "undefined" && Theme.current) ? Theme.current() : "";
      if (now === a.id) return [];
      return [{ label: "界面主题", from: deckThemeName(now), to: deckThemeName(a.id) }];
    },
    run: function (a) { Theme.apply(a.id, true); },
  },
  {
    id: "nav.page",
    label: "去某个页面",
    sample: "打开我的作业",
    risk: "nav",
    leave: true,
    match: function (t) { return deckNavMatch(t); },
    run: function (a) {
      if (!a || !a.page) return;
      if (typeof navigate === "function") navigate(a.page);
      else location.href = a.page;
    },
  },
];

/** 按关键词找页面（学生端的实训 / AI 助手是另一份页面） */
function deckNavMatch(t) {
  const low = String(t || "").toLowerCase();
  let role = "";
  try { role = (typeof currentRole === "function") ? currentRole() : ""; } catch (_) {}
  for (let i = 0; i < DECK_PAGES.length; i++) {
    const it = DECK_PAGES[i];
    for (let k = 0; k < it.keys.length; k++) {
      if (low.indexOf(String(it.keys[k]).toLowerCase()) >= 0) {
        return {
          page: (role === "student" && it.studentPage) ? it.studentPage : it.page,
          label: it.label,
        };
      }
    }
  }
  return null;
}

/** 页面注册的指令 + 内置指令（页面优先，避免「开始做作业」被导航抢走） */
function deckAllActions() {
  return Deck.pageActions.concat(DECK_ACTIONS);
}

/* ---------------- 对外开放的注册口 ---------------- */
const Deck = {
  pageActions: [],
  register: function (list) {
    if (!Array.isArray(list)) return;
    list.forEach(function (a) {
      if (!a || !a.id || typeof a.run !== "function") return;
      if (Deck.pageActions.some(function (x) { return x.id === a.id; })) return;
      Deck.pageActions.push(a);
    });
  },
  open: function () { deckOpen(); },
  close: function () { deckClose(true); },
};
try { window.Deck = Deck; } catch (_) { /* 异常环境忽略 */ }

/* ---------------- 小工具 ---------------- */
function deckEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function deckAttr(s) {
  return deckEsc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function deckHostEl() {
  return document.getElementById("deckHost");
}
function deckSay(msg) {
  const n = document.getElementById("deckStatus");
  if (n) n.textContent = String(msg == null ? "" : msg);
}
function deckFocusInput() {
  const n = document.getElementById("deckInput");
  if (!n) return;
  try { n.focus(); } catch (_) {}
}

/* ---------------- 界面 ---------------- */
function deckHTML() {
  return '<div class="deck-host" id="deckHost">' +
    '<div class="deck-scrim" data-deck="close" aria-hidden="true"></div>' +
    '<div class="deck" id="deckPanel" role="dialog" aria-modal="true" ' +
      'aria-labelledby="deckTitle" aria-describedby="deckDesc">' +
      '<div class="deck-head">' +
        '<p class="deck-kicker">AI 指令条 · 长按 Alt</p>' +
        '<h2 id="deckTitle">说一句，我来做</h2>' +
        '<button class="deck-x" type="button" data-deck="close" aria-label="关闭指令条">✕</button>' +
      '</div>' +
      '<p class="deck-desc" id="deckDesc">说「把字放大一点」「去我的作业」「朗读这一页」。会改设置的动作，先把改动列出来给你确认，确认前什么都没变。</p>' +
      '<form class="deck-form" id="deckForm">' +
        '<label class="sr-only" for="deckInput">输入或说出你要做的事</label>' +
        '<input class="deck-input" id="deckInput" type="text" autocomplete="off" ' +
          'placeholder="例如：把字放大一点">' +
        '<button class="deck-mic" type="button" id="deckMic" aria-pressed="false">' +
          '<span class="deck-mic-dot" aria-hidden="true"></span><span id="deckMicText">语音</span>' +
        '</button>' +
        '<button class="btn btn-primary deck-go" type="submit" id="deckGo">执行</button>' +
      '</form>' +
      '<p class="deck-status" id="deckStatus" role="status" aria-live="polite"></p>' +
      '<div class="deck-review" id="deckReview" hidden></div>' +
      '<div class="deck-undo" id="deckUndoBar" hidden>' +
        '<span id="deckUndoText">已应用</span>' +
        '<button class="btn btn-sm" type="button" data-deck="undo" id="deckUndoBtn">撤销这次改动</button>' +
      '</div>' +
      '<div class="deck-help" id="deckHelp"></div>' +
      '<div class="deck-foot">' +
        '<span class="deck-model" id="deckModel">—</span>' +
        '<span class="deck-tip">Esc 关闭 · Tab 只在框内走</span>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function deckOpen() {
  if (!document.body) return;
  if (deckHostEl()) { deckFocusInput(); return; }

  const host = el(deckHTML());
  if (!host) return;

  deckReturnTo = document.activeElement;
  document.body.appendChild(host);
  document.body.classList.add("modal-open");

  deckBind(host);
  deckRenderHelp(false);
  deckRenderModel();
  deckFocusInput();
  deckSay("可以说了。想不起来就输入「你能做什么」。");
  announce("AI 指令条已打开，输入或说出你要做的事。");
}

let deckReturnTo = null;

function deckClose(restore) {
  const host = deckHostEl();
  if (!host) return;
  deckVoiceStop();
  host.remove();
  document.body.classList.remove("modal-open");
  deckCurrent = null;
  document.removeEventListener("keydown", deckOnKey, true);
  const back = deckReturnTo;
  deckReturnTo = null;
  if (restore !== false && back && back.focus) {
    try { back.focus(); } catch (_) {}
  }
}

function deckBind(host) {
  const form = host.querySelector("#deckForm");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const input = host.querySelector("#deckInput");
      deckSubmit(input ? input.value : "");
    });
  }

  host.addEventListener("click", function (e) {
    const b = (e.target && e.target.closest) ? e.target.closest("[data-deck]") : null;
    if (!b || !host.contains(b)) return;
    const act = b.getAttribute("data-deck");
    if (act === "close") { e.preventDefault(); deckClose(true); return; }
    if (act === "apply") { e.preventDefault(); deckApply(); return; }
    if (act === "cancel") { e.preventDefault(); deckCancel(); return; }
    if (act === "undo") { e.preventDefault(); deckDoUndo(); return; }
    if (act === "fill") {
      e.preventDefault();
      const input = host.querySelector("#deckInput");
      if (input) {
        input.value = b.getAttribute("data-text") || "";
        input.focus();
      }
      return;
    }
  });

  const mic = host.querySelector("#deckMic");
  if (mic) mic.addEventListener("click", deckVoiceToggle);

  document.addEventListener("keydown", deckOnKey, true);
}

function deckFocusables(host) {
  const all = host.querySelectorAll("button, input, textarea, select, a[href]");
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    if (n.disabled) continue;
    if (n.getAttribute("tabindex") === "-1") continue;
    if (n.closest("[hidden]")) continue;
    out.push(n);
  }
  return out;
}

function deckOnKey(e) {
  const host = deckHostEl();
  if (!host) return;

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (deckCurrent) deckCancel();
    else deckClose(true);
    return;
  }
  if (e.key !== "Tab") return;

  const list = deckFocusables(host);
  if (list.length < 2) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function deckRenderModel() {
  const n = document.getElementById("deckModel");
  if (n) n.textContent = deckModelText();
}

function deckModelText() {
  try {
    if (typeof llmReady !== "function") return "未接模型 · 只按本地规则匹配";
    if (!llmReady()) return "未接模型 · 只按本地规则匹配（设置 → 模型接入）";
    const c = llmConfig();
    const label = (c && c.cfg && (c.cfg.label || c.cfg.model)) || (c && c.provider) || "";
    return "模型：" + label;
  } catch (_) {
    return "未接模型 · 只按本地规则匹配";
  }
}

/** 示例清单。expanded = 用户主动问「你能做什么」时展开更多条 */
function deckRenderHelp(expanded) {
  const box = document.getElementById("deckHelp");
  if (!box) return;
  const all = deckAllActions().filter(function (a) { return a.sample; });
  const list = expanded ? all : all.slice(0, 4);
  box.hidden = false;
  box.innerHTML =
    '<p class="deck-help-t">' + (expanded ? "现在能做的事" : "试试这些（点一下填进输入框）") + "</p>" +
    '<ul class="deck-samples">' +
      list.map(function (a) {
        return '<li><button class="deck-sample" type="button" data-deck="fill" data-text="' +
          deckAttr(a.sample) + '">' + deckEsc(a.sample) + "</button>" +
          '<span class="deck-sample-lb">' + deckEsc(a.label) +
          (a.risk === "write" ? " · 会先给你看改动" : "") + "</span></li>";
      }).join("") +
    "</ul>";
}

/* ---------------- 解析与执行 ---------------- */
function deckParse(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const list = deckAllActions();
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.match) continue;
    let args = null;
    try { args = a.match(raw); } catch (_) { args = null; }
    if (args) return { action: a, args: args };
  }
  return null;
}

function deckModelReady() {
  try { return (typeof llmReady === "function") && llmReady(); } catch (_) { return false; }
}

function deckSubmit(text) {
  const t = String(text || "").trim();
  if (!t) { deckSay("先说一句你要做什么。"); return; }

  const hit = deckParse(t);
  if (hit) { deckRun(hit.action, hit.args); return; }

  /* 🔴 没接模型就如实说（和答疑页同一条红线）：别先报「正在问模型」——
     根本没问；也别回「没听懂」——那听着像它听懂了但做不到，实际是没人接话。 */
  if (!deckModelReady()) {
    deckRenderHelp(true);
    deckSay("这句本地规则认不出来，而现在没有接入模型，所以只能认下面列的这几句。" +
      "接上模型才能听懂更多说法：设置 → 模型接入。");
    return;
  }

  deckSay("本地规则没匹配到，正在问模型…");
  deckAskModel(t).then(function (r) {
    if (!r) {
      deckSay("模型没给出能执行的动作 —— 换个说法，或点下面一条现成的试试。");
      return;
    }
    if (r.none) { deckSay("模型也没把握该做哪一件，换个说法试试。"); return; }
    deckRun(r.action, r.args);
  });
}

function deckRun(action, args) {
  if (!action) return;
  const a = args || {};

  if (action.risk === "write") {
    let rows = [];
    try { rows = action.diff ? action.diff(a) : []; } catch (_) { rows = []; }
    if (!rows.length) { deckSay("现在已经是这样了，不用改。"); return; }
    deckReview(action, a, rows);
    return;
  }

  if (action.leave) {
    deckClose(false);
    window.setTimeout(function () { action.run(a); }, 60);
    return;
  }

  deckSay(action.label + "…");
  try {
    action.run(a);
  } catch (err) {
    deckSay("这一步没做成：" + ((err && err.message) || "未知错误"));
  }
}

/* ---------------- diff 审核 ---------------- */
let deckCurrent = null;
let deckUndo = null;

function deckReview(action, args, rows) {
  const box = document.getElementById("deckReview");
  if (!box) return;
  deckCurrent = { action: action, args: args, rows: rows };

  const body = rows.map(function (r) {
    return '<tr><th scope="row">' + deckEsc(r.label) + "</th>" +
      '<td class="deck-df">' + deckEsc(r.from) + "</td>" +
      '<td class="deck-dt">' + deckEsc(r.to) + "</td></tr>";
  }).join("");

  box.innerHTML =
    '<h3 id="deckReviewTitle" tabindex="-1">将要改 ' + rows.length + " 项，确认后才会生效</h3>" +
    '<table class="deck-diff">' +
      '<caption class="sr-only">改动前后对照</caption>' +
      '<thead><tr><th scope="col">项目</th><th scope="col">现在</th><th scope="col">将改为</th></tr></thead>' +
      "<tbody>" + body + "</tbody>" +
    "</table>" +
    '<p class="deck-note">只改你自己的显示设置。确认前什么都没动，取消就完全没发生。</p>' +
    '<div class="deck-review-foot">' +
      '<button class="btn btn-primary" type="button" data-deck="apply" id="deckApply">应用变更</button>' +
      '<button class="btn" type="button" data-deck="cancel" id="deckCancel">取消</button>' +
    "</div>";
  box.hidden = false;

  const help = document.getElementById("deckHelp");
  if (help) help.hidden = true;

  deckSay("请核对这三列：项目、现在、将改为。");
  const title = document.getElementById("deckReviewTitle");
  if (title) { try { title.focus(); } catch (_) {} }
}

function deckCloseReview() {
  const box = document.getElementById("deckReview");
  if (box) { box.hidden = true; box.innerHTML = ""; }
  const help = document.getElementById("deckHelp");
  if (help) help.hidden = false;
  deckFocusInput();
}

function deckApply() {
  const cur = deckCurrent;
  if (!cur) return;

  const snap = deckSnapshot();
  let ok = true;
  try {
    cur.action.run(cur.args);
  } catch (err) {
    ok = false;
    deckSay("没做成：" + ((err && err.message) || "未知错误"));
  }
  deckCurrent = null;
  deckCloseReview();
  if (!ok) return;

  deckUndo = snap;
  const txt = cur.rows.map(function (r) { return r.label + " " + r.from + " → " + r.to; }).join("；");
  deckSay("已应用：" + txt + "。反悔可以点「撤销这次改动」。");

  const bar = document.getElementById("deckUndoBar");
  const t = document.getElementById("deckUndoText");
  if (bar) bar.hidden = false;
  if (t) t.textContent = "已应用 " + cur.rows.length + " 项";
}

function deckCancel() {
  if (!deckCurrent) return;
  deckCurrent = null;
  deckCloseReview();
  deckSay("已取消，什么都没改。");
}

function deckSnapshot() {
  let a11y = null, readMode = null, theme = "";
  try { a11y = window.localStorage.getItem(STORE_KEY.a11y); } catch (_) {}
  try { readMode = window.localStorage.getItem(STORE_KEY.readMode); } catch (_) {}
  try { theme = (typeof Theme !== "undefined" && Theme.current) ? Theme.current() : ""; } catch (_) {}
  return { a11y: a11y, readMode: readMode, theme: theme };
}

/** 撤销：把三份存档恢复成应用前的原样，再整体重画一次 */
function deckRestore(snap) {
  if (!snap) return false;
  try {
    if (snap.a11y === null) window.localStorage.removeItem(STORE_KEY.a11y);
    else window.localStorage.setItem(STORE_KEY.a11y, snap.a11y);
    if (snap.readMode === null) window.localStorage.removeItem(STORE_KEY.readMode);
    else window.localStorage.setItem(STORE_KEY.readMode, snap.readMode);
  } catch (_) { return false; }

  applyA11yVars();
  syncA11yProfileAttr();
  const rm = LS.get(STORE_KEY.readMode, true);
  if (typeof applyReadMode === "function") applyReadMode(rm !== false);
  if (snap.theme && typeof Theme !== "undefined") Theme.apply(snap.theme, true);
  return true;
}

function deckDoUndo() {
  if (!deckUndo) { deckSay("没有可撤销的改动。"); return; }
  const ok = deckRestore(deckUndo);
  deckUndo = null;
  const bar = document.getElementById("deckUndoBar");
  if (bar) bar.hidden = true;
  deckSay(ok ? "已撤销，回到应用之前的样子。" : "撤销失败：当前环境不允许保存设置。");
}

/* ---------------- 朗读整页 ---------------- */
function deckReadPage() {
  const src = (typeof readerSource === "function") ? readerSource() : document.body;
  const raw = src ? (src.innerText || src.textContent || "") : "";
  const text = String(raw).replace(/\s+/g, " ").trim();
  if (!text) { deckSay("这一页没有可朗读的文字。"); return; }
  if (typeof readerSpeak !== "function" || !readerSpeak(text.slice(0, 3000))) {
    deckSay("这个浏览器不支持语音朗读，可以先用读屏软件读这一页。");
    return;
  }
  deckSay("正在朗读这一页。想停就用右下角的「停止」。");
}

/* ---------------- 语音输入（浏览器自带，不接第三方） ---------------- */
let deckVoice = null;
let deckVoiceOn = false;

function deckVoiceCtor() {
  try {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  } catch (_) { return null; }
}

function deckVoiceLabel(on) {
  const t = document.getElementById("deckMicText");
  const b = document.getElementById("deckMic");
  if (t) t.textContent = on ? "在听…" : "语音";
  if (b) b.setAttribute("aria-pressed", String(!!on));
}

function deckVoiceStop() {
  if (deckVoice) {
    try { deckVoice.onresult = null; deckVoice.onerror = null; deckVoice.onend = null; deckVoice.stop(); } catch (_) {}
  }
  deckVoice = null;
  deckVoiceOn = false;
  deckVoiceLabel(false);
}

function deckVoiceToggle() {
  if (deckVoiceOn) { deckVoiceStop(); deckSay("停止收音。"); return; }

  const Ctor = deckVoiceCtor();
  if (!Ctor) {
    deckSay("这个浏览器没有语音识别（Chrome / Edge 支持）。直接打字效果一样。");
    return;
  }
  if (location.protocol === "file:") {
    deckSay("语音输入需要 http(s) 地址，直接双击打开的页面用不了。先打字，或从本地服务打开。");
    return;
  }

  let rec = null;
  try { rec = new Ctor(); } catch (_) {
    deckSay("语音识别启动不了，直接打字吧。");
    return;
  }
  rec.lang = "zh-CN";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  let finalText = "";
  rec.onresult = function (ev) {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    const input = document.getElementById("deckInput");
    if (input) input.value = (finalText + interim).trim();
    if (finalText && ev.results[ev.results.length - 1].isFinal) {
      deckVoiceStop();
      deckSay("听到了，正在执行。");
      deckSubmit(finalText);
    }
  };
  rec.onerror = function (ev) {
    const code = (ev && ev.error) || "";
    const map = {
      "not-allowed": "麦克风被拒绝了：点地址栏右边的麦克风图标，允许这个站点使用麦克风。",
      "service-not-allowed": "浏览器不让用语音识别服务，只能打字。",
      "audio-capture": "没找到麦克风，检查一下设备。",
      "network": "语音识别服务连不上（浏览器的语音识别要联网）。可以直接打字。",
      "no-speech": "没听到声音，再说一次或直接打字。",
      "aborted": "已停止收音。",
    };
    deckSay(map[code] || ("语音识别出错（" + (code || "未知") + "），直接打字吧。"));
    deckVoiceStop();
  };
  rec.onend = function () {
    deckVoiceOn = false;
    deckVoiceLabel(false);
    deckVoice = null;
  };

  try { rec.start(); } catch (_) {
    deckSay("语音识别启动不了，直接打字吧。");
    return;
  }
  deckVoice = rec;
  deckVoiceOn = true;
  deckVoiceLabel(true);
  deckSay("在听，请说一句。说完会自动执行；点按钮或按 Esc 可停。");
}

/* ---------------- 没命中本地规则时问模型：只让它挑 id ---------------- */
function deckJson(raw) {
  let s = String(raw == null ? "" : raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

function deckAskModel(text) {
  return new Promise(function (resolve) {
    let ready = false;
    try { ready = (typeof llmReady === "function") && llmReady(); } catch (_) {}
    if (!ready || typeof llmChat !== "function") { resolve(null); return; }

    const catalog = deckAllActions().map(function (a) {
      return a.id + " = " + a.label + "（例：" + a.sample + "）";
    }).join("\n");

    const sys = "你是应用内的指令解析器。只能从给定的动作里挑一个，" +
      "输出一行 JSON：{\"id\":\"动作 id\",\"say\":\"一句 20 字内的确认\"}。" +
      "没有合适的或不确定，输出 {\"id\":\"none\"}。" +
      "不要输出解释、不要代码块、不要编造动作 id。";

    llmChat(sys, "可选动作：\n" + catalog + "\n\n用户说：" + text, { maxTokens: 160, temperature: 0 })
      .then(function (r) {
        if (!r || !r.ok) { resolve(null); return; }
        const j = deckJson(r.raw);
        resolve(deckFromModel(j, text));
      })
      .catch(function () { resolve(null); });
  });
}

function deckFromModel(obj, text) {
  if (!obj || !obj.id) return null;
  if (String(obj.id) === "none") return { none: true };

  const list = deckAllActions();
  let hit = null;
  for (let i = 0; i < list.length; i++) if (list[i].id === String(obj.id)) hit = list[i];
  if (!hit) return null;                       // 未知 id 一律拒

  // 参数不信模型：导航看本地关键词，其余用本地解析或动作自带的保守默认值
  let args = null;
  if (hit.id === "nav.page") {
    args = deckNavMatch(text);
  } else if (hit.match) {
    try { args = hit.match(text); } catch (_) { args = null; }
    if (!args && hit.fallbackArgs) args = hit.fallbackArgs();
  } else if (hit.fallbackArgs) {
    args = hit.fallbackArgs();
  }
  if (!args) return null;
  return { action: hit, args: args };
}

/* ---------------- 长按 Alt ---------------- */
let deckAltTimer = null;

function deckAltAllowed() {
  try { return deckA11yCfg().deckAlt !== false; } catch (_) { return true; }
}

function deckAltStart() {
  if (!deckAltAllowed()) return;
  if (deckHostEl()) return;
  if (deckAltTimer) return;
  deckAltTimer = window.setTimeout(function () {
    deckAltTimer = null;
    deckOpen();
  }, DECK_HOLD_MS);
}

function deckAltCancel() {
  if (deckAltTimer) {
    window.clearTimeout(deckAltTimer);
    deckAltTimer = null;
  }
}

function deckAltKeyDown(e) {
  // ⚠️ 右 Alt 在部分键盘布局下报的是 "AltGraph"，只认 "Alt" 会导致「右 Alt 按了没反应」
  if (e.key !== "Alt" && e.key !== "AltGraph") {
    // Alt + 别的键 = 组合键，别把长按判定留下来
    deckAltCancel();
    return;
  }
  if (!e.repeat) deckAltStart();
  if (deckAltTimer) e.preventDefault();        // 别让浏览器把单独的 Alt 当菜单键
}

function deckAltKeyUp(e) {
  if (e.key === "Alt" || e.key === "AltGraph") deckAltCancel();
}

document.addEventListener("keydown", deckAltKeyDown, true);
document.addEventListener("keyup", deckAltKeyUp, true);
try { window.addEventListener("blur", deckAltCancel); } catch (_) { /* 忽略 */ }
