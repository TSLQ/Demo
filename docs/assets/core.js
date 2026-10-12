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
  accounts: "st_accounts",          // 本地账号库
  readMode: "st_a11y_read_mode",    // 无障碍阅读模式开关
  agentTask: "st_agent_task",       // 交给 AI 助手的任务（含原文），见 schedule.html 方式三
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
        flash("开始朗读 —— 想停就说一声，或点「停止」", "");
      } else {
        flash("这个浏览器不支持语音朗读，换个浏览器再试", "bad");
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
/** 把 a11y 设置写进「根元素」（壳内写壳的，独立写自己的） */
function applyA11yVars(cfg) {
  const root = rootEl();
  const c = cfg || LS.get(STORE_KEY.a11y, null) || {};
  const size = c.size ?? 15;
  const lh   = c.lh   ?? 1.8;
  const ls   = c.ls   ?? 0;

  root.style.setProperty("--a11y-font-size", size + "px");
  root.style.setProperty("--a11y-line-height", String(lh));
  root.style.setProperty("--a11y-letter-spacing", ls + "em");

  root.toggleAttribute("data-contrast", !!c.contrast);
  root.toggleAttribute("data-reduce-motion", !!c.reduceMotion);

  if (inShell()) {
    notifyShell("st-a11y-changed", {
      vars: {
        "--a11y-font-size": size + "px",
        "--a11y-line-height": String(lh),
        "--a11y-letter-spacing": ls + "em",
      },
      contrast: !!c.contrast,
      reduceMotion: !!c.reduceMotion,
    });
  }
}

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
      <div class="side-foot-note">全部数据保存在本机浏览器</div>
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

  document.body.prepend(side);
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
          <span>班级只保存在本机浏览器。保存后可在左侧栏「班级管理」里点击切换。</span>
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
  document.querySelectorAll(".standalone-top, .standalone-side").forEach((n) => n.remove());
  const holder = document.querySelector(".standalone-content");
  if (holder) {
    const wrap = holder.querySelector(".page-wrap");
    if (wrap && holder.parentNode) holder.parentNode.insertBefore(wrap, holder);
    holder.remove();
  }
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
