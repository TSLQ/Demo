/* ============================================================
   应用壳逻辑
   ------------------------------------------------------------
   顶部栏 + 左侧栏固定，中间 <iframe id="contentFrame"> 换内容。
   切页只改 iframe.src，壳不重建、主题与折叠状态不丢。

   与内容页的分工：
     · 壳负责：顶部栏、左侧栏、主题、折叠、越权拦截、iframe 路由
     · 内容页负责：自己的正文；不在壳内（被直接打开）时由 core.js
       自我渲染一套同样的导航兜底

   路由：location.hash = 目标文件名，如 app.html#chat.html
   导航配置的唯一来源是 assets/nav.js（PAGE_ROLE / ROLES / NAV）
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

/* ---------------- 存储键（与 core.js 保持一致） ---------------- */
const STORE_KEY = {
  theme:    "st_theme",
  role:     "st_role",
  a11y:     "st_a11y",
  density:  "st_density",
  provider: "st_provider",
  name:     "st_display_name",
  apiKey:   "st_api_key",
  readMode: "st_a11y_read_mode",
  agentTask: "st_agent_task",       // 交给 AI 助手的任务（含原文），见 schedule.html 方式三
};

/* ---------------- 主题 ---------------- */
/** 无任何本机记录时的默认主题（用户要求：默认深色） */
const DEFAULT_THEME = "dark";

const THEMES = [
  { id: "cream", label: "Cream" },
  { id: "snow",  label: "Snow"  },
  { id: "dark",  label: "深色"  },
];
const THEME_IDS = THEMES.map((t) => t.id);

const Theme = {
  init() { this.apply(this.current(), false); },
  /**
   * 读取当前主题。⚠️ 顺序很关键：
   *   1) 本机保存的偏好（Cookie / localStorage）—— **最高优先级**，
   *      这才是「用户上次选的主题，下次进来还是它」的依据。
   *   2) HTML 上写死的 data-theme —— 只是**首屏防闪烁**的占位，
   *      绝不能盖过用户已保存的选择（否则改完主题下次又变回去）。
   *   3) 最终兜底 = DEFAULT_THEME（深色）。
   */
  current() {
    const saved = Cookie.get(STORE_KEY.theme) || LS.raw(STORE_KEY.theme);
    if (saved) return String(saved).replace(/^"|"$/g, "");
    const fromDom = document.documentElement.getAttribute("data-theme");
    if (fromDom) return fromDom;
    return DEFAULT_THEME;
  },
  apply(id, persist = true) {
    if (!id) return;
    document.documentElement.setAttribute("data-theme", id);
    if (persist) {
      Cookie.set(STORE_KEY.theme, id, 365);
      LS.rawSet(STORE_KEY.theme, id);
    }
    document.querySelectorAll("[data-theme-btn]").forEach((b) => {
      const on = b.dataset.themeBtn === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    broadcast("st-theme-changed", { theme: id });
  },
};

/* ---------------- 跨 iframe 广播 ---------------- */
/**
 * 通知子页面（iframe）设置发生变化。
 * ⚠️ 变量名不能用 role —— 会遮蔽外层 role() 函数造成 TDZ
 *    ReferenceError: Cannot access 'role' before initialization
 * ⚠️ targetOrigin 在 file:// 下是 "null"，会把消息丢掉 → 退化为 "*"。
 */
function frameTargetOrigin() {
  const o = location.origin;
  return (!o || o === "null") ? "*" : o;
}

function broadcast(type, detail) {
  const myRole = role();
  const frame = document.getElementById("contentFrame");
  try {
    frame?.contentWindow?.postMessage(
      { type, role: myRole, ...(detail || {}) }, frameTargetOrigin()
    );
  } catch (_) { /* 跨域 / 未加载时忽略 */ }
}

/* ---------------- 角色 ---------------- */
function role() {
  const ck = Cookie.get(STORE_KEY.role) || LS.raw(STORE_KEY.role);
  return ck === "teacher" ? "teacher" : "student";
}

function normalize(page) {
  return String(page || "").split("#")[0].split("?")[0].trim();
}

/* ---------------- 加载指示 ---------------- */
let loadingTimer = null;
function showLoading(on) {
  const el = document.getElementById("frameLoading");
  if (!el) return;
  if (on) {
    clearTimeout(loadingTimer);
    el.classList.add("on");
  } else {
    loadingTimer = setTimeout(() => el.classList.remove("on"), 90);
  }
}

/* ---------------- 侧栏高亮 ----------------
   ⚠️ 比对的是**完整目标**（可能带 ?cls=xxx），不是裸页名。
   规则见 nav.js 的 currentIndex()：先精确比对，全不中才退回裸页名。
   多个班级共用 class.html，若一律按裸页名比，点一个班会让所有班一起亮。 */
function highlightNav() {
  const items = [...document.querySelectorAll("#shellSide .side-item")];
  const idx = (typeof currentIndex === "function")
    ? currentIndex(items.map((b) => b.dataset.page || ""), String(currentPage || "").trim())
    : -1;
  items.forEach((b, i) => {
    const on = i === idx;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

/* ---------------- 路由（切 iframe） ---------------- */
let currentPage = "";

function go(page) {
  const raw = String(page || "").trim();
  if (!raw) return;
  const target = normalize(raw);          // 仅用于归属判断（剥掉 ?query 与 #hash）
  if (!target) return;

  // 越权拦截：目标页归属别的角色时，拦回本角色首页
  const owner = (typeof PAGE_ROLE !== "undefined") && PAGE_ROLE[target];
  const mine = role();
  let real = raw;                         // 保留 ?query：同一页面要能区分不同对象
  if (owner && owner !== "both" && owner !== "login" && owner !== mine) {
    console.warn("[shell] 拦截跨端访问:", target, "当前身份:", mine);
    real = (typeof ROLES !== "undefined" && ROLES[mine]) ? ROLES[mine].home : raw;
  }

  currentPage = real;
  highlightNav();                       // 切页后立即更新高亮，否则点了像没反应
  location.hash = real;

  const frame = document.getElementById("contentFrame");
  if (!frame) return;

  showLoading(true);
  frame.src = real;
}

/* ---------------- 折叠 ---------------- */
function collapse(on) {
  const body = document.body;
  const side = document.getElementById("shellSide");
  const btn = document.getElementById("collapseBtn");
  const scrim = document.getElementById("scrim");
  const small = window.matchMedia?.("(max-width: 860px)")?.matches;

  const next = typeof on === "boolean" ? on : !side.classList.contains("collapsed");
  side.classList.toggle("collapsed", next);
  body.classList.toggle("side-collapsed", next);
  btn?.setAttribute("aria-expanded", String(!next));
  if (scrim) scrim.hidden = !(next === false && small);
  LS.set("st_side_collapsed", next);
}

/* ---------------- 渲染侧栏 ---------------- */
function mountSide() {
  const side = document.getElementById("shellSide");
  if (!side) return;
  const r = role();
  const groups = (typeof NAV !== "undefined" && NAV[r]) || [];
  // ⚠️ 不能用 normalize() —— 会把 ?cls=xxx 剥掉，重渲染侧栏后班级高亮就丢了
  const here = String(currentPage || "").trim();
  // 先算出「哪一项是当前项」（规则见 nav.js currentIndex），再按同一顺序渲染
  const targets = groups.reduce((acc, g) =>
    acc.concat((g.items || []).map((it) => (it.page ? navTarget(it) : ""))), []);
  const activeIdx = (typeof currentIndex === "function") ? currentIndex(targets, here) : -1;
  let k = -1;

  // 🔴 菜单区包一层 .side-nav：**只有它滚动**，底部的 .side-foot（用户卡片）固定不动。
  //    与 core.js 的 mountStandaloneSide() 成对维护 —— 改一处必须同步另一处。
  side.innerHTML = `<div class="side-nav">` + groups.map((g) => {
    // 分组标题右侧的「＋」按钮：由 nav.js 的 GROUP_ACTIONS 声明驱动，
    // 「我的课程」→ 添加课程、「班级管理」→ 添加班级，共用同一套样式与布局。
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
        // 「我的课程」的每一项额外带一个「⋯」：
        //   教师端（addCourse）→ 改信息 / 查看邀请码 / 删除课程
        //   学生端（joinCourse）→ 退出课堂
        // ⚠️ 必须放在 .side-item **外面**（button 不能嵌 button，浏览器会拆坏结构），
        //    所以给这一项包一层 .side-row。
        // ⚠️ data-more-kind 把「是哪一端」带到点击处 —— 两端菜单项不一样，不能只看 key。
        const more = ((g.action === "addCourse" || g.action === "joinCourse") && it.key)
          ? `<button class="side-more" type="button" data-more="${it.key}" data-more-kind="${g.action}"
                     aria-label="${it.label} 的更多操作" aria-haspopup="menu" aria-expanded="false">
               <span aria-hidden="true">⋯</span>
             </button>`
          : "";
        return more ? `<div class="side-row">${item}${more}</div>` : item;
      }).join("")}
    </div>`;
  }).join("") + `</div>` +          // 收掉 .side-nav

    `<div class="side-foot">
      <div class="side-user">
        <span class="side-avatar">${(((typeof ROLES !== "undefined" && ROLES[r]) || {}).name || "用户").slice(0, 1)}</span>
        <div class="side-user-body">
          <b>${(((typeof ROLES !== "undefined" && ROLES[r]) || {}).name || "用户")}</b>
          <span>${((typeof ROLES !== "undefined" && ROLES[r]) || {}).label || ""}身份</span>
        </div>
      </div>
      <div class="side-foot-note">全部数据保存在本机浏览器</div>
    </div>`;

  side.querySelectorAll(".side-item").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.classList.contains("disabled")) return;
      go(b.dataset.page);
      if (window.matchMedia?.("(max-width: 860px)")?.matches) collapse(true);
    });
  });

  // 「⋯」→ 操作菜单。🔴 按 data-more-kind 分发：教师端与学生端的菜单项不一样
  side.querySelectorAll(".side-more").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openCourseMenu(b, b.dataset.more, b.dataset.moreKind);
    });
  });

  // 分组标题右侧的「＋」→ 对应的弹窗（data-action 区分：加课程 / 加班级 / 输邀请码加入课堂）
  side.querySelectorAll(".side-add").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.action === "addClass") openAddClass();
      else if (b.dataset.action === "joinCourse") openJoinCourse();
      else openAddCourse();
    });
  });

  highlightNav();
}

/* ============================================================
   添加课程弹窗
   ------------------------------------------------------------
   保存会**真的建课**：nav.js 的 createCourse() 负责校验 + 生成 id +
   写入 COURSES + 落库 st_courses + 回填「我的课程」菜单项，
   这里只负责收集表单、提示错误、重渲染侧栏。
   🔴 core.js 里有一份等价的（独立模式用），改一处必须同步另一处。
   ============================================================ */
/* 学期 / 周次的候选值在 nav.js（termSuggestions() / COURSE_WEEKS）——
   🔴 别在这里再声明一份：nav.js 已用 var 声明过同名全局，
      这里再 `const` 会直接抛 "Identifier has already been declared"。 */


/** HTML 转义 —— 课程表单预填用户输入时用（壳不引用 core.js，这里单独一份） */
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ============================================================
   课程表单 —— 新建与「编辑信息」共用
   ------------------------------------------------------------
   · 不传参数 = 添加课程（侧栏「＋」）
   · 传课程对象 = 编辑课程信息（课程项的「⋯」→ 编辑）
   保存走 nav.js 的 createCourse() / updateCourse()（唯一实现），
   这里只负责收集表单、提示错误、重渲染侧栏、广播给内容页。
   🔴 core.js 里有一份等价的（独立模式用），改一处必须同步另一处。
   ============================================================ */
function openCourseForm(course) {
  const isEdit = !!(course && course.id);
  const c = course || {};
  const host = document.getElementById("modalHost");
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

  // 关闭：点遮罩 / 点 ✕ / 点取消 / 按 Esc
  host.querySelectorAll("[data-close]").forEach((n) =>
    n.addEventListener("click", closeAddCourse));
  document.addEventListener("keydown", modalEsc);

  // 焦点进第一个输入框（无障碍：弹窗打开要转移焦点）
  setTimeout(() => document.getElementById("cName")?.focus?.(), 0);

  // 保存：新建 / 改信息；成功后重渲染侧栏并广播给内容页
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
    mountSide();                  // 重渲染 → 新课程 / 新名字出现在菜单里
    // 🔴 把最新的课程目录广播给内容页。
    //    壳与 iframe 各持一份 COURSES（nav.js 在每个文档里各执行一次），
    //    不广播的话，教案页的课程下拉会一直停在旧列表上。
    broadcast("st-courses-changed", { courses: COURSES });
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
   课程项的「⋯」菜单 —— 改信息 / 删除
   ------------------------------------------------------------
   ⚠️ 菜单挂在 body 上、用 position:fixed 定位：
      .shell-side 是 overflow:hidden（为了底部用户卡片固定），
      菜单若放在侧栏内部会被直接裁掉，看不见。
   🔴 core.js 里有一份等价的（独立模式用），改一处必须同步另一处。
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
  if (wasOpen) return;                       // 再点一次 = 收起

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

  // 定位到按钮下方；贴到视口底部就往上弹
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

  // 下一个事件循环再挂「点别处关闭」，否则这次 click 立刻把它关掉
  setTimeout(() => {
    document.addEventListener("click", onDocClickForCourseMenu);
    document.addEventListener("keydown", onEscForCourseMenu);
  }, 0);
}

/** 删除课程：先把会连带删掉的教案数量讲清楚，再动手 */
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
  mountSide();
  broadcast("st-courses-changed", { courses: COURSES });
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
   添加班级弹窗
   ------------------------------------------------------------
   与添加课程弹窗同一套交互（遮罩 / ✕ / 取消 / Esc 四通道关闭）。
   ⚠️ 同样只是「示例」——表单能填、能校验、能关，**保存逻辑未实现**。
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
  const host = document.getElementById("modalHost");
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

  // 关闭：点遮罩 / 点 ✕ / 点取消 / 按 Esc
  host.querySelectorAll("[data-close]").forEach((n) =>
    n.addEventListener("click", closeAddClass));
  document.addEventListener("keydown", modalEsc);

  // 焦点进第一个输入框（无障碍：弹窗打开要转移焦点）
  setTimeout(() => document.getElementById("kName")?.focus?.(), 0);

  // 保存：⚠️ 仅做校验与提示，不落库
  document.getElementById("classSave").addEventListener("click", () => {
    const name = (document.getElementById("kName")?.value || "").trim();
    const err = document.getElementById("classError");
    if (!name) {
      err.textContent = "请先填写班级名称";
      err.hidden = false;
      document.getElementById("kName")?.focus?.();
      return;
    }
    err.hidden = true;
    // TODO: 保存逻辑待定 —— 班级归属哪个课程、是否与「我的课程」联动尚未确定
    alert(`「${name}」已填写完整。\n\n保存逻辑尚未接入，本弹窗暂为示例。`);
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

/* ---------------- 渲染顶部栏里的身份信息 ---------------- */
function mountTop() {
  const r = role();
  const meta = (typeof ROLES !== "undefined" && ROLES[r]) || { label: "教师", name: "用户" };
  const name = LS.get(STORE_KEY.name, "") || meta.name;

  const set = (id, text) => { const e = document.getElementById(id); if (e) e.textContent = text; };
  set("brandRole", meta.label + "端");
  set("userName", name);
  set("menuName", name);
  set("menuRole", meta.label + "身份");
  set("userAvatar", name.slice(0, 1));
}

/* ---------------- iframe 事件 ---------------- */
function wireFrame() {
  const frame = document.getElementById("contentFrame");
  if (!frame) return;

  frame.addEventListener("load", () => {
    showLoading(false);
    // 内容页是独立文档，必须由壳主动把主题 / 无障碍推给它，
    // 否则壳切深色时中间内容不会跟着变。
    // st-shell-hello 先发：内容页收到后确认「我在壳内」，会撤掉可能误渲染的独立导航。
    broadcast("st-shell-hello", { theme: Theme.current() });
    broadcast("st-theme-changed", { theme: Theme.current() });
    pushA11yToFrame();
    // 阅读模式开关的当前状态也同步过去（内容页将来接上即可生效）
    broadcast("st-a11y-mode", { on: readModeOn() });
  });

  frame.addEventListener("error", iframeFailed);
}

/** 把当前无障碍设置推给 iframe 内的内容页 */
function pushA11yToFrame() {
  const c = LS.get(STORE_KEY.a11y, null) || {};
  const size = c.size ?? 15;
  const lh   = c.lh   ?? 1.8;
  const ls   = c.ls   ?? 0;
  broadcast("st-a11y-changed", {
    vars: {
      "--a11y-font-size": size + "px",
      "--a11y-line-height": String(lh),
      "--a11y-letter-spacing": ls + "em",
    },
    contrast: !!c.contrast,
    reduceMotion: !!c.reduceMotion,
  });
}

function iframeFailed() {
  const bar = document.getElementById("frameError");
  if (bar) bar.hidden = false;
}

/* ---------------- 无障碍阅读模式开关 ----------------
   ⚠️ 本轮只做「开关 + 状态持久化 + 广播」，**不做任何视觉/行为实现**。
   用户明确要求功能先不做，这里只留好接口：
     · 默认勾选（HTML 上写死 checked，JS 未跑时也是勾上的）
     · 状态存 localStorage（st_a11y_read_mode），跨页面保持
     · 变化时广播 st-a11y-mode 给 iframe，将来内容页接上即可生效
   真要实现时，只需在 core.js 的 message 监听里处理 st-a11y-mode。
--------------------------------------------------------------- */
function readModeOn() {
  return LS.get(STORE_KEY.readMode, true) !== false;
}

function mountReadMode() {
  // ⚠️ 用 id 收集，不要用 [data-a11y-mode] 属性选择器（桩验证器查不到）
  const boxes = [document.getElementById("a11yReadMode")].filter(Boolean);
  if (!boxes.length) return;

  boxes.forEach((box) => {
    box.checked = readModeOn();
    box.addEventListener("change", () => {
      const on = !!box.checked;
      LS.set(STORE_KEY.readMode, on);
      boxes.forEach((b) => { b.checked = on; });   // 同页多入口同步
      broadcast("st-a11y-mode", { on });
      // TODO: 功能实现留待后续 —— 阅读模式的具体呈现方式尚未确定
    });
  });
}

/* ---------------- 启动 ---------------- */
function boot() {
  Theme.init();
  wireFrame();

  // 主题按钮
  document.querySelectorAll("[data-theme-btn]").forEach((b) => {
    b.addEventListener("click", () => Theme.apply(b.dataset.themeBtn));
  });

  // 用户菜单
  const btn = document.getElementById("userBtn");
  const menu = document.getElementById("userMenu");
  const closeMenu = () => { if (menu) menu.hidden = true; btn?.setAttribute("aria-expanded", "false"); };
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  menu?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closeMenu);

  menu?.querySelectorAll("[data-go]").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.dataset.go;
      closeMenu();
      if (t === "index.html") {
        Cookie.del(STORE_KEY.role);
        LS.del(STORE_KEY.role);
        location.href = "index.html";
        return;
      }
      go(t);
    });
  });

  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    Cookie.del(STORE_KEY.role);
    LS.del(STORE_KEY.role);
    location.href = "index.html";
  });

  // 折叠
  document.getElementById("collapseBtn")?.addEventListener("click", () => collapse());
  document.getElementById("scrim")?.addEventListener("click", () => collapse(true));

  // 折叠状态记忆
  if (LS.get("st_side_collapsed", false)) collapse(true);

  mountTop();
  mountSide();
  mountReadMode();

  // 首屏路由：hash 优先，其次本角色首页
  // ⚠️ 这里**不能** normalize —— 会丢掉 ?cls=xxx 这类对象选择串，
  //    刷新后「刚才看的是哪个班」就没了。归属判断在 go() 里做。
  const fromHash = location.hash.replace(/^#/, "").trim();
  const home = (typeof ROLES !== "undefined" && ROLES[role()]) ? ROLES[role()].home : "chat.html";
  go(fromHash || home);

  // hash 变化（浏览器前进/后退）也要跟随
  window.addEventListener("hashchange", () => {
    const p = location.hash.replace(/^#/, "").trim();
    if (p && p !== currentPage) go(p);
  });

  // 接收子页面发来的设置变更（子页面改了主题/无障碍 → 壳刷新自己）
  window.addEventListener("message", (e) => {
    // 只接受同源消息；file:// 下 origin 是 "null"，需放行
    const o = e.origin;
    if (o && o !== "null" && o !== location.origin) return;
    const d = e.data || {};
    if (d.type === "st-navigate" && d.page) {
      go(d.page);
    }
    if (d.type === "st-theme-changed" && d.theme && d.theme !== Theme.current()) {
      Theme.apply(d.theme, false);
    }
    // 内容页里改了实训活动 → 更新壳自己那份 ACTIVITIES 并重挂侧栏
    // （侧栏「实训管理」的徽标 = 待教师确认的学生发起活动数，不更新就一直是旧数字）
    if (d.type === "st-activities-changed") {
      if (Array.isArray(d.activities)) {
        ACTIVITIES = d.activities;
      } else {
        // 没带数据才自己读盘；⚠️ 读不到存档会回落种子，反而把刚建的活动抹掉 —— 先确认有存档
        try {
          if (window.localStorage.getItem(activityStoreKey())) ACTIVITIES = loadActivities();
        } catch (_) { /* 隐私模式 / file:// —— 保留内存里那份 */ }
      }
      refreshActivityNav();
      mountSide();
    }
    // 内容页里改了阅读模式 → 壳里的勾选框跟着走
    if (d.type === "st-a11y-mode") {
      const on = d.on !== false;
      LS.set(STORE_KEY.readMode, on);
      const b = document.getElementById("a11yReadMode");
      if (b) b.checked = on;
    }
    if (d.type === "st-a11y-changed") {
      // a11y 变量写在壳的根元素上（子页面通过 frameElement.ownerDocument 修改）
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

  // file:// 下部分浏览器禁 iframe：2.5s 内没 load 就提示，但仍可用（切页整页刷新兜底）
  if (location.protocol === "file:") {
    setTimeout(() => {
      const f = document.getElementById("contentFrame");
      if (f && !f.contentWindow?.location?.href) iframeFailed();
    }, 2500);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

/* ============================================================
   学生端：输入邀请码加入课堂（第 32 轮）
   ------------------------------------------------------------
   🔴 与 shell.js 的同名实现是一对，改一处必须同步另一处。
   校验 / 查课堂 / 落库全在 nav.js（findClassroom / enrollCourse）——
   这里只负责收集输入、提示错误、重渲染侧栏。
   ============================================================ */
function openJoinCourse() {
  const host = document.getElementById("modalHost");
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
    n.addEventListener("click", closeAddCourse));
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
    closeAddCourse();
    mountSide();    // 侧栏里立刻出现这门课
    // 直接跳过去，让「加入」马上有反馈（学生端的课程页就是 AI 答疑）
    go("chat.html?course=" + encodeURIComponent(hit.course.id));
  });
}

/** 教师端：显示这门课的邀请码（学生凭它加入课堂） */
function openJoinCode(courseId) {
  const c = (COURSES || []).find((x) => x.id === courseId);
  if (!c) return;
  const host = document.getElementById("modalHost");
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
    n.addEventListener("click", closeAddCourse));
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
  mountSide();
}
