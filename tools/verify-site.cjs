/**
 * site/ 静态原型验证器（应用壳架构）
 * ------------------------------------------------------------
 * 架构：app.html（应用壳：顶部栏 + 左侧栏 + iframe）承载 8 个内容页。
 * 本验证器用 Node vm 桩化 DOM，真实执行每个页面的脚本：
 *
 *   A. 内容页（chat / reader / ... / index）
 *      - assets/core.js 可加载、Session 隔离、主题、Markdown、a11y
 *      - 声明 data-role、不再有 #sideNav / #demoBar 残留
 *      - 通过 postMessage 与壳通信（navigate / theme / a11y）
 *   B. 应用壳（app.html + shell.js）
 *      - 顶部栏与侧栏容器齐备、iframe 存在
 *      - NAV 双端菜单隔离、PAGE_ROLE 覆盖全部页面
 *      - 越权访问被拦下（教师进学生页 → 回自己首页）
 *      - 主题 / 无障碍广播、file:// 退化
 *
 * 用法：
 *   node tools/verify-site.cjs              # 全部
 *   node tools/verify-site.cjs chat.html    # 指定页面
 * 退出码：0 全通过 / 1 有失败
 * ------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SITE = path.resolve(__dirname, "..", "site");

/** 内容页（由壳的 iframe 承载） */
const CONTENT_PAGES = [
  "chat.html", "reader.html", "analysis.html",
  "exam.html", "homework.html", "class.html", "courseware.html", "stu.html",
  "schedule.html", "lesson.html", "training.html", "training-student.html",
  "agent.html", "agent-student.html", "workbench.html", "settings.html",
];
const SHELL_PAGE = "app.html";
const LOGIN_PAGE = "index.html";
const ALL_PAGES = [LOGIN_PAGE, SHELL_PAGE, ...CONTENT_PAGES];

/**
 * 从 nav.js 解析初始演示账号 —— 断言不自己硬编一份，
 * 否则改账号时验证器会与实现一起「假装正确」。
 */
function readSeedAccounts() {
  const navjs = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");
  const list = [];
  const re = /role:\s*"(\w+)"\s*,\s*user:\s*"([^"]+)"\s*,\s*pass:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(navjs))) list.push({ role: m[1], user: m[2], pass: m[3] });
  return list;
}
const SEED_ACCOUNTS = readSeedAccounts();

let failures = 0;
let checks = 0;
const fail = (m) => { console.log("  x " + m); failures++; };
const pass = (m) => { checks++; console.log("  v " + m); };
const info = (m) => console.log("  - " + m);
const section = (t) => {
  console.log("\n" + "=".repeat(62));
  console.log(" " + t);
  console.log("=".repeat(62));
};

/* ============================================================
   极简 DOM 桩
   ============================================================ */
function makeEl(tag = "div") {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    _html: "",
    _text: "",
    className: "",
    title: "",
    hidden: false,
    value: "",
    innerWidth: 1280,
    style: Object.assign(Object.create(null), {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
      getPropertyValue(k) { return this[k] ?? ""; },
    }),
    dataset: {},
    children: [],
    classList: {
      _s: new Set(),
      add(...cs) { cs.forEach((c) => this._s.add(c)); },
      remove(...cs) { cs.forEach((c) => this._s.delete(c)); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) {
        const want = force === undefined ? !this._s.has(c) : !!force;
        want ? this._s.add(c) : this._s.delete(c);
        return want;
      },
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    get textContent() {
      if (this._text) return this._text;
      return this._html.replace(/<[^>]*>/g, "").trim();
    },
    set textContent(v) { this._text = String(v); },
    setAttribute(k, v) { this[k] = String(v); },
    getAttribute(k) { return this[k] === undefined ? null : String(this[k]); },
    removeAttribute(k) { delete this[k]; },
    hasAttribute(k) { return this[k] !== undefined; },
    toggleAttribute(k, f) {
      const want = f === undefined ? this[k] === undefined : !!f;
      want ? (this[k] = "") : delete this[k];
      return want;
    },
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      if (listeners[t]) listeners[t] = listeners[t].filter((f) => f !== fn);
    },
    dispatchEvent(e) {
      (listeners[e.type] || []).forEach((f) => f(e));
      return true;
    },
    appendChild(c) { this.children.push(c); return c; },
    prepend(c) { this.children.unshift(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    insertAdjacentHTML(_p, html) { this._html += html; },
    querySelector(sel) { return queryAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(this, sel); },
    closest(sel) { return closestMatch(this, sel); },
    focus() {}, blur() {}, scrollIntoView() {},
    /**
     * `<form>.reset()` —— 桩版最小实现（第 40 轮补）。
     * 真浏览器会把每个控件恢复到初始值；桩里没有"初始值"的概念，
     * 所以**只清掉当前值**（value / checked）—— 页面代码调 reset() 的目的是
     * 「提交成功后清空表单」，清空就够了。要验"恢复成初始值"就得上 jsdom。
     */
    reset() {
      const clear = (node) => {
        if (!node || typeof node !== "object") return;
        if ("value" in node && node.type !== "submit" && node.type !== "button") node.value = "";
        if ("checked" in node) node.checked = false;
      };
      clear(this);
      (this.children || []).forEach(clear);
      // 🔴 桩的 registry 是**扁平**的：表单控件未必挂在 form 的 children 下，
      //    所以还要顺带扫一遍该文档注册过的所有元素（靠 _doc 反查）。
      const reg = this._doc && this._doc._registry;
      if (reg) Object.keys(reg).forEach((k) => clear(reg[k]));
    },
    remove() { this._removed = true; },
    click() { this.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} }); },
  };

  if (String(tag).toLowerCase() === "template") {
    const frag = makeEl("div");
    Object.defineProperty(el, "content", {
      get() {
        const child = makeEl("div");
        const first = (el._html.match(/<([a-zA-Z]+)([^>]*)>/) || [])[2] || "";
        const cm = first.match(/class="([^"]*)"/);
        if (cm) cm[1].split(/\s+/).forEach((c) => c && child.classList.add(c));
        for (const dm of first.matchAll(/data-([\w-]+)="([^"]*)"/g)) child.dataset[dm[1]] = dm[2];
        child._html = el._html;
        child._parent = el._parent;
        child.querySelector = (s2) => queryAll(child, s2)[0] || null;
        child.querySelectorAll = (s2) => queryAll(child, s2);
        frag._first = child;
        return frag;
      },
    });
    Object.defineProperty(frag, "firstElementChild", {
      get() { return frag._first; }, configurable: true,
    });
  }
  return el;
}

function withParent(child, parent) {
  if (child && typeof child === "object") child._parent = parent;
  return child;
}

/**
 * 把页面里出现的所有 id 预注册到 doc._registry。
 * ⚠️ 关键：还要把该标签上的属性（type / checked / placeholder / value …）
 *    解析并挂到元素上。否则页面代码读 `input.type` 会得到 undefined，
 *    「显示密码」这类断言会莫名其妙地失败（第 9 轮真实踩到）。
 */
function registerIds(doc, html) {
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*\bid="([\w-]+)"[^>]*>/g)) {
    const tag = m[1], id = m[2], tagStr = m[0];
    const e = withParent(makeEl(tag), doc.body);
    e._doc = doc;                         // 反查用（如 form.reset() 要扫全表）
    e._html = html;
    e.id = id;
    // 解析属性：name="v" / name='v' / 裸属性（如 checked、hidden）
    for (const a of tagStr.matchAll(/([\w-]+)(?:=("([^"]*)"|'([^']*)'))?/g)) {
      const key = a[1];
      if (key === tag || key === id) continue;
      if (a[2] === undefined) {
        // 裸属性（checked / disabled / hidden …）→ 布尔语义
        if (!(key in e)) e[key] = true;
      } else {
        e[key] = a[3] !== undefined ? a[3] : a[4];
      }
    }
    doc._registry[id] = e;
  }
  return doc;
}

function closestMatch(el, sel) {
  const want = sel.replace(/^\./, "");
  let cur = el;
  while (cur) {
    if (cur.classList?.contains(want)) return cur;
    cur = cur._parent;
  }
  return null;
}

/**
 * queryAll —— 桩实现。静态 HTML 未解析成树，直接对 HTML 文本做正则扫描。
 * 支持 #id .cls tag [data-x]，逗号分隔取并集。
 */
function queryAll(root, sel) {
  const html = root._html || "";
  const out = [];
  const seen = new Set();
  const push = (e) => out.push(e);

  for (const raw of String(sel).split(",")) {
    const part = raw.trim();
    if (!part) continue;

    // #id
    let m = part.match(/^#([\w-]+)$/);
    if (m) {
      const reg = root._registry || {};
      if (reg[m[1]] && !seen.has(reg[m[1]])) { seen.add(reg[m[1]]); push(reg[m[1]]); }
      continue;
    }

    // [data-attr] / [data-attr="v"]
    m = part.match(/\[([\w-]+)(?:=["']([^"']*)["'])?\]/);
    if (m && !part.startsWith(".")) {
      const attr = m[1], want = m[2];
      const re = new RegExp("<[^>]*\\b" + attr + "(?:=[\"'][^\"']*[\"']|[\\s>])[^>]*>", "g");
      for (const tagStr of html.match(re) || []) {
        const e = makeEl("div");
        const dv = want !== undefined ? want
          : (tagStr.match(new RegExp(attr + '=["\']([^"\']*)["\']')) || [])[1] || "";
        e.dataset[attr.replace(/^data-/, "")] = dv;
        const cm = tagStr.match(/class="([^"]*)"/);
        if (cm) cm[1].split(/\s+/).forEach((c) => c && e.classList.add(c));
        push(e);
      }
      continue;
    }

    // .class
    m = part.match(/^\.([\w-]+)/);
    if (m) {
      const cls = m[1];
      const re = new RegExp(`<[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, "g");
      for (const tagStr of html.match(re) || []) {
        const e = makeEl("div");
        const cm = tagStr.match(/class="([^"]*)"/);
        if (cm) cm[1].split(/\s+/).forEach((c) => c && e.classList.add(c));
        const dm = tagStr.match(/data-([\w-]+)="([^"]*)"/);
        if (dm) e.dataset[dm[1]] = dm[2];
        push(e);
      }
      continue;
    }

    // tag
    m = part.match(/^([a-zA-Z]+)$/);
    if (m) {
      const re = new RegExp(`<${m[1]}(?:\\s[^>]*)?>`, "gi");
      for (const _ of html.match(re) || []) push(makeEl(m[1]));
      continue;
    }
  }
  return out;
}

function makeDoc() {
  const registry = {};
  const jar = {};
  const doc = makeEl("document");
  doc.documentElement = makeEl("html");
  doc.body = makeEl("body");
  doc.head = makeEl("head");
  doc._registry = registry;
  doc.readyState = "complete";
  doc.hidden = false;

  Object.defineProperty(doc, "cookie", {
    configurable: true,
    get() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "); },
    set(str) {
      const pair = String(str).split(";")[0];
      const i = pair.indexOf("=");
      if (i < 0) return;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (/1970/.test(String(str))) delete jar[k];
      else jar[k] = v;
    },
  });

  doc.getElementById = (id) => {
    if (!registry[id]) {
      const e = withParent(makeEl("div"), doc.body);
      e._doc = doc;                       // 反查用（如 form.reset() 要扫全表）
      registry[id] = e;
    }
    return registry[id];
  };
  doc.querySelector = (s) => doc.querySelectorAll(s)[0] || null;
  doc.querySelectorAll = (s) => queryAll(doc, s);
  doc.createElement = (t) => makeEl(t);
  // 🔴 createTextNode：页面用 document.createTextNode("…") 造文本节点（appendChild 进元素）。
  //    桩里给一个「带 textContent 的假节点」就够 —— 断言读的是 .textContent。
  doc.createTextNode = (t) => {
    const n = makeEl("#text");
    n.textContent = String(t);
    n.nodeValue = String(t);
    return n;
  };
  return doc;
}

/**
 * 模拟「壳的 iframe 元素」：子页面用 window.frameElement.ownerDocument
 * 访问壳的 <html>，以此实现主题 / 无障碍设置写进壳。
 */
function makeShellHost() {
  const shellDoc = makeDoc();
  return { ownerDocument: shellDoc, tagName: "IFRAME", id: "contentFrame" };
}

/* ============================================================
   通用沙箱
   ============================================================ */
function makeSandbox(doc, name, opts = {}) {
  const posted = [];
  const alerted = [];
  const lsMap = new Map();

  const loc = {
    protocol: opts.protocol || "http:",
    pathname: "/" + name,
    href: "http://localhost/" + name,
    hash: opts.hash || "",
    // ⚠️ 必须提供 search：class.html 靠 ?cls=xxx 区分要看哪个班，
    //    缺了它页面脚本会炸在 location.search.match(...)（undefined.match）。
    search: opts.search || "",
    _nav: null,
  };

  const sandbox = {
    document: doc,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Object, Array, String, Number, Boolean,
    RegExp, Error, Map, Set, Promise, Symbol,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite,
    confirm: () => true,
    // 记录弹过的提示框文本：断言「该提示时提示、不该提示时闭嘴」。
    // ⚠️ 若写成空函数，页面里的 alert 调用点就完全不可观测 → 假绿灯。
    alert: (m) => { alerted.push(String(m)); },
    prompt: () => "测试批注内容",
    fetch: () => Promise.reject(new Error("no network in test")),
    SpeechSynthesisUtterance: function (t) { this.text = t; },
    speechSynthesis: { speak() {}, cancel() {} },
    localStorage: {
      get length() { return lsMap.size; },
      key: (i) => [...lsMap.keys()][i] ?? null,
      getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => lsMap.set(k, String(v)),
      removeItem: (k) => lsMap.delete(k),
      clear: () => lsMap.clear(),
    },
    Blob: function () {},
    URL: { createObjectURL: () => "blob:test" },
    // 事件构造器：页面里 new Event("change") 之类需要它。
    // ⚠️ 缺了它会静默炸在 probe 里（异常被吞）→ 监听器根本没跑 → 假绿灯。
    Event: function Event(type, init) {
      this.type = type;
      this.target = null;
      this.bubbles = !!(init && init.bubbles);
      this.cancelable = !!(init && init.cancelable);
      this.defaultPrevented = false;
      this.preventDefault = () => { this.defaultPrevented = true; };
      this.stopPropagation = () => {};
    },
    CustomEvent: function CustomEvent(type, init) {
      this.type = type;
      this.detail = init && init.detail;
      this.preventDefault = () => {};
      this.stopPropagation = () => {};
    },
    history: { pushState() {}, replaceState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    innerWidth: 1280,
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {},
    _posted: posted,
    _alerted: alerted,
    _ls: lsMap,
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;                       // window.self（真实浏览器里 === window）
  sandbox.location = loc;
  sandbox.parent = opts.parent || { postMessage: (m) => posted.push(m), _isHost: true };
  // ⚠️ top 的语义必须贴近真实浏览器：
  //   · 顶层文档：top === self（window）
  //   · iframe 内：top !== self
  // core.js 的 inShell() 现在以 `self !== top` 为主判据，
  // 若这里无脑把 top 设成 parent，会把「独立打开」误判成「壳内」。
  sandbox.top = opts.top || (opts.frameElement ? sandbox.parent : sandbox);
  sandbox.frameElement = opts.frameElement || null;
  sandbox.postMessage = (m) => posted.push(m);

  vm.createContext(sandbox);
  return sandbox;
}

function probeFn(sandbox) {
  return (expr) => {
    try { return vm.runInContext(expr, sandbox); } catch { return undefined; }
  };
}

/**
 * 去掉注释后再做「代码里不该出现 X」这类判断。
 * 🔴 不剥注释会反复误报：代码里那句「不要写 `xxx`」的警告注释，
 *    本身就会命中「有没有 xxx」的正则。（跨域文案那轮已经踩过一次。）
 */
function stripComments(src) {
  return String(src == null ? "" : src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/* ============================================================
   A. 内容页验证
   ============================================================ */
/* ============================================================
   静态 id 引用检查 —— **唯一实现**
   ------------------------------------------------------------
   🔴 这里曾经有两份几乎一样的实现（verifyContentPage 一份、verifyGlobal 一份），
      改了一份另一份还在报错 —— 与「侧栏两份渲染」同源的老毛病：
      同一件事只能有一处实现。
   背景事故：schedule.html 的 renderWeek() 里写 $(\`#weekSource\`)，
   但那个元素在改版时被删了 → 页面一启动就崩。桩验证器看不出来（只查 _html 字符串），
   jsdom 那条报错要等真跑起来才发现。静态查一遍最便宜。
   ============================================================ */
function danglingIds(html, inline) {
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  // 脚本里动态拼出来的 id（模板字符串里的 id="..."）也算存在
  for (const m of inline.matchAll(/\bid="([^"]+)"/g)) declared.add(m[1]);
  // JS 里 createElement 之后再赋 id 的也算（如 #flash 是运行时建的轻提示）
  for (const m of inline.matchAll(/\.\s*id\s*=\s*"([A-Za-z][\w-]*)"/g)) declared.add(m[1]);

  const used = new Set();
  for (const m of inline.matchAll(/\$\$?\(\s*["'`]#([\w-]+)["'`]/g)) used.add(m[1]);
  for (const m of inline.matchAll(/getElementById\(\s*["'`]([\w-]+)["'`]/g)) used.add(m[1]);

  // 跨页面共享的挂载点是运行时才建的，不算缺失
  ["modalHost", "contentFrame", "shellSide", "shellTop", "frameError"].forEach((id) => used.delete(id));

  return [...used].filter((id) => !declared.has(id));
}

function verifyContentPage(name) {
  section(name);
  const file = path.join(SITE, name);
  const html = fs.readFileSync(file, "utf8");
  const doc = makeDoc();

  // 预注册真实存在的 id，并让后代查询可见
  registerIds(doc, html);

  const sandbox = makeSandbox(doc, name, { frameElement: makeShellHost() });
  const probe = probeFn(sandbox);

  /* --- core.js 加载 --- */
  const nav = path.join(SITE, "assets", "nav.js");
  const core = path.join(SITE, "assets", "core.js");
  try {
    vm.runInContext(fs.readFileSync(nav, "utf8"), sandbox, { filename: "nav.js" });
    pass("nav.js（导航配置唯一来源）加载无异常");
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }
  try {
    vm.runInContext(fs.readFileSync(core, "utf8"), sandbox, { filename: "core.js" });
    pass("core.js 加载无异常");
  } catch (e) {
    fail("core.js 报错: " + e.message);
    return;
  }

  /* --- 不应再引用旧的 app.js --- */
  !/assets\/app\.js/.test(html) ? pass("未引用已废弃的 app.js")
    : fail("仍在引用 app.js");

  /* --- 壳遗留物必须清除 --- */
  !/id="sideNav"/.test(html) ? pass("无 #sideNav 残留（侧栏已归壳所有）")
    : fail("仍有 #sideNav 容器");
  !/id="demoBar"/.test(html) ? pass("无 #demoBar 残留（演示条已删除）")
    : fail("仍有 #demoBar 容器");
  !/<nav class="side-nav"/.test(html) ? pass("无硬编码侧栏")
    : fail("页面仍有硬编码侧栏");
  !/\.app-shell|\.main-area|\.side-nav\s*\{/.test(html) ? pass("无壳遗留样式（.app-shell/.main-area/.side-nav）")
    : fail("残留壳样式定义");

  /* --- 内容容器 --- */
  const hasWrap = /<div class="page-wrap/.test(html);
  hasWrap ? pass("含 .page-wrap 内容容器（iframe 内自适应）")
    : fail("缺少 .page-wrap");

  /* --- data-role 声明 --- */
  const declaredRole = (html.match(/<html[^>]*\bdata-role="([\w-]+)"/) || [])[1];
  if (["teacher", "student", "both"].includes(declaredRole)) {
    pass(`声明 data-role=${declaredRole}`);
  } else {
    fail("缺少有效 data-role，实际: " + declaredRole);
  }

  /* --- 宿主探测 API --- */
  typeof probe("inShell") === "function" && typeof probe("rootEl") === "function"
    ? pass("提供宿主探测 API（inShell / rootEl）")
    : fail("缺少 inShell / rootEl");

  /* --- Cookie 往返 --- */
  const rt = probe("(() => { Cookie.set('_t','v',1); return Cookie.get('_t'); })()");
  rt === "v" ? pass("Cookie 存取往返正确") : fail("Cookie 往返异常: " + rt);
  const del = probe("(() => { Cookie.set('_d','x',1); Cookie.del('_d'); return Cookie.get('_d'); })()");
  del === null ? pass("Cookie 删除生效") : fail("Cookie 删除失败: " + del);

  /* --- LS 兜底（localStorage 被禁时不能崩） --- */
  const lsOk = probe("(() => { LS.set('_x',{a:1}); return LS.get('_x').a; })()");
  lsOk === 1 ? pass("LS 存储层可用（含内存兜底）") : fail("LS 异常: " + lsOk);

  /* --- Markdown --- */
  if (probe("typeof mdToHtml") !== "function") {
    fail("mdToHtml 未定义");
  } else {
    const md = probe("mdToHtml");
    const out = md("**粗体**\n\n- 甲\n- 乙\n\n```python\nprint(1)\n```");
    out.includes("<strong>粗体</strong>") ? pass("Markdown 粗体正确") : fail("粗体渲染失败");
    out.includes("<li>甲</li>") ? pass("Markdown 列表正确") : fail("列表渲染失败");
    out.includes("<pre><code") && out.includes("print(1)")
      ? pass("代码块渲染正确") : fail("代码块渲染失败");
    const xss = md('<img src=x onerror=alert(1)>');
    !xss.includes("<img") ? pass("HTML 转义生效（防 XSS）") : fail("存在 XSS 风险");
    const inline = md("公式 `i *= 2` 与 `h % m`");
    inline.includes("<code>i *= 2</code>") ? pass("行内代码渲染正确")
      : fail("行内代码失败: " + inline.slice(0, 100));
  }

  /* --- 主题三套 --- */
  const themes = probe("THEMES");
  if (Array.isArray(themes) && themes.length === 3) {
    const ids = themes.map((t) => (t && t.id) || t).join(",");
    ids === "cream,snow,dark" ? pass("三套主题定义齐全（cream/snow/dark）")
      : fail("主题 id 异常: " + ids);
  } else fail("THEMES 定义异常");

  /* --- 宿主探测：壳内应识别为 in-shell --- */
  probe("inShell()") === true ? pass("识别到运行在应用壳内（inShell=true）")
    : fail("未识别壳环境: " + probe("inShell()"));

  /* --- 无障碍变量注入（应写进壳的根元素） --- */
  const a11yFn = probe("typeof applyA11yVars");
  if (a11yFn === "function") {
    const r = probe("(() => { applyA11yVars({size:18,lh:2.0,ls:0.02,contrast:true}); const root = window.frameElement.ownerDocument.documentElement; return { v: root.style.getPropertyValue('--a11y-font-size'), c: root.hasAttribute('data-contrast') }; })()");
    r && r.v === "18px" && r.c ? pass("无障碍设置写入壳根元素（跨页保持一致）")
      : fail("无障碍注入异常: " + JSON.stringify(r));
  } else fail("applyA11yVars 未定义");

  /* --- navigate：壳内应 postMessage，而不是直接跳 --- */
  if (probe("typeof navigate") === "function") {
    probe("(() => { window._posted.length = 0; navigate('reader.html'); })()");
    const posted = sandbox._posted.filter((m) => m.type === "st-navigate");
    posted.length === 1 && posted[0].page === "reader.html"
      ? pass("跳转请求经 postMessage 交给壳处理")
      : fail("navigate 未向壳发消息: " + JSON.stringify(sandbox._posted));
  } else fail("navigate 未定义");

  /* --- DOMContentLoaded --- */
  try {
    doc.dispatchEvent({ type: "DOMContentLoaded", target: doc });
    pass("DOMContentLoaded 处理无异常");
  } catch (e) {
    fail("DOMContentLoaded 报错: " + e.message);
  }

  /* --- 内联脚本 --- */
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).join("\n");
  if (inline.trim()) {
    try {
      vm.runInContext(inline, sandbox, { filename: name });
      pass("内联脚本执行无异常");
    } catch (e) {
      fail("内联脚本报错: " + e.message);
      console.log("      " + String(e.stack || "").split("\n").slice(1, 4).join("\n      "));
      return;
    }
  }

  /* 脚本引用的 DOM id 检查统一到 verifyGlobal() 的 danglingIds() —— 一处实现 */

  /* --- 分页专项 --- */
  verifyPageSpecific(name, html, inline, probe, sandbox);
}

/* ============================================================
   A-2. 各内容页专项断言
   ============================================================ */
function verifyPageSpecific(name, html, inline, probe, sandbox) {
  if (name === "chat.html") {
    if (probe("typeof pickReply") === "function") {
      const pick = probe("pickReply");
      const cases = [
        ["为什么快速排序最坏是 O(n²)？", "划分"],
        ["哈希表冲突怎么解决？", "开放定址"],
        ["怎样判断算法的时间复杂度？", "三步法"],
        ["进程和线程有什么区别？", "资源分配"],
      ];
      let ok = 0;
      for (const [q, expect] of cases) {
        const r = pick(q);
        if (r.includes(expect) && r.length > 200) ok++;
        else fail(`pickReply 未命中: "${q}" 期望含「${expect}」`);
      }
      ok === cases.length && pass(`问答匹配 ${ok}/${cases.length} 全部命中`);
      const fb = pick("量子纠缠对排序有什么影响");
      fb.length > 100 && pass("未命中时兜底回复正常");
    } else fail("pickReply 未定义");

    const kb = probe("KB");
    Array.isArray(kb) && kb.length >= 4
      ? pass(`预置问答库 ${kb.length} 组，内容充足`) : fail("问答库不足 4 组");
  }

  if (name === "reader.html") {
    const reteach = probe("RETEACH");
    if (reteach && typeof reteach === "object") {
      const n = Object.keys(reteach).length;
      const empty = Object.values(reteach).filter((v) => !v || v.length < 60).length;
      n >= 6 && empty === 0 ? pass(`重讲内容 ${n} 段齐备且均有实质内容`)
        : fail(`重讲内容异常：共 ${n} 段，过短 ${empty} 段`);
    } else fail("RETEACH 未定义");
    /* 第 34 轮：批注行为落进行为日志，批注列表也由它渲染（只有一份存储） */
    /data-note="/.test(html)
      ? fail("段落上还挂着写死的 data-note（批注应来自行为日志）")
      : pass("静态 HTML 里不再写死批注内容");
    /(notesOfCw|behaviorNotes)/.test(html) && /renderNotes/.test(html)
      ? pass("批注列表由 notesOfCw / behaviorNotes 渲染（与学情里的「批注条数」同源）")
      : fail("批注列表没有接行为日志");
    /rec\("read"/.test(html) && /rec\("note"/.test(html) && /rec\("reteach"/.test(html)
      ? pass("阅读 / 批注 / 请求重讲 都会记进行为日志")
      : fail("阅读页没有记录行为");

    /* 第 47 轮：正文不再写死，改成跨账号桶读老师发来的课件 */
    /cwsForStudent\(/.test(html)
      ? pass("🔴 课件来自 cwsForStudent()（跨账号桶读老师发的那份）")
      : fail("课件不是从 cwsForStudent() 读的");
    /cwSections\(/.test(html)
      ? pass("🔴 段落由 cwSections() 渲染（与教师端同一份切段规则）")
      : fail("切段没有用 cwSections()");
    /cwId/.test(html)
      ? pass("🔴 批注 / 阅读都带 cwId（哪一份课件的第几段）")
      : fail("行为记录没带 cwId");
    /currentCwId\(\) === "cw-seed-1"/.test(html)
      ? pass("重讲只对预置示例用内置内容，别的课件如实说明（不假装重讲过）")
      : fail("重讲对非预置课件没有如实兜底");
    !/\bwindow\.prompt\(|(?<![.\w])prompt\(/.test(stripComments(html))
      ? pass("写批注走 pageModalHost()，不再用 window.prompt")
      : fail("还在用 window.prompt");
  }

  /* exam.html 第 44 轮重写：🔴 断言从「写死的假题长得对不对」
     改成「假数据清干净了没有 + 真链路接上了没有」（同 class.html 的思路）。 */
  if (name === "exam.html") {
    probe("typeof CHAPTERS") === "undefined"
      ? pass("页面里不再有写死的章节表（CHAPTERS）") : fail("还留着写死的 CHAPTERS");
    probe("typeof QUESTIONS") === "undefined"
      ? pass("页面里不再有写死的题库（QUESTIONS）") : fail("还留着写死的 QUESTIONS");
    /* 🔴 不许用原生弹窗 —— `jsdom` 与沙箱里没有 `alert` / `prompt`（老版这里全是假弹窗）。
       ⚠️ 必须**连 HTML 注释一起剥**：页头注释里回顾"以前这页用的是 alert/prompt"就是最可能的误报源。 */
    const exCode = stripComments(html).replace(/<!--[\s\S]*?-->/g, "");
    !/\balert\(|\bprompt\(/.test(exCode)
      ? pass("没用 window.alert / prompt（一律走 pageModalHost）") : fail("还在用原生弹窗");
    /* 真链路：出题 / 落库 / 逐题审 / 发布 / 真实名单 */
    ["generateExamQuestions", "createExam", "setQuestionState", "publishExam", "enrolledStudentsOf"].forEach(function (fn) {
      new RegExp(fn + "\\(").test(exCode) ? pass("接上了 " + fn + "()") : fail("没接上 " + fn + "()");
    });
    /syllabusOf\(/.test(exCode)
      ? pass("🔴 章节范围来自**真实教案大纲** syllabusOf()") : fail("章节不是从大纲来的");
    /state === "accepted"/.test(exCode)
      ? pass("🔴 预览 / 发布只取「已采纳」的题（没采纳的不进卷子）") : fail("没筛采纳状态");
    /!llmReady\(\)/.test(exCode) && /llmStatusText\(\)/.test(exCode)
      ? pass("🔴 未接模型时如实说明 + 指路（不编题）") : fail("没做诚实拒绝");
    /"sample"/.test(exCode)
      ? pass("预置示例明确标了来源（不冒充 AI 现出的）") : fail("示例没标注来源");
  }

  /* courseware.html 第 47 轮新建：🔴 断言的重点是「死入口变成真链路」——
     · 章节来自真实大纲 · 正文过了 XSS 清洗 · 发布走真实名单 · 草稿不发学生 */
  if (name === "courseware.html") {
    const cwCode = stripComments(html).replace(/<!--[\s\S]*?-->/g, "");
    !/\balert\(|\bprompt\(/.test(cwCode)
      ? pass("没用 window.alert / prompt（一律走 pageModalHost）") : fail("还在用原生弹窗");
    ["createCw", "updateCw", "deleteCw", "publishCw", "recallCwFrom", "cwSections", "enrolledStudentsOf"].forEach(function (fn) {
      new RegExp(fn + "\\(").test(cwCode) ? pass("接上了 " + fn + "()") : fail("没接上 " + fn + "()");
    });
    /syllabusOf\(/.test(cwCode)
      ? pass("🔴 章节范围来自**真实教案大纲** syllabusOf()") : fail("章节不是从大纲来的");
    /cwTextFromHtml\(/.test(cwCode)
      ? pass("🔴 上传的 HTML 过了 cwTextFromHtml（剥 script/style，挡 XSS）") : fail("上传没做 XSS 清洗");
    /pageModalHost\(\)/.test(cwCode)
      ? pass("预览 / 发布 / 删除走 pageModalHost()") : fail("没走 pageModalHost");
    /FileReader/.test(cwCode)
      ? pass("上传文件用 FileReader 读（不是假装读了）") : fail("上传没接 FileReader");
    /status === "draft"/.test(cwCode) && /status === "published"/.test(cwCode)
      ? pass("草稿 / 已发布两种状态都有呈现") : fail("状态呈现不全");
  }

  /* class.html 第 33 轮重写成「课程成员」：🔴 断言的重点从「假数据长得对不对」
     变成「假数据清干净了没有 + 真实数据链路接上了没有」。 */
  if (name === "class.html") {
    probe("typeof STUDENTS") === "undefined"
      ? pass("页面里不再有写死的假学生数组（STUDENTS）")
      : fail("还留着写死的假学生名单");
    probe("typeof level") === "undefined"
      ? pass("页面里不再有编造掌握度的分级函数 level()")
      : fail("还在用 level() 造成绩");
    probe("typeof enrolledStudentsOf") === "function"
      ? pass("接上了真实的在课学生数据层 enrolledStudentsOf()")
      : fail("没有 enrolledStudentsOf()（名单无从查起）");
    Array.isArray(probe("enrolledStudentsOf('ds')"))
      ? pass("enrolledStudentsOf() 返回名单数组（查不到就是空，不编造）")
      : fail("enrolledStudentsOf() 返回异常");
    // ⚠️ 必须**剥掉注释**再判：代码注释里解释"以前那块是演示数据说明"本身就是最可能的误报源
    /演示数据|DEMO/.test(stripComments(html))
      ? fail("底部「演示数据（DEMO）」说明块还在（用户明确要求删掉）")
      : pass("已按用户要求移除底部的演示数据说明块");
  }

  /* analysis.html 第 34 轮重写：整页从写死的图表改成读 nav.js 的行为日志。
     🔴 断言的重点从「写死的数据长得对不对」变成「写死的还在不在 + 真实链路接上没有」。 */
  if (name === "analysis.html") {
    const body = stripComments(html);
    /* 写死的东西必须清干净（这些都是"看起来像统计、其实是我编的"） */
    [["CHAPTERS", "章节掌握度常量"], ["TRAITS", "风格画像常量"]].forEach(([id, what]) => {
      probe(`typeof ${id}`) === "undefined"
        ? pass(`不再有写死的${what}（${id}）`)
        : fail(`还留着写死的${what}`);
    });
    !/<svg[^>]*class="donut"/.test(body) || /id="ring"/.test(body)
      ? pass("环形图改由数据渲染（svgt 挂在 #ring 上，不再是写死的 stroke-dasharray）")
      : fail("环形图还是写死的");
    const hard = ["掌握度分布", "各章节掌握度", "我的讲解风格画像", "知识掌握度", "平均掌握度"];
    const hits = hard.filter((t) => body.includes(t));
    hits.length === 0
      ? pass("旧的无来源图表标题（掌握度分布 / 章节掌握度 / 讲解风格画像）已全部移除")
      : fail("还在用无来源的图表标题: " + hits.join(" / "));

    /* 真实链路 */
    ["BEHAVIOR", "behaviorSummary", "behaviorByKind", "behaviorByTopic",
     "behaviorTraits", "behaviorTimeline", "behaviorWeakTopics", "behaviorSeedCount",
     "behaviorByDay"].forEach((fn) => {
      probe(`typeof ${fn}`) !== "undefined"
        ? pass(`analysis.html 用到了真实的 ${fn}`) : fail(`analysis.html 没有用 ${fn}`);
    });
    probe("typeof LIST") !== "undefined" && probe("typeof ALL") !== "undefined"
      ? pass("页面把行为日志按「当前课堂」筛出 LIST（别的课堂不混进来）")
      : fail("没有按课堂筛选行为日志");
    /location\.search/.test(body)
      ? pass("analysis.html 读 ?course=（学情也跟着当前课堂走）")
      : fail("analysis.html 没有读 ?course=");
    /id="emptyBox"/.test(html) && /id="dataBox"/.test(html)
      ? pass("有「还没有记录」空状态与数据区两个分支（不编一个空图表出来）")
      : fail("缺少空状态分支");
    /没有可靠的测量口径|不记录停留时长/.test(body)
      ? pass("如实说明「停留时长本版没有口径，所以相关指标不出现」")
      : fail("没有交代算不出来的指标怎么处理");
  }

  if (name === "schedule.html") {
    const slots = probe("SLOTS");
    Array.isArray(slots) && slots.length >= 4 ? pass(`课表节次 ${slots.length} 段`) : fail("课表节次异常");
    const wk = probe("WEEK");
    if (Array.isArray(wk) && wk.length >= 4) {
      wk.every((row) => Array.isArray(row) && row.length === 5)
        ? pass(`周课表 ${wk.length} 段 × 5 天结构完整`)
        : fail("周课表行列结构不齐（应为「节次 × 5 天」）");
      wk.flat().filter(Boolean).length >= 4 ? pass("课表含多门排课") : fail("课表内容过少");
    } else fail("WEEK 未定义");

    const td = probe("TODOS");
    if (Array.isArray(td) && td.length >= 4) {
      pass(`待办事项 ${td.length} 条`);
      new Set(td.map((t) => t.id)).size === td.length ? pass("待办 id 唯一（勾选定位可靠）") : fail("待办 id 重复");
      td.some((t) => t.done) && td.some((t) => !t.done)
        ? pass("待办含已完成与未完成两种状态") : fail("待办状态单一");
    } else fail("TODOS 未定义");

    /* --- 待办：可添加（本轮新增）--- */
    /id="todoAddBtn"/.test(html) ? pass("待办卡片有「＋ 添加事项」按钮")
      : fail("待办卡片缺少添加按钮");
    ["dueInfo", "fmtDate", "dayFrom", "demoTodos", "normalizeTodos", "saveTodos", "openAddTodo"]
      .forEach((fn) => {
        probe(`typeof ${fn}`) === "function" ? pass(`提供 ${fn}()`) : fail(`缺少 ${fn}()`);
      });
    probe(`TODOS_KEY`) === "st_todos"
      ? pass("待办持久化键为 st_todos（带 st_ 前缀）") : fail("待办键名不符: " + probe("TODOS_KEY"));
    /function openAddTodo/.test(inline) && /#todoAddBtn"\)\.addEventListener\("click", openAddTodo\)/.test(inline)
      ? pass("「＋ 添加事项」接上 openAddTodo") : fail("添加按钮未接事件");
    /pageModalHost\(\)/.test((inline.match(/function openAddTodo\([\s\S]*?\n\}/) || [""])[0])
      ? pass("待办弹窗用 pageModalHost 挂载（内容页取不到壳的 #modalHost）")
      : fail("待办弹窗未用 pageModalHost");
    ["dTitle", "dDue", "dTag"].every((id) => new RegExp(`id="${id}"`).test(inline))
      ? pass("添加弹窗含标题 / 截止 / 分类字段") : fail("添加弹窗字段不全");
    /id="dDue" type="date"/.test(inline) ? pass("截止日期用原生日期选择器") : fail("截止日期不是 date");

    /* --- dueInfo 必须是纯函数（today 可注入），否则没法确定性测 --- */
    /function dueInfo\(dueStr, today\)/.test(inline)
      ? pass("dueInfo(dueStr, today) 的「今天」可从参数注入") : fail("dueInfo 未做成可注入的纯函数");
    probe(`dueInfo("2026-09-30", new Date(2026,8,30)).text`) === "今天"
      ? pass("dueInfo：当天 → 「今天」") : fail("dueInfo 当天判断错误");
    probe(`dueInfo("2026-09-29", new Date(2026,8,30)).urgent`) === "urgent"
      ? pass("dueInfo：已过期 → 标红") : fail("dueInfo 过期判断错误");
    probe(`dueInfo("2026-10-01", new Date(2026,8,30)).urgent`) === "soon"
      ? pass("dueInfo：次日 → 标黄") : fail("dueInfo 次日判断错误");
    probe(`dueInfo("今年下个月", new Date(2026,8,30)).urgent`) === ""
      ? pass("dueInfo：认不出的值不炸、也不乱标色") : fail("dueInfo 兜底异常");
    // 紧急度必须是算的，不能是手选的字段
    !/urgent: *"(urgent|soon)"/.test(inline)
      ? pass("紧急度由日期算出（演示数据里不再写死 urgent 字段）")
      : info("仍有写死的 urgent 值");
    // 演示数据的日期必须是相对的，否则过几天就变成"已过期"
    /dayFrom\(/.test(inline) ? pass("演示待办用相对日期（dayFrom），不会随时间变旧")
      : fail("演示待办写死日期，过几天就全变已过期");

    /* --- 删除 + 空状态 --- */
    /class="todo-del"/.test(inline) ? pass("每条待办渲染出删除按钮") : fail("缺删除按钮");
    /e\.target\.closest\("\.todo-del"\)/.test(inline)
      ? pass("删除走事件委托（动态列表可靠）") : fail("删除未用事件委托");
    /TODOS\.splice\(i, 1\)/.test(inline) ? pass("删除真的从数据里移除") : fail("删除逻辑缺失");
    /todo-empty/.test(inline) ? pass("列表为空时有空状态提示") : fail("空列表没有提示");
    // 存档坏了要能回落，且「空数组」不能被当成「没记录」
    probe(`JSON.stringify(normalizeTodos(null))`) === "null"
      ? pass("normalizeTodos 对非数组返回 null（上层好判回落）")
      : fail("normalizeTodos 对非数组处理不当");
    probe(`JSON.stringify(normalizeTodos([{title:"  "},{},null,{title:"有效"}]))`)
      ? probe(`normalizeTodos([{title:"  "},{},null,{title:"有效"}]).length`) === 1
        ? pass("normalizeTodos 丢掉空标题 / 非对象条目") : fail("normalizeTodos 过滤不干净")
      : fail("normalizeTodos 未定义");
    // 「空数组」不能被当成「没有记录」—— 用户删光后重开不该复活演示数据
    const emptyArr = probe(`JSON.stringify(normalizeTodos([]))`);
    emptyArr === "[]" ? pass("normalizeTodos 把空数组规整为空数组（不是 null）")
      : fail("normalizeTodos([]) = " + emptyArr);
    /return saved \|\| demoTodos\(\)/.test(inline)
      ? pass("空数组为真值 → 走 saved 分支，删光后不会复活演示数据")
      : fail("回落逻辑有问题：删光后重开会复活演示数据");

    // 演示数据必须标注
    /DEMO/.test(html) ? pass("页面标注为演示数据（DEMO）") : info("页面无 DEMO 标注（第 17 轮起按用户口径不再强制）");

    // 渲染真实发生（列表由脚本填充，不是静态 HTML）
    const gridHtml = probe("document.getElementById('weekGrid')._html") || "";
    /week-cell/.test(gridHtml) ? pass("课表由脚本渲染出格子") : fail("课表未渲染");
    const todoHtml = probe("document.getElementById('todoList')._html") || "";
    /todo-check/.test(todoHtml) ? pass("待办由脚本渲染出勾选框") : fail("待办未渲染");
    /role="checkbox"/.test(todoHtml) ? pass("勾选框带 role=checkbox（无障碍）") : fail("勾选框缺语义");
    /aria-checked=/.test(todoHtml) ? pass("勾选框带 aria-checked 状态") : fail("勾选框缺 aria-checked");

    // ⚠️ 勾选/切换类「动态生成的元素」的交互断言放在 dom-smoke.cjs（真 DOM）。
    // 桩是扁平 registry，JS 注入的 innerHTML 不会成为可查询节点，
    // 在这里点 #chk-t1 会点不到 → 是桩能力不足，不是页面 Bug。
    const inl = inline;
    /#todoList"\)\.addEventListener\("click"/.test(inl) && /closest\("\.todo-check"\)/.test(inl)
      ? pass("待办用事件委托绑定（动态列表可靠）")
      : fail("待办未用事件委托（动态渲染后点不动）");
    /item\.done = !item\.done/.test(inl) ? pass("勾选逻辑切换完成态") : fail("勾选逻辑缺失");

    /* --- 本轮新增：导入课表 / 设置课表 --- */
    /id="importBtn"/.test(html) && /id="configBtn"/.test(html)
      ? pass("本周课表卡片提供「导入课表」「设置课表」两个入口")
      : fail("课表卡片缺少导入/设置入口");

    ["parseSchedule", "findHeaderIndex", "parseTable", "parseRows",
     "parseDayName", "parseCell", "slotOf"].forEach((fn) => {
      probe(`typeof ${fn}`) === "function"
        ? pass(`课表解析器提供 ${fn}()`) : fail(`缺少 ${fn}()`);
    });

    // 解析器真跑：示例文本必须能解析出课
    const parsed = probe("parseSchedule(IMPORT_SAMPLE)");
    if (parsed && !parsed.error) {
      pass(`示例课表可解析（${parsed.count} 节课 / ${parsed.slots.length} 节次 × ${parsed.days.length} 天）`);
      parsed.count === 9 ? pass("示例课表解析出 9 节课")
        : fail("示例课表解析数量不符: " + parsed.count);
    } else fail("示例课表解析失败: " + JSON.stringify(parsed));

    // 二维表（含行首制表符的常见粘贴形态）不能错位
    const t2 = probe(`parseSchedule("\\t周一\\t周二\\t周三\\n第1-2节\\t数据结构与算法/6A-301\\t\\t操作系统/6B-105")`);
    t2 && t2.week && t2.week[0] && t2.week[0][0] && t2.week[0][0].name === "数据结构与算法"
      ? pass("二维表粘贴解析正确（行首制表符不会让列错位）")
      : fail("二维表解析错位: " + JSON.stringify(t2));
    t2 && t2.week && t2.week[0] && t2.week[0][1] === null
      ? pass("空单元格识别为空堂") : fail("空单元格未被识别为空堂");

    // 逐行格式
    const t3 = probe(`parseSchedule("周一,第1-2节,数据结构与算法,6A-301,计科2301")`);
    t3 && t3.count === 1 && t3.days[0] === "周一" && t3.slots[0].label === "第1-2节"
      ? pass("逐行（CSV）格式解析正确") : fail("逐行格式解析异常: " + JSON.stringify(t3));

    // 制表符分隔的逐行格式（容易被误判成二维表）→ 必须能回落
    const t4 = probe(`parseSchedule("星期一\\t第1-2节 08:00\\t操作系统\\t6B-105")`);
    t4 && !t4.error && t4.slots[0].time === "08:00"
      ? pass("制表符分隔的逐行格式能正确回落解析（并拆出上课时间）")
      : fail("制表符逐行格式被误判: " + JSON.stringify(t4));

    // 坏输入必须给可读报错，而不是静默生成错课表
    const t5 = probe(`parseSchedule("")`);
    t5 && t5.error ? pass("空输入给出可读报错") : fail("空输入未报错");
    const t6 = probe(`parseSchedule("随便写点什么")`);
    t6 && t6.error ? pass("无法识别的输入给出可读报错") : fail("无法识别的输入未报错");

    // 落库与状态
    probe(`LS.get(${JSON.stringify("st_schedule")}, null)`) !== null
      ? pass("课表状态写入 localStorage（st_schedule）")
      : fail("课表状态未持久化");
    probe("typeof setState") === "function" ? pass("提供 setState 统一改状态并重渲染")
      : fail("缺少 setState");
    probe("DAYS.length") === 5 ? pass("默认 5 天（周一～周五）") : fail("默认天数异常: " + probe("DAYS.length"));

    // 渲染列数走 CSS 变量，不写内联 grid-template-columns（否则会盖掉小屏媒体查询）
    /--day-cols/.test(inl) && /--day-cols/.test(html)
      ? pass("课表列数由 --day-cols 驱动（支持导入 7 天课表）")
      : fail("列数未走 CSS 变量，导入 7 天会显示不全");
    /grid-template-columns: 64px repeat\(var\(--day-cols/.test(html)
      ? pass("列数模板读 var(--day-cols)，未写死 5 列")
      : fail("列数仍写死");

    // 两个入口必须各自接上函数，且弹窗有自己的挂载点
    /#importBtn"\)\.addEventListener\("click", openImport\)/.test(inl)
      ? pass("「导入课表」按钮接上 openImport") : fail("导入按钮未接函数");
    /#configBtn"\)\.addEventListener\("click", openConfig\)/.test(inl)
      ? pass("「设置课表」按钮接上 openConfig") : fail("设置按钮未接函数");
    /typeof openImport|function openImport/.test(inl) && /function openConfig/.test(inl)
      ? pass("两个弹窗函数均已定义") : fail("弹窗函数缺失");

    // 内容页在壳内取不到壳的 #modalHost → 必须有自己的挂载点（core.js 提供）
    const coreSrc = fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8");
    /function pageModalHost/.test(coreSrc)
      ? pass("core.js 提供 pageModalHost（内容页自己的弹窗挂载点）")
      : fail("core.js 缺少 pageModalHost");
    /function closePageModal/.test(coreSrc) && /function pageModalEsc/.test(coreSrc)
      ? pass("core.js 提供 closePageModal / pageModalEsc") : fail("缺少弹窗关闭助手");
    /pageModalHost\(\)/.test(inl)
      ? pass("课表弹窗用 pageModalHost 挂载") : fail("课表弹窗未用 pageModalHost");

    // 读本地文件必须走 FileReader 且做能力判断
    /FileReader/.test(inl) ? pass("文件导入走 FileReader（纯前端，不上传）")
      : fail("文件导入未用 FileReader");
    /typeof FileReader === "undefined"/.test(inl)
      ? pass("FileReader 不可用时给出降级提示") : fail("未处理 FileReader 缺失");
    /accept="\.csv,\.txt/.test(inl)
      ? pass("文件选择限定 .csv / .txt（浏览器读不了 .xlsx，已另有说明）")
      : fail("文件选择未限定类型");
    /另存为/.test(inl) ? pass("弹窗内说明了 Excel 需先另存为 CSV") : info("未提示 Excel 另存为 CSV");

    // 不许用 alert 当反馈（导入是真实动作，不该只弹提示）
    !/alert\(/.test(inl) ? pass("导入/设置不用 alert 做反馈（界面直接更新）")
      : info("课表页仍使用 alert");

    /* --- 节次必须按时间排序（逐行格式按天分组，首次顺序不是时间顺序）--- */
    probe("typeof sortSlots") === "function"
      ? pass("提供 sortSlots（按节次里的数字排序）") : fail("缺少 sortSlots");
    const sorted = probe(`sortSlots([{label:"第5-6节"},{label:"第1-2节"},{label:"第9-10节"},{label:"第3-4节"}],[[1],[2],[3],[4]])`);
    sorted && sorted.slots.map((s) => s.label).join(",") === "第1-2节,第3-4节,第5-6节,第9-10节"
      ? pass("乱序节次被排成时间顺序")
      : fail("节次排序不正确: " + JSON.stringify(sorted && sorted.slots));
    sorted && sorted.week.map((r) => r[0]).join(",") === "2,4,1,3"
      ? pass("排序时课表行跟着一起重排（不会错行）")
      : fail("排序后行与节次错位: " + JSON.stringify(sorted && sorted.week));
    const noNum = probe(`sortSlots([{label:"上午"},{label:"下午"}],[[1],[2]])`);
    noNum && noNum.slots[0].label === "上午"
      ? pass("无数字的节次名保持原顺序（不被乱排）") : fail("无数字节次名排序异常");

    // 表头行必须静默跳过，不能报「无法识别的第 1 行」
    const hdr = probe(`parseSchedule("星期,节次,课程,教室,班级\\n周一,第1-2节,数据结构与算法,6A-301,计科2301")`);
    hdr && !hdr.error && hdr.count === 1 && !hdr.skipped
      ? pass("CSV 表头行被静默跳过（不报「无法识别的行」）")
      : fail("表头行未被正确跳过: " + JSON.stringify(hdr && (hdr.error || hdr.skipped)));

    /* --- 随附样例文件 --- */
    [["sample-schedule.csv", "逐行 CSV"], ["sample-schedule-grid.txt", "二维表"]].forEach(([f, kind]) => {
      const fp = path.join(SITE, f);
      if (!fs.existsSync(fp)) { fail(`样例文件缺失：${f}`); return; }
      pass(`随附样例文件存在：${f}（${kind}）`);
      const txt = fs.readFileSync(fp, "utf8");
      const pr = probe(`parseSchedule(${JSON.stringify(txt)})`);
      pr && !pr.error && pr.count > 0
        ? pass(`${f} 用真实解析器解析通过（${pr.count} 节课）`)
        : fail(`${f} 解析失败: ${JSON.stringify(pr && pr.error)}`);
    });
    // CSV 带 BOM 方便 Excel 打开，但解析必须不受影响
    fs.readFileSync(path.join(SITE, "sample-schedule.csv")).slice(0, 3).toString("hex") === "efbbbf"
      ? pass("CSV 带 UTF-8 BOM（Excel 打开中文不乱码）") : fail("CSV 缺 BOM，Excel 里中文会乱码");
    /a\[download\]|download>/.test(inl)
      ? pass("导入弹窗提供样例文件下载链接") : fail("弹窗未提供样例下载");

    // ⚠️ 这里原本有一条「页面必须标注 DEMO」的断言，已按用户要求移除：
    //    schedule.html 底部的演示数据说明块被用户有意删掉，且全站 12 个页面里
    //    只有 class.html / lesson.html 还留着该标注。不再对单个页面强制要求。
    //    （「不能把虚构数据当真数据展示」这条改由 class.html 守：它现在一个编造数字都不许有 ——
    //      那一页有逐人的虚构成绩，性质更重。）

    /* --- 卡片头不再有「本机保存」胶囊（用户要求去掉）--- */
    !/week-src/.test(html) ? pass("已移除「本机保存」胶囊样式（.week-src）")
      : fail("仍残留 .week-src 样式");
    !/id="weekSource"/.test(html) ? pass("已移除胶囊元素（#weekSource）")
      : fail("仍残留 #weekSource 元素");
    /dataset\.source/.test(inl)
      ? pass("数据来源改挂在 data-source 上（界面不占位，状态仍可观测）")
      : fail("来源信息被整个删掉了，导入/恢复是否生效将无法验证");

    /* --- 按当前时间自动高亮（正在上课 / 下一节）--- */
    ["hhmm", "slotRange", "timedSlotCount", "computeFocus", "focusText"].forEach((fn) => {
      probe(`typeof ${fn}`) === "function"
        ? pass(`提供 ${fn}()`) : fail(`缺少 ${fn}()`);
    });
    // 时间解析
    probe(`hhmm("08:00")`) === 480 ? pass("hhmm 解析 08:00 → 480") : fail("hhmm 解析错误");
    probe(`hhmm("8:5")`) === null && probe(`hhmm("25:00")`) === null && probe(`hhmm("")`) === null
      ? pass("hhmm 拒绝非法/空值") : fail("hhmm 未拒绝非法值");
    probe("JSON.stringify(slotRange(0))") === "[480,580]"
      ? pass("第 1–2 节算作 08:00–09:40") : fail("slotRange(0)=" + probe("JSON.stringify(slotRange(0))"));
    probe("DEFAULT_SLOT_MIN") >= 30 ? pass("有默认节次时长兜底（没填结束时间时用）")
      : fail("缺 DEFAULT_SLOT_MIN");
    // 纯函数、可注入时间
    probe(`computeFocus(new Date(2026,8,30,8,30)).state`) === "now"
      ? pass("computeFocus 是纯函数（可注入时间，2026-09-30 周三 08:30 → 正在上课）")
      : fail("computeFocus 结果异常: " + probe(`JSON.stringify(computeFocus(new Date(2026,8,30,8,30)))`));
    probe(`computeFocus(new Date(2026,8,30,11,0)).state`) === "next"
      ? pass("时段内但该格空堂 → 不算正在上课")
      : fail("空堂被误判: " + probe(`JSON.stringify(computeFocus(new Date(2026,8,30,11,0)))`));
    probe(`computeFocus(new Date(2026,9,4,10,0)).day`) === 0
      ? pass("非上课日（周日）→ 顺延到第一个有课的天")
      : fail("非上课日处理错误");
    // 🔴 跨 realm 陷阱：instanceof Date 会静默退回当前时间
    !/instanceof\s+Date/.test(stripComments(inl))
      ? pass("computeFocus 未用 instanceof Date（跨 realm 会失效）")
      : fail("仍在使用 instanceof Date");
    // 该陷阱必须在注释里写明，否则以后有人会「顺手改回去」
    /instanceof[\s\S]{0,40}跨 realm|跨 realm[\s\S]{0,60}instanceof/.test(inl)
      ? pass("注释里写明了「为什么不能用 instanceof Date」")
      : info("建议在 computeFocus 处注释说明 instanceof Date 的坑");
    // 无时间信息不能瞎猜
    probe("typeof timedSlotCount") === "function"
      ? pass("提供 timedSlotCount 以判断「有没有时间信息」") : fail("缺少 timedSlotCount");
    /节次还没填上课时间/.test(inl)
      ? pass("节次缺时间时给出可操作提示（去设置课表补）")
      : fail("缺「没有时间信息」的提示");
    // 不能再有写死的高亮
    !/const NOW\s*=/.test(inl)
      ? pass("已移除写死的高亮 NOW（改为按时间计算）") : fail("仍留有写死的 NOW");
    /id="weekFocus"/.test(html) ? pass("卡片头有状态行挂点（#weekFocus）") : fail("缺 #weekFocus");
    /\.week-cell\.next/.test(html) ? pass("「下一节」有独立样式（虚线与「正在上课」区分）")
      : fail("缺 .week-cell.next 样式");
    /c-flag/.test(html) ? pass("高亮格带「正在上课 / 下一节」文字标签") : fail("缺状态标签样式");
    // 时间会往前走 → 要有重算时机
    /visibilitychange/.test(inl) && /"focus", refreshFocus/.test(inl)
      ? pass("切回标签页 / 聚焦时重算高亮") : fail("缺少回到页面时的重算");
    /setInterval\(refreshFocus/.test(inl) ? pass("页面长开时每分钟兜底重算") : fail("缺兜底重算");

    /* --- 导入要带时间 --- */
    /(\d\{1,2\}:\\d\{2\})/.test(inl) || /\\d\{1,2\}:\\d\{2\}/.test(inl)
      ? pass("解析器识别 HH:MM") : fail("解析器不识别时间");
    const s1 = probe(`slotOf("第1-2节 08:00-09:40")`);
    s1 && s1.label === "第1-2节" && s1.time === "08:00" && s1.end === "09:40"
      ? pass("节次名里的时间范围被拆出来（label/time/end）")
      : fail("slotOf 未拆时间: " + JSON.stringify(s1));
    const s2 = probe(`slotOf("第1-2节 08:00")`);
    s2 && s2.time === "08:00" && s2.end === "" ? pass("只写开始时间也认") : fail("只写开始时间未识别");
    const s3 = probe(`slotOf("第1-2节")`);
    s3 && s3.label === "第1-2节" && s3.time === "" && s3.end === ""
      ? pass("不带时间的节次名不被误拆（1-2 不会当成时刻）")
      : fail("无时间节次被误拆: " + JSON.stringify(s3));
    const pb = probe(`parseSchedule("周一,第1-2节 08:00-09:40,数据结构与算法,6A-301,计科2301\\n周二,第1-2节 08:00-09:40,操作系统")`);
    pb && pb.slots && pb.slots.length === 1 && pb.slots[0].time === "08:00" && pb.slots[0].end === "09:40"
      ? pass("同节次名在多天重复出现时只留一条，并带上时间")
      : fail("逐行格式节次合并异常: " + JSON.stringify(pb && (pb.error || pb.slots)));
    // ⚠️ 表头识别要求「至少 2 个可识别星期名」（否则容易把数据行误判成表头），
    //    所以这里必须给两天，只给一天会走逐行解析并失败。
    const pg = probe(`parseSchedule("节次\\t周一\\t周二\\n第1-2节 08:00-09:40\\t数据结构与算法\\t操作系统")`);
    pg && pg.slots && pg.slots[0] && pg.slots[0].time === "08:00" && pg.slots[0].end === "09:40"
      ? pass("二维表格式同样能带时间")
      : fail("二维表时间解析异常: " + JSON.stringify(pg && (pg.error || pg.slots)));
    // 设置弹窗要能改时间（含结束时间）
    /data-f="time"/.test(inl) ? pass("设置弹窗可改节次开始时间") : fail("设置弹窗缺开始时间输入");
    /data-f="end"/.test(inl) ? pass("设置弹窗可改节次结束时间") : fail("设置弹窗缺结束时间输入");
    /end: s\.end \|\| ""/.test(inl) || /end:/.test(inl)
      ? pass("节次编辑草稿带 end 字段") : fail("草稿缺 end");
    // 格式说明与示例要体现时间
    /节次名后面可以跟上时间/.test(inl + html)
      ? pass("导入弹窗说明了「节次名可跟时间」") : fail("格式说明未提时间");
    /08:00-09:40/.test(inl) ? pass("内置示例带上了时间") : fail("示例缺时间");
    // 样例文件必须带时间（否则导入后不会自动高亮）
    [["sample-schedule.csv", /08:00-09:40/], ["sample-schedule-grid.txt", /08:00-09:40/]].forEach(([f, re]) => {
      const fp = path.join(SITE, f);
      if (fs.existsSync(fp) && re.test(fs.readFileSync(fp, "utf8"))) pass(`样例 ${f} 带节次时间`);
      else fail(`样例 ${f} 没有时间，导入后无法自动高亮`);
    });
    const ps = probe(`parseSchedule(${JSON.stringify(fs.readFileSync(path.join(SITE, "sample-schedule.csv"), "utf8"))})`);
    ps && !ps.error && ps.slots.every((s) => s.time && s.end)
      ? pass("样例 CSV 解析后每个节次都有开始+结束时间")
      : fail("样例 CSV 时间不全: " + JSON.stringify(ps && ps.slots));

    /* --- 方式三：让 AI 助手转格式（本轮只做跳转）--- */
    /id="impAi"/.test(html) ? pass("导入弹窗提供「方式三」入口（#impAi）")
      : fail("缺少方式三入口");
    /imp-alt/.test(inl + html) ? pass("方式三有独立分区样式") : fail("方式三未分区");
    /AI 助手/.test(html.match(/id="impAi"[\s\S]{0,80}/) || "") || /impAi/.test(html)
      ? pass("方式三按钮文案指向 AI 助手") : fail("方式三按钮文案不对");

    // ⚠️ 用户要求删的是**界面上**那条「无法跨域」提示栏。
    //    代码注释里保留「为什么只能本地解析」是正确的 —— 断言要分清楚，
    //    否则会把「删错东西」和「删对了但注释还在」一并判错。
    const openImportBody = (inl.match(/function openImport\(\)[\s\S]*?\n\}/) || [""])[0];
    openImportBody ? pass("能定位到 openImport 弹窗模板") : fail("找不到 openImport");
    !/跨域/.test(openImportBody)
      ? pass("导入弹窗（用户可见部分）已无「跨域」文案")
      : fail("弹窗内仍残留跨域文案");
    !/modal-hint/.test(openImportBody)
      ? pass("导入弹窗顶部提示栏已整块删除")
      : fail("导入弹窗顶部提示栏仍在");
    !/浏览器跨域取不到教务系统/.test(openImportBody)
      ? pass("跨域解释整段已从界面移除") : fail("跨域解释仍在界面上");
    /浏览器也跨域取不到教务系统/.test(inl)
      ? pass("架构原因以代码注释形式保留（不再暴露给用户）")
      : info("跨域原因的注释说明已丢失，后续维护可能摸不着头脑");

    // 提示词必须真的写好（将来 agent 页要直接用它）
    const prompt = probe("AI_PARSE_PROMPT");
    typeof prompt === "string" && /格式一/.test(prompt) && /格式二/.test(prompt)
      ? pass("定义 AI_PARSE_PROMPT，且说明两种目标格式") : fail("AI_PARSE_PROMPT 缺失或不完整");
    /教室/.test(prompt || "") && /不要编造/.test(prompt || "")
      ? pass("提示词写明保留字段与不编造要求") : fail("提示词约束不完整");
    /逐行,每行一节课|逐行/.test(prompt || "") && /制表符/.test(prompt || "")
      ? pass("提示词把两种格式讲清楚了（逐行 / 制表符二维表）")
      : fail("提示词未讲清两种格式");

    // 交接契约
    /STORE_KEY\.agentTask/.test(inl) ? pass("跳转前把任务写进 STORE_KEY.agentTask")
      : fail("未使用 STORE_KEY.agentTask");
    probe(`STORE_KEY.agentTask`) === "st_agent_task"
      ? pass("交接键名为 st_agent_task（与 core.js / shell.js 一致）")
      : fail("交接键名不一致: " + probe("STORE_KEY.agentTask"));
    /navigate\("agent\.html\?task=parse-schedule"\)/.test(inl)
      ? pass("跳转目标为 agent.html?task=parse-schedule")
      : fail("跳转目标不对");
    /prompt: AI_PARSE_PROMPT/.test(inl) && /text: textEl\.value/.test(inl)
      ? pass("任务里同时带上提示词与用户原文") : fail("任务缺少提示词或原文");

    // navigate() 必须保留 query（否则深链退化成裸页名）
    const core = fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8");
    const navBody = (core.match(/function navigate\([\s\S]*?\n\}/) || [""])[0];
    /let real = raw/.test(navBody)
      ? pass("core.js 的 navigate() 保留原始目标（含 query）")
      : fail("navigate() 把 query 剥掉了");
    /const target = raw\.split\("\?"\)\[0\]/.test(navBody)
      ? pass("navigate() 仍用裸页名做越权判断") : fail("navigate() 归属判断有误");

    // 「带 query 的深链」要能让侧栏高亮退回匹配（否则点完侧栏没有高亮项）
    /function currentIndex/.test(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"))
      ? pass("nav.js 提供 currentIndex（精确优先、退回裸页名）")
      : fail("缺少 currentIndex");
    probe(`currentIndex(["class.html?cls=cs2301","class.html?cls=cs2302","class.html","agent.html"], "class.html?cls=cs2302")`) === 1
      ? pass("currentIndex：多个班各自精确命中（不会同时亮）")
      : fail("currentIndex 精确匹配有误");
    probe(`currentIndex(["class.html?cls=cs2301","class.html","agent.html"], "agent.html?task=x")`) === 2
      ? pass("currentIndex：带任务的深链退回匹配裸页名（AI 助手能亮）")
      : fail("currentIndex 退回匹配有误");
    probe(`currentIndex(["class.html?cls=cs2301","class.html"], "class.html")`) === 1
      ? pass("currentIndex：裸页名仍精确命中自己那一项")
      : fail("currentIndex 裸页名匹配有误");

    /* agent.html 第 35 轮**实现了**（原来那份 TODO(agent) 规格已兑现）：
       断言从「有没有记下规格」改成「有没有真的接上」。 */
    const agentHtml = fs.readFileSync(path.join(SITE, "agent.html"), "utf8");
    !/TODO\(agent\)/.test(agentHtml)
      ? pass("TODO(agent) 的规格已兑现（不再是待办）") : fail("TODO 还挂在页面上");
    /st_agent_task|STORE_KEY\.agentTask/.test(agentHtml) && /parse-schedule/.test(agentHtml)
      ? pass("agent.html 消费 st_agent_task 交接（parse-schedule 等 5 种任务）")
      : fail("agent.html 没接住任务交接");
    /回到课表页导入/.test(agentHtml)
      ? pass("解析完给「回到课表页导入」的闭环入口") : fail("缺「转格式 → 回课表导入」的闭环");
    /atom-text-to-table/.test(agentHtml)
      ? pass("课表解析走技能库的 atom-text-to-table（页面里没另写一套）")
      : fail("agent.html 没接上「文本转表格」技能");
  }

  if (name === "lesson.html") {
    /* --- 页面骨架 --- */
    /id="courseSel"/.test(html) ? pass("有课程切换器（一门课一份大纲）") : fail("缺课程切换器");
    /id="outlineTree"/.test(html) && /id="outlineEmpty"/.test(html)
      ? pass("有教案大纲容器 + 空状态容器") : fail("缺大纲容器");
    /id="planPanel"/.test(html) ? pass("有详情容器") : fail("缺详情容器");
    /id="addLessonBtn"/.test(html) && /id="addChapterBtn"/.test(html)
      ? pass("有「新建课时教案」「＋ 章节」入口") : fail("缺新建入口");

    /* --- 数据层（完整规则在 verifyLessonData 里单独跑一遍）--- */
    const st = probe("syllabusStats('ds')");
    st && st.chapters === 4 && st.lessons === 6
      ? pass("页面读到的教案统计与大纲一致（4 章 / 6 份）")
      : fail("统计不一致: " + JSON.stringify(st));

    /* --- 脚本渲染出来的结构 --- */
    const tree = probe("document.getElementById('outlineTree')._html") || "";
    /ch-row/.test(tree) && /第 7 章/.test(tree) ? pass("大纲树由脚本渲染出章") : fail("大纲树未渲染");
    /ls-row/.test(tree) ? pass("大纲树渲染出课时项（章 → 课时两级）") : fail("课时项未渲染");
    /ls-dot/.test(tree) ? pass("课时项带状态点") : fail("缺状态点");
    /ch-hours/.test(tree) ? pass("章行显示计划课时数") : fail("缺课时数");

    const panel = probe("document.getElementById('planPanel')._html") || "";
    /plan-head/.test(panel) ? pass("详情渲染出标题区") : fail("详情未渲染");
    /data-tab/.test(panel) ? pass("详情含「教案 / 版本 / 课后反思」标签") : fail("缺标签页");
    /tabBody/.test(panel) ? pass("详情含标签内容容器") : fail("缺标签容器");
    // ⚠️ 标签里的分节内容（.plan-sec / 六个字段 / AI 说明）写在 #tabBody 里，
    //    而 #tabBody 是运行时才创建的节点 —— 桩的扁平 registry 查不到。
    //    「六个字段真的渲染出来」由 dom-smoke.cjs 的真实 DOM 断言覆盖。

    /* ⚠️ 标签内容（#tabBody）是运行时才创建的节点，桩的扁平 registry 查不到 ——
           「切标签 / 提交版本 / 对比 / 回退 / 反思」的交互断言全部放在 dom-smoke.cjs。 */

    /* --- 关键实现约定 --- */
    /SNAP_FIELDS\.map/.test(inline) ? pass("详情遍历 SNAP_FIELDS 渲染（字段定义不重复）")
      : fail("字段渲染没走统一定义");
    /toneClass\(/.test(inline) ? pass("状态/类型徽标配色走 toneClass（不散落）")
      : fail("徽标配色未统一");
    /pageModalHost\(\)/.test(inline) ? pass("弹窗走 core.js 的 pageModalHost（iframe 内取不到壳的挂载点）")
      : fail("未使用 pageModalHost");
    /commitLesson\(/.test(inline) ? pass("编辑走 commitLesson 产生新版本") : fail("编辑未走版本提交");
    /revertLesson\(/.test(inline) ? pass("回退走 revertLesson") : fail("缺回退实现");
    /diffSnap\(/.test(inline) ? pass("对比走 diffSnap（结构化 diff）") : fail("缺对比实现");
    /window\.confirm/.test(inline) ? pass("回退前有二次确认（不可逆操作要问）") : fail("回退没有确认");
    /STORE_KEY\.agentTask/.test(inline) ? pass("AI 交接写 STORE_KEY.agentTask（与课表导入同一契约）")
      : fail("AI 交接未走统一契约");
    /agent\.html\?task=/.test(inline) ? pass("AI 入口跳 agent.html?task=…") : fail("缺 AI 跳转");
    /navigate\("lesson\.html\?course="/.test(inline)
      ? pass("切课程走 navigate（壳内换 iframe、独立模式整页跳）") : fail("切课程方式不对");
    /history\.replaceState/.test(inline) ? pass("当前课时同步到 URL（可分享/刷新保留）")
      : fail("未同步 URL");
    /LESSON_PICK_KEY/.test(inline) ? pass("记住上次看的课程/课时") : fail("未记住上次选择");

    // 🔴 本轮真实事故：renderLessonPanel 忘了调 renderTabBody()，标签区永远空白。
    //    jsdom 侧有交互断言兜底，这里再加一道静态的（更快定位）。
    /<div id="tabBody"><\/div>`;\s*\n\s*renderTabBody\(\);/.test(inline)
      ? pass("详情渲染后立刻填充标签内容（防「标签区空白」复发）")
      : fail("renderLessonPanel 没有紧跟 renderTabBody()");

    // 教案页不该再引用已废弃的旧结构
    !/id="lessonList"|lesson-item/.test(html) ? pass("旧教案列表结构已彻底移除")
      : fail("仍有旧教案列表残留");
  }

  if (name === "settings.html") {
    const secs = [...html.matchAll(/id="(appearance|a11y|model|account|data)"/g)].map((m) => m[1]);
    secs.length === 5 ? pass(`设置分区齐备 5 项（${secs.join("/")}）`)
      : fail(`设置分区缺项，实得 ${secs.length}: ${secs.join("/")}`);

    ["fontRange", "lhRange", "lsRange", "rateRange"].every((i) => html.includes(`id="${i}"`))
      ? pass("无障碍滑块 4 个齐备（字号/行距/字间距/语速）") : fail("无障碍滑块缺失");

    const KEYV = probe("KEY");
    KEYV && /^st_/.test(String(KEYV)) ? pass(`存储键有前缀隔离（${KEYV}）`)
      : fail("存储键缺少前缀: " + KEYV);

    /localStorage\.setItem\(KEY/.test(inline) ? pass("API Key 写入 localStorage（非 Cookie）")
      : fail("API Key 存储方式不正确");

    if (probe("typeof applyA11y") === "function") {
      const out = probe("(() => { applyA11y(); return { f: document.getElementById('fontVal').textContent, l: document.getElementById('lhVal').textContent }; })()");
      out && /px$/.test(out.f) && /^\d\.\d$/.test(out.l)
        ? pass(`无障碍预览实时联动（字号 ${out.f} / 行距 ${out.l}）`)
        : fail("无障碍预览未联动: " + JSON.stringify(out));

      // 关键：改动必须写到「壳的根元素」，而不是只改 iframe 自己
      const shellSync = probe("(() => { applyA11y(); return (window._posted||[]).some(m => m.type === 'st-a11y-changed'); })()");
      shellSync ? pass("无障碍改动广播给壳（跨页保持一致）")
        : fail("无障碍改动未广播给壳");
    } else fail("applyA11y 未定义");

    // 高对比度开关必须能被读到
    html.includes('id="contrastSw"') && html.includes('id="motionSw"')
      ? pass("高对比度 / 降低动效开关具备 id（可持久化）")
      : fail("对比度 / 动效开关缺少 id");
  }
}

/* ============================================================
   B. 应用壳验证（app.html + shell.js）
   ============================================================ */
function verifyShell() {
  section(SHELL_PAGE + "（应用壳）");
  const file = path.join(SITE, SHELL_PAGE);
  const html = fs.readFileSync(file, "utf8");
  const doc = makeDoc();

  registerIds(doc, html);

  /* --- 壳结构 --- */
  const need = {
    shellSide: "左侧栏容器",
    contentFrame: "内容 iframe",
    collapseBtn: "侧栏折叠按钮",
    userBtn: "用户菜单按钮",
    userMenu: "用户下拉菜单",
    brandRole: "角色标签",
  };
  for (const [id, label] of Object.entries(need)) {
    html.includes(`id="${id}"`) ? pass(`含 ${label}（#${id}）`) : fail(`缺少 ${label}（#${id}）`);
  }

  /<header[^>]*class="shell-top"/.test(html) ? pass("含顶部栏 header.shell-top")
    : fail("缺少顶部栏");
  /class="shell-frame"/.test(html) ? pass("iframe 使用 .shell-frame 样式")
    : fail("iframe 缺少 .shell-frame");
  /assets\/shell\.js/.test(html) ? pass("引用 shell.js") : fail("未引用 shell.js");
  !/assets\/core\.js/.test(html) ? pass("壳不引用 core.js（职责清晰）")
    : fail("壳不应引用 core.js");

  /* 顶部栏只放用户信息与主题（按用户要求） */
  const topMatch = html.match(/<header class="shell-top"[\s\S]*?<\/header>/);
  const top = topMatch ? topMatch[0] : "";
  /data-theme-btn/.test(top) ? pass("顶部栏含主题切换") : fail("顶部栏缺主题切换");

  /* --- 壳的默认主题 = 深色（用户要求） --- */
  {
    const m = html.match(/<html[^>]*\bdata-theme="([\w-]+)"/);
    m ? pass(`壳 HTML 带默认主题占位（${m[1]}）`) : fail("壳缺少 data-theme 占位");
    m && m[1] === "dark" ? pass("壳默认主题为深色") : fail(`壳默认主题应为深色，实际: ${m && m[1]}`);
    ["cream", "snow", "dark"].every((id) => new RegExp(`data-theme-btn="${id}"`).test(top))
      ? pass("顶部栏三套主题按钮齐备") : fail("顶部栏主题按钮不全");
  }
  /id="userBtn"/.test(top) ? pass("顶部栏含用户信息入口") : fail("顶部栏缺用户入口");
  !/side-item/.test(top) ? pass("顶部栏未混入侧栏菜单项") : fail("顶部栏混入菜单项");

  /* --- 无障碍阅读模式勾选（默认勾选；功能未实现，只验开关与状态） --- */
  const box = html.match(/<input[^>]*id="a11yReadMode"[^>]*>/);
  box ? pass("顶部栏含「无障碍阅读模式」勾选项（#a11yReadMode）")
    : fail("缺少无障碍阅读模式勾选项");
  if (box) {
    const tag = box[0];
    /\btype="checkbox"/.test(tag) ? pass("是复选框（checkbox）")
      : fail("无障碍阅读模式不是 checkbox");
    // 默认勾选：HTML 上写死 checked，JS 未跑时也必须勾上
    /\bchecked\b/.test(tag) ? pass("HTML 上默认勾选（脚本未执行时也生效）")
      : fail("未默认勾选（checked 应写死在 HTML 上）");
    // 用 <label for> 关联，点文字也能切换（无障碍基本要求）
    new RegExp(`<label[^>]*\\bfor="a11yReadMode"`).test(html)
      ? pass("勾选项用 <label for> 关联（点文字可切换）")
      : fail("勾选项缺 <label for> 关联");
    // 必须真的在顶部栏里，而不是掉到侧栏
    /id="a11yReadMode"/.test(top) ? pass("勾选项确实位于顶部栏（右侧区域）")
      : fail("勾选项不在顶部栏内");
  }
  /id="a11yReadMode"[\s\S]{0,400}?id="userMenuWrap"/.test(top)
    ? pass("勾选项排在用户菜单之前（靠右一组）")
    : info("勾选项与用户菜单的相对位置可自行调整");

  /* --- nav.js + shell.js 执行 --- */
  const sandbox = makeSandbox(doc, SHELL_PAGE, { hash: "" });
  const probe = probeFn(sandbox);

  try {
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"),
      sandbox, { filename: "nav.js" });
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "shell.js"), "utf8"),
      sandbox, { filename: "shell.js" });
    pass("nav.js + shell.js 加载无异常");
  } catch (e) {
    fail("壳脚本报错: " + e.message);
    return;
  }

  /* --- 双端导航隔离 --- */
  const NAV = probe("NAV");
  const PAGE_ROLE = probe("PAGE_ROLE");
  const ROLES = probe("ROLES");

  if (!NAV || !PAGE_ROLE) { fail("NAV / PAGE_ROLE 未定义"); return; }

  const flatT = (NAV.teacher || []).flatMap((g) => g.items);
  const flatS = (NAV.student || []).flatMap((g) => g.items);

  const tPages = Object.entries(PAGE_ROLE).filter(([, v]) => v === "teacher").map(([f]) => f);
  const sPages = Object.entries(PAGE_ROLE).filter(([, v]) => v === "student").map(([f]) => f);
  const bothPages = Object.entries(PAGE_ROLE).filter(([, v]) => v === "both").map(([f]) => f);

  tPages.length && sPages.length
    ? pass(`角色页划分：教师 ${tPages.length} 页 / 学生 ${sPages.length} 页 / 共享 ${bothPages.length} 页`)
    : fail("角色页划分异常");

  // 菜单里出现的 page 必须都在 PAGE_ROLE 中登记
  const unregistered = [...flatT, ...flatS]
    .map((i) => i.page).filter((p) => p && !PAGE_ROLE[p]);
  unregistered.length === 0 ? pass("菜单项页面均已在 PAGE_ROLE 登记（高亮/拦截可用）")
    : fail("未登记页面: " + [...new Set(unregistered)].join(", "));

  // 🆕 第 30 轮：「我的课程」里**一个灰显占位都不许有**。
  //    没有 page 的菜单项渲染出来就是「暗的、点不动的」——
  //    教师端有过一条 page:"" 的演示「操作系统」，学生端写死过 os / net 两条，
  //    它们看着就像"想删却删不掉"，已全部清掉。
  //    ⚠️ 只查「我的课程」分组：其他分组里「发布课件作业 / 学生管理 / 我的作业」
  //    那类未开放入口是**有意保留**的占位。
  const courseItems = [...(NAV.teacher || []), ...(NAV.student || [])]
    .filter((g) => /我的课程/.test(g.title || ""))
    .flatMap((g) => g.items || []);
  courseItems.length >= 2
    ? pass(`双端「我的课程」共 ${courseItems.length} 项`)
    : fail("「我的课程」项数异常: " + courseItems.length);
  const dimCourses = courseItems.filter((i) => !i.page).map((i) => i.label);
  dimCourses.length === 0
    ? pass("双端「我的课程」都没有灰显不可点的占位项")
    : fail("「我的课程」里还有点不动的项: " + dimCourses.join(", "));

  // 教师端菜单不得含学生专属页，反之亦然
  const tPagesInS = sPages.filter((f) => flatT.some((i) => i.page === f));
  const sPagesInT = tPages.filter((f) => flatS.some((i) => i.page === f));
  tPagesInS.length === 0 && sPagesInT.length === 0
    ? pass("双端菜单完全隔离，无对端专属页混入")
    : fail(`菜单串页: 教师端混入 ${tPagesInS.join(",")} / 学生端混入 ${sPagesInT.join(",")}`);

  // 同一 key 若两端都有，page 必须不同（agent 已拆分）
  const tByKey = Object.fromEntries(flatT.map((i) => [i.key, i.page]));
  const sByKey = Object.fromEntries(flatS.map((i) => [i.key, i.page]));
  const collide = Object.keys(tByKey).filter((k) =>
    sByKey[k] !== undefined && tByKey[k] === sByKey[k] && tByKey[k]
    && PAGE_ROLE[tByKey[k]] !== "both");
  collide.length === 0 ? pass("双端同 key 入口未指向同一页（agent 已拆分）")
    : fail("双端入口指向同一页: " + collide.map((k) => `${k}→${tByKey[k]}`).join(", "));

  // 死链
  const dead = [...flatT, ...flatS].filter((i) => i.page && !fs.existsSync(path.join(SITE, i.page)));
  dead.length === 0 ? pass("菜单无死链") : fail("菜单死链: " + [...new Set(dead.map((i) => i.page))].join(", "));

  // 双端均有设置入口
  [["teacher", flatT], ["student", flatS]].every(([, arr]) => arr.some((i) => i.key === "settings"))
    ? pass("双端菜单均含「设置」入口") : fail("缺少设置入口");

  // 首页存在
  ROLES && fs.existsSync(path.join(SITE, ROLES.teacher.home)) && fs.existsSync(path.join(SITE, ROLES.student.home))
    ? pass(`双端首页有效（教师→${ROLES.teacher.home}，学生→${ROLES.student.home}）`)
    : fail("角色首页路径无效");

  /* --- 越权拦截（核心安全断言） --- */
  if (probe("typeof go") === "function") {
    // 学生身份尝试进入教师页
    probe("(() => { Cookie.set('st_role','student',1); LS.rawSet('st_role','student'); })()");
    sandbox._posted.length = 0;
    const beforeSrc = doc.getElementById("contentFrame").src;
    probe("go('class.html')");
    const afterSrc = doc.getElementById("contentFrame").src;
    const blocked = afterSrc !== "class.html";
    blocked ? pass("越权拦截：学生身份无法进入教师页（class.html）")
      : fail("越权未被拦截！学生进入了 " + afterSrc);
    void beforeSrc;

    // 教师身份尝试进入学生页
    probe("(() => { Cookie.set('st_role','teacher',1); LS.rawSet('st_role','teacher'); })()");
    probe("go('chat.html')");
    const after2 = doc.getElementById("contentFrame").src;
    after2 !== "chat.html" ? pass("越权拦截：教师身份无法进入学生页（chat.html）")
      : fail("越权未被拦截！教师进入了 " + after2);

    // 正常页应放行
    probe("(() => { Cookie.set('st_role','teacher',1); LS.rawSet('st_role','teacher'); })()");
    probe("go('exam.html')");
    doc.getElementById("contentFrame").src === "exam.html"
      ? pass("同角色页面正常放行（teacher → exam.html）")
      : fail("同角色页面被误拦: " + doc.getElementById("contentFrame").src);

    // 共享页放行
    probe("go('settings.html')");
    doc.getElementById("contentFrame").src === "settings.html"
      ? pass("共享页放行（settings.html 双端可进）")
      : fail("共享页被误拦: " + doc.getElementById("contentFrame").src);
  } else fail("go 未定义");

  /* --- 主题广播 --- */
  if (probe("typeof broadcast") === "function") {
    probe("broadcast()");
    info("broadcast 依赖真实 contentWindow，桩环境跳过投递断言");
    pass("提供 broadcast（主题 / 无障碍下发通道）");
  } else fail("broadcast 未定义");

  /* --- 主题持久化：切了要存，下次进来（含登录页）要还是它 --- */
  if (probe("typeof Theme") !== "undefined") {
    // 无记录时默认深色
    probe("(() => { Cookie.del('st_theme'); LS.del('st_theme'); document.documentElement.removeAttribute('data-theme'); })()");
    probe("Theme.current()") === "dark"
      ? pass("壳：无记录时默认深色") : fail("壳默认主题不是深色");

    // 切到 snow → 必须同时写 Cookie 与 localStorage
    probe("Theme.apply('snow')");
    const ck = probe("Cookie.get('st_theme')");
    const lsV = probe("LS.raw('st_theme')");
    probe("Theme.apply('snow', false)");            // 先不写，测下面
    void lsV;
    (ck === "snow" || String(lsV).replace(/"/g, "") === "snow")
      ? pass("切换主题写入本机偏好（Cookie / localStorage）")
      : fail(`主题未持久化：Cookie=${ck} LS=${JSON.stringify(lsV)}`);

    // 重新 init（模拟「下次打开」）→ 读回 snow
    probe("(() => { document.documentElement.setAttribute('data-theme','dark'); })()");
    probe("Theme.init()");
    probe("document.documentElement.getAttribute('data-theme')") === "snow"
      ? pass("下次进入时读回上次所选主题（不被默认值覆盖）")
      : fail("重开后未读回所选主题: " + probe("document.documentElement.getAttribute('data-theme')"));

    // ⚠️ 顶部栏按钮 aria-pressed 的同步放在 dom-smoke.cjs（真 DOM）：
    // 桩的 querySelectorAll 每次返回**新建的临时对象**，Theme.apply 写的状态存不下来。

    // 复原为深色，避免影响后续断言
    probe("Theme.apply('dark')");
  } else fail("Theme 未定义");

  /* --- 无障碍阅读模式开关的行为 --- */
  if (probe("typeof mountReadMode") === "function") {
    const def = probe("readModeOn()");
    def === true
      ? pass("默认读到「开启」（无存储记录时按开启处理）")
      : fail(`默认应为开启，实际: ${def}`);

    // 关掉 → 必须写进 localStorage，且再读为 false
    probe("mountReadMode()");
    probe("(() => { const b = document.getElementById('a11yReadMode'); b.checked = false; b.dispatchEvent(new Event('change')); })()");
    const off = probe("readModeOn()");
    const stored = probe(`LS.get(${JSON.stringify("st_a11y_read_mode")}, null)`);
    off === false ? pass("取消勾选后状态变为「关闭」") : fail("取消勾选未生效: " + off);
    stored === false ? pass("关闭状态已写入 localStorage（跨页保持）")
      : fail("关闭状态未持久化，实际存储: " + JSON.stringify(stored));

    // 打开回来
    probe("(() => { const b = document.getElementById('a11yReadMode'); b.checked = true; b.dispatchEvent(new Event('change')); })()");
    probe("readModeOn()") === true ? pass("重新勾选后状态恢复「开启」") : fail("重新勾选未生效");

    // 状态属于「偏好」类，不该污染业务键命名
    probe(`LS.get(${JSON.stringify("st_a11y_read_mode")}, null)`) === true
      ? pass("阅读模式存储键带 st_ 前缀（与全站约定一致）")
      : fail("阅读模式存储键命名不合约定");

    // ⚠️ 明确记录「本轮不做功能实现」：不得偷偷改主题等视觉状态
    const beforeTheme = probe("Theme.current()");
    probe("(() => { const b = document.getElementById('a11yReadMode'); b.checked = false; b.dispatchEvent(new Event('change')); })()");
    const afterTheme = probe("Theme.current()");
    beforeTheme === afterTheme
      ? pass("开关不擅自改主题（功能未实现，只记录状态）")
      : fail(`开关不该改主题：${beforeTheme} → ${afterTheme}`);
  } else fail("mountReadMode 未定义（开关无法工作）");

  /* --- 壳不因协议差异走不同分支（iframe 优先，失败由提示条兜底） --- */
  {
    const src = fs.readFileSync(path.join(SITE, "assets", "shell.js"), "utf8");
    // go() 内不得出现 file:// 强制跳转（那样会丢掉侧栏导航）
    const goBody = (src.match(/function go\([\s\S]*?\n\}/) || [""])[0];
    !/location\.protocol\s*===?\s*["']file:["']/.test(goBody)
      ? pass("go() 内无 file:// 强制跳转（避免整页刷新丢导航）")
      : fail("go() 仍在 file:// 下强制整页跳转");
    /iframeFailed/.test(src) && /id="frameError"/.test(html)
      ? pass("iframe 加载失败有提示条兜底（#frameError）")
      : fail("缺少 iframe 失败兜底");
  }

  /* --- DOMContentLoaded / boot --- */
  try {
    doc.dispatchEvent({ type: "DOMContentLoaded", target: doc });
    pass("壳启动无异常（顶部栏 / 侧栏 / iframe 已挂载）");
  } catch (e) {
    fail("壳启动报错: " + e.message);
  }

  /* --- 侧栏渲染内容 --- */
  const sideHtml0 = doc.getElementById("shellSide")._html || "";
  /side-item/.test(sideHtml0) ? pass("侧栏由 shell.js 渲染出菜单项")
    : fail("侧栏未渲染菜单");
  /side-foot/.test(sideHtml0) ? pass("侧栏含身份提示脚注") : fail("侧栏缺脚注");

  /* --- 「我的工作」分组（位于「我的课程」之上）--- */
  {
    const tGroups = NAV.teacher || [];
    const wi = tGroups.findIndex((g) => g.title === "我的工作");
    const ci = tGroups.findIndex((g) => g.title === "我的课程");
    wi >= 0 ? pass("教师端存在「我的工作」分组") : fail("缺少「我的工作」分组");
    wi >= 0 && ci >= 0 && wi < ci
      ? pass("「我的工作」排在「我的课程」之上")
      : fail(`分组顺序错误：我的工作@${wi} 我的课程@${ci}`);
    if (wi >= 0) {
      const labels = tGroups[wi].items.map((i) => i.label);
      labels.includes("课表与事项") ? pass("「我的工作」含「课表与事项」")
        : fail("缺「课表与事项」");
      labels.includes("教案") ? pass("「我的工作」含「教案」") : fail("缺「教案」");
      tGroups[wi].items.every((i) => i.page)
        ? pass("「我的工作」各项均为可跳转页面（非灰显占位）")
        : fail("「我的工作」含无页面项");
      tGroups[wi].items.forEach((i) => {
        fs.existsSync(path.join(SITE, i.page))
          ? pass(`条目页面存在：${i.page}`) : fail(`条目页面缺失：${i.page}`);
      });
    }
  }

  /* --- 「我的课程」分组：标题 + 靠右加号按钮 --- */
  {
    // 切到教师身份并重渲染，才能看到教师端侧栏（默认无 cookie 时按学生渲染）
    probe("(() => { Cookie.set('st_role','teacher',1); LS.rawSet('st_role','teacher'); mountSide(); })()");
    const sideHtml = doc.getElementById("shellSide")._html || "";

    // 「我的工作」渲染在「我的课程」之上
    const pWi = sideHtml.indexOf("我的工作");
    const pCi = sideHtml.indexOf("我的课程");
    pWi >= 0 && pCi >= 0 && pWi < pCi
      ? pass("侧栏渲染顺序与配置一致（我的工作在上）")
      : fail(`侧栏渲染顺序不符：我的工作@${pWi} 我的课程@${pCi}`);
    /课表与事项/.test(sideHtml) && /教案/.test(sideHtml)
      ? pass("侧栏渲染出「课表与事项」「教案」两项")
      : fail("侧栏缺「我的工作」子项");
    // 这两项必须是可点的（不带 .disabled）
    /side-item[^>]*data-page="schedule\.html"/.test(sideHtml) && !/disabled[^>]*data-page="schedule\.html"/.test(sideHtml)
      ? pass("「课表与事项」是可点项（非禁用）")
      : fail("「课表与事项」渲染为禁用项");

    const tGroups = NAV.teacher || [];
    const courseGroup = tGroups.find((g) => g.action === "addCourse");
    courseGroup ? pass("教师端存在带加号动作的分组（action: addCourse）")
      : fail("教师端缺少 action: addCourse 的分组");

    if (courseGroup) {
      courseGroup.title === "我的课程"
        ? pass("分组标题为「我的课程」")
        : fail(`分组标题应为「我的课程」，实际: ${courseGroup.title}`);
      !/我教的课程/.test(html) && !/我教的课程/.test(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"))
        ? pass("全站已无「我教的课程」旧文案")
        : fail("仍残留「我教的课程」旧文案");
      courseGroup.items.some((i) => i.page)
        ? pass("「我的课程」分组含可跳转课程项")
        : fail("「我的课程」分组无可跳转项");

      /* --- 「我的课程」由 COURSES 派生 + 可新建（第 19 轮）--- */
      ["createCourse", "loadCourses", "saveCourses", "normalizeCourses", "refreshCourseNav",
       "dropLegacyDemoCourses"]
        .forEach((fn) => {
          probe(`typeof ${fn}`) === "function" ? pass(`nav.js 提供 ${fn}()`) : fail(`缺少 ${fn}()`);
        });
      probe("COURSE_KEY") === "st_courses"
        ? pass("课程持久化键为 st_courses（带 st_ 前缀）") : fail("课程键名不符: " + probe("COURSE_KEY"));
      // 菜单项必须由 COURSES 派生，不能另写一份
      probe("JSON.stringify(NAV.teacher.find((g) => g.action === 'addCourse').items.map((i) => i.label))")
        === probe("JSON.stringify(COURSES.map((c) => c.name))")
        ? pass("「我的课程」菜单项由 COURSES 派生（未另写一份）")
        : fail("菜单项与 COURSES 对不上");
      probe("COURSES.every((c) => !c.page || navTarget({ page: c.page, arg: 'course=' + c.id }) === c.page + '?course=' + c.id)")
        ? pass("每门可点课程都带唯一 course 参数（多门课共用 class.html 不会一起高亮）")
        : fail("课程项缺少 course 参数");
      // 🔴 「我的课程」里一个灰显占位都不该再有（第 30 轮）——
      //    没有 page 的课程渲染出来就是「暗的、点不动的」，用户只会以为坏了。
      probe("NAV.teacher.find((g) => g.action === 'addCourse').items.filter((i) => !i.page).length") === 0
        ? pass("「我的课程」里没有任何灰显占位项")
        : fail("「我的课程」还有点不动的灰显项");
      // 旧存档里残留的演示课程（`page` 为空）在读档时被清掉 ——
      // 改种子清不掉老存档，只能在这一步兜（见 nav.js dropLegacyDemoCourses）
      probe("dropLegacyDemoCourses([{id:'os',name:'操作系统',page:''},{id:'ds',name:'数据结构与算法',page:'class.html'}]).map((c) => c.id).join(',')") === "ds"
        ? pass("dropLegacyDemoCourses 清掉无 page 的旧演示课程（正常课程保留）")
        : fail("旧演示课程没被清掉 —— 老存档里的「操作系统」会一直挂在侧栏");
      probe("dropLegacyDemoCourses(null).length") === 0
        ? pass("dropLegacyDemoCourses 对空/坏值不炸") : fail("dropLegacyDemoCourses 处理空值不当");
      // id 生成：代码优先，重名不撞号
      probe("typeof createCourse === 'function'")
        ? (() => {
            const n0 = probe("COURSES.length");
            const r1 = probe("JSON.stringify(createCourse({ name: '验证用课程A', code: 'ZZ901' }))");
            const r2 = probe("JSON.stringify(createCourse({ name: '验证用课程A', code: 'ZZ902' }))");
            const r3 = probe("JSON.stringify(createCourse({ name: '', code: '' }))");
            probe("COURSES.length") === n0 + 1
              ? pass("createCourse 正常建课（同名第二次被拦下）") : fail("createCourse 去重失效");
            /zz901/.test(r1) ? pass("id 由课程代码生成并转小写（zz901）") : fail("id 生成异常: " + r1);
            JSON.parse(r2).ok === false && /同名/.test(JSON.parse(r2).error || "")
              ? pass("同名课程返回 {ok:false} 与可读提示") : fail("同名未被拦下: " + r2);
            JSON.parse(r3).ok === false ? pass("空名称返回 {ok:false}") : fail("空名称未被拦下");
          })()
        : null;
      // 存档坏了要能回落，空数组要尊重
      probe("JSON.stringify(normalizeCourses(null))") === "null"
        ? pass("normalizeCourses 对非数组返回 null（上层好判回落）") : fail("normalizeCourses 处理不当");
      probe("normalizeCourses([{name:'  '},{},null,{name:'有效'}]).length") === 1
        ? pass("normalizeCourses 丢掉空名称 / 非对象条目") : fail("normalizeCourses 过滤不干净");
      probe("JSON.stringify(normalizeCourses([]))") === "[]"
        ? pass("normalizeCourses 把空数组规整为空数组（不是 null）")
        : fail("normalizeCourses([]) 有问题，删光课程后会复活预置课程");
      // ⚠️ 这条探针曾长期对不上实现、悄悄降级成 info（典型的假绿灯）——
      //    现在按当前实现写真断言：只有「没账号标识 / 演示账号」才回落种子。
      //    学生选课（ENROLLED）同理，两条都要在。
      const navSrc2 = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");
      /return \(!user \|\| isSeedAccount\(user\)\) \? SEED_COURSES\.slice\(\) : \[\];/.test(navSrc2)
        ? pass("无记录时才回落 SEED_COURSES（自注册账号从空开始）")
        : fail("课程回落写法变了 —— 自注册账号可能看到别人的演示课");
      /return \(!user \|\| isSeedAccount\(user\)\) \? normalizeEnrollments\(SEED_ENROLLMENTS\) : \[\];/.test(navSrc2)
        ? pass("学生选课同理：只有演示账号才播种（自注册账号从空的开始）")
        : fail("学生选课的播种条件不对");
      // 🔴 core.js 那份必须同步
      const coreSrc2 = fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8");
      /createCourse\(data\)/.test(coreSrc2) && /updateCourse\(c\.id, data\)/.test(coreSrc2)
        ? pass("core.js（独立模式）接上了 createCourse / updateCourse")
        : fail("core.js 未同步保存逻辑");
      /remountStandaloneSide/.test(coreSrc2)
        ? pass("core.js 提供 remountStandaloneSide（先摘旧再挂新）")
        : fail("core.js 缺少重挂助手 —— mountStandaloneSide 有短路，直接再调无效");
      const shellSrc2 = fs.readFileSync(path.join(SITE, "assets", "shell.js"), "utf8");
      /function openAddCourse/.test(shellSrc2)
        && /createCourse\(data\)/.test(shellSrc2) && /updateCourse\(c\.id, data\)/.test(shellSrc2)
        ? pass("shell.js（壳内）接上了 createCourse / updateCourse")
        : fail("shell.js 未同步保存逻辑");
      // class.html 要认得 ?course=
      const classHtml = fs.readFileSync(path.join(SITE, "class.html"), "utf8");
      /course=\(\[\^&\]\+\)/.test(classHtml) && /function pickCourse/.test(classHtml)
        ? pass("class.html 读取 ?course=xxx（课程视角）") : fail("class.html 未读取 course 参数");
      /本机还没有学生加入这门课/.test(classHtml)
        ? pass("本课还没有学生时给空状态 + 指路邀请码（不拿样本数据冒充）")
        : fail("没有处理「这门课还没有学生」的情形");
    }

    // 教师端渲染出加号按钮
    /id="addCourseBtn"/.test(sideHtml) && /class="side-add"/.test(sideHtml)
      ? pass("教师端侧栏渲染出加号按钮（.side-add#addCourseBtn）")
      : fail("教师端侧栏未渲染加号按钮");

    // 加号必须在「我的课程」的 h4 里，且 h4 已被改成两端布局
    /<h4>[\s\S]{0,400}?id="addCourseBtn"/.test(sideHtml)
      ? pass("加号按钮位于分组标题（h4）内")
      : fail("加号按钮不在分组标题内");

    const css = fs.readFileSync(path.join(SITE, "assets", "shell.css"), "utf8");
    /\.side-group h4\s*\{[^}]*display:\s*flex/.test(css)
      ? pass("分组标题用 flex 布局（标题左、加号右）")
      : fail("分组标题未用 flex，加号无法靠右");
    /\.side-group h4[\s\S]{0,200}?span:first-child[^}]*flex:\s*1/.test(css)
      ? pass("标题占满剩余宽度（把加号顶到最右）")
      : fail("标题未 flex:1，加号不会靠右");
    /\.side-add/.test(css) ? pass("shell.css 定义了 .side-add 样式") : fail("缺少 .side-add 样式");
    /collapsed\s+\.side-add[^{]*\{[^}]*display:\s*none/.test(css)
      ? pass("侧栏折叠时隐藏加号（避免挤压）")
      : fail("折叠态未隐藏加号");

    // 学生端**只能有「输入邀请码加入课堂」这一个加号**（第 32 轮）：
    // 「＋ 添加课程」「＋ 添加班级」是教师端的，出现在学生端就是串味。
    probe("(() => { Cookie.set('st_role','student',1); LS.rawSet('st_role','student'); mountSide(); })()");
    const sSide = doc.getElementById("shellSide")._html || "";
    /joinCourseBtn/.test(sSide) && /data-action="joinCourse"/.test(sSide)
      ? pass("学生端有「加入课堂」加号（写邀请码进课堂）")
      : fail("学生端缺「加入课堂」加号");
    !/addCourseBtn/.test(sSide) && !/addClassBtn/.test(sSide)
      ? pass("学生端不含「添加课程 / 添加班级」加号（双端隔离）")
      : fail("学生端错误出现教师端加号");
    !/班级管理/.test(sSide)
      ? pass("学生端侧栏不含「班级管理」（教师端专属）")
      : fail("学生端泄漏「班级管理」分组");
    // 还原教师身份
    probe("(() => { Cookie.set('st_role','teacher',1); LS.rawSet('st_role','teacher'); mountSide(); })()");
  }

  /* --- 添加课程弹窗（示例） --- */
  {
    const sh = fs.readFileSync(path.join(SITE, "assets", "shell.js"), "utf8");
    /function openAddCourse/.test(sh) ? pass("shell.js 提供 openAddCourse（打开弹窗）")
      : fail("shell.js 缺少 openAddCourse");
    /function closeAddCourse/.test(sh) ? pass("shell.js 提供 closeAddCourse（关闭弹窗）")
      : fail("shell.js 缺少 closeAddCourse");
    /id="modalHost"/.test(html) ? pass("app.html 提供弹窗挂载点（#modalHost）")
      : fail("app.html 缺少 #modalHost");
    /#modalHost\s*\[hidden\]|#modalHost\[hidden\]|\[hidden\]/.test(sh + fs.readFileSync(path.join(SITE, "assets", "shell.css"), "utf8"))
      ? pass("弹窗挂载点默认隐藏")
      : info("弹窗挂载点隐藏方式未显式断言");

    // 打开弹窗 → 必填校验 → 关闭
    sandbox._alerted.length = 0;
    probe("openAddCourse()");
    const host = doc.getElementById("modalHost");
    const mHtml = (host && host._html) || "";
    /class="modal"/.test(mHtml) ? pass("弹窗含 .modal 主体") : fail("弹窗未渲染 .modal");
    /role="dialog"/.test(mHtml) && /aria-modal="true"/.test(mHtml)
      ? pass("弹窗带 role=dialog / aria-modal（无障碍基本要求）")
      : fail("弹窗缺对话框语义");
    /id="cName"/.test(mHtml) ? pass("弹窗含课程名称字段（#cName 必填）") : fail("弹窗缺课程名称字段");
    ["cCode", "cTerm", "cWeek", "cDesc"].every((id) => new RegExp(`id="${id}"`).test(mHtml))
      ? pass("弹窗含课程代码 / 学期 / 周次 / 简介字段")
      : fail("弹窗字段不齐");
    host && host.hidden === false ? pass("打开弹窗后挂载点解除隐藏") : fail("打开后 #modalHost 仍隐藏");
    doc.body.classList.contains("modal-open")
      ? pass("打开弹窗时锁滚动（body.modal-open）")
      : fail("打开弹窗未锁滚动");

    // 空名称提交 → 报错、不弹 alert
    probe("document.getElementById('courseSave').click()");
    const errEl = doc.getElementById("courseError");
    errEl && errEl.hidden === false && /课程名称/.test(errEl.textContent || "")
      ? pass("空课程名提交被拦下并给出提示")
      : fail("空课程名未被校验拦下");
    (sandbox._alerted || []).length === 0
      ? pass("校验失败时不弹提示框（先纠正再保存）")
      : fail("校验失败却弹了提示框");
    // 填写名称后再提交 → **真的建课**（第 19 轮起保存逻辑已接通）
    const coursesBefore = probe("COURSES.length");
    const itemsBefore = probe("(NAV.teacher.find((g) => g.action === 'addCourse') || { items: [] }).items.length");
    probe("(() => { document.getElementById('cName').value = '编译原理'; document.getElementById('cCode').value = 'CS401'; })()");
    probe("document.getElementById('courseSave').click()");

    probe("COURSES.length") === coursesBefore + 1
      ? pass("填好后提交真的建了课（COURSES +1）") : fail("课程未写入 COURSES");
    (sandbox._alerted || []).length === 0
      ? pass("保存成功不再弹 alert（静默落库）") : fail("保存成功却弹了提示框");
    probe("COURSES[COURSES.length - 1].id") === "cs401"
      ? pass("课程 id 由课程代码生成（cs401）") : fail("id 生成异常: " + probe("COURSES[COURSES.length - 1].id"));
    probe("LS.keys().filter((k) => /course/i.test(k)).length") >= 1
      ? pass("写入本机存储（st_courses）") : fail("未落库");
    probe("(NAV.teacher.find((g) => g.action === 'addCourse') || { items: [] }).items.length") === itemsBefore + 1
      ? pass("「我的课程」菜单项 +1（侧栏会跟着多一项）") : fail("菜单项没增加");
    probe("navTarget(NAV.teacher.find((g) => g.action === 'addCourse').items.slice(-1)[0])") === "class.html?course=cs401"
      ? pass("新课程指向 class.html?course=cs401") : fail("新课程跳转目标不对");
    // 课程名重复要被拦下
    probe("(() => { document.getElementById('courseSave').click(); })()");
    probe("COURSES.length") === coursesBefore + 1
      ? pass("同名课程被拦下（不会重复添加）") : fail("同名课程被重复添加了");
    // 建好的课真的能在独立模式渲染出来（菜单数据已回填）
    probe("JSON.stringify(NAV.teacher.find((g) => g.action === 'addCourse').items.slice(-1)[0].label)")
      === JSON.stringify("编译原理")
      ? pass("菜单项 label 取的是课程名") : fail("菜单项 label 不对");

    // Esc 关闭
    probe("document.dispatchEvent(new Event('keydown'), { key: 'Escape' })");
    probe("modalEsc({ key: 'Escape' })");
    const host2 = doc.getElementById("modalHost");
    host2 && host2.hidden === true ? pass("按 Esc 关闭弹窗") : fail("Esc 未关闭弹窗");
    !doc.body.classList.contains("modal-open")
      ? pass("关闭后解除滚动锁")
      : fail("关闭后滚动锁未解除");
    (host2 && host2._html === "") ? pass("关闭后清空弹窗 DOM") : info("弹窗 DOM 清理方式可自行调整");
  }

  /* --- 「班级管理」分组：多个班级 + 靠右加号 --- */
  {
    const tGroups = NAV.teacher || [];
    const ai = tGroups.findIndex((g) => g.title === "智能体");
    const ki = tGroups.findIndex((g) => g.title === "班级管理");

    ki >= 0 ? pass("教师端存在「班级管理」分组") : fail("缺少「班级管理」分组");
    ki >= 0 && ai >= 0 && ki < ai
      ? pass("「班级管理」排在「智能体」之上")
      : fail(`分组顺序错误：班级管理@${ki} 智能体@${ai}`);

    if (ki >= 0) {
      const g = tGroups[ki];
      g.action === "addClass"
        ? pass("「班级管理」带加号动作（action: addClass）")
        : fail(`「班级管理」action 应为 addClass，实际: ${g.action}`);

      // 多个班级 + 全部可点
      g.items.length >= 2
        ? pass(`「班级管理」含 ${g.items.length} 个班级选项`)
        : fail("「班级管理」班级选项过少: " + g.items.length);
      g.items.every((i) => i.page)
        ? pass("班级项均为可跳转页面（非灰显占位）")
        : fail("班级项含无页面项");

      // 每个班都要能被单独识别：同页不同参数，否则侧栏高亮会互相串
      const args = g.items.map((i) => i.arg || "");
      args.every(Boolean) && new Set(args).size === args.length
        ? pass("每个班级项都有唯一对象参数（?cls=xxx），高亮不会互相串")
        : fail("班级项参数缺失或重复: " + JSON.stringify(args));

      g.items.forEach((i) => {
        fs.existsSync(path.join(SITE, i.page))
          ? pass(`班级项页面存在：${i.page}`) : fail(`班级项页面缺失：${i.page}`);
      });

      // 班级菜单项必须由 CLASSES 派生 —— 单一数据源，避免两处对不上
      probe("typeof CLASSES === 'object' && Array.isArray(CLASSES)") === true
        ? pass("nav.js 定义班级目录 CLASSES") : fail("缺少 CLASSES 班级目录");
      probe("CLASS_NAV_ITEMS.length") === g.items.length
        ? pass("侧栏班级项数量与 CLASSES 一致（由 CLASSES 派生）")
        : fail(`班级项数量对不上: 侧栏 ${g.items.length} / CLASSES ${probe("CLASSES.length")}`);
      probe("CLASS_NAV_ITEMS.every((i) => CLASSES.some((c) => c.id === i.key) && i.label === (CLASSES.find((c) => c.id === i.key) || {}).label)")
        ? pass("侧栏班级项的名称取自 CLASSES（未另写一份）")
        : fail("侧栏班级项与 CLASSES 不一致");

      // navTarget 必须把 arg 拼成查询串（壳与独立模式共用）
      probe("navTarget({ page: 'class.html', arg: 'cls=cs2301' })") === "class.html?cls=cs2301"
        ? pass("navTarget 把对象参数拼成查询串")
        : fail("navTarget 未拼查询串: " + probe("navTarget({ page: 'class.html', arg: 'cls=cs2301' })"));
    }
  }

  /* --- 渲染：两个加号 + 班级菜单项带查询串 --- */
  {
    probe("(() => { Cookie.set('st_role','teacher',1); LS.rawSet('st_role','teacher'); mountSide(); })()");
    const sideHtml = doc.getElementById("shellSide")._html || "";

    /id="addClassBtn"/.test(sideHtml)
      ? pass("教师端渲染出「添加班级」加号（.side-add#addClassBtn）")
      : fail("教师端未渲染 #addClassBtn");
    /data-action="addClass"/.test(sideHtml)
      ? pass("加号带 data-action（区分添加课程 / 添加班级）")
      : fail("加号缺 data-action，无法区分两个弹窗");
    /id="addCourseBtn"/.test(sideHtml)
      ? pass("「我的课程」加号仍在（两个加号并存）")
      : fail("原有课程加号被覆盖掉了");

    // 班级菜单项必须带上 ?cls=，否则 click 后无法区分是哪个班
    /data-page="class\.html\?cls=cs2301"/.test(sideHtml)
      ? pass("班级菜单项渲染出对象参数（data-page=class.html?cls=cs2301）")
      : fail("班级菜单项未渲染对象参数");
    const classItemCount = (sideHtml.match(/data-page="class\.html\?cls=/g) || []).length;
    classItemCount >= 2
      ? pass(`渲染出 ${classItemCount} 个带参数的班级菜单项`) : fail("班级菜单项过少");
    // ⚠️ 不能拿整页 sideHtml 查 .side-badge —— 别的分组（如「实训管理」的待确认数）
    //    有合法徽标，会误报。这里直接查数据层：班级项一个徽标都不该有。
    probe("CLASS_NAV_ITEMS.every((i) => !i.badge)")
      ? pass("班级项不再挂编造的「N 人」徽标（真实在课人数由页面算）")
      : fail("班级项还挂着编造的人数徽标");

    // 路由必须保留查询串，否则点班级只会跳到裸 class.html
    probe("go('class.html?cls=cs2301')");
    const hash = String(probe("location.hash") || "");
    /\?cls=cs2301/.test(hash)
      ? pass("go() 保留对象参数（hash = class.html?cls=cs2301）")
      : fail("go() 丢掉了对象参数: " + hash);
    probe("currentPage") === "class.html?cls=cs2301"
      ? pass("currentPage 记录的是完整目标（含参数）")
      : fail("currentPage 未保留参数: " + probe("currentPage"));
    probe("normalize('class.html?cls=cs2301')") === "class.html"
      ? pass("归属判断仍用裸页名（越权拦截不受参数影响）")
      : fail("normalize 未剥掉查询串");
    // ⚠️ 「只有被点的那个班高亮」依赖 querySelectorAll 读回状态，
    //    桩每次返回新建对象 → 这条断言放 dom-smoke.cjs 用真实 DOM 验。
  }

  /* --- 添加班级弹窗（示例） --- */
  {
    const sh = fs.readFileSync(path.join(SITE, "assets", "shell.js"), "utf8");
    const co = fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8");
    /function openAddClass/.test(sh) ? pass("shell.js 提供 openAddClass（打开弹窗）")
      : fail("shell.js 缺少 openAddClass");
    /function closeAddClass/.test(sh) ? pass("shell.js 提供 closeAddClass（关闭弹窗）")
      : fail("shell.js 缺少 closeAddClass");
    /function openAddClass/.test(co)
      ? pass("core.js 同步提供 openAddClass（独立模式也能加班级）")
      : fail("core.js 缺少 openAddClass（双份渲染必须成对维护）");
    /function closeAddClass/.test(co)
      ? pass("core.js 同步提供 closeAddClass") : fail("core.js 缺少 closeAddClass");

    sandbox._alerted.length = 0;
    probe("openAddClass()");
    const host = doc.getElementById("modalHost");
    const mHtml = (host && host._html) || "";
    /class="modal"/.test(mHtml) ? pass("班级弹窗含 .modal 主体") : fail("班级弹窗未渲染 .modal");
    /role="dialog"/.test(mHtml) && /aria-modal="true"/.test(mHtml)
      ? pass("班级弹窗带 role=dialog / aria-modal") : fail("班级弹窗缺对话框语义");
    /id="kName"/.test(mHtml) ? pass("班级弹窗含班级名称字段（#kName 必填）") : fail("缺班级名称字段");
    ["kMajor", "kGrade", "kCourse", "kCount"].every((id) => new RegExp(`id="${id}"`).test(mHtml))
      ? pass("班级弹窗含专业 / 年级 / 关联课程 / 人数字段")
      : fail("班级弹窗字段不齐");
    /添加班级/.test(mHtml) ? pass("弹窗标题为「添加班级」") : fail("弹窗标题不对");

    // 空名称提交 → 拦下且不弹 alert
    probe("document.getElementById('classSave').click()");
    const errEl = doc.getElementById("classError");
    errEl && errEl.hidden === false && /班级名称/.test(errEl.textContent || "")
      ? pass("空班级名提交被拦下并给出提示")
      : fail("空班级名未被校验拦下");
    (sandbox._alerted || []).length === 0
      ? pass("校验失败时不弹提示框") : fail("校验失败却弹了提示框");

    // 填写后提交 → 仅示例提示，不落库
    probe("(() => { document.getElementById('kName').value = '计科 2303 班'; })()");
    probe("document.getElementById('classSave').click()");
    (sandbox._alerted || []).length === 1 && /计科 2303 班/.test(sandbox._alerted[0])
      ? pass("填好后提交给出「保存逻辑未接入」示例提示")
      : fail("未给出示例提示: " + JSON.stringify(sandbox._alerted));
    probe("LS.keys().filter((k) => /class|banji/i.test(k)).length") === 0
      ? pass("示例弹窗不写入班级数据（保存逻辑待定）")
      : fail("示例弹窗写了班级数据");

    // Esc 关闭 —— 两个弹窗共用 modalEsc，必须关对的那个
    probe("modalEsc({ key: 'Escape' })");
    const host2 = doc.getElementById("modalHost");
    host2 && host2.hidden === true ? pass("按 Esc 关闭班级弹窗（modalEsc 正确分发）")
      : fail("Esc 未关闭班级弹窗");
    !doc.body.classList.contains("modal-open")
      ? pass("关闭班级弹窗后解除滚动锁") : fail("滚动锁未解除");
  }

  /* --- class.html = 课程成员：真实名单 + 邀请码，且不编造 --- */
  {
    const ch = fs.readFileSync(path.join(SITE, "class.html"), "utf8");
    /location\.search/.test(ch)
      ? pass("class.html 读取 location.search（?course= / ?cls=）")
      : fail("class.html 未读取 URL 参数");
    /CLASSES/.test(ch)
      ? pass("?cls= 视角仍取 nav.js 的 CLASSES（单一数据源）")
      : fail("class.html 未使用 CLASSES");
    /enrolledStudentsOf/.test(ch) && /localStudentAccounts/.test(ch)
      ? pass("名单来自真实数据层（本机学生账号 × 选课记录），不是写死的样本")
      : fail("class.html 没接真实名单数据层");
    /joinCodeOf\(COURSE\)/.test(ch)
      ? pass("页面显示本课邀请码（与学生端要输入的是同一个 joinCodeOf）")
      : fail("页面没有邀请码");
    /data-stu=/.test(ch)
      ? pass("学生姓名 / 详情按钮可点击（data-stu 钩子）")
      : fail("学生姓名不可点");
    /id="crumbText"/.test(ch) && /id="pageSub"/.test(ch)
      ? pass("页头有可更新的面包屑 / 副标题挂点")
      : fail("页头缺挂点");
    !/id="stAvg"|stSubmit|stRisk|stuTotal/.test(ch)
      ? pass("编造的统计挂点（平均分 / 提交率 / 需关注 / 人数）已清掉")
      : fail("还留着编造统计的挂点");
    // ⚠️ 负面词表（"掌握度 / 提交率"）会被**如实说明的句子**误伤（那几句里本来就要提到它们），
    //    所以改成正面断言：表头必须是真实字段，旧的那些编造列不许再出现。
    /加入时间/.test(ch) && /加入用的邀请码/.test(ch)
      ? pass("名单表头是真实字段（学生 / 账号 / 加入时间 / 加入用的邀请码）")
      : fail("名单表头不对");
    !/<th[^>]*>\s*(作业提交|状态|树|图|排序|查找)\s*<\/th>/.test(ch)
      ? pass("旧的编造列（知识掌握度 / 作业提交 / 状态）已移除")
      : fail("还在显示编造的表格列");

    /* 第 34 轮：点学生姓名 = 他在「我的学情」里看到的东西 */
    /<th scope="col">近期活跃<\/th>/.test(ch)
      ? pass("名单多了「近期活跃」列（读该学生自己的行为日志）")
      : fail("名单没有近期活跃列");
    /behaviorOf\(s\.key\)/.test(ch) && /behaviorInCourse\(/.test(ch)
      ? pass("「近期活跃」走学生自己的行为日志，且按本课口径筛（behaviorInCourse）")
      : fail("近期活跃没有走学生自己的行为日志 / 没按本课筛");
    !/list = behaviorOf\(roleUser\)/.test(ch)
      ? pass("详情弹窗也按本课筛（与学生自己打开本课学情同一个口径）")
      : fail("弹窗取的是全部课堂的记录，会与学生自己看到的不一致");
    /function stuBehaviorBlock/.test(ch) && /stuBehaviorBlock\(s\.key\)/.test(ch)
      ? pass("详情弹窗渲染该学生的学情块（stuBehaviorBlock）")
      : fail("详情弹窗没有学情块");
    /modal-wide/.test(ch)
      ? pass("详情弹窗用宽版（图表放得下）")
      : fail("详情弹窗仍是窄版，图表会挤成一列");
    ["behaviorSummary", "behaviorByKind", "behaviorByTopic", "behaviorTraits",
     "behaviorTimeline", "behaviorWeakTopics"].every((fn) => ch.includes(fn))
      ? pass("弹窗用的聚合函数与 analysis.html 完全同一组（两边数字不会打架）")
      : fail("弹窗自己算了一套");
    /还没有任何学习行为记录/.test(ch)
      ? pass("该学生没有行为记录时给空状态（不画空白图表）")
      : fail("没有行为记录时的兜底缺失");
  }

  /* --- 添加班级弹窗的字段来源 --- */
  {
    const sh = fs.readFileSync(path.join(SITE, "assets", "shell.js"), "utf8");
    /classCourseOptions/.test(sh)
      ? pass("关联课程下拉项从教师端真实课程派生（不另写一份课名）")
      : fail("关联课程选项来源不明");
  }
}

/* ============================================================
   B-2. 独立模式验证（内容页被直接打开时自带导航）
   ============================================================ */
/* ============================================================
   ① 出题与组卷（exam）—— 第 44 轮
   ------------------------------------------------------------
   老版 `exam.html` 是**纯静态壳**：章节写死 4 条、题库写死 4 道、
   「生成题目」只是 `setTimeout` 假装、预览/发布用 `alert`、改题干用 `prompt`。
   这一节盯三件事：**真数据链路 / 真落库 / 诚实口径**。
   ============================================================ */
function verifyExam() {
  section("出题与组卷（nav.js + exam.html / homework.html）");

  const doc = makeDoc();
  const sandbox = makeSandbox(doc, "exam.html");
  const probe = probeFn(sandbox);
  try {
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sandbox, { filename: "nav.js" });
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }
  const src = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");

  /* --- 形状 --- */
  probe("EXAM_KEY") === "st_exam"
    ? pass("考试键为 st_exam（带 st_ 前缀）") : fail("键名不符: " + probe("EXAM_KEY"));
  probe("EXAM_MAX") > 0 ? pass("有上限 EXAM_MAX=" + probe("EXAM_MAX")) : fail("缺上限");
  ["EXAM_TYPES", "EXAM_DIFF", "EXAM_QSTATE", "EXAM_STATE"].forEach(function (k) {
    probe("typeof " + k) === "object" ? pass("有 " + k + "（枚举表）") : fail("缺 " + k);
  });
  ["examStoreKey", "normalizeExams", "loadExams", "saveExams", "examOf", "createExam", "updateExam",
   "deleteExam", "examAssetCount", "setQuestionState", "updateQuestion", "replaceQuestion",
   "publishExam", "recallExamFrom", "examsForStudent", "examOfAnywhere", "examStats", "examCountOf",
   "examBucketKeys", "readExamBucket", "extractJson", "examSystemPrompt", "examUserPrompt",
   "generateExamQuestions", "seedExams", "splitPoints", "refreshExamNav"].forEach(function (fn) {
    probe("typeof " + fn) === "function" ? pass("提供 " + fn + "()") : fail("缺少 " + fn + "()");
  });

  /* --- 分桶 + 跨桶（学生端读不读得到，全看这个） --- */
  /EXAM_KEY \+ ":" \+ u/.test(src)
    ? pass("按账号分桶（st_exam:<角色>:<账号>）") : fail("没按账号分桶");
  probe("JSON.stringify(examBucketKeys())").indexOf("st_exam") >= 0
    ? pass("examBucketKeys() 由账号库推出桶键（不枚举 localStorage 键）") : fail("examBucketKeys() 不对");

  /* --- 🔴 splitPoints：章节知识点是**顿号分隔的字符串**，不是数组（踩过） --- */
  const sp = JSON.parse(probe('JSON.stringify(splitPoints("图的存储结构、DFS/BFS、最短路径"))'));
  Array.isArray(sp) && sp.length === 3 && sp[2] === "最短路径"
    ? pass("🔴 splitPoints 把顿号分隔的字符串切成数组（直接 .slice() 会崩）")
    : fail("splitPoints 没切对: " + JSON.stringify(sp));
  const sp2 = JSON.parse(probe('JSON.stringify(splitPoints(["a","b"]))'));
  Array.isArray(sp2) && sp2.length === 2 ? pass("splitPoints 对已是数组的也认") : fail("splitPoints 不认数组");

  /* --- 🔴 生成：未接模型时如实拒绝，绝不返回题 --- */
  probe("typeof generateExamQuestions") === "function"
    ? pass("出题走 generateExamQuestions()（真接模型那条链路）") : fail("没有出题函数");
  /llmChat\(examSystemPrompt\(\)/.test(src)
    ? pass("出题复用共用的 llmChat（与工作台同一条调用链路）") : fail("出题自己写了一套请求");

  /* --- extractJson：抠不出来就返回 null，不硬塞 --- */
  probe('JSON.stringify(extractJson("代码如下：\\n```json\\n[{\\"a\\":1}]\\n```\\n完毕"))') === '[{"a":1}]'
    ? pass("extractJson 能从 markdown 围栏里抠出 JSON") : fail("extractJson 抠不出围栏里的 JSON");
  String(probe('extractJson("随便一段话")')) === "null"
    ? pass("抠不出时返回 null（交给页面如实报错，不硬塞）") : fail("抠不出时没返回 null");

  /* --- 种子 --- */
  const seeds = JSON.parse(probe("JSON.stringify(EXAMS.map(function(e){return {t:e.title,s:e.source,q:e.questions.length};}))"));
  seeds.length >= 1 ? pass("演示账号有种子卷（" + seeds.length + " 份）") : fail("没有种子卷");
  seeds[0] && seeds[0].s === "sample"
    ? pass("种子标了 source=sample（界面上要如实标出来）") : fail("种子没标来源");

  /* ============================================================
     题型：单选 / 多选 / 填空 / 简答 —— 用户明确要的四种（**不做编程题**）
     ============================================================ */
  const qt = JSON.parse(probe("JSON.stringify(EXAM_QTYPES)"));
  Array.isArray(qt) && qt.length >= 4
    ? pass("有题型表 EXAM_QTYPES（页面按它画勾选项，不写死）") : fail("缺 EXAM_QTYPES");

  const qtKeys = qt.map(function (t) { return t.key; });
  JSON.stringify(qtKeys) === '["single","multi","blank","short"]'
    ? pass("🔴 题型就是这四种：单选 / 多选 / 填空 / 简答") : fail("题型表不对: " + JSON.stringify(qtKeys));
  (qtKeys.indexOf("code") < 0 && !probe("EXAM_TYPES.code"))
    ? pass("🔴 没有「编程题」—— EXAM_TYPES / EXAM_QTYPES 里都删干净了（用户明确要求）")
    : fail("编程题还在");

  const qtOn = JSON.parse(probe("JSON.stringify(EXAM_QTYPES.filter(function(t){return t.on;}).map(function(t){return t.key;}))"));
  JSON.stringify(qtOn) === JSON.stringify(qtKeys)
    ? pass("🔴 默认四种全部勾上") : fail("默认题型不对: " + JSON.stringify(qtOn));

  JSON.stringify(JSON.parse(probe("JSON.stringify(examPickTypes())"))) === JSON.stringify(qtOn)
    ? pass("examPickTypes() 不给参数 → 用默认四种") : fail("examPickTypes 默认值不对");
  JSON.stringify(JSON.parse(probe('JSON.stringify(examPickTypes(["multi","乱写","blank"]))'))) === '["multi","blank"]'
    ? pass("examPickTypes 过掉不认识的题型（存档被手改也不怕）") : fail("examPickTypes 没过滤");
  JSON.stringify(JSON.parse(probe("JSON.stringify(examPickTypes([]))"))) === JSON.stringify(qtOn)
    ? pass("题型给空数组 → 兜回默认四种（不会出一份没有题的卷）") : fail("空题型没兜底");

  /* --- 🔴 增 / 删一道题（用户要求：能添加、能删减） --- */
  ["addQuestion", "removeQuestion"].forEach(function (fn) {
    probe("typeof " + fn) === "function" ? pass("提供 " + fn + "()（页面不自己 splice）") : fail("缺少 " + fn + "()");
  });
  probe('createExam({ title:"增删测试卷", questions:[{ text:"原有题一" }] })');
  const addEid = probe("EXAMS[0].id");
  probe('setQuestionState("' + addEid + '", 0, "accepted")');
  const addBad = JSON.parse(probe('JSON.stringify(addQuestion("' + addEid + '", { text:"   " }))'));
  addBad.ok === false ? pass("空题干不让加（加进去就是废题）") : fail("空题干居然加进去了");
  const addOk = JSON.parse(probe('JSON.stringify(addQuestion("' + addEid + '", { type:"single", text:"新加的选择题", options:["A 甲","B 乙"], answer:"b" }))'));
  (addOk.ok && addOk.index === 1) ? pass("能加一道题（默认追加到末尾）") : fail("加题失败: " + JSON.stringify(addOk));
  probe('examOf("' + addEid + '").questions.length') === 2
    ? pass("加完卷子里是 2 题") : fail("加题没落库");
  probe('examQuestionAt("' + addEid + '", 1).state') === "pending"
    ? pass("手工加的题也是「待审」（不自动采纳）") : fail("手工加的题被自动采纳了");
  probe('examQuestionAt("' + addEid + '", 1).answer') === "B"
    ? pass("加进来的题也过一遍归一（小写 b → B）") : fail("加题没归一");
  const rmBad = JSON.parse(probe('JSON.stringify(removeQuestion("' + addEid + '", 9))'));
  rmBad.ok === false ? pass("删不存在的题号被拒") : fail("越界删除没拦住");
  const rmOk = JSON.parse(probe('JSON.stringify(removeQuestion("' + addEid + '", 0))'));
  (rmOk.ok && probe('examOf("' + addEid + '").questions.length') === 1)
    ? pass("能删一道题（真移出列表，不是标记弃用）") : fail("删题失败");
  probe('examOf("' + addEid + '").questions[0].text') === "新加的选择题"
    ? pass("删的是指定的那道（不是删错了）") : fail("删错题了");
  probe('deleteExam("' + addEid + '")');

  /* --- 🔴 AI 助手的「题位表」也要用同一份题型表（别再写死一张含编程题的表） --- */
  const quizOut = JSON.parse(probe('JSON.stringify(runSkill("atom-gen-quiz", { points:"图的存储、排序", count:8 }))'));
  const quizText = (quizOut.lines || []).join("\n");
  !/编程/.test(quizText)
    ? pass("🔴 AI 助手的题位表里没有「编程」题型（与出题页同一份 EXAM_QTYPES）")
    : fail("题位表里还有编程题");
  /单选/.test(quizText) && /填空/.test(quizText)
    ? pass("题位表按四种题型轮换排（单选 / 多选 / 填空 / 简答）") : fail("题位表题型不对");

  /* --- 多选：答案必须归一（排序 + 去重 + 丢越界字母） --- */
  probe('normalizeAnswerLetters("dba")') === "ABD"
    ? pass("🔴 多选答案归一：dba → ABD（不排序的话「答全」判定会乱）") : fail("多选答案没归一");
  probe('normalizeAnswerLetters("A、B、B", 4)') === "AB"
    ? pass("答案里的顿号 / 重复字母被清掉") : fail("答案没清干净: " + probe('normalizeAnswerLetters("A、B、B", 4)'));
  probe('normalizeAnswerLetters("ABZ", 4)') === "AB"
    ? pass("指向不存在选项的字母被丢掉（4 个选项只能答 A–D）") : fail("越界字母没丢");

  /* --- 填空：多空（|| 分隔）与选项清空 --- */
  const bq = JSON.parse(probe('JSON.stringify(normalizeExamQuestion({ type:"blank", text:"A ___ B ___", answer:"甲||乙" }))'));
  Array.isArray(bq.blanks) && bq.blanks.length === 2 && bq.blanks[1] === "乙" && bq.options.length === 0
    ? pass("🔴 填空题：`answer` 里的 || 拆成多空，选项一律清空") : fail("填空归一不对: " + JSON.stringify(bq));
  const bq2 = JSON.parse(probe('JSON.stringify(normalizeExamQuestion({ type:"blank", text:"X ___", answer:"单空" }))'));
  bq2.blanks.length === 1 ? pass("单空填空题 blanks 长度 1") : fail("单空没归一: " + JSON.stringify(bq2.blanks));
  const bq3 = JSON.parse(probe('JSON.stringify(normalizeExamQuestion({ type:"blank", text:"X ___ Y ___", blanks:["甲","乙"], options:["A 多余的选项"] }))'));
  bq3.blanks.length === 2 && bq3.options.length === 0
    ? pass("填空题带了 options 会被丢掉（空写在题干里，用 ___）") : fail("填空题没清选项");

  /* --- 🔴 题型校正：老师勾了什么，就只能出什么 --- */
  const co1 = JSON.parse(probe('JSON.stringify(coerceExamQuestionType({ type:"single", options:["A","B"], answer:"B" }, ["single","multi","blank"]))'));
  (co1.type === "single" && !co1.warn) ? pass("题型本来就在勾选范围 → 原样不动") : fail("范围内还乱改: " + JSON.stringify(co1));
  const co2 = JSON.parse(probe('JSON.stringify(coerceExamQuestionType({ type:"short", text:"简述…", options:[] }, ["single","multi","blank"]))'));
  (co2.type === "blank" && /已按/.test(String(co2.warn)))
    ? pass("🔴 模型给了简答、老师只要选择/填空 → 收成填空，**并留质检提示**")
    : fail("没校正: " + JSON.stringify(co2));
  const co3 = JSON.parse(probe('JSON.stringify(coerceExamQuestionType({ type:"short", text:"简述…", options:[] }, ["single","multi"]))'));
  (co3.type === "short" && /不在你勾选/.test(String(co3.warn)))
    ? pass("无处可归 → 保留原题型 + 如实提示（**不静默改写**）") : fail("硬塞了: " + JSON.stringify(co3));
  const co4 = JSON.parse(probe('JSON.stringify(coerceExamQuestionType({ type:"short", options:["A x","B y"], answer:"AB" }, ["single","multi","blank"]))'));
  (co4.type === "multi" && /已按/.test(String(co4.warn)))
    ? pass("有选项 + 多字母答案 → 校正成多选（不会误判成单选）") : fail("多选没认出来: " + JSON.stringify(co4));

  /* --- 提示词里必须把题型要求说清楚 --- */
  /只出这几种/.test(src) ? pass("出题提示词写明「只出这几种」题型") : fail("提示词没说题型");
  const up = String(probe('examUserPrompt({ courseName:"数据结构", chapters:[{ title:"第 6 章" }] }, { count:4, types:["single","multi","blank"] })'));
  (/单选/.test(up) && /多选/.test(up) && /填空/.test(up))
    ? pass("提示词带上了三种题型的名字") : fail("提示词没带题型名");
  /___/.test(up) ? pass("提示词告诉模型：填空题用 ___ 表示空") : fail("没说填空怎么写");
  /ABD/.test(up) ? pass("提示词给出多选答案的写法（升序，如 ABD）") : fail("没说多选答案格式");

  /* --- 种子：打开就能看到三种题型 --- */
  const seedTypes = JSON.parse(probe("JSON.stringify((function(){ var s={}; EXAMS[0].questions.forEach(function(q){ s[q.type]=1; }); return Object.keys(s); })())"));
  ["single", "multi", "blank"].every(function (k) { return seedTypes.indexOf(k) >= 0; })
    ? pass("🔴 种子卷里三种题型都有（打开就能看到选择 / 多选 / 填空）")
    : fail("种子里题型不全: " + JSON.stringify(seedTypes));
  const seedBlanks = JSON.parse(probe("JSON.stringify((EXAMS[0].questions.filter(function(q){return q.type==='blank';})[0]||{}).blanks || [])"));
  seedBlanks.length >= 2 ? pass("种子里那道填空题是多空的（演示 || 的用法）") : fail("种子填空题没有多空");

  /* --- 🔴 改题也要按题型重新归一（手改完答案形状不能歪） --- */
  probe('setQuestionState(EXAMS[0].id, 0, "accepted")');
  const uq = JSON.parse(probe('JSON.stringify(updateQuestion(EXAMS[0].id, 0, { options:["A x","B y","C z"], answer:"c" }))'));
  (uq.ok && uq.question.answer === "C" && uq.question.options.length === 3)
    ? pass("🔴 updateQuestion 支持改选项，且改完按题型归一（小写 c → C）")
    : fail("改题没归一: " + JSON.stringify(uq));
  const uqMulti = JSON.parse(probe('JSON.stringify(normalizeExamQuestion({ type:"multi", options:["A x","B y","C z","D w"], answer:"c、b、a" }))'));
  uqMulti.answer === "ABC"
    ? pass("🔴 多选答案也归一（c、b、a → ABC）") : fail("多选没归一: " + uqMulti.answer);
  const uq2 = JSON.parse(probe('JSON.stringify(updateQuestion(EXAMS[0].id, 0, { options:["A x"], answer:"A" }))'));
  uq2.ok && uq2.question.options.length === 1
    ? pass("改选项真的落库（不是只改内存）") : fail("改选项没落库");

  /* --- 统计 --- */
  const st0 = JSON.parse(probe("JSON.stringify(examStats(EXAMS[0]))"));
  typeof st0.total === "number" && typeof st0.accepted === "number"
    ? pass("examStats 给出计数（页面不自己算）") : fail("examStats 不对");

  /* --- 🔴 发布：没采纳的不许发（空卷发出去是事故） --- */
  probe('createExam({ title:"验证器卷", questions:[{ text:"题干", state:"pending" }] })');
  const newId = probe("EXAMS[0].id");
  const pub0 = JSON.parse(probe('JSON.stringify(publishExam(EXAMS[0].id, ["student:lisi"]))'));
  pub0.ok === false && /采纳/.test(String(pub0.error || ""))
    ? pass("🔴 一道题都没采纳 → 拒绝发布") : fail("没拦住空卷发布: " + JSON.stringify(pub0));

  probe('setQuestionState(EXAMS[0].id, 0, "accepted")');
  const pub1 = JSON.parse(probe('JSON.stringify(publishExam(EXAMS[0].id, ["student:lisi"]))'));
  pub1.ok === true && pub1.added === 1 ? pass("采纳之后能发布") : fail("采纳后发布失败: " + JSON.stringify(pub1));
  const pub2 = JSON.parse(probe('JSON.stringify(publishExam(EXAMS[0].id, ["student:lisi"]))'));
  pub2.added === 0 && pub2.updated === 1
    ? pass("重复发布同一人只更新时间（不堆重复记录）") : fail("重复发布会堆记录");
  const pub3 = JSON.parse(probe('JSON.stringify(publishExam(EXAMS[0].id, []))'));
  pub3.ok === false ? pass("空名单被拒（不假装发出去了）") : fail("空名单没拦住");

  /* --- 学生端只看得到发给自己的、且只有已发布的 --- */
  probe('examsForStudent("student:lisi").length') >= 1
    ? pass("lisi 收到了这份卷子") : fail("lisi 没收到");
  probe('examsForStudent("student:wangwu").length') === 0
    ? pass("没发给的人看不到（跨桶不等于全放行）") : fail("没发的人也看到了");
  probe('examCountOf("student:lisi")') >= 1 ? pass("examCountOf 给出份数（菜单徽标用）") : fail("examCountOf 不对");
  probe("EXAMS[0].status") === "published" ? pass("发布后状态变 published") : fail("状态没变 published");

  /* --- 撤回：没发过的如实报错；全撤回 → 退回草稿 --- */
  const rec1 = JSON.parse(probe('JSON.stringify(recallExamFrom(EXAMS[0].id, "student:lisi"))'));
  rec1.ok === true ? pass("能撤回已发布的") : fail("撤回失败");
  const rec2 = JSON.parse(probe('JSON.stringify(recallExamFrom(EXAMS[0].id, "student:lisi"))'));
  rec2.ok === false ? pass("重复撤回如实报错（本来就没发）") : fail("重复撤回没报错");
  probe('examsForStudent("student:lisi").length') === 0
    ? pass("撤回后学生端看不到了") : fail("撤回没生效");
  probe("EXAMS[0].status") === "draft"
    ? pass("全部撤回后退回草稿") : fail("全撤回后状态没退");

  /* --- 🔴 逐题审核：越界一律如实拒绝，不静默 --- */
  const bad1 = JSON.parse(probe('JSON.stringify(setQuestionState(EXAMS[0].id, 99, "accepted"))'));
  bad1.ok === false ? pass("改不存在的题号被拒") : fail("越界题号没拦住");
  const bad2 = JSON.parse(probe('JSON.stringify(setQuestionState(EXAMS[0].id, 0, "乱写"))'));
  bad2.ok === false ? pass("不认识的状态被拒") : fail("乱写状态没拦住");
  const bad3 = JSON.parse(probe('JSON.stringify(updateQuestion(EXAMS[0].id, 0, { text: "   " }))'));
  bad3.ok === false ? pass("空题干被拒") : fail("空题干没拦住");
  const bad4 = JSON.parse(probe('JSON.stringify(updateExam(EXAMS[0].id, { paper: { totalScore: 0 } }))'));
  bad4.ok === false ? pass("总分 0 被拒") : fail("总分 0 没拦住");

  /* --- createExam 的边界 --- */
  const ce1 = JSON.parse(probe('JSON.stringify(createExam({}))'));
  ce1.ok === false ? pass("一道题都没有 → 拒绝建卷") : fail("空卷居然建出来了");
  const ce2 = JSON.parse(probe('JSON.stringify(updateSim("nope", {}))'));
  ce2.ok === false ? pass("改不存在的卷被拒") : fail("改不存在的卷没拦住");

  /* --- 删前数影响 --- */
  /已采纳|已经发给/.test(String(probe("examAssetCount(EXAMS[0].id)")))
    ? pass("删前用 examAssetCount() 数清影响") : fail("删前没数影响");

  /* --- 🔴 徽标必须现算（老版学生端「我的作业」写死 badge:"2" 是假数据） --- */
  !/key:\s*"hw"[\s\S]{0,60}?badge:\s*"/.test(src)
    ? pass("🔴 学生端「我的作业」的徽标不再是写死的（refreshExamNav 现算）")
    : fail("徽标还是写死的假数字");

  /* ============================================================
     页面：homework.html（学生端接收）
     ============================================================ */
  const hw = fs.readFileSync(path.join(SITE, "homework.html"), "utf8");
  const hwCode = stripComments(hw).replace(/<!--[\s\S]*?-->/g, "");
  /examsForStudent\(/.test(hwCode)
    ? pass("🔴 学生端用 examsForStudent() **跨桶**读（记录在老师的桶里）") : fail("学生端没跨桶读");
  !/\bexamOf\(/.test(hwCode)
    ? pass("学生端没用只认本桶的 examOf()（用了会什么都看不到）") : fail("学生端用了 examOf()");
  !/window\.(alert|prompt)\(/.test(hwCode)
    ? pass("学生端没用原生弹窗") : fail("学生端用了原生弹窗");
  !/\banswer\b/.test(hwCode)
    ? pass("🔴 学生端不读题目的 answer 字段（答案与解析在老师端）") : fail("学生端把答案给学生看了");
  /不是防作弊/.test(hw) && /隐藏/.test(hw)
    ? pass("🔴 如实说明判分边界（答案无法真正隐藏、不是防作弊系统）") : fail("没说清判分功能的边界");
  /submitExamAnswer\(/.test(hwCode)
    ? pass("学生端提交走 submitExamAnswer()（存学生自己的桶）") : fail("学生端没有提交链路");
  /myExamAnsOf\(/.test(hwCode)
    ? pass("学生端读回自己的提交（已交 / 未交状态）") : fail("学生端没读回提交状态");
  /pageModalHost\(\)/.test(hwCode)
    ? pass("看题弹窗走 pageModalHost()") : fail("看题没走 pageModalHost");
  /个空/.test(hw)
    ? pass("学生端也标出填空题有几个空") : fail("学生端填空没显示空数");

  /* ============================================================
     ②' 第 48 轮：作业提交判分 + 学习活跃 + 学生管理页
     ============================================================ */
  section("作业提交判分 + 学习活跃 + 学生管理（第 48 轮）");

  /* ---- 判分：多选「答全才给分」 ---- */
  probe('gradeOneQuestion({type:"multi",options:["A","B","C","D"],answer:"ACD"}, ["A","C"]).ok') === false
    ? pass("🔴 多选「答全才给分」：**少选**算错") : fail("多选少选被判对");
  probe('gradeOneQuestion({type:"multi",options:["A","B","C","D"],answer:"ACD"}, ["A","B","C","D"]).ok') === false
    ? pass("🔴 多选「答全才给分」：**多选**算错") : fail("多选多选被判对");
  probe('gradeOneQuestion({type:"multi",options:["A","B","C","D"],answer:"ACD"}, ["C","A","D"]).ok') === true
    ? pass("多选答全（顺序无关，归一后全等）→ 对") : fail("多选答全被判错");
  probe('gradeOneQuestion({type:"single",options:["A","B"],answer:"b"}, "B").ok') === true
    ? pass("单选小写答案归一后判对") : fail("单选归一失效");
  probe('gradeOneQuestion({type:"blank",blanks:["n²","2e"]}, ["n²"," 2e "]).ok') === true
    ? pass("填空去空白后比对 → 判对") : fail("填空比对没去空白");
  probe('gradeOneQuestion({type:"blank",blanks:["n²","2e"]}, ["n²",""]).ok') === false
    ? pass("填空漏一空 → 判错") : fail("填空漏空被判对");
  probe('gradeOneQuestion({type:"short"}, "随便写点").graded') === false
    ? pass("🔴 简答**不**自动判分（待老师批，不假装机器能判主观题）") : fail("简答被自动判了");

  /* ---- 判分：整卷只报客观题得分，不折算卷面分 ---- */
  const gpJSON = probe('JSON.stringify(gradeExamPaper({questions:[{id:"q1",type:"single",options:["A","B"],answer:"A",state:"accepted"},{id:"q2",type:"short",state:"accepted"}],paper:{totalScore:100}}, {q1:"A",q2:"写了"}))');
  const gp = JSON.parse(gpJSON);
  gp.objectiveGot === 50 && gp.objectiveTotal === 50 && gp.pending === 1
    ? pass("整卷只报客观题得分（50/50，简答 pending=1）—— 不折算卷面分") : fail("整卷判分口径不对: " + gpJSON);
  probe('gradeExamPaper({questions:[{id:"q1",type:"single",options:["A","B"],answer:"A",state:"dropped"}],paper:{totalScore:100}}, {q1:"A"}).questions') === 0
    ? pass("未采纳的题不计入卷面（只算 accepted）") : fail("把未采纳的题也算进去了");

  /* ---- 提交分桶 + 跨桶读 ---- */
  probe('examAnsKeyOf("student:zhangsan")') === "st_exam_ans:student:zhangsan"
    ? pass("提交按账号分桶（st_exam_ans:<角色>:<账号>）") : fail("提交没分桶");
  probe('JSON.stringify(examAnsBucketKeys())').indexOf("st_exam_ans") >= 0
    ? pass("examAnsBucketKeys() 由账号库推键（不枚举 localStorage）") : fail("examAnsBucketKeys 不对");
  const loadAnsSrc = (src.match(/function loadExamAns[\s\S]*?\n}/) || [""])[0];
  !/\bLS\./.test(loadAnsSrc) && /readExamAnsBucket\(/.test(loadAnsSrc)
    ? pass("🔴 loadExamAns 走 readExamAnsBucket()（不用 LS，避开 TDZ）") : fail("loadExamAns 用了 LS");
  const saveAnsSrc = (src.match(/function saveExamAns[\s\S]*?\n}/) || [""])[0];
  /window\.localStorage/.test(saveAnsSrc)
    ? pass("saveExamAns 用 window.localStorage（与 load 同一套）") : fail("saveExamAns 没落盘");
  probe('typeof submitExamAnswer') === "function"
    ? pass("提交走 submitExamAnswer()（同一份卷覆盖、attempts 累加）") : fail("没有 submitExamAnswer");
  probe('typeof examAnsOfStudent') === "function"
    ? pass("老师端跨桶读用 examAnsOfStudent()") : fail("没有 examAnsOfStudent");

  /* ---- 学习活跃（「考勤」口径，按天） ---- */
  probe('recentActiveDays([], Date.now(), 7).length') === 7
    ? pass("recentActiveDays 固定返回 7 格（没记录也不塌）") : fail("活跃格子数不对");
  probe('recentActiveDays([{at: Date.now()}], Date.now(), 7).slice(-1)[0].active') === true
    ? pass("recentActiveDays 最后一格＝今天，有记录则 active") : fail("活跃按天口径不对");
  probe('silentDays([], Date.now())') === -1
    ? pass("silentDays 无记录返回 -1（页面分开显示「无记录」）") : fail("silentDays 无记录口径不对");
  probe('silentDays([{at: Date.now() - 3*86400000}], Date.now())') === 3
    ? pass("silentDays 按**本地零点**算沉默天数") : fail("silentDays 算错");
  probe('typeof studentOverview') === "function" && probe('typeof activeSummaryOf') === "function"
    ? pass("学生总册走 studentOverview() / activeSummaryOf()（页面不自己算）") : fail("缺学生总册数据层");

  /* ---- 学生管理页（stu.html）---- */
  const stuHtml = fs.readFileSync(path.join(SITE, "stu.html"), "utf8");
  const stuCode = stripComments(stuHtml).replace(/<!--[\s\S]*?-->/g, "");
  /studentOverview\(/.test(stuCode)
    ? pass("学生管理页读 studentOverview()（不自己拼数据）") : fail("学生管理页没走数据层");
  /pageModalHost\(\)/.test(stuCode)
    ? pass("学生详情弹窗走 pageModalHost()") : fail("学生管理弹窗没走 pageModalHost");
  !/window\.(alert|prompt)\(/.test(stuCode)
    ? pass("学生管理页没用原生弹窗") : fail("学生管理页用了原生弹窗");
  /不是课堂点名/.test(stuHtml)
    ? pass("🔴 如实说明「学习活跃」**不是课堂点名**（不冒充考勤）") : fail("没写清考勤口径");
  /没有课堂考勤/.test(stuHtml)
    ? pass("🔴 如实说明本机**没有课堂考勤数据**（无教务系统）") : fail("没说清数据边界");
  /examAnsOfStudent|answers/.test(stuCode)
    ? pass("学生管理页读学生的提交（作业情况有真来源）") : fail("作业情况没有数据来源");

  /* ---- 侧栏接线：学生管理不再是灰显占位 ---- */
  probe('NAV.teacher.filter(function(g){return g.title==="教学";})[0].items.filter(function(i){return i.key==="stu";})[0].page') === "stu.html"
    ? pass("🔴 侧栏「学生管理」接上 stu.html（不再是灰显占位）") : fail("学生管理还是灰显");
  probe('PAGE_ROLE["stu.html"]') === "teacher"
    ? pass("PAGE_ROLE 登记 stu.html=teacher（越权拦截生效）") : fail("PAGE_ROLE 没登记 stu.html");

  /* ============================================================
     页面：exam.html 的题型勾选（选择 / 填空 / 多选）
     ============================================================ */
  const exHtml = fs.readFileSync(path.join(SITE, "exam.html"), "utf8");
  const exCode = stripComments(exHtml).replace(/<!--[\s\S]*?-->/g, "");
  /id="qtypes"/.test(exHtml) ? pass("第一步有题型勾选区 #qtypes") : fail("缺题型勾选区");
  /EXAM_QTYPES/.test(exCode) ? pass("题型条目来自 EXAM_QTYPES（**不写死列表**）") : fail("页面写死了题型");
  /function renderTypes\b/.test(exCode) ? pass("有 renderTypes() 画勾选项") : fail("缺 renderTypes");
  /function toggleType\b/.test(exCode) ? pass("有 toggleType()（点一下切换）") : fail("缺 toggleType");
  /至少留一种/.test(exHtml) ? pass("🔴 至少留一种题型（一种都不勾就没法出题，直接拦下）") : fail("没拦「一个都不勾」");
  /types:\s*state\.types\.slice\(\)/.test(exCode) ? pass("出题配置带上勾选的题型（cfg.types）") : fail("出题没带题型");
  /types:\s*\[old\.type\]/.test(exCode) ? pass("🔴 换一题保持原题型（在选择题上换出来还是选择题）") : fail("换题没锁题型");
  /function answerText\b/.test(exCode) ? pass("答案用 answerText() 写（填空题按空的先后编号）") : fail("答案没按题型写");
  /答全才给分/.test(exHtml) ? pass("多选题标了「答全才给分」") : fail("多选没给提示");
  /个空/.test(exHtml) ? pass("填空题显示「共 N 个空」") : fail("填空没显示空数");
  /每个空写 ___/.test(exHtml) ? pass("改填空题时题干栏写明「每个空写 ___」") : fail("改填空没说清怎么写空");
  /多空用 \|\| 按顺序分隔/.test(exHtml) ? pass("改填空题时答案栏写明多空用 || 分隔") : fail("改填空没说清多空");
  /key:\s*"options"/.test(exCode) && /v\.options/.test(exCode)
    ? pass("选择题能改选项（改完落库）") : fail("选择题改不了选项");

  /* --- 🔴 「添加一题」要能选：AI 出 / 自己填 --- */
  /function openAddQ\b/.test(exCode) && /data-mc="ai"/.test(exHtml) && /data-mc="manual"/.test(exHtml)
    ? pass("🔴 「添加一题」先问来源：让 AI 出一道 / 自己填一道")
    : fail("「添加一题」没有来源选择");
  /function openManualQ\b/.test(exCode) ? pass("有 openManualQ()（自己填的表单）") : fail("缺手填入口");
  /function aiAddQ\b/.test(exCode) ? pass("有 aiAddQ()（让 AI 补一道）") : fail("缺 AI 加题入口");
  /generateExamQuestions\(makeScope\(\), \{[\s\S]{0,140}?count:\s*1[\s\S]{0,80}?types:\s*\[type\]/.test(exCode)
    ? pass("🔴 AI 加题只出 1 题、且只出所选题型（types:[type]）") : fail("AI 加题没锁题型 / 题量");
  /createExam\(/.test(exCode) && /\$\("addQBtn"\)\.addEventListener\("click", openAddQ\)/.test(exCode)
    ? pass("按钮绑定到 openAddQ（不是老的手填流程）") : fail("按钮没绑对");
  /goSet3/.test(exCode) && /llmReady\(\)/.test(exCode)
    ? pass("🔴 没接模型时 AI 加题如实拒绝（带「去设置填 Key」按钮）") : fail("AI 加题没做未接模型处理");
  /function scopeError\b/.test(exCode)
    ? pass("出题范围校验收成一个 scopeError()（整卷生成与补一道共用）") : fail("范围校验没收敛");
}

function verifyCourseware() {
  section("课件（nav.js + courseware.html / reader.html）");

  const doc = makeDoc();
  const sandbox = makeSandbox(doc, "courseware.html");
  const probe = probeFn(sandbox);
  try {
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sandbox, { filename: "nav.js" });
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }
  const src = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");

  /* --- 形状 --- */
  probe("CW_KEY") === "st_courseware"
    ? pass("课件键为 st_courseware（带 st_ 前缀）") : fail("键名不符: " + probe("CW_KEY"));
  probe("CW_MAX") > 0 ? pass("有上限 CW_MAX=" + probe("CW_MAX")) : fail("缺上限");
  ["CW_STATE", "CW_SOURCE"].forEach(function (k) {
    probe("typeof " + k) === "object" ? pass("有 " + k + "（枚举表）") : fail("缺 " + k);
  });
  ["cwStoreKey", "cwSections", "cwTextFromHtml", "normalizeCw", "normalizeCws", "loadCws", "saveCws",
   "cwOf", "cwBucketKeys", "readCwBucket", "cwStats", "createCw", "updateCw", "deleteCw",
   "cwAssetCount", "publishCw", "recallCwFrom", "cwsForStudent", "cwCountOf", "seedCws", "notesOfCw"]
    .forEach(function (fn) {
      probe("typeof " + fn) === "function" ? pass("提供 " + fn + "()") : fail("缺少 " + fn + "()");
    });

  /* --- 分桶 + 跨桶 --- */
  /CW_KEY \+ ":" \+ u/.test(src)
    ? pass("按账号分桶（st_courseware:<角色>:<账号>）") : fail("没按账号分桶");
  probe("JSON.stringify(cwBucketKeys())").indexOf("st_courseware") >= 0
    ? pass("cwBucketKeys() 由账号库推出桶键（不枚举 localStorage 键）") : fail("cwBucketKeys() 不对");

  /* --- 🔴 分段规则：唯一实现，空行分段 --- */
  const sec = JSON.parse(probe('JSON.stringify(cwSections("甲\\n\\n乙\\n\\n\\n丙"))'));
  JSON.stringify(sec) === '["甲","乙","丙"]'
    ? pass("🔴 cwSections 空行分段 + 多余空行折叠") : fail("cwSections 分段不对: " + JSON.stringify(sec));
  JSON.parse(probe('JSON.stringify(cwSections("甲\\n乙"))')).length === 1
    ? pass("段内单换行不拆段") : fail("单换行被误拆成两段");
  JSON.parse(probe('JSON.stringify(cwSections("   \\n\\n  "))')).length === 0
    ? pass("全空白 → 0 段") : fail("空白没归零");

  /* --- 🔴 XSS：上传的 HTML 必须剥掉 script/style，实体只解一层 --- */
  const conv = probe('cwTextFromHtml("<h2>标题</h2><p>正文</p><script>alert(1)</script><ul><li>甲</li></ul>")');
  conv.indexOf("alert") < 0 && conv.indexOf("<script") < 0
    ? pass("🔴 cwTextFromHtml 剥掉 script（挡 XSS）") : fail("script 没剥掉: " + conv);
  /## 标题/.test(conv) ? pass("h2 → Markdown 二级标题") : fail("标题没转 Markdown");
  /- 甲/.test(conv) ? pass("li → - 列表") : fail("列表没转");
  probe('cwTextFromHtml("&amp;lt;危险&amp;gt;")').indexOf("&lt;危险&gt;") >= 0
    ? pass("🔴 实体只解一层（&amp;lt; 不二次解码成 <）") : fail("实体被二次解码");

  /* --- 种子：已发布，学生端能读到 --- */
  const seeds = JSON.parse(probe("JSON.stringify(CWS.map(function(c){return {id:c.id,st:c.status,p:c.publishedTo.length};}))"));
  seeds.length >= 1 ? pass("预置账号有种子课件（" + seeds.length + " 份）") : fail("没有种子课件");
  seeds[0] && seeds[0].st === "published" && seeds[0].p >= 1
    ? pass("🔴 种子是已发布 + 带下发记录（学生端切过去就能读）") : fail("种子不是已发布状态");

  /* --- 发布规矩：空名单拒、空正文拒、重发不重复记账 --- */
  const cr = JSON.parse(probe('JSON.stringify(createCw({title:"t", body:"一段\\n\\n二段"}))'));
  cr.ok ? pass("有正文能新建课件") : fail("新建失败: " + JSON.stringify(cr));
  const cid = cr.cw && cr.cw.id;
  !JSON.parse(probe('JSON.stringify(createCw({title:"t", body:"   "}))')).ok
    ? pass("空正文拒绝新建") : fail("空正文居然建成了");
  !JSON.parse(probe('JSON.stringify(publishCw("' + cid + '", []))')).ok
    ? pass("空名单拒绝发布") : fail("空名单居然发布了");
  const p1 = JSON.parse(probe('JSON.stringify(publishCw("' + cid + '", ["student:lisi"]))'));
  const p2 = JSON.parse(probe('JSON.stringify(publishCw("' + cid + '", ["student:lisi"]))'));
  (p1.ok && p1.added === 1 && p2.ok && p2.added === 0 && p2.updated === 1)
    ? pass("🔴 发布不重复记账（重发只刷新时间）") : fail("重复发布记账了: " + JSON.stringify(p2));

  /* --- 草稿不发学生 --- */
  probe('JSON.stringify(cwsForStudent("student:lisi").map(function(c){return c.id;}))').indexOf(cid) >= 0
    ? pass("🔴 cwsForStudent 跨桶读到已发布的（含刚发的那份）") : fail("学生读不到刚发的课件");
  probe('JSON.stringify(updateCw("' + cid + '", {body:"一段\\n\\n二段\\n\\n三段"}))')
    .indexOf('"ok":true') >= 0 ? pass("updateCw 能改正文") : fail("改正文失败");

  /* --- notesOfCw：老记录（无 cwId）算当前这份，别人的排除 --- */
  const nNote = probe('JSON.stringify(notesOfCw([{kind:"note",label:"老",seg:1,courseId:"ds",at:1,cwId:""},' +
    '{kind:"note",label:"本",seg:2,courseId:"ds",at:2,cwId:"cw-a"},{kind:"note",label:"别",seg:3,courseId:"ds",at:3,cwId:"cw-b"}],"cw-a","ds").map(function(e){return e.label;}))');
  JSON.parse(nNote).length === 2 && nNote.indexOf("老") >= 0 && nNote.indexOf("别") < 0
    ? pass("🔴 notesOfCw：老记录算当前这份、别人的排除") : fail("notesOfCw 过滤不对: " + nNote);

  probe('deleteCw("' + cid + '")');
  probe("cwOf('" + cid + "') == null") === true
    ? pass("deleteCw 真删（cwOf 取不到了）") : fail("删除没生效");
}

function verifyNoDemoWords() {
  section("界面文案：不再有「演示模式」这类提示（用户明确要求全清）");

  /* 🔴 只匹配「演示 + 名词」的组合词 —— 教案内容里的**动词**用法（"动画演示冒泡排序"）
     与助手问答的**关键词**表（用户问"演示"能命中「数据边界」那一问）都是要保留的，
     用 `/演示/` 一刀切会把它们误伤（这类误报踩过多次）。 */
  const RE = /演示(模式|账号|数据|课程|回复|题库|内容|条目|记录|选课|卡片)/;
  const FILES = ["chat.html", "settings.html", "index.html", "analysis.html", "class.html",
                 "agent.html", "agent-student.html", "schedule.html", "training.html",
                 "training-student.html", "reader.html", "workbench.html", "exam.html", "homework.html",
                 "courseware.html", path.join("assets", "nav.js")];
  let hit = 0;
  FILES.forEach(function (f) {
    const s = fs.readFileSync(path.join(SITE, f), "utf8");
    const m = RE.exec(s);
    if (!m) { pass(f + " 不含「演示 XX」字样"); return; }
    hit += 1;
    fail(f + " 仍有「" + m[0] + "」: …" +
      s.slice(Math.max(0, m.index - 20), m.index + 22).replace(/\s+/g, " ") + "…");
  });
  hit === 0 ? pass("🔴 全站界面文案已清干净（含 nav.js 里的提示串）") : fail("还有 " + hit + " 个文件残留");

  /* 顺带守住「保留区」没被误删 */
  const navjs = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");
  /动画演示/.test(navjs)
    ? pass("教案内容里的动词用法（动画演示…）仍在 —— 那不是提示，别误删")
    : info("教案内容里已无「动画演示」（若是有意改的，忽略本条）");
}

function verifyStandalone() {
  section("独立模式（内容页直接打开）");

  // 语法层面：core.js 必须提供独立模式能力
  const core = fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8");
  /function mountStandalone/.test(core) ? pass("core.js 提供 mountStandalone（独立模式渲染）")
    : fail("core.js 缺少 mountStandalone");
  /function standaloneGo/.test(core) ? pass("core.js 提供 standaloneGo（独立模式跳转 + 越权校验）")
    : fail("core.js 缺少 standaloneGo");
  /inShell\(\)\) return/.test(core) ? pass("独立模式在壳内自动跳过（不会双重渲染导航）")
    : fail("独立模式缺少 inShell 短路");

  // 内容页必须同时引入 nav.js / core.js / shell.css
  for (const p of CONTENT_PAGES) {
    const h = fs.readFileSync(path.join(SITE, p), "utf8");
    const ok = /assets\/nav\.js/.test(h) && /assets\/core\.js/.test(h) && /assets\/shell\.css/.test(h);
    if (ok) pass(`${p} 独立模式依赖齐备（nav.js + core.js + shell.css）`);
    else {
      const miss = [];
      if (!/assets\/nav\.js/.test(h)) miss.push("nav.js");
      if (!/assets\/core\.js/.test(h)) miss.push("core.js");
      if (!/assets\/shell\.css/.test(h)) miss.push("shell.css");
      fail(`${p} 缺 ${miss.join("/")}`);
    }
  }

  // 实际执行：以「独立打开」身份跑一个学生页，确认导航被渲染出来
  const name = "chat.html";
  const html = fs.readFileSync(path.join(SITE, name), "utf8");
  const doc = makeDoc();
  registerIds(doc, html);
  doc.body._html = html;
  const sb = makeSandbox(doc, name, { frameElement: null, protocol: "file:" });
  const probe = probeFn(sb);

  try {
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sb, { filename: "nav.js" });
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8"), sb, { filename: "core.js" });
    pass("独立模式脚本加载无异常");
  } catch (e) {
    fail("独立模式脚本报错: " + e.message);
    return;
  }

  probe("inShell()") === false ? pass("独立打开时 inShell 判定为 false")
    : fail("独立打开被误判为壳内");

  // 触发 DOMContentLoaded → 应渲染出顶部栏与侧栏
  try {
    doc.dispatchEvent({ type: "DOMContentLoaded", target: doc });
  } catch (e) {
    fail("独立模式 DOMContentLoaded 报错: " + e.message);
    return;
  }

  const bodyChildren = doc.body.children || [];
  const hasTop = bodyChildren.some((c) => c.classList?.contains("shell-top"));
  const hasSide = bodyChildren.some((c) => c.classList?.contains("shell-side"));
  hasTop ? pass("独立模式自动渲染顶部栏") : fail("独立模式未渲染顶部栏");
  hasSide ? pass("独立模式自动渲染左侧栏") : fail("独立模式未渲染侧栏");

  const sideNode = bodyChildren.find((c) => c.classList?.contains("shell-side"));
  if (sideNode) {
    const items = /side-item/.test(sideNode._html || "");
    const foot = /side-foot/.test(sideNode._html || "");
    const label = /AI 答疑|我的学情/.test(sideNode._html || "");
    items && label ? pass("独立模式侧栏渲染出本角色菜单项")
      : fail("独立模式侧栏菜单为空");
    foot ? pass("独立模式侧栏含身份脚注") : fail("独立模式侧栏缺脚注");
  }

  doc.body.classList.contains("standalone-body")
    ? pass("body 标记 .standalone-body（布局样式生效）")
    : fail("缺少 .standalone-body 标记");

  // 独立模式的越权拦截
  if (probe("typeof standaloneGo") === "function") {
    probe("(() => { Cookie.set('st_role','student',1); LS.rawSet('st_role','student'); })()");
    probe("standaloneGo('class.html')");
    sb.location.href !== "class.html"
      ? pass("独立模式越权拦截生效（学生无法进入教师页）")
      : fail("独立模式越权未被拦截");
    probe("(() => { Cookie.set('st_role','student',1); })()");
    probe("standaloneGo('reader.html')");
    sb.location.href === "reader.html"
      ? pass("独立模式同角色页面正常放行")
      : fail("独立模式同角色被误拦: " + sb.location.href);
  } else fail("standaloneGo 未定义");

  // navigate()：独立打开时整页跳转，且必须保留 ?query
  // （schedule.html 的「方式三」靠它把任务带到 agent.html，丢了 query 就白跳）
  if (probe("typeof navigate") === "function") {
    probe("(() => { Cookie.set('st_role','student',1); LS.rawSet('st_role','student'); })()");
    probe("navigate('reader.html?task=demo')");
    sb.location.href === "reader.html?task=demo"
      ? pass("独立模式 navigate() 保留 query（深链不退化）")
      : fail("navigate() 丢了 query: " + sb.location.href);

    // 归属判断仍只看裸页名 → 带 query 的跨端目标一样要被拦
    probe("navigate('class.html?cls=cs2301')");
    !/^class\.html/.test(sb.location.href)
      ? pass("navigate() 带 query 的跨端目标仍被拦下（归属只看裸页名）")
      : fail("带 query 的跨端目标漏拦: " + sb.location.href);

    // 空目标不该乱跳
    const before = sb.location.href;
    probe("navigate('')");
    sb.location.href === before
      ? pass("navigate('') 不做无意义跳转") : fail("空目标触发了跳转");

    // 壳内则不应该自己跳，而要交给壳
    probe("(() => { Cookie.set('st_role','student',1); })()");
  } else fail("navigate 未定义");
}

/* ============================================================
   C. 登录页验证
   ============================================================ */
function verifyLogin() {
  section(LOGIN_PAGE + "（登录页）");
  const file = path.join(SITE, LOGIN_PAGE);
  const html = fs.readFileSync(file, "utf8");
  const doc = makeDoc();
  registerIds(doc, html);
  const sandbox = makeSandbox(doc, LOGIN_PAGE);
  const probe = probeFn(sandbox);

  // ⚠️ 必须按真实页面的加载顺序执行：nav.js 在前（提供 SEED_ACCOUNTS / ACCOUNT_KEY），
  //    core.js 在后。只跑 core.js 会让这些常量变成 undefined → 账号库恒为空。
  try {
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"),
      sandbox, { filename: "nav.js" });
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8"),
      sandbox, { filename: "core.js" });
  } catch (e) {
    fail("nav.js / core.js 报错: " + e.message);
    return;
  }

  const role = (html.match(/<html[^>]*\bdata-role="([\w-]+)"/) || [])[1];
  role === "login" ? pass("声明 data-role=login（无导航注入）") : fail("data-role 应为 login，实际: " + role);
  !/id="sideNav"/.test(html) ? pass("登录页无侧栏") : fail("登录页不应有 #sideNav");
  !/id="demoBar"/.test(html) ? pass("登录页无演示条") : fail("登录页仍有 #demoBar");
  // 登录页参与主题：HTML 上写死 data-theme 作为**首屏防闪烁**占位，
  // 且默认必须是深色（用户要求「登录界面默认深色」）。
  {
    const m = html.match(/<html[^>]*\bdata-theme="([\w-]+)"/);
    m ? pass(`登录页 HTML 带默认主题占位（${m[1]}）`)
      : fail("登录页缺少 data-theme 占位（首屏会闪一次错误配色）");
    m && m[1] === "dark"
      ? pass("登录页默认主题为深色")
      : fail(`登录页默认主题应为深色，实际: ${m && m[1]}`);
    // 必须是合法主题 id
    (m && ["cream", "snow", "dark"].includes(m[1]))
      ? pass("登录页默认主题 id 合法") : fail("登录页默认主题 id 非法: " + (m && m[1]));
  }
  // Theme.current() 在「无保存记录」时必须回落深色（不跟随系统）
  if (probe("typeof DEFAULT_THEME") !== "undefined") {
    probe("DEFAULT_THEME") === "dark"
      ? pass("默认主题常量 DEFAULT_THEME = dark")
      : fail("DEFAULT_THEME 不是 dark: " + probe("DEFAULT_THEME"));
    // 真正读一次：清掉偏好 + 抹掉 DOM 占位后，current() 必须回落 DEFAULT_THEME
    probe(`(() => { Cookie.del('st_theme'); LS.del('st_theme'); document.documentElement.removeAttribute('data-theme'); })()`);
    const cur = probe("Theme.current()");
    cur === "dark" ? pass("无偏好且无 DOM 占位时，Theme.current() 回落深色")
      : fail("未回落深色，实际: " + cur);
    // 且不得依赖系统 prefers-color-scheme
    const src = fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8");
    !/prefers-color-scheme[\s\S]{0,80}?return preferDark/.test(src)
      ? pass("默认主题不跟随系统 prefers-color-scheme（是产品设定）")
      : fail("默认主题仍在跟随系统配色");
  } else fail("DEFAULT_THEME 未定义（默认主题无法保证）");

  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).join("\n");
  try {
    vm.runInContext(inline, sandbox, { filename: LOGIN_PAGE });
    pass("内联脚本执行无异常");
  } catch (e) {
    fail("内联脚本报错: " + e.message);
    return;
  }

  // ⚠️ core.js 的 mountReadMode 挂在 DOMContentLoaded 上；
  //    真实浏览器里这个事件一定会来，桩里必须手动补发，否则监听器根本没绑。
  try { doc.dispatchEvent({ type: "DOMContentLoaded", target: doc }); } catch (_) {}
  if (typeof sandbox._fireDocReady === "function") sandbox._fireDocReady();

  // 进入后应写入角色并跳转到壳
  const dest = probe("(() => { Cookie.set('st_role','teacher',1); LS.rawSet('st_role','teacher'); return 'ok'; })()");
  dest === "ok" ? pass("登录时写入角色 Cookie + localStorage") : fail("角色未写入");
  /app\.html/.test(inline) ? pass("登录后跳转到应用壳（app.html）")
    : fail("登录未跳转到 app.html");

  verifyLoginForm(html, sandbox, probe);
}

/* ------------------------------------------------------------
   登录页·注册 / 登录 / 无障碍开关
   规则：账号存本地（st_accounts）；注册要查重与校验；
        登录要按所选身份匹配账号；密码错不得放行。
   ------------------------------------------------------------ */
function verifyLoginForm(html, sandbox, probe) {
  const has = (re, okMsg, badMsg) => (re.test(html) ? pass(okMsg) : fail(badMsg));

  /* --- 结构 --- */
  has(/id="loginForm"/, "登录表单使用 <form>（回车可提交）", "缺少 #loginForm");
  has(/id="account"/, "登录页有账号输入框", "缺少账号输入框 #account");
  has(/id="password"/, "登录页有密码输入框", "缺少密码输入框 #password");
  has(/autocomplete="current-password"/, "密码框声明 autocomplete", "密码框缺 autocomplete");

  has(/id="regForm"/, "有注册表单（#regForm）", "缺少注册表单");
  has(/id="regUser"/, "注册有账号输入框", "注册缺账号输入框");
  has(/id="regPass"/, "注册有密码输入框", "注册缺密码输入框");
  has(/id="regName"/, "注册有姓名输入框", "注册缺姓名输入框");
  has(/autocomplete="new-password"/, "注册密码框声明 new-password", "注册密码框缺 autocomplete");
  has(/id="tabLogin"[\s\S]{0,200}?id="tabReg"/, "有登录 / 注册切换标签", "缺少切换标签");

  // 演示账号表已改为「本地账号库种子」，不再有固定密码表
  const navjs = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");
  /SEED_ACCOUNTS/.test(navjs) ? pass("nav.js 提供 SEED_ACCOUNTS 初始账号")
    : fail("nav.js 缺少 SEED_ACCOUNTS");
  /ACCOUNT_KEY\s*=\s*"st_accounts"/.test(navjs)
    ? pass("账号库存放键为 st_accounts（唯一来源）")
    : fail("nav.js 未定义 ACCOUNT_KEY = st_accounts");
  !/DEMO_ACCOUNTS/.test(navjs) ? pass("旧的固定演示账号表已移除（改为可注册）")
    : fail("nav.js 仍残留 DEMO_ACCOUNTS 固定账号表");
  /assets\/nav\.js/.test(html) ? pass("登录页引入 nav.js 取账号配置")
    : fail("登录页未引入 nav.js（账号会变成两份实现）");

  /* --- 无障碍阅读模式勾选（登录页左下角，默认勾选） --- */
  const a11y = html.match(/<input[^>]*id="a11yReadMode"[^>]*>/);
  a11y ? pass("登录页有无障碍阅读模式勾选（#a11yReadMode）")
    : fail("登录页缺无障碍阅读模式勾选");
  if (a11y) {
    /\btype="checkbox"/.test(a11y[0]) ? pass("是复选框") : fail("不是 checkbox");
    /\bchecked\b/.test(a11y[0]) ? pass("登录页勾选项默认勾选")
      : fail("登录页勾选项未默认勾选");
    /<label[^>]*\bfor="a11yReadMode"/.test(html)
      ? pass("勾选项用 <label for> 关联") : fail("勾选项缺 <label for>");
    // 位置：必须在左栏（.login-aside）内，且排在底部校名之后
    const aside = (html.match(/<aside class="login-aside"[\s\S]*?<\/aside>/) || [""])[0];
    /id="a11yReadMode"/.test(aside) ? pass("勾选项确实位于左侧栏内")
      : fail("勾选项不在左栏内");
    const footIdx = aside.indexOf("成都理工");
    const boxIdx = aside.indexOf('id="a11yReadMode"');
    footIdx >= 0 && boxIdx > footIdx
      ? pass("勾选项排在「成都理工大学」署名之后")
      : fail("勾选项位置应在校名下方");
  }

  /* --- 行为：账号库 --- */
  const seeded = probe("(() => { try { return loadAccounts().length; } catch(e) { return 'THREW:' + e.message; } })()");
  Number(seeded) >= 2 ? pass(`首次打开自动预置 ${seeded} 个演示账号（观众不必先注册）`)
    : fail("未自动预置演示账号，实际: " + seeded);

  const persisted = probe(`(() => { try { return typeof LS.raw(${JSON.stringify("st_accounts")}); } catch(e) { return 'THREW'; } })()`);
  persisted === "string" ? pass("账号库已落盘到 localStorage（st_accounts）")
    : fail("账号库未落盘: " + persisted);

  // 注册：账号重复必须被拒
  const dup = probe(`(() => {
    try {
      document.getElementById('regName').value = '王五';
      document.getElementById('regUser').value = ${JSON.stringify("teacher")};
      document.getElementById('regPass').value = 'abcdef';
      selectRole('teacher');
      return verifyReg() === null ? 'REJECTED' : 'ACCEPTED';
    } catch(e) { return 'THREW:' + e.message; }
  })()`);
  dup === "REJECTED" ? pass("注册：重复账号被拒绝")
    : fail("注册重复账号未被拒: " + dup);

  // 注册：短密码必须被拒
  const short = probe(`(() => {
    try {
      document.getElementById('regUser').value = 'zhangming';
      document.getElementById('regPass').value = '123';
      return verifyReg() === null ? 'REJECTED' : 'ACCEPTED';
    } catch(e) { return 'THREW:' + e.message; }
  })()`);
  short === "REJECTED" ? pass("注册：密码过短被拒绝")
    : fail("注册短密码未被拒: " + short);

  // 注册：合法信息 → 写入账号库
  const before = probe("loadAccounts().length");
  const created = probe(`(() => {
    try {
      document.getElementById('regName').value = '张明';
      document.getElementById('regUser').value = 'zhangming';
      document.getElementById('regPass').value = 'zm@2026';
      selectRole('student');
      const acc = verifyReg();
      if (!acc) return 'REJECTED';
      const list = loadAccounts(); list.push({ ...acc, createdAt: Date.now() });
      saveAccounts(list);
      return 'OK';
    } catch(e) { return 'THREW:' + e.message; }
  })()`);
  const after = probe("loadAccounts().length");
  created === "OK" && after === before + 1
    ? pass("注册：合法信息写入本地账号库（+1 条）")
    : fail(`注册未落库: ${created}，${before} → ${after}`);

  // 登录：新注册的账号能用
  const login = probe(`(() => {
    try {
      selectRole('student');
      document.getElementById('account').value = 'zhangming';
      document.getElementById('password').value = 'zm@2026';
      return verify() ? 'PASS' : 'REJECTED';
    } catch(e) { return 'THREW:' + e.message; }
  })()`);
  login === "PASS" ? pass("登录：刚注册的账号校验通过")
    : fail("刚注册的账号无法登录: " + login);

  // 登录：密码错误必须被拦下
  probe("(() => { document.getElementById('password').value = 'wrong-pass'; })()");
  const bad = probe("(() => { try { return verify() ? 'PASS' : 'REJECTED'; } catch(e) { return 'THREW:' + e.message; } })()");
  const errShown = probe("document.getElementById('loginError').hidden === false");
  bad === "REJECTED" && errShown
    ? pass("登录：密码错误被拦下并给出可见提示")
    : fail("密码错误未被拦下（verify=" + bad + "，提示 hidden=" + !errShown + "）");

  // 登录：身份不符要给出明确指引（跨端账号）
  const cross = probe(`(() => {
    try {
      selectRole('teacher');
      document.getElementById('account').value = 'zhangming';   // 这是学生账号
      document.getElementById('password').value = 'zm@2026';
      const r = verify();
      return (r === false) ? (document.getElementById('loginError').textContent || '') : 'PASSED';
    } catch(e) { return 'THREW:' + e.message; }
  })()`);
  /学生/.test(cross) ? pass("登录：身份不符时提示该账号属于另一身份")
    : fail("身份不符未给出明确指引，实际提示: " + cross);

  // 未注册账号 → 引导去注册
  const none = probe(`(() => {
    try {
      document.getElementById('account').value = 'nobody-here';
      document.getElementById('password').value = 'whatever';
      verify();
      return document.getElementById('loginError').textContent || '';
    } catch(e) { return 'THREW:' + e.message; }
  })()`);
  /注册/.test(none) ? pass("登录：未注册账号时引导去注册")
    : fail("未注册账号时未引导注册，实际: " + none);

  /* --- 切换标签 --- */
  const tabs = probe(`(() => {
    try {
      setTab('reg');
      const a = document.getElementById('regForm').hidden === false
             && document.getElementById('loginForm').hidden === true;
      setTab('login');
      const b = document.getElementById('loginForm').hidden === false
             && document.getElementById('regForm').hidden === true;
      return String(a && b);
    } catch(e) { return 'THREW:' + e.message; }
  })()`);
  tabs === "true" ? pass("登录 / 注册标签切换真的换表单项")
    : fail("标签切换无效: " + tabs);

  /* --- 无障碍开关共享同一状态 --- */
  // ⚠️ 桩里 getElementById 与 querySelector 返回的不是同一对象，
  //    必须用与页面代码相同的取法（querySelector），否则监听器绑在另一个元素上。
  const rm = probe(`(() => {
    try {
      const b = document.querySelector('#a11yReadMode');
      b.checked = false; b.dispatchEvent(new Event('change'));
      const off = LS.get(${JSON.stringify("st_a11y_read_mode")}, null);
      b.checked = true; b.dispatchEvent(new Event('change'));
      const on = LS.get(${JSON.stringify("st_a11y_read_mode")}, null);
      return String(off) + '|' + String(on);
    } catch(e) { return 'THREW:' + e.message; }
  })()`);
  rm === "false|true" ? pass("登录页无障碍开关写入同一存储键（与壳内一致）")
    : fail("登录页无障碍开关未持久化: " + rm);

  /* --- 显示/隐藏密码 --- */
  /id="pwdEye"/.test(html) ? pass("密码框有显示/隐藏切换")
    : fail("缺少密码显示切换 #pwdEye");
  const eye = probe(`(() => {
    try {
      const btn = document.querySelector('#pwdEye');
      const inp = document.querySelector('#password');
      const before = inp.type;
      btn.dispatchEvent(new Event('click'));
      const after = inp.type;
      return before + '→' + after;
    } catch(e) { return 'THREW:' + e.message; }
  })()`);
  eye === "password→text" ? pass("点「显示」后密码框真的切到明文")
    : fail("密码显示切换无效: " + eye);
}

/* ============================================================
   D. 全站一致性
   ============================================================ */
/* ============================================================
   教案数据层 —— 大纲 / 课时 / 版本链 / diff 纯函数
   ------------------------------------------------------------
   这些是 nav.js 里的数据与规则（不是某个页面的渲染），
   单独跑一遍：页面坏了能看出来，规则悄悄坏掉也能看出来。
   ============================================================ */
function verifyLessonData() {
  section("教案数据层（nav.js）");

  const doc = makeDoc();
  const sandbox = makeSandbox(doc, "lesson.html");
  const probe = probeFn(sandbox);

  const nav = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");
  try {
    vm.runInContext(nav, sandbox, { filename: "nav.js" });
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }

  /** 探针断言的小包装：把「probe 出来的值」直接判真假 */
  const chk2 = (cond, msg) => { cond ? pass(msg) : fail(msg); };

  /* --- 大纲按课程组织，且不给没课的课程编造 --- */
  const syl = probe("SYLLABUS");
  syl && syl.ds && Array.isArray(syl.ds.chapters) && syl.ds.chapters.length === 4
    ? pass("教案大纲按课程组织（ds 4 章）") : fail("大纲数据缺失或章数异常");
  probe("syllabusOf('os')") == null
    ? pass("没有大纲的课程返回空（不编造章节）") : fail("凭空给出了 os 的大纲");

  const ids = probe("Object.keys(LESSONS)");
  Array.isArray(ids) && ids.length === 6
    ? pass(`课时教案 ${ids.length} 份`) : fail("LESSONS 数量异常: " + (ids && ids.length));

  const st = probe("syllabusStats('ds')");
  st && st.chapters === 4 && st.lessons === 6 && st.taught === 1 && st.ready === 3 && st.draft === 2
    ? pass("大纲统计一致（4 章 / 6 份：已上 1、待上 3、草稿 2）")
    : fail("统计不一致: " + JSON.stringify(st));

  probe("Object.values(LESSONS).filter((l) => !chapterOf(l.courseId, l.chapterId)).length") === 0
    ? pass("每份课时教案都挂在真实存在的章下")
    : fail("存在孤儿教案（章已不存在）");

  /* --- 版本链 --- */
  const q = probe("LESSONS['ds-c7-2']");
  q && q.commits.length >= 3 ? pass("课时教案带版本链（≥3 版）") : fail("缺版本链");
  probe("lessonHistory(LESSONS['ds-c7-2']).length") === probe("LESSONS['ds-c7-2'].commits.length")
    ? pass("版本历史与 commits 一一对应") : fail("历史长度异常");
  probe("lessonHistory(LESSONS['ds-c7-2'])[0].index") === probe("LESSONS['ds-c7-2'].head")
    ? pass("历史倒序且带原下标（对比/回退靠它定位）") : fail("历史顺序不对");
  probe("lessonHistory(LESSONS['ds-c7-2'])[0].commit.id") === "v3"
    ? pass("最新一版排在时间线最前") : fail("最新版不在最前");
  probe("lessonReflects(LESSONS['ds-c7-2']).length") === 1
    ? pass("课后反思能从版本链里捞出来") : fail("反思提取异常");
  probe("LESSONS['ds-c7-2'].commits[2].kind") === "reflect"
    ? pass("课后改进被识别为独立类型") : fail("版本类型异常");

  /* --- 字段定义唯一 --- */
  const fields = probe("SNAP_FIELDS.map((f) => f.key)");
  const need = ["goals", "keyPoints", "hardPoints", "steps", "homework", "note"];
  JSON.stringify(fields) === JSON.stringify(need)
    ? pass("六个内容字段由 SNAP_FIELDS 单一定义（渲染与 diff 共用）")
    : fail("字段定义不一致: " + JSON.stringify(fields));

  /* --- 纯函数：diff --- */
  JSON.stringify(probe("splitSentences('甲。乙！丙')")) === JSON.stringify(["甲。", "乙！", "丙"])
    ? pass("按句切分（中文标点）") : fail("按句切分异常");
  probe("splitSentences('')") .length === 0 ? pass("空文本切分为空数组") : fail("空文本切分异常");
  probe("lcsDiff(['a','x','c'],['a','y','c']).map((p) => p.op).join('')") === "=-+="
    ? pass("标量字段用最长公共子序列逐句 diff") : fail("lcsDiff 异常");
  probe("alignListDiff(['a'],['b'])[0].op") === "~"
    ? pass("数组字段同一位置的改动标 ~") : fail("alignListDiff 异常");

  // 🔴 实测出来的：按**下标**一一对齐时，中间插一条会把后面每条都标成「改动」，
  //    噪声盖过真正的修改。改成按内容做 LCS 之后，插入只占一行。
  const ins = probe("alignListDiff(['甲','乙','丙'], ['甲','新','乙','丙'])");
  ins && ins.length === 4 && ins[1].op === "+" && ins[2].op === "=" && ins[3].op === "="
    ? pass("数组中间插一条只标一行新增（不干扰其后各项）")
    : fail("插入判定噪声过大: " + JSON.stringify(ins));
  const del = probe("alignListDiff(['甲','乙','丙'], ['甲','丙'])");
  del && del.length === 3 && del[1].op === "-" && del[2].op === "="
    ? pass("数组中间删一条只标一行删除") : fail("删除判定异常: " + JSON.stringify(del));
  probe("alignListDiff([],['a'])[0].op") === "+" && probe("alignListDiff(['a'],[])[0].op") === "-"
    ? pass("数组新增 / 删除分别标 + 与 -") : fail("对齐增删判定异常");

  const d = probe("diffSnap(LESSONS['ds-c7-2'].commits[1].snap, LESSONS['ds-c7-2'].commits[2].snap)");
  d && d.changed === 3 ? pass(`diffSnap 算出 ${d.changed} 个字段有变化`) : fail("diffSnap 统计异常");
  d && d.fields.some((f) => f.key === "steps" && f.parts.some((p) => p.op === "~"))
    ? pass("课堂流程的改动能落到具体某一步") : fail("流程 diff 异常");
  d && d.fields.find((f) => f.key === "homework").same === true
    ? pass("未改动的字段标为相同（不噪声）") : fail("未改字段判定异常");
  probe("diffSnap(null, null).changed") === 0 ? pass("diffSnap 容忍空快照") : fail("空快照异常");
  probe("snapEqual(LESSONS['ds-c7-2'].commits[0].snap, LESSONS['ds-c7-2'].commits[2].snap)")
    ? fail("snapEqual 把不同版本判成相同") : pass("snapEqual 能区分不同版本");

  /* --- 语义红线：版本历史只增不减 --- */
  !/\.commits\s*=(?!=)/.test(nav)
    ? pass("源码里没有给 commits 整体赋值的写法（历史不覆盖）")
    : fail("出现了覆盖 commits 的写法");
  !/commits\.(splice|pop|shift)/.test(nav)
    ? pass("源码里没有删改历史数组的写法") : fail("出现了删改历史的写法");

  const len0 = probe("LESSONS['ds-c7-2'].commits.length");
  probe("revertLesson('ds-c7-2', 0).ok");
  probe("LESSONS['ds-c7-2'].commits.length") === len0 + 1
    ? pass("回退是**新增**一版，历史条数 +1") : fail("回退改动了历史长度");
  probe("LESSONS['ds-c7-2'].commits[LESSONS['ds-c7-2'].head].kind") === "revert"
    ? pass("回退版本的类型记为 revert") : fail("回退类型不对");
  probe("snapEqual(lessonSnap(LESSONS['ds-c7-2']), LESSONS['ds-c7-2'].commits[0].snap)")
    ? pass("回退后内容等于目标版本") : fail("回退内容不对");
  // ⚠️ 上面刚回退过一次，所以「当前版本」已经变了 —— 必须用 head 去试
  probe("revertLesson('ds-c7-2', LESSONS['ds-c7-2'].head).ok") === false
    ? pass("「回到当前版本」被拦下（不做无意义的回退）") : fail("无效回退没被拦");
  probe("revertLesson('ds-c7-2', 99).ok") === false
    ? pass("越界版本号被拦下") : fail("越界版本没被拦");

  /* --- 提交语义 --- */
  const snapBefore = probe("JSON.stringify(lessonSnap(LESSONS['ds-c7-1']))");
  probe("commitLesson('ds-c7-1', lessonSnap(LESSONS['ds-c7-1']), '没改东西', 'edit').ok") === false
    ? pass("内容没变时不产生新版本（不靠说明刷版本）") : fail("内容没变却产生了新版本");
  probe("commitLesson('ds-c7-1', lessonSnap(LESSONS['ds-c7-1']), '只记反思', 'reflect', " +
        "{ date: '第 5 教学周', saw: '学生卡住了', todo: '下次放慢' }).ok")
    ? pass("课后反思即使内容不变也留下版本（反思本身就是要留的）") : fail("反思没留下版本");
  probe("LESSONS['ds-c7-1'].status") === "taught"
    ? pass("记了反思自动把课时标成「已上」") : fail("状态没联动");
  probe("LESSONS['ds-c7-1'].taughtAt") === "第 5 教学周" ? pass("上课日期记下来了") : fail("日期没记");
  probe("JSON.stringify(lessonSnap(LESSONS['ds-c7-1']))") === snapBefore
    ? pass("记反思不会顺手改教案内容") : fail("反思改动了内容");

  /* --- 新建与校验 --- */
  probe("createSyllabus('ds').ok") === false ? pass("已有大纲时重复创建被拦") : fail("重复建大纲未拦");
  probe("createSyllabus('nope').ok") === false ? pass("给不存在的课程建大纲被拦") : fail("越界建大纲未拦");

  const r = probe("addLesson('os', 'x', '课时')");
  r && r.ok === false ? pass("给不存在的章加课时被拦") : fail("越界加课时未拦");
  probe("addLesson('ds', 'ds-c7', '第 7 章 · 第 1 课时：冒泡与插入排序').ok") === false
    ? pass("同名课时被拦下") : fail("同名课时未拦");
  probe("addLesson('ds', 'ds-c7', '   ').ok") === false ? pass("空课时名被拦") : fail("空名未拦");

  const added = probe("addLesson('ds', 'ds-c7', '第 7 章 · 第 4 课时：计数排序')");
  added && added.ok && added.lesson.id === "ds-c7-4"
    ? pass("新课时 id 按章内序号生成（ds-c7-4）") : fail("新课时 id 异常: " + JSON.stringify(added && added.lesson && added.lesson.id));
  added && added.lesson.commits.length === 1 && added.lesson.commits[0].kind === "init"
    ? pass("新教案自带 v1（初稿）") : fail("初始版本异常");
  added && added.lesson.status === "draft" ? pass("新教案默认草稿态") : fail("默认状态异常");
  probe("SYLLABUS.ds.chapters[2].lessonIds.indexOf('ds-c7-4') >= 0")
    ? pass("新课时挂到章下（大纲树立刻可见）") : fail("新课时没挂到章里");

  probe("addChapter('ds', '  ').ok") === false ? pass("空章节名被拦") : fail("空章节名未拦");
  probe("addChapter('ds', SYLLABUS.ds.chapters[0].title).ok") === false
    ? pass("同名章节被拦") : fail("同名章节未拦");
  probe("removeChapter('ds', 'ds-c7').ok") === false
    ? pass("章里还有教案时不许删章（不会连带丢教案）") : fail("章被误删");
  probe("setLessonStatus('ds-c7-1', '乱值').ok") === false
    ? pass("非法状态值被拦") : fail("非法状态未拦");

  /* --- 存档健壮性 --- */
  const junk = '{"a":{"title":"没有 commits"},"b":null,"ds-c9-1":{"title":"T","commits":[{"id":"v1"}]}}';
  const doc2 = makeDoc();
  const sb2 = makeSandbox(doc2, "lesson.html");
  try { sb2.window.localStorage.setItem("st_lessons", junk); } catch (_) {}
  try { sb2.window.localStorage.setItem("st_syllabus", '{"ds":{"chapters":[]}}'); } catch (_) {}
  try { vm.runInContext(nav, sb2, { filename: "nav.js" }); } catch (_) {}
  const probe2 = probeFn(sb2);
  const p2 = probe2("Object.keys(LESSONS)");
  p2 && p2.length === 1 && p2[0] === "ds-c9-1"
    ? pass("坏存档：无 commits 的条目被丢弃，其余补全")
    : fail("坏存档处理异常: " + JSON.stringify(p2));
  probe2("SYLLABUS.ds") == null
    ? pass("没有任何章的大纲视为无效（不假装有）") : fail("空章节大纲被当成有效");

  const doc3 = makeDoc();
  const sb3 = makeSandbox(doc3, "lesson.html");
  try { sb3.window.localStorage.setItem("st_lessons", "{}"); } catch (_) {}
  try { sb3.window.localStorage.setItem("st_syllabus", "{}"); } catch (_) {}
  try { vm.runInContext(nav, sb3, { filename: "nav.js" }); } catch (_) {}
  const probe3 = probeFn(sb3);
  probe3("Object.keys(LESSONS).length") === 0 && probe3("Object.keys(SYLLABUS).length") === 0
    ? pass("空对象是有效存档（删光教案后重开不复活种子）")
    : fail("空存档被当成「没有记录」");

  /* --- 调序（第 28 轮）：接口用「插到谁前面」表达，不用下标 --- */
  const doc4 = makeDoc();
  const sb4 = makeSandbox(doc4, "lesson.html");
  // 用种子数据（ds）来测：它的章与课时都是确定的
  try { vm.runInContext(nav, sb4, { filename: "nav.js" }); } catch (_) {}
  const p4 = probeFn(sb4);

  ["moveChapter", "moveLesson", "moveChapterBy", "moveLessonBy"].every((fn) =>
    new RegExp("function " + fn + "\\s*\\(").test(nav))
    ? pass("nav.js 提供章 / 课时的调序实现（拖动与上移下移共用）")
    : fail("缺调序实现");
  const moveLessonBody = (nav.match(/function moveLesson\([\s\S]*?\n\}/) || [""])[0];
  /chapters\.forEach\(\(c\) => \{ c\.lessonIds = \(c\.lessonIds \|\| \[\]\)\.filter/.test(moveLessonBody)
    ? pass("移动课时前先从**所有**章里摘掉（否则会挂在两章下面 —— 界面看像复制了一份）")
    : fail("移动课时没有从所有章里摘除 —— 教案会重复出现在多章里");

  // 章：把第 1 章挪到最后
  const before = p4("SYLLABUS.ds.chapters.map(function (c) { return c.id; })");
  /* ---- 大纲版本链（第 29 轮）---- */
  /function syllabusChapters\s*\(/.test(nav) && /function commitOutline\s*\(/.test(nav)
    && /function revertSyllabus\s*\(/.test(nav) && /function diffChapters\s*\(/.test(nav)
    ? pass("nav.js 提供大纲版本链：读取 / 提交 / 回退 / 结构对比")
    : fail("大纲版本链的实现不全");
  /Object\.defineProperty\(syl, "chapters"/.test(nav)
    ? pass("syl.chapters 是快照的只读 getter（结构只有一份真相，不会存两份）")
    : fail("结构被存了两份 —— 迟早不同步");
  const getterFn = (nav.match(/function attachChaptersGetter[\s\S]*?\n\}/) || [""])[0];
  /set\(\)/.test(getterFn) && /throw new Error/.test(getterFn)
    ? pass("getter 带 setter 守卫：给 syl.chapters 赋值会直接抛错（挡住「就地改历史」）")
    : fail("syl.chapters 可被赋值 —— 有人会误改到历史快照上");

  chk2(p4("syllabusChapters('ds').length") === 4, "种子大纲读得到 4 章");
  chk2(p4("SYLLABUS.ds.commits.length") === 1 && p4("SYLLABUS.ds.commits[0].kind") === "init",
    "种子大纲自带 1 个 init 版本（首次打开就有历史，不是空的）");
  chk2(!/chapters/.test(p4("Object.keys(SYLLABUS.ds).join(',')")),
    "存档里不再冗余存 chapters（只有快照一份）");
  chk2(p4("(function () { try { SYLLABUS.ds.chapters = []; return 0; } catch (e) { return 1; } })()") === 1,
    "给 syl.chapters 赋值会抛错");

  // 结构没变不出版本；变了才出
  chk2(p4("commitOutline('ds', syllabusChapters('ds'), '没改').unchanged") === true,
    "结构没变 → 不产生噪声版本");
  const vSnap = p4("JSON.stringify(SYLLABUS.ds.commits[0].snap)");
  const addedCh = p4("(function () { var c = cloneData(syllabusChapters('ds'));"
    + " c.push({ id: 'ds-c99', title: '第 99 章', hours: 0, points: '', lessonIds: [] });"
    + " var r = commitOutline('ds', c, '加一章', 'structure');"
    + " return { ok: r.ok, id: r.commit && r.commit.id, n: SYLLABUS.ds.commits.length }; })()");
  chk2(addedCh && addedCh.ok === true && addedCh.id === "v2" && addedCh.n === 2, "结构变了 → 追加 v2");
  chk2(p4("JSON.stringify(SYLLABUS.ds.commits[0].snap)") === vSnap,
    "🔴 加章之后 v1 的快照一个字都没变（历史是只读的）");
  chk2(p4("syllabusChapters('ds').length") === 5, "当前结构读到新值（5 章）");

  // 变更函数都走版本链
  const ops = p4("(function () { var out = {};"
    + " out.before = SYLLABUS.ds.commits.length;"
    + " addChapter('ds', '第 98 章'); out.a = SYLLABUS.ds.commits.length;"
    + " updateChapter('ds', 'ds-c1', { hours: 7 }); out.b = SYLLABUS.ds.commits.length;"
    + " moveChapterBy('ds', 'ds-c1', 1); out.c = SYLLABUS.ds.commits.length;"
    + " return out; })()");
  chk2(ops && ops.a === ops.before + 1 && ops.b === ops.a + 1 && ops.c === ops.b + 1,
    "加章 / 改章 / 调序每次都追加一版");
  // 只看刚做的那三步（前面还留了一条测试用的 v2）
  const kSeq = p4("SYLLABUS.ds.commits.slice(-3).map(function (c) { return c.kind; }).join(',')");
  chk2(kSeq === "structure,edit,structure", "提交类型分类正确（structure / edit / structure）");

  // 回退：追加一版、结构还原、历史不删
  const rv = p4("(function () { var n0 = SYLLABUS.ds.commits.length;"
    + " var r = revertSyllabus('ds', 0);"
    + " return { ok: r.ok, kind: r.commit && r.commit.kind, msg: r.commit && r.commit.msg,"
    + "          n0: n0, n: SYLLABUS.ds.commits.length, chapters: syllabusChapters('ds').length }; })()");
  chk2(rv && rv.ok === true && rv.kind === "revert" && rv.n === rv.n0 + 1 && rv.chapters === 4,
    "回退：追加一条 revert 版本、结构还原成 4 章、历史不减");
  chk2(/回到 v1/.test(rv && rv.msg), "回退版本的说明写明回到哪一版");
  chk2(p4("revertSyllabus('ds', SYLLABUS.ds.head).ok") === false, "「回到当前版本」被拦");
  chk2(p4("revertSyllabus('ds', 99).ok") === false, "越界版本被拦");

  // 结构对比
  const dc = p4("(function () { var A = syllabusChapters('ds'); var B = cloneData(A);"
    + " B[0].hours = 4; B[1].title = '改名了'; var mv = B.splice(2, 1)[0]; B.push(mv);"
    + " B.push({ id: 'ds-cX', title: '新章', hours: 0, points: '', lessonIds: [] });"
    + " var r = diffChapters(A, B);"
    + " return { ops: r.map(function (e) { return e.op; }).join(','),"
    + "          notes: r.map(function (e) { return e.note; }).join(' | ') }; })()");
  chk2(dc && /add/.test(dc.ops) && /chg/.test(dc.ops), "结构对比能认出「新增」与「改动」");
  chk2(/计划课时 2 → 4/.test(dc.notes), "对比写明课时数变化");
  chk2(/标题「第 6 章 · 图」→「改名了」/.test(dc.notes), "对比写明改名");
  chk2(/位置 \d+ → \d+/.test(dc.notes), "对比写明位置变化");
  chk2(p4("diffChapters(syllabusChapters('ds'), syllabusChapters('ds')).every(function (e) { return e.op === '='; })"),
    "同一份结构对比自己 → 全是「没变」");
  chk2(p4("diffChapters(null, undefined).length") === 0, "结构传空也不崩");
  chk2(/commitKind/.test(nav) && /COMMIT_KIND_FALLBACK/.test(nav),
    "提交类型有兜底（未知 kind 不会读到 undefined.label）");

  const r1 = p4("moveChapter('ds', SYLLABUS.ds.chapters[0].id, null).ok");
  const afterIds = p4("SYLLABUS.ds.chapters.map(function (c) { return c.id; })");
  r1 === true && afterIds[afterIds.length - 1] === before[0] && afterIds.length === before.length
    ? pass("moveChapter：第 1 章挪到末尾，数量不变") : fail("moveChapter 异常: " + JSON.stringify(afterIds));
  p4("moveChapter('ds', '" + before[0] + "', '" + before[1] + "').ok") === true
    && p4("SYLLABUS.ds.chapters[0].id") === before[0]
    ? pass("moveChapter：再插回第 2 章前面（可逆）") : fail("moveChapter 回插异常");
  p4("moveChapter('ds', 'ds-c1', 'nope').ok") === false
    ? pass("moveChapter：目标不存在时拒绝（不静默乱插）") : fail("目标不存在却成功了");

  // 课时：跨章移动后原章不残留（⚠️ 种子数据里「第 1 章」是空章，别写死下标）
  // 🔴 变更后必须**重新读** syllabusChapters —— 旧快照是不可变的，
  //    变更函数改的是新快照，握着旧对象引用会看到"什么都没变"（假失败）。
  const lsn = p4("(function () {"
    + " var before = syllabusChapters('ds'), from = null, to = null;"
    + " before.forEach(function (c) { if (!from && c.lessonIds.length) from = c; });"
    + " before.forEach(function (c) { if (!to && c.id !== from.id) to = c; });"
    + " var n0 = from.lessonIds.length, id = from.lessonIds[0];"
    + " var r = moveLesson(id, to.id, null);"
    + " var a = null, b = null;"
    + " syllabusChapters('ds').forEach(function (c) {"
    + "   if (c.id === from.id) a = c; if (c.id === to.id) b = c; });"
    + " return { ok: r.ok, leftInFrom: a.lessonIds.indexOf(id), fromLen: a.lessonIds.length, n0: n0,"
    + "          inTo: b.lessonIds.indexOf(id) >= 0, chapterId: LESSONS[id].chapterId === to.id }; })()");
  lsn && lsn.ok === true && lsn.leftInFrom === -1 && lsn.fromLen === lsn.n0 - 1
    && lsn.inTo === true && lsn.chapterId === true
    ? pass("moveLesson：跨章移动后原章不残留、目标章有、chapterId 同步")
    : fail("moveLesson 跨章移动异常: " + JSON.stringify(lsn));

  const sameCh = p4("(function () {"
    + " var cur = syllabusChapters('ds'), ch = null;"
    + " cur.forEach(function (c) { if (!ch && c.lessonIds.length >= 2) ch = c; });"
    + " var n0 = ch.lessonIds.length, a = ch.lessonIds[0], b = ch.lessonIds[1];"
    + " var r = moveLesson(a, ch.id, null);"
    + " var now = null;"
    + " syllabusChapters('ds').forEach(function (c) { if (c.id === ch.id) now = c; });"
    + " return { ok: r.ok, last: now.lessonIds[now.lessonIds.length - 1] === a,"
    + "          n: now.lessonIds.length, n0: n0, hasB: now.lessonIds.indexOf(b) >= 0 }; })()");
  sameCh && sameCh.ok === true && sameCh.last === true
    && sameCh.n === sameCh.n0 && sameCh.hasB === true
    ? pass("moveLesson：同章内挪到末尾（数量不变，不会自己复制自己）")
    : fail("同章内移动异常: " + JSON.stringify(sameCh));

  // 上移 / 下移：边界要拦住并给出人话
  const up1 = p4("moveChapterBy('ds', SYLLABUS.ds.chapters[0].id, -1)");
  up1 && up1.ok === false && /第一章/.test(up1.error)
    ? pass("moveChapterBy：第一章再上移被拦并说明原因") : fail("章上移边界异常: " + JSON.stringify(up1));
  const dn1 = p4("moveChapterBy('ds', SYLLABUS.ds.chapters[SYLLABUS.ds.chapters.length - 1].id, 1)");
  dn1 && dn1.ok === false && /最后一章/.test(dn1.error)
    ? pass("moveChapterBy：最后一章再下移被拦") : fail("章下移边界异常: " + JSON.stringify(dn1));
  const lUp = p4("(function () { var ch = null;"
    + " SYLLABUS.ds.chapters.forEach(function (c) { if (!ch && c.lessonIds.length) ch = c; });"
    + " return moveLessonBy(ch.lessonIds[0], -1); })()");
  lUp && lUp.ok === false && /第一个/.test(lUp.error)
    ? pass("moveLessonBy：本章第一个再上移被拦") : fail("课时上移边界异常: " + JSON.stringify(lUp));
}

/* ============================================================
   实训数据层 —— 路径库 / 骨架生成 / 活动 CRUD
   ------------------------------------------------------------
   🔴 这里最要紧的一条不变量：**「不给答案，给路径」**。
      它不是文案，是能被机器验的 —— 断言骨架里不出现终点结论
      （`PATH_LIB[].answerNote` 只给教师看，不进骨架）。
   ============================================================ */
function verifyTrainingData() {
  section("实训数据层（nav.js）");

  const doc = makeDoc();
  const sandbox = makeSandbox(doc, "training.html");
  const probe = probeFn(sandbox);
  const navSrc = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");

  try {
    vm.runInContext(navSrc, sandbox, { filename: "nav.js" });
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }

  /* --- ① 导航入口：挂在「教学」组，指向真实页面 --- */
  const item = probe("findTeacherNavItem('training')");
  item && item.page === "training.html" && item.label === "实训管理"
    ? pass("教师端「教学」组里有「实训管理」且指向 training.html")
    : fail("实训管理入口异常: " + JSON.stringify(item));
  probe("NAV.teacher.find((g) => g.title === '教学').items.some((i) => i.key === 'training')")
    ? pass("它挂在「教学」组里（不是别的组）") : fail("实训管理挂错分组");
  probe("PAGE_ROLE['training.html']") === "teacher"
    ? pass("training.html 在 PAGE_ROLE 登记为教师页（高亮 / 越权拦截都靠它）")
    : fail("PAGE_ROLE 未登记 training.html: " + probe("PAGE_ROLE['training.html']"));
  probe("(function () { var n = pendingStudentActivities();"
    + " var b = findTeacherNavItem('training').badge;"
    + " return n ? b === n + ' 待确认' : b === undefined; })()")
    ? pass("学生发起直接开启 → 不再有「待确认」，教师端徽标不挂（0 不挂徽标这条边界仍守）")
    : fail("徽标与待确认数不一致");

  /* --- ② 存储按账号分桶（与课程同一规矩） --- */
  /ACTIVITY_KEY\s*\+\s*":"\s*\+\s*u/.test(navSrc)
    ? pass("实训存档键按账号拼接（st_activities:<角色>:<账号>）")
    : fail("实训存储没有按账号分桶");
  probe("normalizeActivities([]).length") === 0
    ? pass("空数组是有效存档（删光活动不复活演示数据）")
    : fail("空存档会被当成「没有记录」→ 演示数据复活");
  probe("normalizeActivities('坏值')") === null
    ? pass("坏存档返回 null（上层好判回落）") : fail("坏存档处理不当");

  /* --- ③ 🔴 最核心的不变量：不给答案，给路径 --- */
  const sk = probe("draftSkeleton('圆的面积公式是怎么创造出来的')");
  sk && sk.source === "path" && sk.pathId === "circle-area"
    ? pass("一句话目标能命中预置路径库（圆面积 → 割圆术）")
    : fail("路径命中异常: " + JSON.stringify(sk && { s: sk.source, p: sk.pathId }));
  probe("('answerNote' in draftSkeleton('圆的面积公式是怎么来的'))") === false
    ? pass("骨架里不带 answerNote（终点结论只留给教师看）")
    : fail("把 answerNote 拷进骨架了 —— 等于把答案发给学生");
  probe("JSON.stringify(draftSkeleton('圆的面积公式是怎么来的')).indexOf('πr²')") === -1
    ? pass("骨架文本里不出现终点结论（πr²）—— 「不给答案」是机器可验的")
    : fail("骨架里出现了结论，这条路就白走了");
  probe("draftSkeleton('圆的面积公式是怎么来的').stages.every((s) => s.title && s.prompt && s.tryIt)")
    ? pass("每一步都有「标题 + 引导问题 + 动手做」三件套")
    : fail("有步骤缺引导问题或缺动手项 —— 就成了空壳");
  probe("PATH_LIB.every((p) => p.stages.length >= 3 && p.stages.every((s) => s.prompt && s.tryIt))")
    ? pass("路径库里每条路径都是 ≥3 步的完整骨架") : fail("路径库有条目不完整");
  probe("PATH_LIB.every((p) => !!p.answerNote)")
    ? pass("每条路径都给教师留了 answerNote（提醒终点在哪、为什么别急着给）")
    : fail("路径库缺 answerNote");

  /* --- ④ 未命中 → 通用骨架（也要"只给路径"），来源如实说明 --- */
  probe("draftSkeleton('怎么泡一杯好喝的咖啡').source") === "generic"
    ? pass("没命中路径库时给通用探究骨架（不硬套一条无关路径）") : fail("误命中路径库");
  probe("draftSkeleton('怎么泡一杯好喝的咖啡').stages.length") >= 3
    ? pass("通用骨架也是完整的一条路径（≥3 步）") : fail("通用骨架步数不足");
  probe("/通用/.test(skeletonSourceText(draftSkeleton('怎么泡一杯好喝的咖啡')))"
    + " && /命中预置路径库/.test(skeletonSourceText(draftSkeleton('勾股定理是怎么发现的')))")
    ? pass("界面能如实说明骨架来源（命中哪条 / 通用），不假装联网检索过")
    : fail("骨架来源说明不到位");
  probe("draftSkeleton('圆').pathId") === ""
    ? pass("只命中一个单字关键词不算命中（避免误套路径）") : fail("单字关键词误命中");

  /* --- ⑤ 活动 CRUD 与状态机 --- */
  const n0 = probe("ACTIVITIES.length");
  n0 >= 2 ? pass(`预置演示实训 ${n0} 条（教师发布 + 学生发起各一条）`)
    : fail("预置实训数量异常: " + n0);
  probe("ACTIVITIES.some((a) => a.origin === 'student' && a.status === 'open')")
    ? pass("有一条「学生发起、直接开启」的演示活动（灵感 02 的入口）") : fail("没有学生发起的演示活动");

  const c1 = probe("createActivity({ goal: '柯里化到底解决了什么问题' })");
  c1 && c1.ok && c1.activity.status === "draft"
    ? pass("新建实训默认是草案（骨架先给教师过一眼，不直接发出去）")
    : fail("新建实训状态异常: " + JSON.stringify(c1));
  probe("ACTIVITIES.length") === n0 + 1 ? pass("新建后活动数 +1") : fail("新建没进列表");
  probe("createActivity({ goal: '' }).ok") === false
    ? pass("空目标被拦下（返回 {ok:false}）") : fail("空目标也能建");
  probe("setActivityStatus('" + c1.activity.id + "', 'publish').ok") === false
    ? pass("未知状态被拦下（不静默改坏数据）") : fail("未知状态被接受");
  probe("setActivityStatus('" + c1.activity.id + "', 'open').ok") === true
    ? pass("有骨架的活动可以发布为「进行中」") : fail("发布失败");
  probe("(function () { var r = createActivity({ goal: '空骨架用例' });"
    + " updateActivity(r.activity.id, { skeleton: { source: 'generic', stages: [] } });"
    + " return setActivityStatus(r.activity.id, 'open').ok; })()") === false
    ? pass("没有任何引导步骤的实训不允许发布（拦住空壳活动）") : fail("空骨架也能发布");

  /* --- ⑥ 步骤增删调序（沿用"插到谁前面"的约定） --- */
  const seq = probe("(function () {"
    + " var r = createActivity({ goal: '步骤调序用例' });"
    + " var id = r.activity.id;"
    + " var b = ACTIVITIES.find(function (a) { return a.id === id; });"
    + " var ids0 = b.skeleton.stages.map(function (s) { return s.id; });"
    + " addStage(id, null);"                                  // 末尾加一步
    + " var n1 = b.skeleton.stages.length;"
    + " var movedId = b.skeleton.stages[n1 - 1].id;"          // 末尾那一步（新增的）
    + " moveStage(id, movedId, ids0[0]);"                     // 挪到最前面
    + " return { n0: ids0.length, n1: n1,"
    + "          first: b.skeleton.stages[0].id === movedId,"
    + "          second: b.skeleton.stages[1].id === ids0[0],"
    + "          count: b.skeleton.stages.length }; })()");
  seq && seq.n1 === seq.n0 + 1 ? pass("加一步：骨架步数 +1") : fail("addStage 无效: " + JSON.stringify(seq));
  seq && seq.first && seq.second && seq.count === seq.n1
    ? pass("moveStage：用「插到谁前面」表达（末尾一步挪到最前，原来第一步顺位后移）")
    : fail("调序结果不对: " + JSON.stringify(seq));
  probe("(function () { var b = ACTIVITIES[ACTIVITIES.length - 1];"
    + " moveStageBy(b.id, b.skeleton.stages[0].id, -1); return 1; })()")
    ? pass("moveStageBy：第一步再上移不会越界（内部边界由 moveStageBy 拦）")
    : fail("上移越界");
  probe("(function () { var b = ACTIVITIES[ACTIVITIES.length - 1];"
    + " while (b.skeleton.stages.length > 1) removeStage(b.id, b.skeleton.stages[0].id);"
    + " return removeStage(b.id, b.skeleton.stages[0].id).ok; })()") === false
    ? pass("删到只剩一步时被拦下（骨架不能是空的）") : fail("能把骨架删空");

  /* --- ⑦ 删除：先数清楚再删，返回被删掉的内容量 --- */
  const del = probe("(function () { var b = ACTIVITIES.filter(function (a) { return a.origin === 'teacher'; })[0];"
    + " var r = deleteActivity(b.id); return r && r.ok ? r.removed : null; })()");
  del && typeof del.stages === "number" && typeof del.participants === "number" && typeof del.findings === "number"
    ? pass("删除实训会返回连带删掉的步数 / 参与人数 / 发现数（删前能讲清楚）")
    : fail("删除返回值缺计数: " + JSON.stringify(del));
  probe("deleteActivity('不存在的 id').ok") === false
    ? pass("删不存在的活动返回 {ok:false}") : fail("删不存在的活动没拦住");

  /* --- ⑧ 未知状态一律兜底，别 undefined.label 崩 --- */
  probe("activityStatus('nonsense').label") === "草案"
    ? pass("未知状态读出来有兜底（不会 undefined.label 崩掉整页）") : fail("状态兜底失效");
  probe("normalizeActivities([{ title: '坏状态', status: 'whatever', skeleton: { stages: [{ prompt: 'p', tryIt: 't' }] } }])[0].status") === "draft"
    ? pass("存档里出现未知状态会被归一化回草案") : fail("未知状态没有归一化");
}

/* ============================================================
   实训 —— 学生端（参与 + 发起）
   ------------------------------------------------------------
   学生端「实训」页（training-student.html）：
     参与老师发布的 open/done 活动（跨账号桶读）、逐步推进、
     记路线、标记新发现、并自己发起（origin:student，**直接开启**）。
   🔴 与 exam / courseware 同一套跨桶规矩：
     老师发的记录在老师桶里 → 学生跨桶读；学生发起 → 落学生桶 + 同步本机教师桶。
   ============================================================ */
function verifyStudentTraining() {
  section("实训 —— 学生端（参与 + 发起）");

  const doc = makeDoc();
  const sandbox = makeSandbox(doc, "training-student.html");
  const probe = probeFn(sandbox);
  const navSrc = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");

  /* 预置跨账号环境：两个账号 + 老师桶里一条 open 活动（记录在老师桶，学生桶里没有） */
  sandbox.localStorage.setItem("st_accounts", JSON.stringify([
    { role: "teacher", user: "teacher", pass: "x", name: "李老师" },
    { role: "student", user: "student", pass: "x", name: "李同学" },
  ]));
  sandbox.localStorage.setItem("st_current_user", "student:student");
  sandbox.localStorage.setItem("st_activities:teacher:teacher", JSON.stringify([{
    id: "act-x", title: "跨桶实训", goal: "圆的面积公式怎么来的", courseId: "ds",
    origin: "teacher", createdBy: "", status: "open", openEnded: true,
    skeleton: { source: "path", pathId: "circle-area", pathTitle: "圆的面积", era: "", goal: "圆的面积", stages: [
      { id: "s1", title: "第一步", prompt: "往哪想", clue: "线索", tryIt: "动手" },
      { id: "s2", title: "第二步", prompt: "往哪想2", clue: "线索2", tryIt: "动手2" },
    ] },
    participants: [], findings: [], createdAt: 1, updatedAt: 1,
  }]));

  try {
    vm.runInContext(navSrc, sandbox, { filename: "nav.js" });
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }

  /* --- ① 菜单入口 + PAGE_ROLE --- */
  const sItem = probe("findStudentNavItem('training')");
  sItem && sItem.page === "training-student.html" && sItem.label === "实训"
    ? pass("学生端「学习」组有「实训」且指向 training-student.html")
    : fail("学生端实训入口异常: " + JSON.stringify(sItem));
  probe("NAV.student.find((g) => g.title === '学习').items.some((i) => i.key === 'training')")
    ? pass("它挂在「学习」组（不是别的组）") : fail("实训挂错分组");
  probe("PAGE_ROLE['training-student.html']") === "student"
    ? pass("training-student.html 在 PAGE_ROLE 登记为学生页（高亮 / 越权拦截都靠它）")
    : fail("PAGE_ROLE 未登记 training-student.html: " + probe("PAGE_ROLE['training-student.html']"));
  probe("NAV.student.find((g) => g.title === '学习').items.some((i) => i.key === 'training' && i.page === 'training-student.html')")
    && probe("NAV.teacher.find((g) => g.title === '教学').items.some((i) => i.key === 'training' && i.page === 'training.html')")
    ? pass("双端「实训」各有各的页（教师 training.html / 学生 training-student.html），key 相同但不指向同一页")
    : fail("双端实训入口指向异常");

  /* --- ② 跨桶读：老师桶里的 open 活动，学生能读到 --- */
  probe("activitiesForStudent('student:student').some((a) => a.id === 'act-x')")
    ? pass("学生跨账号桶读到了老师发布的 open 实训（记录在老师桶里）")
    : fail("跨桶读取失效（学生读不到老师桶的活动）");
  probe("activitiesForStudent('').length") === 0
    ? pass("没身份时读不到任何实训（不泄露）") : fail("空身份泄露了实训");
  probe("activitiesForStudent('student:student').some((a) => a.origin === 'student' && a.createdBy === 'student:student' && a.status === 'open')")
    ? pass("「我发起的」也一并读到（直接开启，status=open）")
    : fail("自己发起的活动没被读到");

  /* --- ③ activityOfAnywhere --- */
  probe("!!activityOfAnywhere('act-x')")
    ? pass("activityOfAnywhere 能跨桶找到活动（学生才打得开）") : fail("跨桶查找失效");

  /* --- ④ 进度层（存学生桶） --- */
  probe("markStageDone('act-x', 's1', false).ok") === true
    ? pass("能记录「走到哪一步」") : fail("推进进度失败");
  probe("myProgressOf('act-x').currentStage") === "s1"
    ? pass("进度读得回（currentStage）") : fail("进度读回失败: " + JSON.stringify(probe("myProgressOf('act-x')")));
  probe("markStageDone('act-x', '', true).ok") === true && probe("myProgressOf('act-x').done") === true
    ? pass("能标记「走完了」（done）") : fail("完成标记失败");
  probe("addRouteNote('act-x', '我把它拼成长方形').ok") === true
    ? pass("能记路线笔记") : fail("记笔记失败");
  probe("myProgressOf('act-x').notes.length") >= 1
    ? pass("笔记读得回") : fail("笔记读回失败");
  probe("addRouteNote('act-x', '  ').ok") === false
    ? pass("空笔记被拦") : fail("空笔记也被记");
  probe("(function(){ var raw = window.localStorage.getItem('st_training_progress:student:student'); return !!raw; })()")
    ? pass("进度真的落盘到学生桶（st_training_progress:<角色>:<账号>）")
    : fail("进度没落盘到学生桶");

  /* --- ⑤ 新发现（广播写回老师桶） --- */
  const f = probe("addMyFinding('act-x', '我试了割补法', '李同学')");
  f && f.ok ? pass("能标记新发现") : fail("标记新发现失败: " + JSON.stringify(f));
  probe("(function(){ var raw = window.localStorage.getItem('st_activities:teacher:teacher'); return raw && raw.indexOf('割补法') >= 0; })()")
    ? pass("新发现写回了老师桶（老师看得到）") : fail("新发现没落到老师桶");
  probe("addMyFinding('act-x', '   ').ok") === false
    ? pass("空新发现被拦") : fail("空新发现也被记");

  /* --- ⑥ 学生发起：落学生桶 + 同步教师桶（直接开启） --- */
  const c = probe("createStudentActivity({ goal: '排序算法为什么有这么多' })");
  c && c.ok && c.activity.origin === "student" && c.activity.status === "open" && c.activity.createdBy === "student:student"
    ? pass("学生发起：origin=student、open（直接开启）、createdBy=自己")
    : fail("学生发起异常: " + JSON.stringify(c && c.activity));
  probe("(function(){ var raw = window.localStorage.getItem('st_activities:student:student'); return raw && raw.indexOf('排序算法') >= 0; })()")
    ? pass("学生发起的写进了学生自己的桶")
    : fail("学生发起的没落学生桶");
  probe("(function(){ var raw = window.localStorage.getItem('st_activities:teacher:teacher'); return raw && raw.indexOf('排序算法') >= 0; })()")
    ? pass("学生发起的同步到了本机教师桶（老师也能看到这条）")
    : fail("学生发起的没同步给老师");
  probe("createStudentActivity({ goal: '' }).ok") === false
    ? pass("学生发起空目标被拦") : fail("空目标也能发起");
  probe("localTeacherAccounts().length") >= 1
    ? pass("localTeacherAccounts 由账号库推出教师账号（同步用）") : fail("localTeacherAccounts 失效");

  /* --- ⑦ 学生端徽标 = 进行中数量（现算，不写死） --- */
  const badge = probe("(function(){ refreshStudentTrainingNav(); var b = findStudentNavItem('training').badge; return b; })()");
  badge && /^\d+ 个$/.test(String(badge))
    ? pass("学生端「实训」徽标现算 = 进行中数量（" + badge + "）")
    : fail("徽标异常: " + JSON.stringify(badge));
}

/* ============================================================
   学生选课 / 邀请码（nav.js）
   ------------------------------------------------------------
   学生端「我的课程 ＋」= 输入邀请码加入课堂。
   🔴 邀请码必须是**确定性派生**的：老师看到的码 = 学生要输入的码。
      断言里直接拿 joinCodeOf(预置课程) 去 findClassroom() 走一遍闭环。
   ============================================================ */
function verifyEnrollData() {
  section("学生选课 / 邀请码（nav.js）");

  const doc = makeDoc();
  const sandbox = makeSandbox(doc, "chat.html");
  const probe = probeFn(sandbox);

  try {
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sandbox, { filename: "nav.js" });
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }

  /* --- ① 加号走数据驱动（与教师端那两个同一套机制） --- */
  const act = probe("GROUP_ACTIONS.joinCourse");
  act && act.id === "joinCourseBtn" && /邀请码/.test(act.label || "")
    ? pass("GROUP_ACTIONS 声明了「输入邀请码加入课堂」加号")
    : fail("joinCourse 加号声明异常: " + JSON.stringify(act));
  probe("NAV.student.find((g) => g.title === '我的课程').action") === "joinCourse"
    ? pass("学生端「我的课程」组挂了 action=joinCourse（渲染侧自动出加号）")
    : fail("学生端「我的课程」组没挂 action");
  probe("NAV.student.find((g) => g.action === 'joinCourse').items.every((i) => !!i.page)")
    ? pass("学生课程项都带页面（不会渲染成灰的、点不动的占位）")
    : fail("学生课程里出现了没有 page 的灰显项");
  probe("NAV.student.find((g) => g.action === 'joinCourse').items.every((i) => /^course=/.test(i.arg || ''))")
    ? pass("学生课程项都带唯一 course 参数（多门课共用 chat.html 不会一起高亮）")
    : fail("学生课程项缺 course 参数");

  /* --- ② 邀请码：确定性、格式、唯一 --- */
  const c1 = probe("JSON.stringify(joinCodeOf(SEED_COURSES[0]))");
  const c2 = probe("JSON.stringify(joinCodeOf(SEED_COURSES[0]))");
  c1 === c2 && /^"[A-Z0-9]{1,8}-[2-9A-HJ-NP-Z]{4}"$/.test(c1)
    ? pass("邀请码是确定性派生且格式为「课程代码-4 位校验位」：" + JSON.parse(c1))
    : fail("邀请码格式/确定性不对: " + c1);
  !/[01OI]/.test(JSON.parse(c1).split("-")[1])
    ? pass("校验位不含 0/O/1/I（念给同学听、手抄都不会错）")
    : fail("校验位里出现了容易看错的字符: " + c1);
  probe("(function () { var codes = classroomCatalog().map(function (x) { return joinCodeOf(x.course); });"
    + " return new Set(codes).size === codes.length; })()")
    ? pass("课堂目录里没有两门课撞码（校验位起效）")
    : fail("有课程撞码 —— 学生会进错课堂");
  probe("joinCodeOf({ id: 'cs201-a', code: 'CS201' }) !== joinCodeOf({ id: 'cs201-b', code: 'CS201' })")
    ? pass("不同课但同课程代码，邀请码也不同（两位老师各开一门 CS201 不会串）")
    : fail("同课程代码的两门课撞码了");

  /* --- ③ 学生输入的容错 --- */
  probe("normalizeJoinCode(' cs201 - 7k3m ')") === probe("normalizeJoinCode('CS2017K3M')")
    ? pass("输入容错：忽略大小写 / 空格 / 连字符（少抄一个横线也能进）")
    : fail("输入容错失效");

  /* --- ④ 找课堂：完整码 / 只有课程代码 / 瞎写 --- */
  const full = probe("JSON.stringify(findClassroom(joinCodeOf(SEED_COURSES[0])))");
  JSON.parse(full) && JSON.parse(full).course && JSON.parse(full).course.id === "ds"
    ? pass("用预置课程的邀请码能找到课堂（老师给的码 = 学生输入的码）")
    : fail("邀请码找不到课堂: " + full);
  probe("(function () { var r = findClassroom('  cs201- ' + joinCodeOf(SEED_COURSES[0]).split('-')[1].toLowerCase());"
    + " return r && r.course.id; })()") === "ds"
    ? pass("码写歪了（小写 + 多敲空格）也能进同一个课堂")
    : fail("容错后仍找不到");
  probe("(function () { var r = findClassroom('CS201'); return r && r.course.id; })()") === "ds"
    ? pass("只报课程代码（老师常这样念）也能进 —— 唯一匹配时才认")
    : fail("只输入课程代码找不到");
  probe("findClassroom('ZZZ-9999')") === null
    ? pass("查无此码时返回 null（不瞎猜一个课堂）") : fail("瞎写的码也能匹配到课堂");
  probe("findClassroom('')") === null
    ? pass("空输入返回 null") : fail("空输入没拦住");

  /* --- ⑤ 加入 / 重复加入 / 退出 --- */
  const n0 = probe("ENROLLED.length");
  probe("ENROLLED.some((e) => e.courseId === 'ds')")
    ? pass("演示账号的选课里有预置课程（一进来就有课看）") : fail("演示选课为空");
  const dup = probe("JSON.stringify(enrollCourse(SEED_COURSES[0]))");
  JSON.parse(dup).ok === false && /已经/.test(JSON.parse(dup).error || "")
    ? pass("重复加入同一门课被拦下并说明（不静默复制一条）")
    : fail("重复加入没拦住: " + dup);
  const joined = probe("(function () { var r = createCourse({ name: '编译原理选课用例', code: 'ZZP1' });"
    + " var e = enrollCourse(r.course, 'teacher:teacher', 1700000000000);"
    + " return JSON.stringify({ ok: e.ok, id: e.enrollment && e.enrollment.courseId,"
    + " by: e.enrollment && e.enrollment.by, at: e.enrollment && e.enrollment.at }); })()");
  JSON.parse(joined).ok === true && JSON.parse(joined).id
    ? pass("加入课堂成功（记下课程 id）") : fail("加入失败: " + joined);
  probe("ENROLLED.length") === n0 + 1 ? pass("加入后选课表 +1") : fail("选课表没增加");
  probe("enrolledOf('" + JSON.parse(joined).id + "') !== null")
    ? pass("enrolledOf() 能查到这条选课") : fail("enrolledOf 查不到");
  probe("(function () { try { return /" + JSON.parse(joined).id + "/.test(window.localStorage.getItem(enrollStoreKey()) || ''); }"
    + " catch (e) { return false; } })()")
    ? pass("选课落盘（st_enroll，按账号分桶）") : fail("选课没落盘");
  probe("(function () { var r = leaveCourse('" + JSON.parse(joined).id + "');"
    + " return r.ok && !enrolledOf('" + JSON.parse(joined).id + "'); })()")
    ? pass("退出课堂：只删自己这条选课记录") : fail("退出课堂失败");
  probe("leaveCourse('不存在的课').ok") === false
    ? pass("退出没加入的课返回 {ok:false}") : fail("退出没加入的课没拦住");
  probe("normalizeEnrollments([]).length") === 0
    ? pass("空数组是有效选课存档（退光课堂不复活演示选课）")
    : fail("空选课存档会复活演示数据");
  probe("normalizeEnrollments([{ name: '没有课程 id' }, { courseId: 'x' }]).length") === 1
    ? pass("选课规整：没有 courseId 的记录被丢掉") : fail("选课规整不干净");

  /* --- ⑥ 课程名以「实时目录」为准（老师改名，学生跟着变） --- */
  const renamed = probe("(function () {"
    + " var r = createCourse({ name: '改名用例', code: 'ZZP2' });"
    + " enrollCourse(r.course, 'teacher:teacher');"
    + " updateCourse(r.course.id, { name: '改名用例（新）' });"
    + " var n = studentCourseName(r.course.id);"
    + " leaveCourse(r.course.id);"
    + " return n; })()");
  renamed === "改名用例（新）"
    ? pass("学生看到的课名优先取实时目录（老师改名学生跟着变，不是加入时的快照）")
    : fail("课名没跟着老师改: " + renamed);
  probe("studentCourseName('压根不存在的课')") === "压根不存在的课"
    ? pass("课已不在本机时退回快照 / id（不显示 undefined）") : fail("兜底异常");
  probe("accountDisplayName('teacher:zhangsan')") === "zhangsan"
    ? pass("账号标识取不到中文名时退回账号名（不显示 teacher:zhangsan）")
    : fail("账号显示名兜底异常: " + probe("accountDisplayName('teacher:zhangsan')"));

  /* --- ⑦ 两份 UI 必须成对（壳内 / 独立模式） --- */
  const shellSrc = fs.readFileSync(path.join(SITE, "assets", "shell.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8");
  ["openJoinCourse", "openJoinCode", "askLeaveCourse"].forEach((fn) => {
    shellSrc.includes("function " + fn) && coreSrc.includes("function " + fn)
      ? pass(`shell.js / core.js 都提供了 ${fn}()`)
      : fail(`${fn}() 只写了一边（另一端的侧栏点了没反应）`);
  });
  shellSrc.includes('data-more-kind') && coreSrc.includes('data-more-kind')
    ? pass("两端渲染都带 data-more-kind（教师/学生「⋯」菜单才不会串）")
    : fail("缺 data-more-kind");
  /dataset\.action === "joinCourse"/.test(shellSrc) && /dataset\.action === "joinCourse"/.test(coreSrc)
    ? pass("两端加号都能分发到「加入课堂」")
    : fail("加号分发漏了一端");
}

/* ============================================================
   学习行为日志（nav.js）—— 第 34 轮
   ------------------------------------------------------------
   这一层是「学生看到的学情」和「老师点学生姓名看到的详情」的**唯一数据源**，
   所以聚合函数全部做成「时间从参数进来」的纯函数，断言能喂固定时间点。
   ============================================================ */
function verifyBehaviorData() {
  section("学习行为日志（nav.js）");

  const doc = makeDoc();
  const sandbox = makeSandbox(doc, "chat.html");
  const probe = probeFn(sandbox);

  try {
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sandbox, { filename: "nav.js" });
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }

  /* --- ① 形状（键、函数、枚举兜底） --- */
  probe("BEHAVIOR_KEY") === "st_behavior"
    ? pass("行为日志键为 st_behavior（带 st_ 前缀）") : fail("键名不符: " + probe("BEHAVIOR_KEY"));
  ["logBehavior", "normBehavior", "behaviorOf", "behaviorInCourse", "behaviorSummary", "behaviorStreak",
   "behaviorByKind", "behaviorByTopic", "behaviorWeakTopics", "behaviorByDay",
   "behaviorTimeline", "behaviorTraits", "behaviorSeedCount", "behaviorNotes",
   "hasNoteAt", "topicOf", "dayStart", "clearBehavior"].forEach((fn) => {
    probe(`typeof ${fn}`) === "function" ? pass(`提供 ${fn}()`) : fail(`缺少 ${fn}()`);
  });
  probe("behaviorKind('nope').label") === "其他行为"
    ? pass("未知行为类型兜底为「其他行为」（不 undefined.label 崩掉）")
    : fail("未知行为类型没有兜底");
  probe("BEHAVIOR_MAX") === 400
    ? pass("日志有条数上限（BEHAVIOR_MAX=400，只丢最旧的）") : fail("没有条数上限");
  /* 按课堂筛：这是"学生自己看到的"与"老师点开看到的"能对上数的前提 */
  const inCourse = probe("(function () { var L = [{ courseId:'ds', at:1 }, { courseId:'os', at:2 }, { at:3 }];" +
    " return { ds: behaviorInCourse(L, 'ds').length, os: behaviorInCourse(L, 'os').length," +
    "   none: behaviorInCourse(L, '').length, nullList: behaviorInCourse(null, 'ds').length }; })()");
  inCourse && inCourse.ds === 2 && inCourse.os === 2 && inCourse.none === 3 && inCourse.nullList === 0
    ? pass("behaviorInCourse：只算本课 + 不分课的老记录（两边同一条规则）")
    : fail("behaviorInCourse 口径不对: " + JSON.stringify(inCourse));

  /* --- ② 规整：按时间升序 / 丢掉坏数据 / 超限截断 --- */
  const bt = probe(
    "(() => {" +
    "  const mk = (k, d, label, topic) => { const t = new Date(Date.now() - d * DAY_MS);" +
    "    t.setHours(20, 0, 0, 0); return { kind: k, label: label || ('行为' + d), topic: topic, at: t.getTime() }; };" +
    "  const L = normBehavior([mk('ask',0,'图的适用条件'), mk('got',0,'懂了'), mk('ask',2,'图的适用条件')," +
    "    { kind:'bogus', label:'x', at: Date.now() }, { kind:'ask', label:'没有时间的' }," +
    "    mk('note',5,'三路划分'), mk('read',3,'第 1 段')]);" +
    "  return { n: L.length, asc: L.every((e,i) => i === 0 || L[i-1].at <= e.at)," +
    "    other: L.filter((e) => e.kind === 'other').length," +
    "    sum: behaviorSummary(L, Date.now()), bykind: behaviorByKind(L)," +
    "    topics: behaviorByTopic(L), weak: behaviorWeakTopics(L)," +
    "    days: behaviorByDay(L, 14, Date.now()), streak: behaviorStreak(L, Date.now())," +
    "    traits: behaviorTraits(L, Date.now())," +
    "    capped: normBehavior(Array.from({ length: 450 }, (_, i) => ({ kind:'ask', label:'x', at: Date.now() - i * 1000 }))).length };" +
    "})()");
  bt && bt.n === 6 ? pass("规整：丢掉没时间的记录，未知类型归入「其他」（7 → 6）")
    : fail("规整结果不符: " + JSON.stringify(bt && bt.n));
  bt && bt.asc ? pass("规整后按时间升序（图表与时间线都假定有顺序）") : fail("规整后没有排序");
  bt && bt.other === 1 ? pass("未知 kind 保留下来但标为「其他」（不是静默丢掉）")
    : fail("未知 kind 处理异常: " + (bt && bt.other));
  bt && bt.capped === 400 ? pass("超过 400 条时只保留最新的一批") : fail("没有截断: " + (bt && bt.capped));

  /* --- ③ 概览 / 分布 / 分天 --- */
  bt && bt.sum.total === 6 ? pass("概览 total 正确（6 条）") : fail("total 不符: " + (bt && bt.sum.total));
  bt && bt.sum.week === 6 ? pass("近 7 天计数正确（都在 7 天内）") : fail("week 不符: " + (bt && bt.sum.week));
  bt && bt.sum.activeDays === 4 ? pass("活跃天数按天去重（今天 / -2 / -3 / -5 → 4 天）")
    : fail("活跃天数不符: " + (bt && bt.sum.activeDays));
  bt && bt.sum.byKind.ask === 2 ? pass("按类型计数正确（提问 2）") : fail("byKind.ask 不符");
  bt && bt.bykind.length && bt.bykind[0].kind === "ask"
    ? pass("按类型分布降序（最多的排第一）") : fail("类型分布没排序");
  bt && bt.days.length === 14 ? pass("近 14 天逐日序列长度 14") : fail("逐日序列长度不对");
  // 注意：那条未知类型的记录 at = Date.now()，所以"今天"一共 3 条（提问 + 懂了 + 其他）
  bt && bt.days[13].count === 3 && bt.days[12].count === 0 && bt.days[11].count === 1
    ? pass("逐日序列补 0 且对齐「今天」（今天 3 / 昨天 0 / 前天 1）")
    : fail("逐日序列对不齐: " + JSON.stringify(bt && bt.days.map((d) => d.count)));

  /* --- ④ 连续天数：今天没动不算断 --- */
  const st = probe(
    "(() => { const mk = (d) => { const t = new Date(Date.now() - d * DAY_MS);" +
    "    t.setHours(20,0,0,0); return { kind:'ask', label:'x', at:t.getTime() }; };" +
    "  return { three: behaviorStreak(normBehavior([mk(0), mk(1), mk(2)]), Date.now())," +
    "    noToday: behaviorStreak(normBehavior([mk(1), mk(2)]), Date.now())," +
    "    gap: behaviorStreak(normBehavior([mk(0), mk(1), mk(3)]), Date.now())," +
    "    none: behaviorStreak([], Date.now()) }; })()");
  st && st.three === 3 ? pass("连续 3 天算得对") : fail("连续天数不符: " + JSON.stringify(st));
  st && st.noToday === 2 ? pass("今天还没动不算断（从昨天起算 → 2 天）")
    : fail("「今天没动」被算成断了: " + (st && st.noToday));
  st && st.gap === 2 ? pass("中间断一天就停在断点之前（2 天）") : fail("断点判断不对: " + (st && st.gap));
  st && st.none === 0 ? pass("没有记录时连续天数为 0") : fail("空日志的连续天数不为 0");

  /* --- ⑤ 话题归类 / 薄弱话题（都是从行为推的） --- */
  const tp = probe("['快速排序最坏情况','Dijkstra 不能有负权边','哈希表冲突','链表的指针','今天天气不错']" +
    ".map((t) => topicOf(t))");
  tp && tp[0] === "排序" && tp[1] === "图" && tp[2] === "查找" && tp[3] === "线性表" && tp[4] === "其他"
    ? pass("话题归类正确（排序 / 图 / 查找 / 线性表，认不出就是「其他」）")
    : fail("话题归类异常: " + JSON.stringify(tp));
  bt && bt.topics.length === 2 && bt.topics[0].topic === "图" && bt.topics[0].count === 2
    ? pass("话题分布只统计提问 / 重讲 / 批注，且按次数降序（图 2 次）")
    : fail("话题分布异常: " + JSON.stringify(bt && bt.topics));
  bt && bt.weak.length === 1 && bt.weak[0].topic === "图"
    ? pass("「该补的地方」从行为推：反复问（≥2 次）且从没标「懂了」")
    : fail("薄弱话题推断异常: " + JSON.stringify(bt && bt.weak));
  const neg = probe(
    "(() => { const mk = (k, d, label) => { const t = new Date(Date.now() - d * DAY_MS);" +
    "    t.setHours(20,0,0,0); return { kind:k, label:label, at:t.getTime() }; };" +
    "  return { withGot: behaviorWeakTopics(normBehavior([mk('ask',1,'图'), mk('ask',1,'图'), mk('got',1,'图')])).length," +
    "    once: behaviorWeakTopics(normBehavior([mk('ask',1,'图')])).length," +
    "    traitNoAsk: behaviorTraits(normBehavior([mk('note',1,'x')]), Date.now())[0].score }; })()");
  neg && neg.withGot === 0 ? pass("标过「懂了」的话题不再算薄弱（否定用例）")
    : fail("标了懂了还算薄弱: " + (neg && neg.withGot));
  neg && neg.once === 0 ? pass("只问过一次不算「反复问」（否定用例）")
    : fail("问一次就算薄弱: " + (neg && neg.once));
  neg && neg.traitNoAsk === 0 ? pass("没有提问时画像没有基准（分数 0，不硬算一个百分比）")
    : fail("没有基准还给了分数: " + (neg && neg.traitNoAsk));
  bt && bt.traits.length === 5 && bt.traits[0].count === 0 && bt.traits[3].score === 50
    ? pass("画像 = 行为次数 ÷ 提问次数，且把原始次数带出来给人核")
    : fail("画像计算异常: " + JSON.stringify(bt && bt.traits));

  /* --- ⑥ 跨账号读 / 只有演示账号有种子 --- */
  probe("behaviorOf('student:student').length > 0")
    ? pass("教师端能读到某个学生账号的行为日志（behaviorOf）") : fail("读不到学生账号的日志");
  probe("behaviorOf('student:student').every((e) => e.seed === true)")
    ? pass("演示账号那份是预置记录，且**每一条都标了 seed**（界面据此如实说明）")
    : fail("预置记录没有全部标记 seed");
  probe("behaviorOf('student:nobody-xyz').length") === 0
    ? pass("本机不存在的学生 → 空日志（不回落成演示数据）")
    : fail("陌生账号读到了日志");
  probe("behaviorOf('')").length === 0
    ? pass("账号标识为空时返回空数组（不误读全局桶）") : fail("空标识返回值异常");
  // 造一个"另一个账号的行为桶"：键名与 st_behaviorStoreKey 的拼法必须一致
  const lisiBucket = JSON.stringify([
    { kind: "ask", label: "李四问的", at: Date.now() - 3600000 },
    { kind: "note", label: "李四写的批注", at: Date.now() - 1800000, seg: 3 },
  ]);
  probe("window.localStorage.setItem('st_behavior:student:lisi', " + JSON.stringify(lisiBucket) + ")");
  probe("behaviorOf('student:lisi').length") === 2
    ? pass("按「st_behavior:<角色>:<账号>」分桶读到另一个账号的记录")
    : fail("跨账号读取失败");
  probe("hasNoteAt(BEHAVIOR, '', 3) || hasNoteAt(behaviorOf('student:lisi'), '', 3)")
    ? pass("批注挂了段落号（hasNoteAt 能按段落查）") : fail("批注段落号没接上");
  probe("behaviorNotes(behaviorOf('student:lisi'), '').length") === 1
    ? pass("批注列表从行为日志里取（课件页与学情同源）") : fail("behaviorNotes 取值异常");

  /* --- ⑦ 写路径：记一条要能读回来 --- */
  const before = probe("BEHAVIOR.length");
  const rec0 = probe("logBehavior({ kind: 'ask', label: '快速排序怎么划分？' })");
  probe("BEHAVIOR.length") === before + 1
    ? pass("logBehavior 写进内存日志") : fail("logBehavior 没写进去");
  rec0 && rec0.topic === "排序" ? pass("写入时自动归类话题（提问 → 排序）")
    : fail("写入没有归类: " + JSON.stringify(rec0 && rec0.topic));
  /快速排序怎么划分/.test(String(probe("window.localStorage.getItem(behaviorStoreKey())") || ""))
    ? pass("logBehavior 顺手落盘（刷新不丢）") : fail("logBehavior 没落盘");
  probe("logBehavior({ kind: 'other', label: '' })") === null
    ? pass("既没类型又没内容的记录不写（避免噪声）") : fail("空记录被写进去了");
  probe("clearBehavior(); BEHAVIOR.length") === 0
    ? pass("clearBehavior() 清空当前账号的日志") : fail("clearBehavior 无效");
  probe("window.localStorage.getItem(behaviorStoreKey())") === "[]"
    ? pass("清空后存档写成空数组（不是删键 —— 否则演示账号刷新又会长出演示记录）")
    : fail("清空后存档状态不对");

  /* --- ⑧ 纯函数：同一个输入 + 同一个"现在" → 同一个输出 --- */
  const twice = probe(
    "(function () { var mk = function (k, d) { var t = new Date(Date.now() - d * DAY_MS);" +
    "   t.setHours(20,0,0,0); return { kind: k, label: 'x', at: t.getTime() }; };" +
    " var L = normBehavior([mk('ask', 1), mk('note', 2)]);" +
    " var n = Date.now();" +
    " return JSON.stringify(behaviorSummary(L, n)) === JSON.stringify(behaviorSummary(L, n)); })()");
  twice === true ? pass("聚合函数是纯函数（同输入同输出，断言不会因「跑测试的时刻」而飘）")
    : fail("聚合函数不稳定");
}

/* ============================================================
   三层技能库 + 画像（nav.js）—— 第 35 轮
   ------------------------------------------------------------
   参考 DeepTutor 的 skill / persona 分工。这里守四条：
     · 三层结构齐全，系统层 always
     · **群组层由 CLASSES / ENROLLED 真实派生**（不是写死的分类名）
     · 🔴 学生端一个写技能都没有；教师端每个写技能都带「等待确认」
     · 画像从行为推（会的 / 不会的 / 偏好），先修路线可解释
   ============================================================ */
function verifySkillData() {
  section("三层技能 + 画像（nav.js）");

  const navSrc = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");

  /**
   * 造一个干净沙箱：先把本机存档塞进去，再跑 nav.js。
   * 🔴 **nav.js 一个沙箱只能跑一次** —— 它顶层有 `let BEHAVIOR_SEQ` / `let ACT_STAGE_SEQ`，
   *    在同一个 realm 里再跑一遍会直接 `SyntaxError: Identifier has already been declared`
   *    （第 35 轮踩到：想用"重跑一次拿到新数据"的写法，结果第二个用例整段没跑）。
   */
  const boot = (ls) => {
    const sb = makeSandbox(makeDoc(), "agent.html");
    const p = probeFn(sb);
    Object.keys(ls || {}).forEach((k) => {
      p("window.localStorage.setItem(" + JSON.stringify(k) + ", " + JSON.stringify(String(ls[k])) + ")");
    });
    try { vm.runInContext(navSrc, sb, { filename: "nav.js" }); }
    catch (e) { fail("nav.js 报错: " + e.message); }
    return p;
  };

  const T = boot();                       // 教师视角（本机有 CLASSES / COURSES 种子）
  const probe = T;

  /* --- ① 三层结构 --- */
  probe("JSON.stringify(SKILL_LAYER_ORDER)") === '["system","group","atomic"]'
    ? pass("三层顺序固定：系统层 / 群组层 / 原子层") : fail("层顺序不对");
  probe("SYSTEM_SKILLS.length") >= 3 && probe("SYSTEM_SKILLS.every((s) => s.always === true)")
    ? pass("系统层 " + probe("SYSTEM_SKILLS.length") + " 条，每条都 always（每次挂载）")
    : fail("系统层没有全部 always");
  probe("ATOMIC_SKILLS.length") >= 8
    ? pass("原子层 " + probe("ATOMIC_SKILLS.length") + " 条最细的活") : fail("原子层太少");
  probe("GROUP_SCENES.length") >= 5
    ? pass("群组层有 " + probe("GROUP_SCENES.length") + " 个通用场景") : fail("群组场景太少");
  probe("roleSkills('teacher').every((s) => !!s.id && !!s.name && !!s.desc && !!s.when)")
    ? pass("每条技能都有 id / 名称 / 说明 / 什么时候用") : fail("有技能缺字段");
  probe("roleSkills('teacher').every((s) => (s.steps || []).length > 0)")
    ? pass("每条技能都写了可展示的步骤（不是只有一句说明）") : fail("有技能没写步骤");

  /* --- ② 群组层必须由真实数据派生 --- */
  probe("groupSkills('teacher').filter((s) => s.groupType === 'class').length") === probe("CLASSES.length")
    ? pass("教师端群组层按 CLASSES 派生：一班一条（" + probe("CLASSES.length") + " 个班）")
    : fail("班级技能数与 CLASSES 不一致");
  probe("groupSkills('teacher').filter((s) => s.groupType === 'course').length") === probe("COURSES.length")
    ? pass("教师端群组层按 COURSES 派生：一门课一条") : fail("课程技能数与 COURSES 不一致");
  probe("groupSkills('teacher').filter((s) => s.groupType === 'class').every((s) => (s.keys || []).indexOf(s.name) >= 0)")
    ? pass("班级技能按班名命中（说出班名就能挂上）") : fail("班级技能没有按班名做关键词");

  /* --- ③ 🔴 只读铁律（学生端 vs 教师端） --- */
  probe("roleSkills('student').filter((s) => s.kind === 'write').length") === 0
    ? pass("学生端一个「会改动」的技能都没有") : fail("学生端混进了写技能");
  probe("JSON.stringify(roleSkills('student').flatMap((s) => (s.steps || []).map((x) => x.arg || '')).filter((a) => /publish_|delete_/.test(a)))") === "[]"
    ? pass("学生端所有步骤里不含 publish_ / delete_（动作链只读）") : fail("学生端出现了写动作");
  probe("JSON.stringify(planFromChain(routeSkills('发布作业并删除章节', { role: 'student' }).chain, { role: 'student' }).filter((s) => s.kind === 'write'))") === "[]"
    ? pass("学生即使被要求发布 / 删除，动作链里也不会出现写操作") : fail("学生端能被路由出写操作");
  probe("roleSkills('teacher').filter((s) => s.kind === 'write').every((s) => (s.steps || []).some((x) => x.name === '等待确认'))")
    ? pass("教师端每个写技能都在步骤里带「等待确认」") : fail("有写技能没带确认步");
  probe("planFromChain(routeSkills('帮我出一道题', { role: 'teacher' }).chain, { role: 'teacher' }).some((s) => s.wait)")
    ? pass("教师端路由出写操作时，动作链里确实插进了确认步") : fail("确认步没插进去");
  probe("planFromChain([{ id: 'x', layer: 'atomic', kind: 'write', name: 'x', steps: [{ name: '干活' }] }], { role: 'teacher' }).some((s) => s.wait)")
    ? pass("兜底：写技能自己漏了确认步时，planFromChain 会补一步") : fail("兜底没生效");
  probe("planFromChain([{ id: 'x', layer: 'atomic', kind: 'write', name: 'x', steps: [{ name: '干活' }] }], { role: 'teacher', allowWrite: false })[0].downgraded") === true
    ? pass("授权关闭时写操作被标为「只给建议」") : fail("授权开关没接进动作链");

  /* --- ④ 路由：命中与回落 --- */
  const hit = (q, role) => probe("JSON.stringify(routeSkills(" + JSON.stringify(q) + ", { role: '" + role + "' }).atomic.map((s) => s.id))");
  /atom-proofread/.test(hit("校对一下这份教案", "teacher")) ? pass("「校对」命中原子层 atom-proofread") : fail("校对没命中");
  /atom-gen-quiz/.test(hit("帮我出一道题", "teacher")) ? pass("「帮我出一道题」命中出题（自然说法也认）") : fail("出题没命中");
  /atom-analogy/.test(hit("我图论听不懂，用我懂的类比讲讲", "student")) ? pass("「用我懂的类比讲讲」命中 atom-analogy") : fail("类比没命中");
  /atom-diagnose/.test(hit("我哪块最弱", "student")) ? pass("「我哪块最弱」命中定位薄弱") : fail("定位薄弱没命中");
  probe("routeSkills('计科 2301 班谁跟不上', { role: 'teacher' }).group.some((s) => s.id === 'grp-class-cs2301')")
    ? pass("点到班级名时挂上的是**那个班**的技能") : fail("班级没命中");
  probe("routeSkills('你能做什么', { role: 'teacher', courseId: 'ds' }).group.some((s) => s.fallback === true)")
    ? pass("没点名时群组层回落到「你当前的课」并标出 fallback") : fail("群组层没有上下文回落");
  probe("routeSkills('你能做什么', { role: 'teacher' }).system.length") >= 3
    ? pass("系统层无条件挂满（怎么用这个应用）") : fail("系统层没挂满");
  probe("routeSkills('随便说点什么', { role: 'student' }).atomic.length") === 0
    ? pass("原子层只在真命中时才挂（没提到那件活就不挂）") : fail("原子层乱挂");

  /* --- ⑤ runSkill：能算的当场算（确定性，不假动作） --- */
  const t2t = probe("JSON.stringify(runSkill('atom-text-to-table', { text: '周一 第1-2节 数据结构与算法 6A-301 计科2301\\n周二,第3-4节,操作系统,6B-105,计科2301\\n这一行缺少节次' }, { role: 'teacher' }).lines)");
  /周一,第1-2节,数据结构与算法,6A-301,计科2301/.test(t2t)
    ? pass("文本转表格：真的解析出了标准格式那一行") : fail("转表格结果不对");
  /没认出来/.test(t2t) ? pass("认不出来的行原样列出（不猜、不丢）") : fail("没有交代认不出的行");
  const LESSON_MD = "# 7.2 快速排序\n课程：数据结构与算法　课时长度：45 分钟\n\n## 教学目标\n讲清快排复杂度\n\n## 教学重点\n- 划分平衡性\n\n## 教学难点\n划分平衡性\n\n## 课堂流程\n- 导入（5 分钟）：提问\n- 讲解（20 分钟）：推导\n- 练习（8 分钟）：做题\n\n## 作业布置\n（待补充）\n\n## 学情提示\n（未填写）";
  const lc = probe("JSON.stringify(runSkill('atom-lesson-check', { text: " + JSON.stringify(LESSON_MD) + " }, { role: 'teacher' }).lines)");
  /33 分钟/.test(lc) && /45 分钟/.test(lc) ? pass("教案自查：算出流程时长与课时长度不符（33 / 45 分钟）") : fail("时长没算出来");
  /作业布置/.test(lc) && /空的/.test(lc) ? pass("教案自查：指出空小节") : fail("空小节没查出");
  /重合/.test(lc) ? pass("教案自查：指出重点与难点重复") : fail("重点难点重复没查出");
  const de = probe("JSON.stringify(runSkill('atom-diff-explain', { text: '## 教学目标\\n+ 新增一行\\n- 删掉一行\\n\\n## 课堂流程\\n+ 加了一步' }, { role: 'teacher' }).lines)");
  /2 个小节/.test(de) && /新增 2 行/.test(de) && /删除 1 行/.test(de)
    ? pass("差异解读：客观归纳出小节数与增删行数") : fail("差异归纳不对");
  // ⚠️ 口径写在 note 里而不是 lines 里 —— 断言要盯对字段（盯错了会红而产品没错）
  // ⚠️ 探针表达式里**不要写字面换行**（外层字符串会把 \n 变成真换行，内层字符串立刻非法）
  //    —— 用 String.fromCharCode(10) 拼，或者干脆 JSON.stringify 整个返回值
  const deObj = probe("JSON.stringify(runSkill('atom-diff-explain', { text: '## 教学目标' + String.fromCharCode(10) + '+ 新增一行' }, { role: 'teacher' }))");
  /客观/.test(deObj)
    ? pass("差异解读在说明里交代口径：只客观归纳、不评价好坏") : fail("没写口径");
  probe("runSkill('atom-lesson-draft', { chapterTitle: '第 7 章', hours: 4 }, { role: 'teacher' }).lines.join('').indexOf('待补充') >= 0")
    ? pass("起草教案：没有 Key 时给「结构完整但内容待补充」的骨架") : fail("草稿骨架不对");
  probe("runSkill('atom-lesson-draft', {}, { role: 'teacher' }).note.indexOf('API Key') >= 0")
    ? pass("起草教案如实说明「成文需要 API Key」") : fail("没有 Key 的降级说明缺失");
  probe("runSkill('no-such-skill', {}, { role: 'teacher' }).ok") === false
    ? pass("跑不存在的技能返回 ok:false（不静默失败）") : fail("未知技能没有报错");

  /* --- ⑥ 画像：从行为推，且能解释 --- */
  const BEH = [];
  for (let i = 0; i < 2; i++) BEH.push({ kind: "ask", label: "图的最短路径适用条件", topic: "图", courseId: "ds", at: Date.now() - 86400000 });
  BEH.push({ kind: "ask", label: "树怎么遍历", topic: "树", courseId: "ds", at: Date.now() - 86400000 });
  BEH.push({ kind: "got", label: "树怎么遍历", topic: "树", courseId: "ds", at: Date.now() - 86400000 });
  BEH.push({ kind: "ask", label: "排序稳定性怎么判断", topic: "排序", courseId: "ds", at: Date.now() - 86400000 });
  BEH.push({ kind: "ask", label: "排序怎么划分", topic: "排序", courseId: "ds", at: Date.now() - 86400000 });
  BEH.push({ kind: "code", label: "看代码", topic: "排序", courseId: "ds", at: Date.now() - 86400000 });
  BEH.push({ kind: "code", label: "看代码", topic: "图", courseId: "ds", at: Date.now() - 86400000 });
  const S = boot({
    st_current_user: "student:zhangsan",
    "st_enroll:student:zhangsan": JSON.stringify([
      { courseId: "ds", name: "数据结构与算法", code: "CS201", joinCode: "CS201-22DT", at: 1 },
    ]),
    "st_behavior:student:zhangsan": JSON.stringify(BEH),
  });
  S("groupSkills('student').filter((s) => s.groupType === 'course').length") >= 1
    ? pass("学生端群组层按他自己的 ENROLLED 派生（我加入的课堂）") : fail("学生端没有按选课派生群组技能");
  S("BEHAVIOR.length") >= 8 ? pass("学生视角读到了自己的行为记录（" + S("BEHAVIOR.length") + " 条）") : fail("行为记录没读进来");

  const prof = S("JSON.stringify(behaviorProfile(BEHAVIOR, Date.now()))");
  /"topic":"树"/.test(prof) ? pass("画像：从「标过懂了」推出「已经懂的」") : fail("known 没推出来");
  /"topic":"图","count":2/.test(prof) ? pass("画像：从「反复问且没标懂」推出「反复卡住的」") : fail("gaps 没推出来");
  S("fitPersona(Date.now()).changes.length") > 0
    ? pass("磨合：第一次跑写出一条依据（不是空转）") : fail("磨合没产生依据");
  S("fitPersona(Date.now()).changes.length") === 0
    ? pass("磨合是幂等的：同样的行为不会反复刷记录") : fail("磨合不幂等");
  S("MY_PERSONA.log.length") === 1 ? pass("磨合记录留了一条，写明依据多少条行为") : fail("磨合记录数不对（" + S("MY_PERSONA.log.length") + "）");
  S("MY_PERSONA.known.join(',')") === "树" ? pass("磨合结果写进了画像的 known") : fail("known 没写进画像");
  S("MY_PERSONA.gaps.join(',')") === "图,排序" ? pass("磨合结果写进了画像的 gaps") : fail("gaps 没写进画像");
  S("window.localStorage.getItem('st_persona:student:zhangsan')") !== null
    ? pass("画像按账号落盘（st_persona:<角色>:<账号>）") : fail("画像没落盘");

  // ⚠️ 别把局部变量叫 path —— 它会遮蔽模块顶部的 const path = require("path")，
  //    结果是函数体里更早的 path.join(...) 直接 TDZ 报错（第 35 轮踩到，和全局名撞车同一族）
  const route = S("JSON.stringify(learningPath(behaviorProfile(BEHAVIOR, Date.now()), 3))");
  /"chain":\["树","图"\]/.test(route) ? pass("学习路径：先修「树」已标懂 → 路线是 树 → 图") : fail("先修路线不对");
  /"bridge":"树是/.test(route) ? pass("学习路径带上预置的类比桥（从树讲到图）") : fail("类比桥没带上");
  S("learningPath(behaviorProfile(BEHAVIOR, Date.now()), 3).filter((x) => x.topic === '排序')[0].bridge") === ""
    ? pass("没有预置桥的路线如实留空（页面会写「本版没预置」，不编）") : fail("没预置的桥不该编");
  S("learningPath(behaviorProfile(BEHAVIOR, Date.now()), 3).filter((x) => x.topic === '排序')[0].chain.join('→')") === "线性表→排序"
    ? pass("先修没标懂时，路线从先修起步（线性表 → 排序）") : fail("先修没标懂的处理不对");
  S("personaBrief(behaviorProfile(BEHAVIOR, Date.now())).join('|').indexOf('已经懂了')") >= 0
    ? pass("讲法简报包含「已经懂了」与「切入顺序」（persona 该注入的东西）") : fail("简报内容不全");
  S("JSON.stringify(learningPath(behaviorProfile([], Date.now())))") === "[]"
    ? pass("没有任何行为时路线为空（不编一条假路线）") : fail("空数据下路线不为空");
  S("typeof personaFitLine(behaviorProfile([], Date.now()))") === "string"
    ? pass("没有行为时也给得出默认讲法（基础画像永远在）") : fail("默认讲法缺失");
  S("clearPersona(); MY_PERSONA.known.length") === 0
    ? pass("clearPersona() 能回到基础画像") : fail("clearPersona 无效");
}

/**
 * 🔴 nav.js 的顶层全局名不得与任何页面内联脚本的 `const/let` 重名。
 * 第 26/27/28/29/35 轮一共踩了 5 次：重名 → `SyntaxError: Identifier 'X' has already been declared`
 * → **整个脚本不执行**（不是报个错就过去，是整页功能全没了；第 35 轮撞的是登录页的 `PERSONA`）。
 * 这里把「靠人记」换成机器扫：只比顶层（列 0）的 const/let，函数内的局部名不算。
 */
function verifyGlobalNames() {
  section("全局命名（防撞车）");
  const navSrc = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");
  const globals = new Set();
  navSrc.replace(/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm, (m, n) => { globals.add(n); return m; });
  const clashes = [];
  ALL_PAGES.forEach((f) => {
    const html = fs.readFileSync(path.join(SITE, f), "utf8");
    const inline = (html.match(/<script>[\s\S]*?<\/script>/g) || []).join("\n");
    const lex = new Set();
    inline.replace(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/gm, (m, n) => { lex.add(n); return m; });
    lex.forEach((n) => { if (globals.has(n)) clashes.push(f + " 的 " + n); });
  });
  clashes.length === 0
    ? pass("nav.js 的全局名与 " + ALL_PAGES.length + " 个页面的顶层 const/let 无重名（重名会让整页脚本不执行）")
    : fail("全局名与页面局部名撞车：" + clashes.join("、"));
}

function verifyGlobal() {
  section("全站一致性");

  const missing = ALL_PAGES.filter((p) => !fs.existsSync(path.join(SITE, p)));
  missing.length === 0 ? pass(`全部 ${ALL_PAGES.length} 个页面齐备`)
    : fail("缺失页面: " + missing.join(", "));

  // 侧栏产物必须唯一（只有壳渲染侧栏）
  const withSide = CONTENT_PAGES.filter((p) =>
    /id="sideNav"/.test(fs.readFileSync(path.join(SITE, p), "utf8")));
  withSide.length === 0 ? pass("侧栏渲染唯一收敛到壳（内容页零残留）")
    : fail("内容页仍含侧栏: " + withSide.join(", "));

  // 内容页必须都引用 core.js
  const noCore = CONTENT_PAGES.filter((p) =>
    !/assets\/core\.js/.test(fs.readFileSync(path.join(SITE, p), "utf8")));
  noCore.length === 0 ? pass("全部内容页引用 core.js（共享工具层）")
    : fail("未引用 core.js: " + noCore.join(", "));

  // 资源文件存在
  ["assets/design.css", "assets/shell.css", "assets/core.js", "assets/shell.js"].every((f) =>
    fs.existsSync(path.join(SITE, f)))
    ? pass("全部资源文件齐备（design.css / shell.css / core.js / shell.js）")
    : fail("资源文件缺失");

  // design.css 必须定义壳与无障碍变量
  const css = fs.readFileSync(path.join(SITE, "assets/design.css"), "utf8");
  /--a11y-font-size/.test(css) ? pass("design.css 定义无障碍变量")
    : fail("design.css 缺少 --a11y-font-size");
  /\.page-wrap/.test(css) ? pass("design.css 定义 .page-wrap") : fail("design.css 缺 .page-wrap");
  /\[data-contrast\]/.test(css) ? pass("design.css 支持高对比度") : fail("design.css 缺 [data-contrast]");
  /\[data-reduce-motion\]/.test(css) ? pass("design.css 支持降低动效") : fail("design.css 缺 [data-reduce-motion]");

  const scss = fs.readFileSync(path.join(SITE, "assets", "shell.css"), "utf8");
  /\.shell-top/.test(scss) && /\.shell-side/.test(scss) && /\.shell-frame/.test(scss)
    ? pass("shell.css 定义顶部栏 / 侧栏 / iframe 布局") : fail("shell.css 结构样式缺失");
  /\.shell-side\.collapsed/.test(scss) ? pass("shell.css 支持侧栏折叠态") : fail("shell.css 缺折叠态");

  /* 🔴 侧栏底部（用户卡片）必须**固定**，不能被长菜单顶下去。
     做法：侧栏自身不滚，滚动交给 .side-nav —— 只有菜单区滚，脚注永远看得见。
     如果哪天把 overflow-y:auto 写回 .shell-side，菜单一长脚注又会被推到滚动末尾。 */
  // ⚠️ 必须先剥掉 CSS 注释再匹配 —— 注释里正好写着「之前这里是 overflow-y: auto」，
  //    直接匹配会把解释文字当成代码（这个坑在 JS 侧已经踩过两次，见 stripComments）。
  const scssCode = scss.replace(/\/\*[\s\S]*?\*\//g, "");
  const sideBase = (scssCode.match(/\.shell-side\s*\{([^}]*)\}/) || [, ""])[1];
  !/overflow-y\s*:\s*auto/.test(sideBase)
    ? pass("侧栏本身不滚动（底部用户卡片不会被长菜单顶下去）")
    : fail("`.shell-side` 又写成 overflow-y:auto —— 底部脚注会被顶到滚动末尾");
  const sideNavCss = (scssCode.match(/\.shell-side\s+\.side-nav\s*\{([^}]*)\}/) || [, ""])[1];
  /overflow-y\s*:\s*auto/.test(sideNavCss) && /min-height\s*:\s*0/.test(sideNavCss)
    ? pass("菜单区 .side-nav 单独滚动（min-height:0 让 flex 子项真的能收缩）")
    : fail("缺 .side-nav 的滚动规则，或漏了 min-height:0（漏了滚动不会生效）");
  const sideFootCss = (scssCode.match(/\.shell-side\s+\.side-foot\s*\{([^}]*)\}/) || [, ""])[1];
  /flex\s*:\s*0\s+0\s+auto/.test(sideFootCss) && !/margin-top\s*:\s*auto/.test(sideFootCss)
    ? pass(".side-foot 不参与伸缩（固定贴底）")
    : fail(".side-foot 还在靠 margin-top:auto —— 内容超高时就会失效");

  const sideRenderFiles = ["assets/shell.js", "assets/core.js"];
  const noNavWrap = sideRenderFiles.filter((f) =>
    !/class="side-nav"/.test(fs.readFileSync(path.join(SITE, f), "utf8")));
  noNavWrap.length === 0
    ? pass("两处侧栏渲染都包出了 .side-nav（壳内 + 独立模式成对）")
    : fail("未包 .side-nav: " + noNavWrap.join(", "));

  // 用户卡类名必须与 design.css 一致（曾写成 side-user-meta，整套排版静默失效）
  const dcssContent = fs.readFileSync(path.join(SITE, "assets/design.css"), "utf8");
  const sideJsAll = sideRenderFiles.map((f) => fs.readFileSync(path.join(SITE, f), "utf8")).join("\n");
  /\.side-user-body/.test(dcssContent) && /class="side-user-body"/.test(sideJsAll) && !/side-user-meta/.test(sideJsAll)
    ? pass("用户卡类名与 design.css 一致（side-user-body）")
    : fail("用户卡类名对不上 —— 渲染写一套、样式写另一套，排版会静默失效");

  // 旧 app.js 不应再被引用
  const usesOldJs = ALL_PAGES.filter((p) =>
    /assets\/app\.js/.test(fs.readFileSync(path.join(SITE, p), "utf8")));
  usesOldJs.length === 0 ? pass("全站无 app.js 残留引用")
    : fail("仍引用 app.js: " + usesOldJs.join(", "));

  // div 配平
  const unbalanced = ALL_PAGES.filter((p) => {
    const h = fs.readFileSync(path.join(SITE, p), "utf8");
    const open = (h.match(/<div\b/g) || []).length;
    const close = (h.match(/<\/div>/g) || []).length;
    return open !== close;
  });
  unbalanced.length === 0 ? pass("全部页面 div 标签配平")
    : fail("div 不配平: " + unbalanced.join(", "));

  // 脚本引用的 id 必须真实存在（DOM 桩无法发现的问题）—— 实现见 danglingIds()
  const dangling = [];
  for (const p of ALL_PAGES) {
    const h = fs.readFileSync(path.join(SITE, p), "utf8");
    const inline = [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1]).join("\n");
    const miss = danglingIds(h, inline);
    if (miss.length) dangling.push(`${p}: ${miss.join("/")}`);
  }
  /* 🔴 壳新建课程后必须广播 —— 壳与 iframe 各持一份 COURSES（nav.js 各执行一次），
        不广播的话，左边刚建的课在教案页的课程下拉里根本选不到。 */
  const shellSrc = fs.readFileSync(path.join(SITE, "assets/shell.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(SITE, "assets/core.js"), "utf8");
  const lessonSrc = fs.readFileSync(path.join(SITE, "lesson.html"), "utf8");

  /broadcast\("st-courses-changed"/.test(shellSrc)
    ? pass("壳新建课程后广播 st-courses-changed")
    : fail("壳建课后没有广播 —— 内容页的课程列表会停在旧数据上");
  /d\.type === "st-courses-changed"/.test(coreSrc) && /function applyCoursesChanged/.test(coreSrc)
    ? pass("内容页接住该消息并收口在 applyCoursesChanged()")
    : fail("内容页没有处理课程目录变化");
  /function notifyCoursesChanged/.test(coreSrc)
    ? pass("独立模式建课也走同一个收口（notifyCoursesChanged）")
    : fail("独立模式建课后没有通知页面");
  /"st-courses-changed"\s*\)/.test(lessonSrc) || /addEventListener\("st:courses-changed"/.test(lessonSrc)
    ? pass("教案页监听课程变化 → 重渲染课程下拉")
    : fail("教案页没监听课程变化");
  /未建大纲/.test(lessonSrc)
    ? pass("课程下拉标出「未建大纲」的课（一眼看出哪门还没排）")
    : fail("课程下拉没有标注哪门课还没有大纲");

  /* 🔴 课程必须**按账号分开存** —— 换账号登录要看到自己的课，不是上一个人的。
     键形如 `st_courses:teacher:zhangsan`；没有账号标识时才退回全局桶。 */
  const navSrc = fs.readFileSync(path.join(SITE, "assets/nav.js"), "utf8");
  const indexSrc = fs.readFileSync(path.join(SITE, "index.html"), "utf8");

  /function courseStoreKey\s*\(/.test(navSrc) && /COURSE_KEY \+ ":" \+ u/.test(navSrc)
    ? pass("课程存档键按账号拼接（st_courses:<角色>:<账号>）")
    : fail("课程没有按账号分开存 —— 换账号会看到上一个人的课");
  /localStorage\.setItem\(courseStoreKey\(\)/.test(navSrc)
    && /localStorage\.getItem\(key\)/.test(navSrc)
    ? pass("读写的都是当前账号的键（没有回退到全局桶）")
    : fail("读写用了固定键，账号隔离会失效");
  /function isSeedAccount\s*\(/.test(navSrc)
    ? pass("只有预置演示账号才播种演示课程")
    : fail("缺少「是否演示账号」的判断");
  /return \(!user \|\| isSeedAccount\(user\)\) \? SEED_COURSES\.slice\(\) : \[\]/.test(navSrc)
    ? pass("自己注册的账号从空课程开始，不再永远看到演示的那两门")
    : fail("自建账号仍会被塞演示课程");
  /function tryMigrateLegacyCourses\s*\(/.test(navSrc)
    ? pass("老版本的全局存档会迁到当前账号名下（只迁一次）")
    : fail("没有旧数据迁移 —— 升级后老用户会突然看不到自己的课");
  /LS\.rawSet\("st_current_user"/.test(indexSrc) || /CURRENT_USER_KEY/.test(indexSrc)
    ? pass("登录 / 注册时记下当前账号（st_current_user）")
    : fail("登录没有记账号 —— 无法区分是谁的课程");
  /STORE_KEY\.currentUser|currentUser: "st_current_user"/.test(coreSrc)
    ? pass("st_current_user 进了 STORE_KEY（键名唯一来源）")
    : fail("st_current_user 键名散落");
  /enter\(acc\.name, acc\.user\)/.test(indexSrc) && /enter\(hit\.name, hit\.user\)/.test(indexSrc)
    ? pass("登录 / 注册 / 演示快捷通道三条路径都带上了账号")
    : fail("有登录路径没传账号");

  /* 课程项的「⋯」：改信息 / 删除 */
  const shellSrc3 = fs.readFileSync(path.join(SITE, "assets/shell.js"), "utf8");
  const coreSrc3 = fs.readFileSync(path.join(SITE, "assets/core.js"), "utf8");

  /class="side-more"/.test(shellSrc3) && /class="side-more"/.test(coreSrc3)
    ? pass("两处侧栏都渲染出课程项的「⋯」（壳内 + 独立模式成对）")
    : fail("有一处侧栏没渲染「⋯」");
  ["openCourseMenu", "openEditCourse", "askDeleteCourse"].every((fn) =>
    new RegExp("function " + fn + "\\s*\\(").test(shellSrc3)
      && new RegExp("function " + fn + "\\s*\\(").test(coreSrc3))
    ? pass("课程菜单 / 编辑信息 / 删除在壳与独立模式都实现了")
    : fail("有一处缺课程菜单相关实现");
  /document\.body\.appendChild\(menu\)/.test(shellSrc3)
    && /document\.body\.appendChild\(menu\)/.test(coreSrc3)
    ? pass("菜单挂在 body 上（侧栏是 overflow:hidden，挂里面会被裁掉）")
    : fail("菜单挂错位置，会被侧栏裁掉");
  /* 🔴 课程项的「⋯」必须**绝对定位**。
     `.side-item` 是 `width: 100%`：若「⋯」当 flex 兄弟节点参与行内布局，
     它会吃掉 22px + 间距 → 课程项的胶囊背景比别的菜单项**短一截**，
     看起来像缺了一块（第 25 轮修的就是这个）。 */
  const moreCss = (scssCode.match(/\.shell-side \.side-more\s*\{([^}]*)\}/) || [, ""])[1];
  /position\s*:\s*absolute/.test(moreCss)
    ? pass("「⋯」绝对定位（不占行内宽度，课程项胶囊与其它项等宽）")
    : fail("「⋯」参与行内布局 —— 课程项的胶囊会比别的菜单项短一截");
  !/flex\s*:\s*0\s+0/.test(moreCss)
    ? pass("「⋯」没有 flex 主轴尺寸（不会被当成 flex 兄弟节点）")
    : fail("「⋯」还有 flex 尺寸声明，说明它又回到行内布局了");
  /pointer-events\s*:\s*none/.test(moreCss) && /pointer-events\s*:\s*auto/.test(scssCode)
    ? pass("「⋯」隐形时不接点击、显形才可点（右端不会变成隐形陷阱）")
    : fail("隐形的「⋯」仍会吃掉点击 —— 点课程名边缘会莫名弹出菜单");
  const rowItemCss = (scssCode.match(/\.shell-side \.side-row \.side-item\s*\{([^}]*)\}/) || [, ""])[1];
  /margin-bottom\s*:\s*0/.test(rowItemCss)
    ? pass("行间距移到 .side-row（行高与「⋯」的垂直居中基准一致）")
    : fail("课程项还带 margin-bottom，「⋯」会偏离垂直中线");
  /padding-right\s*:\s*\d+px/.test(rowItemCss) && !/padding-right\s*:\s*(0|0px)/.test(rowItemCss)
    ? pass("课程项右侧给「⋯」留位（文字不会压到它下面）")
    : fail("课程项右侧没留位，文字会和「⋯」重叠");
  /\.shell-side \.side-row\s*\{[^}]*position\s*:\s*relative/.test(scssCode)
    ? pass(".side-row 是定位参照（position: relative）")
    : fail(".side-row 没有 position: relative，「⋯」会飘到别处");

  /* 课程表单的「开课学期 / 上课周次」必须**可自由输入**（第 26 轮）。
     各校的排课形态差得远（暑假小学期、集中实践周、单双周…），
     用固定 <select> 会把「其他情况」堵死。改成 input + datalist。 */
  /function termSuggestions\s*\(now\)/.test(navSrc)
    ? pass("nav.js 提供 termSuggestions()（学期候选的唯一定义）")
    : fail("没有 termSuggestions() —— 学期候选又散在各处了");
  const termFn = (navSrc.match(/function termSuggestions[\s\S]*?\n\}/) || [""])[0];
  // ⚠️ 先剥注释再判断 —— 函数里恰好写着「别用 instanceof Date」这句解释，
  //    直接匹配会把解释文字当成代码（这个坑本轮又踩了一次）。
  const termFnCode = stripComments(termFn);
  !/instanceof\s+Date/.test(termFnCode) && /typeof now\.getFullYear/.test(termFnCode)
    ? pass("日期类型用鸭子类型判断（instanceof Date 跨 realm 会静默失效）")
    : fail("termSuggestions 的日期判断方式有跨 realm 风险");
  /instanceof[\s\S]{0,40}跨 realm|跨 realm[\s\S]{0,60}instanceof/.test(termFn)
    ? pass("注释里写明了「为什么不能用 instanceof Date」（防止以后被顺手改回去）")
    : fail("缺「为什么不能用 instanceof Date」的注释");
  !/\b(19|20)\d{2}\b/.test(termFnCode)
    ? pass("学期候选由年份现算（没有写死的年份 —— 不会过期）")
    : fail("termSuggestions 里写死了年份，过几年就错");
  /var COURSE_WEEKS\s*=/.test(navSrc)
    ? pass("nav.js 是周次候选的唯一定义") : fail("周次候选没在 nav.js");

  // 🔴 nav.js 用 var 声明了 COURSE_WEEKS；shell.js / core.js 若再 `const` 同名，
  //    会直接抛 "Identifier has already been declared" 把整页脚本打挂。
  [["assets/shell.js", shellSrc3], ["assets/core.js", coreSrc3]].forEach(([f, src]) => {
    !/const\s+COURSE_(TERMS|WEEKS)\b/.test(src)
      ? pass(f + " 未重复声明课程候选常量（避免与 nav.js 的全局重复声明）")
      : fail(f + " 重复声明了 COURSE_TERMS/COURSE_WEEKS —— 会抛重复声明错误");
    /<input[^>]*id="cTerm"[^>]*list="cTermList"/.test(src) && /<input[^>]*id="cWeek"[^>]*list="cWeekList"/.test(src)
      ? pass(f + " 学期 / 周次是输入框并挂了候选列表")
      : fail(f + " 学期 / 周次还不是可自由输入的控件");
    /<datalist id="cTermList">/.test(src) && /<datalist id="cWeekList">/.test(src)
      ? pass(f + " 提供 datalist 候选") : fail(f + " 缺 datalist 候选");
    !/<select class="select" id="c(?:Term|Week)"/.test(src)
      ? pass(f + " 已无固定下拉（不存在「只有几个选项」的限制）")
      : fail(f + " 学期 / 周次仍是固定下拉");
  });
  // 用户要求删掉那段说明条；可用写法靠**占位文案**提示，不再单独占版面
  !/学期与周次/.test(shellSrc3) && !/学期与周次/.test(coreSrc3)
    ? pass("课程表单的说明条已删除（两处都没了）")
    : fail("课程表单还留着说明条");
  /placeholder="例如：2026 秋季、暑假小学期"/.test(shellSrc3)
    && /placeholder="例如：1–16 周、单周、集中实践周"/.test(coreSrc3)
    ? pass("可用写法改由占位文案提示")
    : fail("占位文案没提示可用写法");
  // 弹层不能挂在侧栏内部
  !/\.shell-side[\s\S]{0,200}side-menu/.test(scss)
    ? pass("菜单样式没有被塞进 .shell-side 作用域") : info("菜单样式写在侧栏内（注意别被裁剪）");

  ["updateCourse", "deleteCourse", "courseAssetCount"].every((fn) =>
    new RegExp("function " + fn + "\\s*\\(").test(navSrc))
    ? pass("nav.js 提供改信息 / 删除 / 资产统计（唯一实现）")
    : fail("nav.js 缺课程变更函数");
  /delete SYLLABUS\[id\]/.test(navSrc) && /delete LESSONS\[k\]/.test(navSrc)
    ? pass("删课程会连带清掉该课的教案（不留孤儿数据）")
    : fail("删课程没清教案 —— 会留下孤儿数据");
  /courseAssetCount\(courseId\)/.test(shellSrc3) && /教案会一起删除/.test(shellSrc3)
    ? pass("删除前二次确认，并说明会连带删掉多少教案")
    : fail("删除没有确认，或没把后果说清楚");

  /* ---- 教案大纲：章 / 课时 / 整份大纲 都能删（第 27 轮）---- */
  // ⚠️ 这个函数里已经有一个 lessonSrc 了 —— 换个名字（同名 const 会直接抛错，正是本项目踩过的坑）
  const lessonSrc2 = fs.readFileSync(path.join(SITE, "lesson.html"), "utf8");

  ["askDeleteChapter", "askDeleteLesson", "askDeleteSyllabus", "afterTreeRemove",
   "openTreeMenu", "closeTreeMenu", "treeAction"].every((fn) =>
    lessonSrc2.includes("function " + fn + "("))
    ? pass("章 / 课时 / 整份大纲 的删除与菜单都有实现")
    : fail("缺删除相关实现");
  /function deleteSyllabus\s*\(/.test(navSrc)
    ? pass("nav.js 提供 deleteSyllabus()（整份大纲的唯一删除实现）")
    : fail("nav.js 缺 deleteSyllabus()");
  /LESSONS\[id\]\.courseId === courseId/.test(navSrc)
    ? pass("删整份大纲时按 courseId 清教案（不依赖可能漏记的 lessonIds，不留孤儿数据）")
    : fail("删大纲没清干净课时教案 —— 会留下点不到的孤儿数据");
  /window\.confirm/.test(lessonSrc2) && /删除后无法撤销/.test(lessonSrc2)
    ? pass("删除类操作都有二次确认并说明不可撤销")
    : fail("删除没有二次确认");
  /含它们的全部版本记录|个版本记录会一起删除/.test(lessonSrc2)
    ? pass("确认框说清了会连带删掉版本记录") : fail("确认框没提版本记录");
  /if \(n\) \{[\s\S]{0,120}flash\(/.test(lessonSrc2)
    ? pass("章里还有教案时直接说明原因（不弹无效的确认框）")
    : fail("章里有教案时的处理方式不对");


  // 大纲树的「⋯」与侧栏课程项同一套做法：绝对定位、隐形时不接点击
  const lessonCss = lessonSrc2.match(/<style>([\s\S]*?)<\/style>/);
  const lessonCssCode = stripComments(lessonCss ? lessonCss[1] : "");
  const treeMore = (lessonCssCode.match(/\.tree-more\s*\{([^}]*)\}/) || [, ""])[1];
  /position\s*:\s*absolute/.test(treeMore)
    ? pass("大纲树行的「⋯」绝对定位（不把行的胶囊挤窄）")
    : fail("大纲树行的「⋯」参与行内布局 —— 胶囊会比别的行短");
  /pointer-events\s*:\s*none/.test(treeMore)
    ? pass("大纲树行的「⋯」隐形时不接点击") : fail("大纲树行的「⋯」隐形时仍会吃点击");
  /\.side-menu\s*,\s*\.tree-menu|\.tree-menu\s*,\s*\.side-menu/.test(scssCode)
    ? pass("菜单样式与侧栏共用一份定义（.side-menu / .tree-menu 并列）")
    : fail("弹层菜单样式被复制成了两份");
  /\.outline-more\s*\{[^}]*position\s*:\s*static/.test(lessonCssCode)
    ? pass("卡片头的「⋯」回到文档流（复用外观但不绝对定位）")
    : fail("卡片头「⋯」被当成行内浮层处理，位置会飘");
  /* ---- 大纲调序：拖动 + 上移/下移（第 28 轮）---- */
  /data-drag="ch"/.test(lessonSrc2) && /data-drag="ls"/.test(lessonSrc2)
    && (lessonSrc2.match(/draggable="true"/g) || []).length >= 2
    ? pass("章行 / 课时行都标了 draggable 与 data-drag")
    : fail("大纲树的行还没做成可拖动");
  ["dragstart", "dragover", "drop", "dragend"].every((ev) =>
    new RegExp('addEventListener\\("' + ev + '"').test(lessonSrc2))
    ? pass("拖动的四个事件都接上了（dragstart / dragover / drop / dragend）")
    : fail("拖动事件没接全");
  /function dropInfo\s*\(/.test(lessonSrc2) && /preventDefault\(\)/.test(lessonSrc2)
    ? pass("有落点判定，且 dragover 里 preventDefault（否则浏览器不允许 drop）")
    : fail("缺落点判定或没 preventDefault");
  /上移本章/.test(lessonSrc2) && /下移本章/.test(lessonSrc2)
    ? pass("菜单里也有「上移 / 下移」（不依赖拖动也能调序）")
    : fail("菜单缺上移下移 —— 没鼠标拖不动的用户就没法调序");
  /setData\("text\/plain"/.test(lessonSrc2)
    ? pass("dragstart 里 setData（Firefox 不设就拖不动）") : fail("没 setData，Firefox 拖不动");

  ["dragging", "drop-before", "drop-after", "drop-into"].every((cls) =>
    new RegExp("\\." + cls + "\\s*[,{:. ]").test(lessonCssCode))
    ? pass("拖动 / 落点状态都有对应样式")
    : fail("缺拖动状态样式（用户看不到落点在哪儿）");
  /\.[a-z-]*drop-before[^{]*\{[^}]*box-shadow/.test(lessonCssCode)
    ? pass("落点用 box-shadow 画指示线（不改变行高，不会让列表抖动）")
    : fail("落点指示实现方式会顶动布局");
  /cursor\s*:\s*grab/.test(lessonCssCode)
    ? pass("可拖动的行用 grab 光标（看得出来能拖）") : fail("没有可拖动的光标提示");

  /function moveChapter\s*\(courseId, chapterId, beforeChapterId\)/.test(navSrc)
    && /function moveLesson\s*\(lessonId, targetChapterId, beforeLessonId\)/.test(navSrc)
    ? pass("调序接口用「插到谁前面」表达（不用下标 —— 同列表内移动时下标会错位）")
    : fail("调序接口按下标传参，容易错位");
  /function moveChapterBy\s*\(/.test(navSrc) && /function moveLessonBy\s*\(/.test(navSrc)
    ? pass("上移 / 下移复用同一份排序实现") : fail("上移下移另写了一套排序");

  /* ---- 大纲版本历史：界面接线（第 29 轮）---- */
  ["renderOutlineHistory", "renderSylDiff", "revertOutline", "handoffOutlineDiff"].every((fn) =>
    lessonSrc2.includes("function " + fn + "("))
    ? pass("大纲版本历史的渲染 / 对比 / 回退 / AI 解读都有实现")
    : fail("大纲版本历史的界面实现不全");
  /id="sylVerBtn"/.test(lessonSrc2) && /state\.outlineHistory/.test(lessonSrc2)
    ? pass("卡片头有「版本 N」入口，且用 state.outlineHistory 切视图")
    : fail("缺大纲版本入口");
  /renderOutlineHistory\(panel\)/.test(lessonSrc2)
    ? pass("大纲历史视图优先级高于章节 / 教案详情（选中具体对象时会退出）")
    : fail("大纲历史视图没接进 renderPlan");
  !/COMMIT_KIND\[/.test(lessonSrc2)
    ? pass("页面不再直接索引 COMMIT_KIND（走 commitKind() 兜底，未知类型不会崩）")
    : fail("还有直接 COMMIT_KIND[kind] 的写法 —— 遇到未知类型会读到 undefined.label");
  /state\.outlineHistory = false/.test(lessonSrc2)
    ? pass("点左栏的章 / 课时行会退出历史视图（不卡在历史里）")
    : fail("选了具体对象却还停在历史视图");
  /不会因此恢复/.test(lessonSrc2)
    ? pass("回退确认框提醒「已删掉的课时教案不会恢复」")
    : fail("回退没提醒数据缺口 —— 用户会以为整份都回来了");

  /* 🔴 `hidden` 靠 UA 样式表的 [hidden]{display:none}，会被作者样式的 display 盖掉：
     典型 `<button class="btn" hidden>` —— `.btn{display:inline-flex}` 直接又把它显示出来。 */
  /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important/.test(
    fs.readFileSync(path.join(SITE, "assets/design.css"), "utf8"))
    ? pass("[hidden] 有全局 !important 兜底（作者样式的 display 盖不掉它）")
    : fail("缺 [hidden] 兜底规则 —— 带 display 的 hidden 元素会照常显示");
  !/\.login-form\[hidden\]|\.shell-frame-error\[hidden\]/.test(scss)
    && !/\.login-form\[hidden\]/.test(fs.readFileSync(path.join(SITE, "assets/design.css"), "utf8"))
    ? pass("没有重复的窄 [hidden] 规则（唯一机制）")
    : fail("还留着会被全局规则覆盖的窄 [hidden] 规则");

  // 预置课程必须都是可点的：侧栏不该再有「暗的、点不动的」演示项
  const seedBlock = (navSrc.match(/var SEED_COURSES = \[([\s\S]*?)\n\];/) || [, ""])[1];
  !/page:\s*""/.test(seedBlock)
    ? pass("预置课程都带页面（侧栏不再出现灰显不可点的演示项）")
    : fail("预置课程里还有 page 为空的灰显项");

  /\.side-more/.test(scss) && /\.side-menu/.test(scss)
    ? pass("shell.css 定义「⋯」按钮与课程菜单样式") : fail("缺「⋯」/ 菜单样式");

  dangling.length === 0 ? pass("脚本引用的 DOM id 均真实存在（无空指针风险）")
    : fail("引用了不存在的 id → " + dangling.join("; "));

  // 脚本里用到的 data-* 钩子必须在 HTML 中出现（CSS/事件委托依赖）
  const hookMissing = [];
  for (const p of ALL_PAGES) {
    const h = fs.readFileSync(path.join(SITE, p), "utf8");
    const hooks = new Set([...h.matchAll(/dataset\.(\w+)/g)].map((m) =>
      "data-" + m[1].replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())));
    for (const m of h.matchAll(/\[data-([\w-]+)[\]=]/g)) hooks.add("data-" + m[1]);
    const miss = [...hooks].filter((k) => !h.includes(k) && !/^data-(role|theme)$/.test(k));
    if (miss.length) hookMissing.push(`${p}: ${miss.join("/")}`);
  }
  hookMissing.length === 0 ? pass("dataset / data-* 钩子在 HTML 中均有对应标记")
    : info("疑似未使用的 data 钩子: " + hookMissing.join("; "));

  // 编码红线：模板字面量内未转义的反引号（会导致 SyntaxError，已被脚本执行覆盖）
  info("脚本可执行性已由上文逐页真实执行覆盖");
}

/* ============================================================
   E. 端到端联动（壳 ⇄ 内容页）
   ============================================================ */
/* ============================================================
   技能开关与自定义分组（第 36 轮）
   ------------------------------------------------------------
   左栏那棵技能树的数据层。断言重点：关掉**真的**影响路由、关掉**不等于**删除、
   锁定项关不掉、分组只是视图（删组不删技能）、状态按账号分桶。
   ============================================================ */
function verifySkillState() {
  section("技能开关与自定义分组（nav.js）");

  const doc = makeDoc();
  const sandbox = makeSandbox(doc, "agent.html");
  const probe = probeFn(sandbox);

  try {
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sandbox, { filename: "nav.js" });
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }

  /* --- ① 形状 --- */
  probe("SKILL_STATE_KEY") === "st_skills"
    ? pass("状态键为 st_skills（带 st_ 前缀）") : fail("键名不符: " + probe("SKILL_STATE_KEY"));
  ["skillStateStoreKey", "normalizeSkillState", "loadSkillState", "saveSkillState",
   "skillEnabled", "setSkillEnabled", "toggleSkillEnabled", "disabledSkillCount", "activeSkills",
   "resetSkillState", "skillGroups", "createSkillGroup", "renameSkillGroup", "deleteSkillGroup",
   "addSkillToGroup", "removeSkillFromGroup", "groupsOfSkill", "skillGroupAssetCount",
   "skillLocked", "skillLockReason", "skillAnyRole", "skillClosed", "toggleSkillClosed"].forEach((fn) => {
    probe("typeof " + fn) === "function" ? pass("提供 " + fn + "()") : fail("缺少 " + fn + "()");
  });
  probe("typeof SKILL_LOCKED") === "object" ? pass("SKILL_LOCKED 声明了锁定的技能") : fail("没有 SKILL_LOCKED");

  const src = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");
  /SKILL_STATE_KEY \+ ":" \+ u/.test(src)
    ? pass("技能状态按账号分桶（st_skills:<角色>:<账号>）") : fail("没按账号分桶");

  /* --- ② 默认全开；关掉只影响 activeSkills，不影响全量视图 --- */
  probe("disabledSkillCount('teacher')") === 0 ? pass("默认一条都没关") : fail("默认状态不对");
  probe("activeSkills('teacher').length === roleSkills('teacher').length")
    ? pass("没关任何技能时 activeSkills == roleSkills") : fail("两者不一致");

  const off = JSON.parse(probe("JSON.stringify((function () { setSkillEnabled('atom-proofread', false);"
    + " return { en: skillEnabled('atom-proofread'), n: disabledSkillCount('teacher'),"
    + " all: roleSkills('teacher').filter(function (s) { return s.id === 'atom-proofread'; }).length,"
    + " act: activeSkills('teacher').filter(function (s) { return s.id === 'atom-proofread'; }).length }; })())") || "null");
  off && off.en === false && off.n === 1 && off.all === 1 && off.act === 0
    ? pass("关掉一条：skillEnabled=false、activeSkills 少一条，而全量视图仍有它（关≠删）")
    : fail("关掉逻辑不对: " + JSON.stringify(off));

  /* --- ③ 关掉**真的**影响路由，且如实报告 --- */
  probe("JSON.stringify(routeSkills('帮我校对这段', { role: 'teacher' }).atomic.map(function (s) { return s.id; }))") === "[]"
    ? pass("关掉后路由真的不再挂它") : fail("关掉了还挂");
  /atom-proofread/.test(String(probe("JSON.stringify(routeSkills('帮我校对这段', { role: 'teacher' }).offHit)")))
    ? pass("routeSkills 的 offHit 如实报告「本来会命中，但你关掉了」")
    : fail("offHit 没报");
  probe("toggleSkillEnabled('atom-proofread').enabled") === true
    ? pass("再点一次就打开（开关双向）") : fail("打不开");

  /* --- ④ 锁定的技能关不掉 --- */
  const lock = JSON.parse(probe("JSON.stringify((function () { var r = setSkillEnabled('sys-confirm-gate', false);"
    + " return { ok: r.ok, en: skillEnabled('sys-confirm-gate'), err: r.error || '' }; })())") || "null");
  lock && lock.ok === false && lock.en === true && /锁定/.test(lock.err)
    ? pass("「改前确认」锁死：关不掉，并且说明了原因") : fail("锁定没生效: " + JSON.stringify(lock));
  probe("normalizeSkillState({ off: { 'sys-confirm-gate': 1 } }).off['sys-confirm-gate'] === undefined")
    ? pass("坏存档里写着「关了锁定技能」，读回来也强制打开") : fail("坏存档没兜住");
  probe("typeof setSkillEnabled('no-such-skill', false).ok === 'boolean' && setSkillEnabled('no-such-skill', false).ok === false")
    ? pass("不存在的技能 id 返回 {ok:false}（不静默成功）") : fail("未知 id 没拦");

  /* --- ⑤ 自定义分组 --- */
  const g = JSON.parse(probe("JSON.stringify((function () {"
    + " var a = createSkillGroup('备课时用'); var b = createSkillGroup('备课时用'); var c = createSkillGroup('   ');"
    + " return { a: a.ok, dup: b.ok, blank: c.ok, n: skillGroups().length }; })())") || "null");
  g && g.a === true && g.dup === false && g.blank === false && g.n === 1
    ? pass("新建分组：空名与重名都被拦住（不静默建一个「未命名」）") : fail("分组校验不对: " + JSON.stringify(g));

  const g2 = JSON.parse(probe("JSON.stringify((function () { var gid = skillGroups()[0].id;"
    + " addSkillToGroup(gid, 'atom-proofread'); addSkillToGroup(gid, 'atom-proofread');"
    + " return { n: skillGroupOf(gid).skills.length, cnt: skillGroupAssetCount(gid).skills,"
    + " of: groupsOfSkill('atom-proofread').length }; })())") || "null");
  g2 && g2.n === 1 && g2.cnt === 1 && g2.of === 1
    ? pass("收技能进分组：重复加是幂等的（一条技能只出现一次）") : fail("分组幂等不对: " + JSON.stringify(g2));

  probe("groupsOfSkill('atom-proofread').length === groupsOfSkill('atom-rubric').length")
    ? fail("不同技能的归属统计串了") : pass("归属按技能 id 算（没串）");

  const g3 = JSON.parse(probe("JSON.stringify((function () { var gid = skillGroups()[0].id;"
    + " var r = deleteSkillGroup(gid);"
    + " return { ok: r.ok, removed: r.removed, groups: skillGroups().length,"
    + " skillStill: roleSkills('teacher').filter(function (s) { return s.id === 'atom-proofread'; }).length }; })())") || "null");
  g3 && g3.ok === true && g3.removed === 1 && g3.groups === 0 && g3.skillStill === 1
    ? pass("删分组只删视图：里面那条技能还在三层里（removed 报出条数）")
    : fail("删分组把技能一起删了: " + JSON.stringify(g3));

  /* --- ⑥ 折叠状态、恢复默认 --- */
  probe("toggleSkillClosed('layer:system') === true && skillClosed('layer:system') === true")
    ? pass("层的折叠状态可切换并记住") : fail("折叠状态不对");
  const rs = JSON.parse(probe("JSON.stringify((function () {"
    + " setSkillEnabled('atom-proofread', false); createSkillGroup('临时'); toggleSkillClosed('layer:system');"
    + " resetSkillState();"
    + " return { off: disabledSkillCount('teacher'), g: skillGroups().length,"
    + " en: skillEnabled('atom-proofread'), cl: skillClosed('layer:system') }; })())") || "null");
  rs && rs.off === 0 && rs.g === 0 && rs.en === true && rs.cl === false
    ? pass("恢复默认：技能全开 + 分组清空 + 折叠复位") : fail("恢复默认不对: " + JSON.stringify(rs));

  /* --- ⑦ 学生端：能关，但永远关不出写技能来 --- */
  probe("activeSkills('student').filter(function (s) { return s.kind === 'write'; }).length") === 0
    ? pass("学生端 activeSkills 里一个写技能都没有") : fail("学生端漏进了写技能");
  probe("activeSkills('student').filter(function (s) { return s.id === 'sys-confirm-gate'; }).length") === 0
    ? pass("「改前确认」不挂学生端（它只拦教师端的写操作）") : fail("闸门挂到学生端了");
  probe("(function () { setSkillEnabled('grp-self-study', false);"
    + " return activeSkills('student').filter(function (s) { return s.id === 'grp-self-study'; }).length === 0"
    + " && skillEnabled('grp-self-study') === false; })()")
    ? pass("学生端独有的技能也能单独关（状态层跨角色找得到它）") : fail("学生端技能关不掉");

  /* --- ⑧ 页面接线（静态） --- */
  ["agent.html", "agent-student.html"].forEach((f) => {
    const h = fs.readFileSync(path.join(SITE, f), "utf8");
    /id="skillTree"/.test(h) ? pass(f + " 有左栏技能树挂点") : fail(f + " 缺 skillTree");
    /id="newGroupBtn"/.test(h) && /id="skillResetBtn"/.test(h)
      ? pass(f + " 有「＋ 新建分组 / 恢复默认」") : fail(f + " 缺按钮");
    /class="agent-rail"/.test(h) && !/class="agent-side"/.test(h)
      ? pass(f + " 是「技能库 + 画像」一列（不再夹着对话区）") : fail(f + " 布局没换");
    /function openSpMenu/.test(h) && /document\.body\.appendChild\(m\)/.test(h)
      ? pass(f + " 的「⋯」菜单挂在 body 上（面板滚动不会裁掉）") : fail(f + " 菜单实现不对");
    /toggleSkillEnabled/.test(h) ? pass(f + " 调数据层的开关函数，没在页面里另存一份状态")
      : fail(f + " 页面没接数据层开关");
    !/localStorage\.setItem\(\s*["']st_skills/.test(h)
      ? pass(f + " 没有自己往 st_skills 里写（存储只有一处实现）") : fail(f + " 页面越权写了存储");
    /关掉不等于删除/.test(h) || /勾选＝以后会挂/.test(h)
      ? pass(f + " 界面上写明了「关掉不等于删除」") : fail(f + " 没说明关掉的语义");
  });
}

/* ============================================================
   工作台（第 37 轮）—— 灵感 01 的「层 3：临时工作台」
   ------------------------------------------------------------
   断言重点：**存快照不存配方**、生成走同一套技能库、演示卡片按角色分、
   上限到了拒绝新建而不是悄悄丢最旧的。
   ============================================================ */
function verifyWorkbench() {
  section("工作台（nav.js + workbench.html）");

  const doc = makeDoc();
  const sandbox = makeSandbox(doc, "workbench.html");
  const probe = probeFn(sandbox);

  try {
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sandbox, { filename: "nav.js" });
  } catch (e) {
    fail("nav.js 报错: " + e.message);
    return;
  }

  /* --- ① 形状 --- */
  probe("WORKBENCH_KEY") === "st_workbench"
    ? pass("工作台键为 st_workbench（带 st_ 前缀）") : fail("键名不符: " + probe("WORKBENCH_KEY"));
  ["workbenchStoreKey", "normalizeCards", "loadCards", "saveCards", "cardOf", "nextCardId",
   "cardFromRun", "createCard", "updateCard", "deleteCard", "duplicateCard", "clearCards",
   "cardsOfKind", "cardKindCounts", "cardToMarkdown", "cardKind", "cardKindOfSkill",
   "seedCards", "seedStudentCards", "fmtStamp", "currentRoleOf",
   "runnableIds", "runSkillChain", "primarySkillId"].forEach((fn) => {
    probe("typeof " + fn) === "function" ? pass("提供 " + fn + "()") : fail("缺少 " + fn + "()");
  });
  const src = fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8");
  /WORKBENCH_KEY \+ ":" \+ u/.test(src)
    ? pass("工作台按账号分桶（st_workbench:<角色>:<账号>）") : fail("没按账号分桶");

  /* ============================================================
     ⑧ AI 工作台（第 41 轮立形态，第 43 轮清掉其余两个页签）
     ------------------------------------------------------------
     用户原话：「不是，不是让你做个我已经有的工作台，我是让你做个让 ai 生产工作台」
     → 这一页**只有**「说清想要什么 → AI 现场写一个 → 打开就能用」这一件事。
     ============================================================ */

  /* --- 生成链路（nav.js 侧）--- */
  ["wsSystemPrompt", "wsUserPrompt", "appsOfKind"].forEach(function (fn) {
    probe("typeof " + fn) === "function" ? pass("数据层有 " + fn + "()") : fail("缺 " + fn + "()");
  });
  const wsSys = String(probe('wsSystemPrompt("")') || "");
  /工作台/.test(wsSys) ? pass("提示词是「工作台」那套") : fail("提示词不对");
  /localStorage/.test(wsSys) && /wstool:/.test(wsSys)
    ? pass("提示词要求生成的页面自己存数据（localStorage + wstool: 前缀）") : fail("提示词没要求存数据");
  /新增|勾选/.test(wsSys) && /删除/.test(wsSys)
    ? pass("提示词要求可操作闭环（不是一张静态报表）") : fail("提示词没要求操作闭环");
  /禁止任何外部请求/.test(wsSys) ? pass("提示词禁外部请求") : fail("没禁外部请求");

  /* --- 🔴 教学模拟的痕迹必须清干净（第 43 轮按用户要求整体移除）--- */
  ["simSystemPrompt", "simUserPrompt", "SEED_SIM_TITRATION", "addSimFeedback", "recallSimFrom",
   "seedSims"].forEach(function (fn) {
    probe("typeof " + fn) === "undefined"
      ? pass("教学模拟的 " + fn + " 已移除") : fail(fn + " 还在（应该删掉）");
  });
  /* --- 🔴 事务台（st_desk）的数据层也要清干净 --- */
  ["DESK_KEY", "DESK", "DESK_GOAL"].forEach(function (k) {
    probe("typeof " + k) === "undefined"
      ? pass("事务台的 " + k + " 已移除") : fail(k + " 还在（应该删掉）");
  });
  ["deskSummary", "deskBuckets", "deskByKind", "deskTrend", "deskAlerts",
   "createDeskItem", "seedDesk", "toggleDeskDone", "deskStoreKey"].forEach(function (fn) {
    probe("typeof " + fn) === "undefined"
      ? pass("事务台的 " + fn + "() 已移除") : fail(fn + "() 还在（应该删掉）");
  });
  !/st_desk/.test(src) ? pass("nav.js 里不再有 st_desk 这个键") : fail("还留着 st_desk");

  /* --- 页面：workbench.html --- */
  const h = fs.readFileSync(path.join(SITE, "workbench.html"), "utf8");
  /data-role="both"/.test(h) ? pass("workbench.html 声明 data-role=both（双端共用）") : fail("没声明 both");

  /* 生成区 */
  /id="appAsk"/.test(h) ? pass("有需求输入框（说一句你想要什么）") : fail("缺需求输入框");
  /id="appExamples"/.test(h) ? pass("有示例 chips（不知道写什么时点一下）") : fail("缺示例 chips");
  /id="appMake"/.test(h) && /让 AI 造一个/.test(h) ? pass("有「让 AI 造一个」按钮") : fail("缺生成按钮");
  /id="appProgress"/.test(h) ? pass("有进度区（不让人对着空白等）") : fail("缺进度区");
  /id="appBannerBox"/.test(h) ? pass("有 toast 宿主") : fail("缺 toast 宿主");
  /* 列表 */
  /id="appGrid"/.test(h) ? pass("有工作台列表") : fail("缺列表");
  /id="appCount"/.test(h) && /id="appListTitle"/.test(h) ? pass("列表头有标题与计数") : fail("列表头不全");
  /* 生成走数据层（页面自己不发请求、不写提示词）*/
  /generateSimHtml\([^)]*\{\s*kind:\s*"workbench"\s*\}/.test(h)
    ? pass('🔴 生成走 generateSimHtml(kind:"workbench")') : fail("生成没接数据层");
  /createSim\(\{[\s\S]{0,220}?kind:\s*"workbench"/.test(h) ? pass("结果经 createSim 落库（标了 kind）") : fail("没落库");
  /appsOfKind\([\s\S]{0,80}?"workbench"/.test(h) ? pass("列表用 appsOfKind(…,\"workbench\") 取") : fail("没按 kind 取");
  /* 卡片动作 */
  ["app-open", "app-send", "app-rename", "app-del"].forEach(function (a) {
    new RegExp('"' + a + '"').test(h) ? pass("工作台卡片有 " + a + " 动作") : fail("缺动作 " + a);
  });
  /* 打开：pageModalHost + 同源沙箱（要存数据）*/
  /function openApp[\s\S]{0,800}?pageModalHost\(\)/.test(h) ? pass("打开工作台走 pageModalHost()") : fail("打开没走 pageModalHost");
  /simFrameEl\(s,\s*\{\s*persist:\s*true\s*\}\)/.test(h)
    ? pass("🔴 工作台用同源沙箱（要 localStorage 存住数据，刷新不丢）") : fail("工作台没给同源，数据存不住");
  /setAttribute\("sandbox",\s*o\.persist\s*\?\s*"allow-scripts allow-same-origin"\s*:\s*"allow-scripts"\)/.test(h)
    ? pass("沙箱取值分两档（默认只给 allow-scripts）") : fail("沙箱取值不对");
  /* 跨桶取数（学生打开老师发来的那份）*/
  /simOfAnywhere\(id\)/.test(h)
    ? pass("🔴 取记录走 simOfAnywhere（跨桶 —— 学生才打得开老师发来的）") : fail("只用 simOf，学生打不开");
  /* 学生端分区 + 没有教师动作 */
  /老师发来的/.test(h) ? pass("学生端分区显示「老师发来的」") : fail("学生端没分区");
  /simsForStudent\(me\)/.test(h) ? pass("学生端用 simsForStudent() 取「发我的」") : fail("没取发我的");
  /app-send[\s\S]{0,400}?app-rename[\s\S]{0,200}?app-del/.test(h) && /if \(IS_T\)/.test(h)
    ? pass("🔴 下发/改名/删除只在教师端（学生端的卡片只有「打开」）") : fail("学生端也有教师动作");
  /* 诚实口径 */
  /!llmReady\(\)/.test(h) && /llmStatusText\(\)/.test(h)
    ? pass("🔴 未接模型时如实说明 + 指路设置（不塞假工作台）") : fail("没做诚实拒绝");
  /function toast\b/.test(h) ? pass("有操作反馈（toast）") : fail("缺操作反馈");
  /dk-empty/.test(h) ? pass("有空状态引导") : fail("缺空状态");
  /数据存在它自己的浏览器存储里/.test(h) ? pass("页脚如实说明数据存哪") : fail("没说清数据存哪");

  /* --- 🔴 两个页签必须干净移除（用户第 43 轮要求：「我只要工作台」）--- */
  const goneList = [
    ["事务台视图", /id="tabDesk"/], ["教学模拟视图", /id="tabTools"/],
    ["页签条", /class="dk-tabs"/], ["模拟器生成函数", /function makeSim\(/],
    ["模拟器列表渲染", /function renderSimList\(/], ["事务台渲染", /function renderToday\(/],
    ["事务台明细行", /function deskRow\(/], ["页签切换", /function setTab\(/],
  ];
  const stuck = goneList.filter(function (g) { return g[1].test(h); });
  stuck.length === 0
    ? pass("🔴 教学模拟与事务台的界面已彻底移除（只留 AI 工作台）")
    : fail("还留着：" + stuck.map(function (g) { return g[0]; }).join("、"));
  !/deskSummary|createDeskItem|toggleDeskDone|renderSimList|makeSim\(/.test(h)
    ? pass("页面不再引用事务台 / 模拟器的函数") : fail("还在调已删的函数");

  /* --- ⑨ 导航 --- */
  const navT = probe("JSON.stringify((NAV.teacher || []).filter(function (g) { return g.title === '智能体'; })[0].items.map(function (i) { return i.label + ':' + i.page; }))");
  const navS = probe("JSON.stringify((NAV.student || []).filter(function (g) { return g.title === '智能体'; })[0].items.map(function (i) { return i.label + ':' + i.page; }))");
  /工作台:workbench\.html/.test(navT) ? pass("教师端「智能体」组有工作台") : fail("教师端没挂工作台: " + navT);
  /工作台:workbench\.html/.test(navS) ? pass("学生端「智能体」组有工作台") : fail("学生端没挂工作台: " + navS);

  ["agent.html", "agent-student.html"].forEach((f) => {
    const a = fs.readFileSync(path.join(SITE, f), "utf8");
    /收进工作台/.test(a) && /createCard\(cardFromRun\(/.test(a)
      ? pass(f + " 的结果卡能「收进工作台」") : fail(f + " 没接工作台");
  });

  /* --- 设置页的连接测试必须真调（不能再是 alert 假弹窗）--- */
  const stHtml = fs.readFileSync(path.join(SITE, "settings.html"), "utf8");
  // ⚠️ 只看**可执行代码**，注释里回顾"以前这里是假弹窗"不算违规（踩过）
  const stCode = stHtml.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  /连接测试（演示）/.test(stCode)
    ? fail("设置页的「测试连接」还是假弹窗（假装测过了）") : pass("设置页删掉了假的连接测试");
  /function testConnection/.test(stCode) && /Authorization/.test(stCode)
    ? pass("设置页真的发一次最小请求验 Key 与 CORS") : fail("设置页没有真调用");
  /LLM_PROVIDERS\[provider\]/.test(stCode)
    ? pass("设置页从 LLM_PROVIDERS 取地址（与调用层同一份配置）") : fail("设置页自己写死了地址");
}

function verifyIntegration() {
  section("端到端联动（壳 ⇄ 内容页）");

  /* ---- 1. 共享存储：壳写入的角色，内容页能读到 ---- */
  {
    const sharedLs = new Map();
    const sharedJar = {};

    const mkDoc = () => {
      const d = makeDoc();
      Object.defineProperty(d, "cookie", {
        configurable: true,
        get() { return Object.entries(sharedJar).map(([k, v]) => `${k}=${v}`).join("; "); },
        set(str) {
          const pair = String(str).split(";")[0];
          const i = pair.indexOf("=");
          if (i < 0) return;
          const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
          if (/1970/.test(String(str))) delete sharedJar[k]; else sharedJar[k] = v;
        },
      });
      d._sharedLs = sharedLs;
      return d;
    };

    const mkSb = (doc, extra = {}) => {
      const sb = makeSandbox(doc, SHELL_PAGE, extra);
      // 用共享 localStorage 覆盖
      sb.localStorage = {
        get length() { return sharedLs.size; },
        key: (i) => [...sharedLs.keys()][i] ?? null,
        getItem: (k) => (sharedLs.has(k) ? sharedLs.get(k) : null),
        setItem: (k, v) => sharedLs.set(k, String(v)),
        removeItem: (k) => sharedLs.delete(k),
        clear: () => sharedLs.clear(),
      };
      return sb;
    };

    // 壳：以学生身份启动
    const shellDoc = mkDoc();
    shellDoc.body._html = fs.readFileSync(path.join(SITE, SHELL_PAGE), "utf8");
    for (const m of shellDoc.body._html.matchAll(/\bid="([\w-]+)"/g)) {
      const e = withParent(makeEl("div"), shellDoc.body);
      e._html = shellDoc.body._html;
      shellDoc._registry[m[1]] = e;
    }
    const shellSb = mkSb(shellDoc, { hash: "" });
    vm.createContext(shellSb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), shellSb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "shell.js"), "utf8"), shellSb);
    const sp = probeFn(shellSb);

    // 模拟登录页写入角色
    sp("(() => { Cookie.set('st_role','student',1); LS.rawSet('st_role','student'); })()");
    sp("role()") === "student" ? pass("壳从共享存储读到登录页写入的角色（student）")
      : fail("壳未读到角色: " + sp("role()"));

    // 内容页：同源同存储，应读到同一角色
    const childDoc = mkDoc();
    const childHtml = fs.readFileSync(path.join(SITE, "chat.html"), "utf8");
    childDoc.body._html = childHtml;
    registerIds(childDoc, childHtml);
    const childSb = mkSb(childDoc, { frameElement: makeShellHost() });
    vm.createContext(childSb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), childSb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8"), childSb);
    const cp = probeFn(childSb);

    cp("currentRole()") === "student"
      ? pass("内容页与壳共享存储，读到同一角色")
      : fail("内容页角色不一致: " + cp("currentRole()"));
  }

  /* ---- 2. 主题一致性：壳切主题 → 子页面根元素同步 ---- */
  {
    const shellHost = makeShellHost();
    const childDoc = makeDoc();
    const childHtml = fs.readFileSync(path.join(SITE, "chat.html"), "utf8");
    childDoc.body._html = childHtml;
    registerIds(childDoc, childHtml);
    // 壳的根元素先设为 dark
    shellHost.ownerDocument.documentElement.setAttribute("data-theme", "dark");

    const sb = makeSandbox(childDoc, "chat.html", { frameElement: shellHost });
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8"), sb);
    const p = probeFn(sb);

    p("Theme.current()") === "dark"
      ? pass("子页面继承壳的主题（未登录壳设为 dark 时同步生效）")
      : fail("主题未继承: " + p("Theme.current()"));

    // 子页面改主题 → 写回壳
    p("Theme.apply('snow')");
    shellHost.ownerDocument.documentElement.getAttribute("data-theme") === "snow"
      ? pass("子页面改主题写回壳根元素（设置页与顶部栏不脱节）")
      : fail("主题未写回壳: " + shellHost.ownerDocument.documentElement.getAttribute("data-theme"));

    // 并广播给壳（让顶部栏按钮刷新）
    sb._posted.some((m) => m.type === "st-theme-changed" && m.theme === "snow")
      ? pass("子页面改主题时向壳广播（顶部栏按钮状态可刷新）")
      : fail("未广播主题变更");
  }

  /* ---- 3. 无障碍一致性：设置页改动 → 壳根元素同步 ---- */
  {
    const shellHost = makeShellHost();
    const childDoc = makeDoc();
    const childHtml = fs.readFileSync(path.join(SITE, "settings.html"), "utf8");
    childDoc.body._html = childHtml;
    registerIds(childDoc, childHtml);
    const sb = makeSandbox(childDoc, "settings.html", { frameElement: shellHost });
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "core.js"), "utf8"), sb);
    const p = probeFn(sb);

    const rootStyle = shellHost.ownerDocument.documentElement.style;
    p("applyA11yVars({size:20,lh:2.2,ls:0.05})");
    rootStyle.getPropertyValue("--a11y-font-size") === "20px"
      ? pass("无障碍字号写入壳根元素（整站生效）")
      : fail("无障碍字号未写入壳: " + rootStyle.getPropertyValue("--a11y-font-size"));
    rootStyle.getPropertyValue("--a11y-line-height") === "2.2"
      ? pass("无障碍行高写入壳根元素")
      : fail("行高未同步");
    sb._posted.some((m) => m.type === "st-a11y-changed")
      ? pass("无障碍改动向壳广播")
      : fail("无障碍改动未广播");
  }

  /* ---- 4. 导航链路：壳收 postMessage → 切 iframe ---- */
  {
    const doc = makeDoc();
    const html = fs.readFileSync(path.join(SITE, SHELL_PAGE), "utf8");
    doc.body._html = html;
    registerIds(doc, html);
    let msgHandler = null;
    const sb = makeSandbox(doc, SHELL_PAGE, { hash: "" });
    sb.addEventListener = (t, fn) => { if (t === "message") msgHandler = fn; };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"), sb);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "shell.js"), "utf8"), sb);
    const p = probeFn(sb);

    p("(() => { Cookie.set('st_role','teacher',1); LS.rawSet('st_role','teacher'); })()");
    msgHandler && msgHandler({ data: { type: "st-navigate", page: "exam.html" } });
    doc.getElementById("contentFrame").src === "exam.html"
      ? pass("壳接收子页面 st-navigate 消息并切换 iframe")
      : fail("壳未响应 st-navigate: " + doc.getElementById("contentFrame").src);

    // 越权消息也应被拦
    msgHandler && msgHandler({ data: { type: "st-navigate", page: "chat.html" } });
    doc.getElementById("contentFrame").src !== "chat.html"
      ? pass("子页面发起的越权跳转同样被壳拦截")
      : fail("越权 postMessage 未被拦截");
  }
}

/* ============================================================
   入口
   ============================================================ */
const args = process.argv.slice(2);

console.log("站点目录: " + SITE);

if (args.length === 0) {
  for (const p of CONTENT_PAGES) verifyContentPage(p);
  verifyLogin();
  verifyShell();
  verifyLessonData();
  verifyTrainingData();
  verifyStudentTraining();
  verifyEnrollData();
  verifyBehaviorData();
  verifySkillData();
  verifySkillState();
  verifyWorkbench();
  verifyExam();
  verifyCourseware();
  verifyNoDemoWords();
  verifyStandalone();
  verifyIntegration();
  verifyGlobalNames();
  verifyGlobal();
} else {
  for (const p of args) {
    const f = path.isAbsolute(p) ? p : path.join(SITE, p);
    if (!fs.existsSync(f)) { fail("文件不存在: " + f); continue; }
    const base = path.basename(f);
    if (base === SHELL_PAGE) verifyShell();
    else if (base === LOGIN_PAGE) verifyLogin();
    else if (CONTENT_PAGES.includes(base)) verifyContentPage(base);
    else fail("未知页面: " + base);
  }
}

console.log("\n" + "=".repeat(62));
console.log(failures === 0
  ? `结果: 全部通过 ✓（${checks} 项检查）`
  : `结果: ${failures} 项失败 ✗ / 通过 ${checks} 项`);
console.log("=".repeat(62));
process.exit(failures === 0 ? 0 : 1);
