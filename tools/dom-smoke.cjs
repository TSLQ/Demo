/**
 * 真实 DOM 冒烟测试（jsdom）
 * ------------------------------------------------------------
 * verify-site.cjs 用的是自建 DOM 桩，能验「逻辑」，但验不了
 * 「真实解析后的结构」。本脚本用 jsdom 真正解析 HTML、真正执行
 * 页面脚本，检查渲染出来的节点树是否符合预期。
 *
 * 用法：node tools/dom-smoke.cjs
 * 退出码：0 全通过 / 1 有失败
 * ------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const JSDOM_PATH = path.join(__dirname, ".deps", "node_modules", "jsdom");
let JSDOM, CookieJar;
try {
  ({ JSDOM, CookieJar } = require(JSDOM_PATH));
} catch (e) {
  console.log("跳过：未安装 jsdom。安装方法：");
  console.log("  cd tools/.deps && npm install jsdom");
  process.exit(0);
}

const SITE = path.resolve(__dirname, "..", "docs");

let fail = 0, ok = 0;
const P = (m) => { ok++; console.log("  v " + m); };
const F = (m) => { fail++; console.log("  x " + m); };
const info = (m) => { console.log("  - " + m); };
const errors = [];

/** 把 <script src> / <link href> 解析成 file:// 绝对路径并内联，
 *  让 jsdom 无需真的发起网络/文件请求也能执行外部脚本。 */
function inlineAssets(root, file) {
  const dir = path.dirname(path.join(SITE, file));
  let html = fs.readFileSync(path.join(SITE, file), "utf8");

  // 内联外部脚本
  html = html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g, (_m, src) => {
    try {
      const code = fs.readFileSync(path.resolve(dir, src), "utf8");
      // 用 </scr"+"ipt> 规避提前闭合
      return "<script>\n" + code.replace(/<\/script>/gi, "<\\/script>") + "\n</script>";
    } catch (e) {
      return "<!-- missing: " + src + " -->";
    }
  });

  // 内联样式表
  html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>/g, (_m, href) => {
    try {
      const css = fs.readFileSync(path.resolve(dir, href), "utf8");
      return "<style>\n" + css + "\n</style>";
    } catch (e) {
      return "<!-- missing: " + href + " -->";
    }
  });

  return html;
}

function load(file, opts = {}) {
  const html = inlineAssets(SITE, file);
  return new JSDOM(html, {
    // opts.query 用于「同一页面的不同对象」，如 class.html?cls=cs2301
    url: (opts.url || "http://localhost/") + file + (opts.query || ""),
    runScripts: "dangerously",
    pretendToBeVisual: true,
    cookieJar: opts.jar,                     // 传入同一 jar 即可模拟「同一浏览器再次打开」
    beforeParse(win) {
      win.addEventListener("error", (e) => errors.push(file + ": " + e.message));
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      // ⚠️ jsdom 没实现 Element.scrollIntoView（真实浏览器都有）→ 补个空实现。
      //    不补的话，页面里正常的"点一下滚到视野内"会抛错，把后面的逻辑一起带走 ——
      //    那是"桩缺件"造成的假失败，不是产品 Bug。
      if (win.Element && !win.Element.prototype.scrollIntoView) {
        win.Element.prototype.scrollIntoView = function () {};
      }
      // 还原「上次会话」留下的本机数据（用于验证持久化真的生效）
      const r = opts.restore;
      if (r) {
        if (r.cookie) {
          for (const part of String(r.cookie).split(";")) {
            const kv = part.trim();
            if (kv && kv.includes("=")) win.document.cookie = kv + "; path=/";
          }
        }
        if (r.ls) for (const [k, v] of Object.entries(r.ls)) {
          try { win.localStorage.setItem(k, String(v)); } catch (_) {}
        }
      }
      if (opts.role) win.document.cookie = "st_role=" + opts.role + "; path=/";
    },
  });
}

const ROLE_OF = {
  "exam.html": "teacher",
  "class.html": "teacher",
  "courseware.html": "teacher",
  "schedule.html": "teacher",
  "lesson.html": "teacher",
  "agent.html": "teacher",
};

/** 等 jsdom 把脚本（含 DOMContentLoaded）跑完 */
function settle(dom) {
  return new Promise((resolve) => {
    if (dom.window.document.readyState === "complete") {
      setTimeout(resolve, 0);
    } else {
      dom.window.addEventListener("load", () => setTimeout(resolve, 0));
    }
  });
}

async function main() {

console.log("\n=== 1. 登录页 ===");
{
  const dom = load("index.html");
  await settle(dom);
  const d = dom.window.document;
  const cards = d.querySelectorAll(".role-card");
  cards.length >= 2 ? P("渲染出 " + cards.length + " 张角色卡") : F("角色卡缺失");
  const btn = d.getElementById("enterBtn");
  btn ? P("进入按钮存在") : F("进入按钮缺失");
  !d.querySelector("#sideNav") ? P("无侧栏（登录页应纯净）") : F("登录页混入侧栏");
  const studentCard = [...cards].find((c) => c.dataset.role === "student");
  if (studentCard) studentCard.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  btn && /学生/.test(btn.textContent) ? P("点选学生角色后按钮文案切换") : F("按钮文案未切换: " + (btn && btn.textContent));

  // 账号密码表单：真渲染里确认「注册 → 落盘 → 可登录」闭环
  const acc = d.getElementById("account");
  const pwd = d.getElementById("password");
  acc && pwd ? P("账号 / 密码输入框渲染存在") : F("账号或密码输入框缺失");

  // 首次打开应自动预置演示账号（观众不必先注册）
  {
    const stored = dom.window.localStorage.getItem("st_accounts");
    let list = [];
    try { list = JSON.parse(stored || "[]"); } catch (_) {}
    Array.isArray(list) && list.length >= 2
      ? P(`首屏自动预置 ${list.length} 个演示账号到 localStorage`)
      : F("未预置演示账号，实际: " + stored);
  }

  // 登录 / 注册 标签切换
  {
    const regForm = d.getElementById("regForm");
    const loginForm = d.getElementById("loginForm");
    regForm && loginForm ? P("注册表单与登录表单同时存在") : F("缺少注册表单");
    d.getElementById("tabReg").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    regForm.hidden === false && loginForm.hidden === true
      ? P("切到「注册账号」后表单真的换了")
      : F("标签切换无效");
    d.getElementById("tabLogin").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    loginForm.hidden === false && regForm.hidden === true
      ? P("切回「登录」后表单换回")
      : F("切回登录无效");
  }

  // 注册一个新账号 → 落盘 → 用新账号登录
  {
    d.getElementById("tabReg").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    d.getElementById("regName").value = "王小明";
    d.getElementById("regUser").value = "wangxm";
    d.getElementById("regPass").value = "wx@2026";
    // 选学生身份
    const stu = [...d.querySelectorAll(".role-card")].find((c) => c.dataset.role === "student");
    stu.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    d.getElementById("regForm").dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }));

    let list = [];
    try { list = JSON.parse(dom.window.localStorage.getItem("st_accounts") || "[]"); } catch (_) {}
    const hit = list.find((a) => a.user === "wangxm");
    hit ? P("注册后账号写入 localStorage（st_accounts）") : F("注册未落盘: " + JSON.stringify(list));
    hit && hit.role === "student" ? P("账号归属为所选身份（student）")
      : F("账号身份记录错误: " + (hit && hit.role));

    // 重复账号应被拒
    d.getElementById("regUser").value = "wangxm";
    d.getElementById("regForm").dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    const err = d.getElementById("regError");
    !err.hidden && /占用/.test(err.textContent)
      ? P("重复账号注册被拒并提示")
      : F("重复账号未被拒: " + err.textContent);
  }

  // 密码显示切换 + 无障碍勾选
  {
    d.getElementById("tabLogin").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    const p2 = d.getElementById("password");
    d.getElementById("pwdEye").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    p2.type === "text" ? P("点「显示」后密码框切到明文") : F("密码显示切换无效: " + p2.type);

    const box = d.getElementById("a11yReadMode");
    box && box.checked === true ? P("登录页无障碍勾选默认打开") : F("登录页无障碍勾选未默认打开");
  }
  dom.window.close();
}

console.log("\n=== 2. 应用壳（学生身份）===");
{
  const dom = load("app.html", { role: "student" });
  await settle(dom);
  const d = dom.window.document;
  const side = d.getElementById("shellSide");
  const items = side ? side.querySelectorAll(".side-item") : [];
  items.length >= 6 ? P("侧栏渲染 " + items.length + " 个菜单项") : F("侧栏菜单过少: " + items.length);
  const labels = [...items].map((b) => (b.querySelector(".side-label") || {}).textContent || "");
  labels.includes("AI 答疑") && labels.includes("我的学情")
    ? P("含学生端菜单（AI 答疑 / 我的学情）") : F("学生菜单异常: " + labels.join(","));
  !labels.some((l) => /出题|组卷|班级学情|学生管理/.test(l))
    ? P("未泄漏教师端菜单") : F("泄漏教师端菜单: " + labels.join(","));
  /学生/.test(d.getElementById("brandRole").textContent) ? P("顶部栏显示学生端") : F("角色标签错误");
  d.getElementById("contentFrame") ? P("内容 iframe 存在") : F("iframe 缺失");

  // 🔴 学生端「我的课程」也不能有灰的、点不动的占位项（第 30 轮清掉写死的「操作系统 / 计算机网络」）。
  //    那种项看着像"想删却删不掉"，`page: null` 会被渲染成 .side-item.disabled。
  {
    const sGroup = [...d.querySelectorAll("#shellSide .side-group")]
      .find((g) => /我的课程/.test((g.querySelector("h4 span") || {}).textContent || ""));
    const sItems = sGroup ? [...sGroup.querySelectorAll(".side-item")] : [];
    sItems.length >= 1 && sItems.every((b) => b.dataset.page)
      ? P(`学生端「我的课程」${sItems.length} 项，全部可点`)
      : F("学生端「我的课程」仍有灰显不可点的项: " + sItems.length);
    sGroup && sGroup.querySelectorAll(".side-item.disabled").length === 0
      ? P("学生端侧栏没有「暗的、点不动的」课程了") : F("学生端仍有灰显课程");
    !/操作系统|计算机网络/.test(sGroup ? sGroup.textContent : "")
      ? P("不再有「操作系统 / 计算机网络」这类演示占位") : F("演示占位还在");
  }

  // 无障碍阅读模式勾选：默认勾上 + 状态真的会存下来（功能未实现，只验开关）
  {
    const box = d.getElementById("a11yReadMode");
    if (!box) F("缺少无障碍阅读模式勾选项");
    else {
      P("顶部栏渲染出「无障碍阅读模式」勾选项");
      box.checked === true ? P("默认勾选（初始为开）") : F("默认未勾选");
      const label = d.querySelector('label[for="a11yReadMode"]');
      /无障碍阅读模式/.test(label ? label.textContent : "")
        ? P("勾选项文案为「无障碍阅读模式」") : F("勾选项文案不符");

      // 取消勾选 → 状态落盘
      box.checked = false;
      box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const st = dom.window.localStorage.getItem("st_a11y_read_mode");
      st === "false" || st === false
        ? P("取消勾选后写入 localStorage（读出 " + st + "）")
        : F("取消勾选未持久化，实际: " + st);
      // 勾回来
      box.checked = true;
      box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const st2 = dom.window.localStorage.getItem("st_a11y_read_mode");
      String(st2) === "true" ? P("重新勾选后状态回写为 true") : F("重新勾选未回写: " + st2);

      // 第 57 轮：阅读模式不再是「只记状态」—— 根元素真的挂 / 摘 data-read-mode
      d.documentElement.hasAttribute("data-read-mode")
        ? P("开启时根元素挂 data-read-mode（阅读态真的生效）") : F("未挂 data-read-mode");
      box.checked = false;
      box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      !d.documentElement.hasAttribute("data-read-mode")
        ? P("取消勾选后 data-read-mode 被移除（阅读态真的撤掉）") : F("取消后阅读态没撤掉");
      box.checked = true;
      box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      d.documentElement.hasAttribute("data-read-mode")
        ? P("重新勾选后阅读态恢复") : F("重新勾选未恢复阅读态");
    }
  }
  dom.window.close();
}

console.log("\n=== 2b. 无障碍阅读模式：内容页真的生效（第 57 轮）===");
{
  const dom = load("chat.html", { role: "student" });
  await settle(dom);
  const w = dom.window, d = w.document;
  d.documentElement.hasAttribute("data-read-mode")
    ? P("内容页默认进入阅读态（默认开）") : F("内容页没有阅读态");
  const bar = d.getElementById("readerBar");
  bar ? P("阅读工具条已挂出（#readerBar）") : F("阅读工具条没挂出");
  if (bar) {
    bar.querySelector('[data-rb="read"]') ? P("工具条有「朗读本页」") : F("缺朗读按钮");
    bar.querySelector('[data-rb="stop"]') ? P("工具条有「停止」") : F("缺停止按钮");
    bar.querySelector('[data-rb="minus"]') && bar.querySelector('[data-rb="plus"]')
      ? P("工具条有字号 −＋") : F("缺字号按钮");
    bar.querySelector('[data-rb="off"]') ? P("工具条有「退出」") : F("缺退出按钮");
    // 退出 → 阅读态与工具条一并撤掉
    bar.querySelector('[data-rb="off"]').dispatchEvent(new w.Event("click", { bubbles: true }));
    !d.documentElement.hasAttribute("data-read-mode") && !d.getElementById("readerBar")
      ? P("点「退出」后阅读态与工具条一并撤掉") : F("退出没生效");
  }
  dom.window.close();
}

console.log("\n=== 3. 应用壳（教师身份）===");
{
  const dom = load("app.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const items = d.querySelectorAll("#shellSide .side-item");
  const labels = [...items].map((b) => (b.querySelector(".side-label") || {}).textContent || "");
  labels.includes("出题与组卷") && labels.includes("课程成员")
    ? P("含教师端菜单（出题与组卷 / 课程成员）") : F("教师菜单异常: " + labels.join(","));
  !labels.some((l) => /AI 答疑|课件阅读|我的学情/.test(l))
    ? P("未泄漏学生端菜单") : F("教师侧栏泄漏: " + labels.join(","));
  /教师/.test(d.getElementById("brandRole").textContent) ? P("顶部栏显示教师端") : F("角色标签错误");
  dom.window.close();
}

console.log("\n=== 3a. 侧栏结构：底部用户卡片固定（不被长菜单顶下去）===");
{
  const dom = load("app.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const side = d.querySelector(".shell-side");
  const kids = [...side.children].map((c) => c.className);
  kids.length === 2 && kids[0] === "side-nav" && kids[1] === "side-foot"
    ? P("壳内侧栏只有两块：菜单区 + 底部区")
    : F("侧栏子元素结构不对: " + kids.join(", "));

  const nav = side.querySelector(":scope > .side-nav");
  const foot = side.querySelector(":scope > .side-foot");
  !nav.contains(foot) ? P("底部用户卡片不在滚动区里（不会被菜单滚走）")
    : F("用户卡片被放进了菜单区 —— 会跟着菜单一起滚走");

  const itemsAll = side.querySelectorAll(".side-item").length;
  nav.querySelectorAll(".side-item").length === itemsAll
    ? P("全部 " + itemsAll + " 个菜单项都在滚动区里") : F("有菜单项落在滚动区外");
  nav.querySelectorAll(":scope > .side-group").length === side.querySelectorAll(".side-group").length
    ? P("全部分组都在滚动区里") : F("有分组落在滚动区外");

  foot.querySelector(".side-user-body") ? P("用户卡用 .side-user-body（与 design.css 一致）")
    : F("用户卡类名不对，排版样式会失效");
  foot.querySelector(".side-foot-note") ? P("底部保留「数据保存在本机」说明") : F("缺底部说明");
  dom.window.close();
}

{
  const dom = load("exam.html", { role: "teacher" });        // 独立模式（双击 html）
  await settle(dom);
  const d = dom.window.document;
  const side = d.querySelector(".shell-side");
  const nav = side.querySelector(":scope > .side-nav");
  const foot = side.querySelector(":scope > .side-foot");
  nav && foot && !nav.contains(foot)
    ? P("独立模式侧栏结构同样正确（两处渲染成对维护）")
    : F("独立模式侧栏结构与壳内不一致");
  dom.window.close();
}

console.log("\n=== 3a-2. 课程项的「⋯」不占行内宽度（胶囊与其它菜单项等宽）===");
{
  /* 🔴 上一版把「⋯」做成了 flex 兄弟节点。但 .side-item 是 width:100%，
     兄弟节点会占走 22px + gap → 课程项的 hover/active 胶囊比其它菜单项**短一截**，
     看着像缺了一块。现在「⋯」绝对定位、不参与行内布局。
     jsdom 不做布局，但能从样式表算出级联结果 —— 用它盯死这一点。 */
  const dom = load("app.html", { role: "teacher" });
  await settle(dom);
  const w = dom.window, d = w.document;
  const cs = (el) => w.getComputedStyle(el);

  const more = d.querySelector("#shellSide .side-more");
  more ? P("侧栏渲染出课程项的「⋯」") : F("没有「⋯」");
  if (more) {
    cs(more).position === "absolute"
      ? P("「⋯」是绝对定位（不占行内宽度，胶囊不会被挤窄）")
      : F("「⋯」还在参与行内布局 —— 课程项胶囊会比别的项短: " + cs(more).position);
    cs(more).right !== "auto"
      ? P("「⋯」贴右端（right: " + cs(more).right + "）") : F("「⋯」没有贴右端");
    /translateY/.test(cs(more).transform)
      ? P("「⋯」垂直居中（" + cs(more).transform + "）") : F("「⋯」未垂直居中");
    /* 🔴 第 55 轮改：原来 opacity:0（只有 hover 才浮出来）→ 用户根本找不到
       「编辑 / 删除课程」入口。现在常显、常可点，hover 只负责加深。 */
    cs(more).opacity !== "0" && cs(more).pointerEvents === "auto"
      ? P("「⋯」常显且可点（原来 hover 才出现 —— 入口看不见）")
      : F("「⋯」不可见 / 点不到: opacity=" + cs(more).opacity
          + " pointer-events=" + cs(more).pointerEvents);
  }

  const rowItem = d.querySelector("#shellSide .side-row .side-item");
  const plain = d.querySelector("#shellSide .side-group > .side-item");
  rowItem && plain ? P("侧栏里同时有「课程项」和「普通菜单项」") : F("拿不到对比用的菜单项");

  if (rowItem && plain) {
    cs(rowItem).marginBottom === "0px"
      ? P("行间距移到 .side-row（行高与「⋯」的居中基准一致）")
      : F("课程项还带 margin-bottom，会把「⋯」顶偏: " + cs(rowItem).marginBottom);
    parseInt(cs(rowItem).paddingRight, 10) >= 26
      ? P("课程项右侧给「⋯」留了位（文字不会压到它下面）")
      : F("课程项右侧没留位，文字会和「⋯」重叠: " + cs(rowItem).paddingRight);
    // 关键：课程项与普通项的**可用宽度**必须一致（宽度 + 内边距都对齐）
    cs(rowItem).width === cs(plain).width
      ? P("课程项与普通菜单项同宽（都是 " + cs(rowItem).width + "）—— 胶囊对齐，不再缺一块")
      : F("课程项比普通项窄: " + cs(rowItem).width + " vs " + cs(plain).width);
    cs(plain).paddingRight === "10px" && cs(plain).marginBottom === "2px"
      ? P("普通菜单项的样式没被带偏（padding-right 10px / margin-bottom 2px）")
      : F("普通菜单项样式被改了: " + cs(plain).paddingRight + " / " + cs(plain).marginBottom);
  }

  // 折叠态侧栏只有 58px，不该再给「⋯」留位
  // ⚠️ jsdom 的计算样式**不实现优先级**（后出现的规则直接覆盖先出现的），
  //    所以这里的断言只在「不依赖优先级」时可信 —— 折叠态的右内边距已被
  //    `.collapsed .side-item { padding: 9px 0 }` 归零，与真实浏览器结果一致。
  const side = d.querySelector("#shellSide");
  side.classList.add("collapsed");
  const cur = cs(d.querySelector("#shellSide .side-row .side-item")).paddingRight;
  cur === "0px" ? P("折叠态收起「⋯」的留位（58px 不浪费宽度）")
    : F("折叠态仍留着空位: " + cur);
  side.classList.remove("collapsed");

  dom.window.close();
}

console.log("\n=== 3b. 「我的课程」分组 + 添加课程弹窗（真实 DOM）===");
{
  const dom = load("app.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const w = dom.window;
  const alerts = [];
  w.alert = (m) => alerts.push(String(m));   // jsdom 未实现 alert，接管以断言内容
  // 定位「带加号的那个分组」（不能假定它是第一个分组 —— 前面还有「我的工作」）
  const addBtn = d.getElementById("addCourseBtn");
  addBtn ? P("渲染出加号按钮 #addCourseBtn") : F("未渲染加号按钮");
  const h4 = addBtn ? addBtn.closest("h4") : null;
  h4 ? P("加号确实位于某个分组标题（h4）内") : F("加号不在任何 h4 内");
  if (h4) {
    const title = (h4.querySelector("span") || {}).textContent || "";
    title === "我的课程" ? P("该分组标题为「我的课程」") : F("分组标题: " + title);
    // 真实布局断言：flex + 标题 flex:1 → 加号靠右
    const cs = w.getComputedStyle(h4);
    /flex/.test(cs.display) ? P("分组标题为 flex 布局") : F("分组标题 display=" + cs.display);
    const tspan = h4.querySelector("span");
    const ts = tspan ? w.getComputedStyle(tspan) : null;
    ts && /(^|\s)1(\s|$)|1 1|auto/.test(ts.flex + " " + ts.flexGrow)
      ? P("标题占满剩余宽度（加号被顶到最右）") : F("标题 flex=" + (ts && ts.flex));
  }
  !/我教的课程/.test(d.body.innerHTML) ? P("页面无「我教的课程」旧文案") : F("残留旧文案");

  // 点击加号 → 弹窗出现
  const host = d.getElementById("modalHost");
  addBtn && addBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  const modal = d.querySelector("#modalHost .modal");
  modal ? P("点加号弹出 .modal") : F("点加号未弹窗");
  host && !host.hidden ? P("#modalHost 解除隐藏") : F("#modalHost 仍 hidden");
  d.body.classList.contains("modal-open") ? P("body 加 .modal-open 锁滚动") : F("未锁滚动");
  modal && modal.getAttribute("role") === "dialog" ? P("弹窗 role=dialog") : F("弹窗缺 role");
  modal && modal.getAttribute("aria-modal") === "true" ? P("弹窗 aria-modal=true") : F("缺 aria-modal");
  ["cName", "cCode", "cTerm", "cWeek", "cDesc"].every((id) => d.getElementById(id))
    ? P("弹窗 5 个字段齐全") : F("弹窗字段缺失");
  // 焦点应落到第一个输入框
  d.activeElement && d.activeElement.id === "cName"
    ? P("焦点自动进入课程名称输入框") : info("焦点位置: " + (d.activeElement && d.activeElement.id));

  // 空名称提交 → 报错
  d.getElementById("courseSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  const err = d.getElementById("courseError");
  err && !err.hidden && /课程名称/.test(err.textContent)
    ? P("空课程名提交被拦下并提示") : F("空名称未被拦下");

  // 填好后保存 → 真的建课（不再是示例提示）
  const coursesBefore = w.eval("COURSES.length");
  const navBefore = d.querySelectorAll("#shellSide .side-item").length;
  d.getElementById("cName").value = "编译原理";
  d.getElementById("cCode").value = "CS401";
  d.getElementById("courseSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);

  alerts.length === 0 ? P("保存成功时不再弹 alert（静默落库）") : F("仍弹了提示框: " + JSON.stringify(alerts));
  d.getElementById("modalHost").hidden ? P("保存后弹窗自动关闭") : F("保存后弹窗未关");
  w.eval("COURSES.length") === coursesBefore + 1
    ? P(`COURSES ${coursesBefore} → ${coursesBefore + 1} 条`) : F("课程未加入 COURSES");

  const created = w.eval("COURSES[COURSES.length - 1]");
  created.name === "编译原理" && created.id === "cs401"
    ? P("课程 id 由课程代码生成（cs401）") : F("id 生成异常: " + JSON.stringify(created));
  created.page === "class.html" ? P("新课程可点（page=class.html）") : F("新课程不可点");

  // 侧栏真的多了一项，且指向 ?course=cs401
  const navAfter = d.querySelectorAll("#shellSide .side-item").length;
  navAfter === navBefore + 1 ? P(`侧栏菜单项 ${navBefore} → ${navAfter}`) : F("侧栏没多出课程项");
  const newItem = [...d.querySelectorAll("#shellSide .side-item")]
    .find((b) => b.dataset.page === "class.html?course=cs401");
  newItem ? P("新课程出现在「我的课程」里（data-page=class.html?course=cs401）") : F("找不到新课程菜单项");
  newItem && /编译原理/.test(newItem.textContent) ? P("菜单项显示课程名") : F("菜单项文案不对");
  newItem && newItem.closest(".side-group") &&
  /我的课程/.test(newItem.closest(".side-group").querySelector("h4").textContent)
    ? P("挂在「我的课程」分组下（不是别处）") : F("挂错分组");

  // 落库
  const stored = JSON.parse(w.localStorage.getItem("st_courses") || "null");
  Array.isArray(stored) && stored.some((c) => c.id === "cs401")
    ? P("写入 localStorage 的 st_courses") : F("未持久化: " + JSON.stringify(stored));

  // 点新课程 → 只有它高亮（同页多对象的老问题）
  newItem.dispatchEvent(new w.Event("click", { bubbles: true }));
  const act = [...d.querySelectorAll("#shellSide .side-item.active")];
  act.length === 1 && /cs401/.test(act[0].dataset.page)
    ? P("点新课程后只有它高亮（不与「班级学情」串味）") : F("高亮异常: " + act.map((b) => b.dataset.page).join(","));

  // 同名再建一次要被拦下
  // ⚠️ 上面保存成功后 mountSide() 重渲染过侧栏，最初那个 addBtn 已经脱链 ——
  //    必须重新取（虽然监听器还在老节点上能凑合点动，但那是运气不是设计）
  const addBtn2 = d.getElementById("addCourseBtn");
  addBtn2.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.getElementById("cName").value = "编译原理";
  d.getElementById("courseSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const dupErr = d.getElementById("courseError");
  dupErr && !dupErr.hidden && /同名/.test(dupErr.textContent)
    ? P("重复课程名被拦下并提示") : F("同名课程未被拦下");
  w.eval("COURSES.length") === coursesBefore + 1
    ? P("被拦下时不落库") : F("被拦下却加了课程");

  // ✕ 关闭
  const x = d.querySelector("#modalHost .modal-x");
  x && x.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.getElementById("modalHost").hidden ? P("点 ✕ 关闭弹窗") : F("✕ 未关闭");
  !d.body.classList.contains("modal-open") ? P("关闭后解除滚动锁") : F("滚动锁未解除");

  // Esc 关闭（重新打开再按 Esc）
  d.getElementById("addCourseBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  d.querySelector("#modalHost .modal") ? P("可再次打开弹窗") : F("二次打开失败");
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  d.getElementById("modalHost").hidden ? P("按 Esc 关闭弹窗") : F("Esc 未关闭");

  dom.window.close();
}

console.log("\n=== 3b-2. 课程项的「⋯」：编辑信息 / 删除 ===");
{
  const custom = JSON.stringify([
    { id: "ds", name: "数据结构与算法", page: "class.html" },
    { id: "cs401", name: "编译原理", code: "CS401", term: "2026 秋季", page: "class.html" },
  ]);
  const syl = JSON.stringify({ cs401: { courseId: "cs401", goal: "", chapters: [
    { id: "cs401-c1", title: "第 1 章 · 引论", hours: 2, points: "", lessonIds: ["cs401-c1-1"] }] } });
  const lsn = JSON.stringify({ "cs401-c1-1": { id: "cs401-c1-1", courseId: "cs401",
    chapterId: "cs401-c1", title: "第 1 章 · 第 1 课时：引论", minutes: 45, status: "draft", head: 0,
    commits: [{ id: "v1", kind: "init", msg: "新建课时教案", snap: {} }] } });

  const dom = load("app.html", { role: "teacher",
    restore: { ls: { st_courses: custom, st_syllabus: syl, st_lessons: lsn } } });
  const w = dom.window, d = w.document;
  await settle(dom);
  w.confirm = () => true;
  w.alert = () => {};

  const group = () => [...d.querySelectorAll("#shellSide .side-group")]
    .find((g) => /我的课程/.test(g.querySelector("h4 span").textContent));

  const rows = [...group().querySelectorAll(".side-row")];
  const moreBtns = [...group().querySelectorAll(".side-more")];
  moreBtns.length === rows.length && moreBtns.length === 2
    ? P("每门课都带一个「⋯」（" + moreBtns.length + " 个）") : F("「⋯」数量不对: " + moreBtns.length);
  group().querySelectorAll(".side-item button").length === 0
    ? P("「⋯」放在 .side-item 外面（没有 button 嵌 button 破坏结构）") : F("出现了按钮嵌套");
  group().querySelectorAll(".side-item.disabled").length === 0
    ? P("侧栏里没有「暗的、点不动的」课程了") : F("仍有灰显不可点的课程");

  const csBtn = moreBtns.find((b) => b.dataset.more === "cs401");
  csBtn ? P("「⋯」带着课程 id（data-more）") : F("「⋯」没有绑定课程 id");

  /* --- 展开 / 收起 --- */
  csBtn.click();
  await settle(dom);
  const menu = d.getElementById("sideMenu");
  menu ? P("点「⋯」弹出课程菜单") : F("菜单没出现");
  menu && /编辑课程信息/.test(menu.textContent) ? P("菜单含「编辑课程信息」") : F("缺编辑项");
  menu && /删除课程/.test(menu.textContent) ? P("菜单含「删除课程」") : F("缺删除项");
  csBtn.getAttribute("aria-expanded") === "true" ? P("按钮标记为展开态") : F("aria-expanded 没更新");
  menu && menu.parentNode === d.body
    ? P("菜单挂在 body 上（侧栏 overflow:hidden 会把它裁掉）") : F("菜单挂错地方，会被裁掉");

  csBtn.click();
  await settle(dom);
  !d.getElementById("sideMenu") ? P("再点一次收起菜单") : F("菜单没收起");

  csBtn.click();
  await settle(dom);
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle(dom);
  !d.getElementById("sideMenu") ? P("Esc 能关掉菜单") : F("Esc 没关掉");

  /* --- 编辑信息 --- */
  csBtn.click();
  await settle(dom);
  d.querySelector('#sideMenu [data-act="edit"]').click();
  await settle(dom);
  const h = d.getElementById("modalHost");
  h.querySelector(".modal") ? P("点「编辑课程信息」弹出表单") : F("表单没出现");
  /编辑课程信息/.test(h.querySelector("#modalTitle").textContent)
    ? P("弹窗标题是「编辑课程信息」") : F("标题不对");
  h.querySelector("#cName").value === "编译原理"
    ? P("表单预填了当前课程名") : F("没预填: " + h.querySelector("#cName").value);
  h.querySelector("#cCode").value === "CS401" ? P("课程代码也预填了") : F("代码没预填");

  // 改成与已有课程重名 → 拦下
  h.querySelector("#cName").value = "数据结构与算法";
  h.querySelector("#courseSave").click();
  await settle(dom);
  (h.querySelector(".modal") && !h.querySelector("#courseError").hidden)
    ? P("改成已有课程名会被拦下（弹窗不关）") : F("重名没被拦");

  h.querySelector("#cName").value = "编译原理（改）";
  h.querySelector("#courseSave").click();
  await settle(dom);
  w.COURSES.find((c) => c.id === "cs401").name === "编译原理（改）"
    ? P("改课程信息生效（数据已更新）") : F("数据没改到");
  [...group().querySelectorAll(".side-item")].some((b) => /编译原理（改）/.test(b.textContent))
    ? P("侧栏上的名字跟着更新") : F("侧栏没更新");
  d.getElementById("modalHost").hidden ? P("保存后弹窗关闭") : F("弹窗没关");
  /编译原理（改）/.test(String(w.localStorage.getItem("st_courses") || ""))
    ? P("改动已落库") : F("没落库");

  /* --- 删除：先取消 --- */
  w.confirm = () => false;
  const findMore = () => [...group().querySelectorAll(".side-more")].find((b) => b.dataset.more === "cs401");
  findMore().click();
  await settle(dom);
  d.querySelector('#sideMenu [data-act="delete"]').click();
  await settle(dom);
  w.COURSES.some((c) => c.id === "cs401") ? P("确认框点「取消」不会删除课程") : F("取消了还是删了");

  /* --- 删除：确认（连带删掉该课程的教案）--- */
  let confirmText = "";
  w.confirm = (msg) => { confirmText = String(msg); return true; };
  findMore().click();
  await settle(dom);
  d.querySelector('#sideMenu [data-act="delete"]').click();
  await settle(dom);

  /删除后无法撤销/.test(confirmText) ? P("确认框讲明了不可撤销") : F("确认框没提后果");
  /教案会一起删除/.test(confirmText)
    ? P("确认框讲清了会连带删掉多少教案") : F("确认框没提教案: " + confirmText);
  !w.COURSES.some((c) => c.id === "cs401") ? P("删除课程生效") : F("课程没删掉");
  w.SYLLABUS.cs401 === undefined ? P("该课程的教案大纲一起删除（不留孤儿数据）") : F("教案大纲残留");
  Object.values(w.LESSONS).every((l) => l.courseId !== "cs401")
    ? P("该课程的课时教案一起删除") : F("课时教案残留");
  ![...group().querySelectorAll(".side-item")].some((b) => /编译原理/.test(b.textContent))
    ? P("侧栏里这一项也消失了") : F("侧栏还留着");
  !/编译原理/.test(String(w.localStorage.getItem("st_courses") || ""))
    ? P("删除已落库") : F("删除没落库");
  dom.window.close();
}

console.log("\n=== 3b-3. 课程表单：学期 / 周次可自由输入（候选只是建议，不是限制）===");
{
  /* 用户原话：「这个开课时间和上课周次不应该可以自己选吗，给几个固定的其他情况怎么办？」
     所以这两个字段从 <select> 改成**普通输入框 + datalist 候选**：
     常用写法一点就有，暑假小学期 / 集中实践周 / 随到随学也能照填。 */
  const dom = load("app.html", { role: "teacher" });
  const w = dom.window, d = w.document;
  await settle(dom);
  w.confirm = () => true;
  w.alert = () => {};

  /* --- 1. 纯函数：候选随当前日期走，且日期可注入 --- */
  const T = w.termSuggestions;
  typeof T === "function" ? P("nav.js 提供 termSuggestions()") : F("缺 termSuggestions");
  if (typeof T === "function") {
    T(new Date(2026, 9, 1)).join("|") === "2026 秋季|2027 春季|2027 秋季"
      ? P("10 月 → 2026 秋季 / 2027 春季 / 2027 秋季")
      : F("秋季候选不对: " + T(new Date(2026, 9, 1)));
    T(new Date(2026, 2, 1)).join("|") === "2026 春季|2026 秋季|2027 春季"
      ? P("3 月 → 2026 春季 / 2026 秋季 / 2027 春季")
      : F("春季候选不对: " + T(new Date(2026, 2, 1)));
    /春季$/.test(T(new Date(2026, 6, 15))[0]) && /秋季$/.test(T(new Date(2026, 7, 1))[0])
      ? P("7 月算春季学期、8 月起算秋季（分界正确）")
      : F("春秋分界不对");
    T(null).length === 3 && T().length === 3 ? P("不传 / 传 null 都回落当前日期，不炸") : F("空参数处理不对");
    /typeof now\.getFullYear === "function"/.test(
      fs.readFileSync(path.join(SITE, "assets", "nav.js"), "utf8"))
      ? P("用鸭子类型判断日期（不用 instanceof Date —— 跨 realm 会失效）")
      : F("日期类型判断方式有跨 realm 风险");
  }
  Array.isArray(w.COURSE_WEEKS) && w.COURSE_WEEKS.includes("集中实践周")
    ? P("周次候选含非整周的情形（集中实践周）") : F("周次候选不全: " + w.COURSE_WEEKS);

  /* --- 2. 表单控件形态：输入框，不是下拉 --- */
  w.localStorage.setItem("st_current_user", "teacher:zhangsan");
  w.COURSES.length = 0;
  w.refreshCourseNav();

  d.getElementById("addCourseBtn").click();
  await settle(dom);
  const h = d.getElementById("modalHost");
  h.querySelector("#cTerm").tagName === "INPUT" && h.querySelector("#cWeek").tagName === "INPUT"
    ? P("「开课学期」「上课周次」是输入框（不再是固定下拉）")
    : F("控件类型不对: " + h.querySelector("#cTerm").tagName + "/" + h.querySelector("#cWeek").tagName);
  h.querySelectorAll("select").length === 0
    ? P("表单里已无 select —— 不存在「只有几个选项」的限制") : F("仍有下拉控件");
  h.querySelector("#cTerm").getAttribute("list") === "cTermList"
    ? P("输入框挂了候选列表（list=cTermList）") : F("没有关联候选列表");
  d.getElementById("cTermList") && d.getElementById("cWeekList")
    ? P("页面里有 #cTermList / #cWeekList 两个 datalist") : F("缺 datalist");
  const termOpts = [...d.querySelectorAll("#cTermList option")].map((o) => o.value);
  termOpts.length === 3 && termOpts[0] === T()[0]
    ? P("学期候选是现算的（" + termOpts.join(" / ") + "），年份不会写死过期")
    : F("学期候选不对: " + termOpts);
  [...d.querySelectorAll("#cWeekList option")].length >= 5
    ? P("周次候选 " + [...d.querySelectorAll("#cWeekList option")].length + " 个")
    : F("周次候选太少");
  /学期与周次/.test(h.textContent)
    ? F("课程表单里还留着那段说明条（用户要求删掉）")
    : P("已删掉课程表单的说明条");
  /2026 秋季/.test(h.querySelector("#cTerm").placeholder)
    ? P("靠占位文案提示可用写法（不额外占版面）")
    : F("占位文案没提示可用写法: " + h.querySelector("#cTerm").placeholder);

  /* --- 3. 候选外的写法必须原样收下 --- */
  h.querySelector("#cName").value = "编译原理";
  h.querySelector("#cCode").value = "CS401";
  h.querySelector("#cTerm").value = "2027 夏季";
  h.querySelector("#cWeek").value = "3–9 周";
  h.querySelector("#courseSave").click();
  await settle(dom);

  const c = w.COURSES.find((x) => x.name === "编译原理");
  c && c.term === "2027 夏季" ? P("候选外的学期（2027 夏季）被原样保存") : F("学期被改写: " + (c && c.term));
  c && c.weeks === "3–9 周" ? P("候选外的周次（3–9 周）被原样保存") : F("周次被改写: " + (c && c.weeks));
  /2027 夏季/.test(String(w.localStorage.getItem("st_courses:teacher:zhangsan") || ""))
    ? P("自定义值已落库") : F("没落库");

  /* --- 4. 编辑：预填原值，且能改成任意写法、也能清空 --- */
  w.openEditCourse("cs401");
  await settle(dom);
  const h2 = d.getElementById("modalHost");
  h2.querySelector("#cTerm").value === "2027 夏季" && h2.querySelector("#cWeek").value === "3–9 周"
    ? P("编辑时两个字段都预填了原值（不是回到第一个候选）")
    : F("预填不对: " + h2.querySelector("#cTerm").value + " / " + h2.querySelector("#cWeek").value);
  h2.querySelector("#cTerm").value = "";
  h2.querySelector("#cWeek").value = "随到随学";
  h2.querySelector("#courseSave").click();
  await settle(dom);
  w.COURSES.find((x) => x.id === "cs401").weeks === "随到随学"
    ? P("周次可填完全自定义的写法（随到随学）") : F("自定义周次没保存");
  w.COURSES.find((x) => x.id === "cs401").term === ""
    ? P("学期可清空，且不会回落成第一个候选（不替用户填数据）") : F("清空后又被填上了");

  /* --- 5. 独立模式（双击 html）同样改到位 --- */
  const dom2 = load("lesson.html", { role: "teacher" });
  const w2 = dom2.window, d2 = w2.document;
  await settle(dom2);
  w2.localStorage.setItem("st_current_user", "teacher:zhangsan");
  d2.getElementById("addCourseBtn").click();
  await settle(dom2);
  const h3 = d2.getElementById("modalHost");
  h3.querySelector("#cTerm").tagName === "INPUT" && d2.getElementById("cTermList")
    ? P("独立模式课程表单同样是输入框 + datalist（两处成对）")
    : F("独立模式没同步改到");
  h3.querySelector("#cName").value = "离散数学";
  h3.querySelector("#cTerm").value = "2027 春季";
  h3.querySelector("#cWeek").value = "双周";
  h3.querySelector("#courseSave").click();
  await settle(dom2);
  const c2 = w2.COURSES.find((x) => x.name === "离散数学");
  c2 && c2.term === "2027 春季" && c2.weeks === "双周"
    ? P("独立模式保存自定义值成功") : F("独立模式保存失败: " + JSON.stringify(c2));

  dom.window.close();
  dom2.window.close();
}

console.log("\n=== 3c. 独立模式下教师端侧栏同样有加号 ===");
{
  const dom = load("exam.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const addBtn = d.getElementById("addCourseBtn");
  addBtn ? P("独立模式渲染出加号按钮") : F("独立模式缺加号按钮");
  /我的课程/.test(d.body.innerHTML) ? P("独立模式分组标题为「我的课程」") : F("独立模式标题错误");
  addBtn && addBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  d.querySelector("#modalHost .modal")
    ? P("独立模式点加号能弹出弹窗") : F("独立模式弹窗未出现");
  // 独立模式下弹窗挂载点要按需创建
  d.getElementById("modalHost") ? P("独立模式按需创建 #modalHost") : F("独立模式缺挂载点");
  dom.window.close();
}

console.log("\n=== 3c-2. 独立模式下班级管理同样存在且能加班级 ===");
{
  const dom = load("exam.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const w = dom.window;
  const alerts = [];
  w.alert = (m) => alerts.push(String(m));

  // 独立模式与壳内是两套渲染代码，必须成对维护 —— 这里单独验一遍
  /班级管理/.test(d.body.innerHTML) ? P("独立模式侧栏含「班级管理」分组") : F("独立模式缺「班级管理」");
  const classBtn = d.getElementById("addClassBtn");
  classBtn ? P("独立模式渲染出添加班级加号 #addClassBtn") : F("独立模式缺 #addClassBtn");
  const classItems = [...d.querySelectorAll(".side-item")]
    .filter((b) => /^class\.html\?cls=/.test(b.dataset.page || ""));
  classItems.length >= 2 ? P(`独立模式渲染出 ${classItems.length} 个班级项`) : F("独立模式班级项过少");

  classBtn && classBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.querySelector("#modalHost .modal") ? P("独立模式点班级加号能弹窗") : F("独立模式班级弹窗未出现");
  d.getElementById("kName") ? P("独立模式班级弹窗字段齐全") : F("独立模式班级弹窗字段缺失");
  // 独立模式下挂载点也是按需创建的
  d.getElementById("modalHost") ? P("独立模式按需创建弹窗挂载点") : F("独立模式缺挂载点");
  // Esc 必须关掉的是班级弹窗（两个弹窗共用 modalEsc，靠内容分发）
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  d.getElementById("modalHost").hidden ? P("独立模式 Esc 关闭班级弹窗") : F("独立模式 Esc 未关闭");
  void alerts;
  dom.window.close();
}

console.log("\n=== 3c-3. 「班级管理」分组：多班 + 添加班级弹窗（真实 DOM）===");
{
  const dom = load("app.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const w = dom.window;
  const alerts = [];
  w.alert = (m) => alerts.push(String(m));

  /* --- 分组位置：必须在「智能体」之上 --- */
  const titles = [...d.querySelectorAll("#shellSide .side-group")]
    .map((g) => (g.querySelector("h4 span") || {}).textContent || "");
  const ki = titles.indexOf("班级管理");
  const ai = titles.indexOf("智能体");
  ki >= 0 ? P("侧栏渲染出「班级管理」分组") : F("侧栏缺「班级管理」分组，实际: " + titles.join("|"));
  ki >= 0 && ai >= 0 && ki < ai
    ? P("「班级管理」位于「智能体」之上") : F(`分组顺序错误：班级管理@${ki} 智能体@${ai}`);

  /* --- 多个班级选项，且每项都带对象参数 --- */
  const classItems = [...d.querySelectorAll("#shellSide .side-item")]
    .filter((b) => /^class\.html\?cls=/.test(b.dataset.page || ""));
  classItems.length >= 2
    ? P(`渲染出 ${classItems.length} 个班级选项`) : F("班级选项过少: " + classItems.length);
  const labels = classItems.map((b) => (b.querySelector(".side-label") || {}).textContent || "");
  labels.every(Boolean) ? P("班级项都有名称: " + labels.join(" / ")) : F("班级项缺名称");
  classItems.every((b) => !b.classList.contains("disabled"))
    ? P("班级项均可点击（非灰显占位）") : F("班级项被渲染为禁用");
  classItems.every((b) => !b.querySelector(".side-badge"))
    ? P("班级项不再挂「N 人」徽标（第 33 轮：那是编造的在册人数）")
    : F("班级项还挂着编造的人数徽标");

  /* --- 点某个班 → 只有它高亮（同页多对象的关键）--- */
  const first = classItems[0];
  const firstPage = first.dataset.page;
  first.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.getElementById("contentFrame").getAttribute("src") === firstPage
    ? P("点班级项后 iframe.src = " + firstPage) : F("iframe 未带上对象参数: " + d.getElementById("contentFrame").getAttribute("src"));
  w.location.hash.includes("?cls=")
    ? P("URL hash 同步带上对象参数") : F("hash 丢参数: " + w.location.hash);
  const actives = [...d.querySelectorAll("#shellSide .side-item.active")];
  actives.length === 1
    ? P("同一时刻只有 1 个菜单项高亮（班级高亮不互相串）")
    : F("高亮项数量异常: " + actives.length + "（" + actives.map((b) => b.dataset.page).join(",") + "）");
  actives[0] === first ? P("高亮的正是被点的那个班") : F("高亮的不是被点的项");

  /* --- 再点另一个班 → 高亮转移，仍只有一个 --- */
  const second = classItems[1];
  second.dispatchEvent(new w.Event("click", { bubbles: true }));
  const actives2 = [...d.querySelectorAll("#shellSide .side-item.active")];
  actives2.length === 1 && actives2[0] === second
    ? P("切换到另一个班后高亮正确转移（仍唯一）")
    : F("切换班级后高亮异常: " + actives2.map((b) => b.dataset.page).join(","));

  /* --- 整块重渲染侧栏后高亮不能丢（曾因 mountSide 里 normalize 掉参数而失效）--- */
  w.mountSide();
  const afterRemount = [...d.querySelectorAll("#shellSide .side-item.active")];
  afterRemount.length === 1 && afterRemount[0].dataset.page === second.dataset.page
    ? P("重渲染侧栏后班级高亮仍在（here 未剥掉对象参数）")
    : F("重渲染侧栏后高亮丢失/错位: " +
        afterRemount.map((b) => b.dataset.page).join(",") || "无");
  // 重渲染会重建节点，后续断言要重新取
  const classItems2 = [...d.querySelectorAll("#shellSide .side-item")]
    .filter((b) => /^class\.html\?cls=/.test(b.dataset.page || ""));
  classItems2.length >= 2 ? P("重渲染后班级项仍齐全") : F("重渲染后班级项丢失");

  /* --- 加号：与课程加号并存，且打开的是班级弹窗 --- */
  const classBtn = d.getElementById("addClassBtn");
  classBtn ? P("渲染出添加班级加号 #addClassBtn") : F("未渲染 #addClassBtn");
  d.getElementById("addCourseBtn") ? P("课程加号仍并存（两个加号互不覆盖）") : F("课程加号被覆盖");
  if (classBtn) {
    const h4 = classBtn.closest("h4");
    const t = h4 ? (h4.querySelector("span") || {}).textContent : "";
    t === "班级管理" ? P("班级加号位于「班级管理」的 h4 内") : F("班级加号所在分组: " + t);
    const cs = w.getComputedStyle(h4);
    /flex/.test(cs.display) ? P("班级分组标题同样为 flex（加号靠右）") : F("班级 h4 display=" + cs.display);
  }

  classBtn && classBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  const modal = d.querySelector("#modalHost .modal");
  modal ? P("点班级加号弹出弹窗") : F("点班级加号未弹窗");
  /添加班级/.test((d.getElementById("modalTitle") || {}).textContent || "")
    ? P("弹窗标题为「添加班级」") : F("弹窗标题不对");
  ["kName", "kMajor", "kGrade", "kCourse", "kCount"].every((id) => d.getElementById(id))
    ? P("班级弹窗 5 个字段齐全") : F("班级弹窗字段缺失");
  modal && modal.getAttribute("role") === "dialog" ? P("班级弹窗 role=dialog") : F("班级弹窗缺 role");

  // 空名称提交 → 报错
  d.getElementById("classSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  const err = d.getElementById("classError");
  err && !err.hidden && /班级名称/.test(err.textContent)
    ? P("空班级名提交被拦下并提示") : F("空班级名未被拦下");

  // 填好后提交 → **真的建班** + 侧栏立刻出现（第 55 轮）
  const clsItems = () => [...d.querySelectorAll("#shellSide .side-item")]
    .filter((b) => /^class\.html\?cls=/.test(b.dataset.page || ""));
  const clsBefore = clsItems().length;
  d.getElementById("kName").value = "计科 2303 班";
  d.getElementById("kCount").value = "42";
  d.getElementById("classSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  alerts.length === 0
    ? P("建班不再弹「保存逻辑未接入」示例提示") : F("还在弹示例提示: " + JSON.stringify(alerts));
  clsItems().length === clsBefore + 1
    ? P("新班级立刻出现在侧栏「班级管理」里（" + clsBefore + " → " + clsItems().length + "）")
    : F("侧栏没出现新班: " + clsBefore + " → " + clsItems().length);
  const newCls = w.CLASSES[w.CLASSES.length - 1];
  newCls.label === "计科 2303 班" ? P("新班级名称落库正确") : F("名称不对: " + newCls.label);
  newCls.count === 42 ? P("学生人数也存了（额定人数）") : F("人数没存: " + newCls.count);
  /计科 2303 班/.test(String(w.localStorage.getItem(w.eval("classStoreKey()")) || ""))
    ? P("写进了按账号分桶的存档") : F("没落库");

  // Esc 关闭 —— 两个弹窗共用 modalEsc，必须分发到班级那个
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  d.getElementById("modalHost").hidden ? P("按 Esc 关闭班级弹窗") : F("Esc 未关闭班级弹窗");
  // 关完再开课程弹窗 → Esc 仍要能关（证明分发不是写死班级）
  d.getElementById("addCourseBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  d.querySelector("#modalHost .modal") ? P("课程弹窗仍可正常打开") : F("课程弹窗打不开");
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  d.getElementById("modalHost").hidden ? P("Esc 对课程弹窗同样有效（分发正确）") : F("课程弹窗 Esc 失效");

  dom.window.close();
}

console.log("\n=== 3c-4. class.html（课程成员）：真实的「谁在课里」===");
{
  /* 🔴 这一节守的是第 33 轮的核心诉求：「不要假数据，要真的看谁在课程里列出来」。
     做法：本机账号库里 role=student 的账号 × 他们自己的选课桶（st_enroll:student:<账号>）。 */

  /** 造一个「本机有 N 个学生 + 各自的选课记录」的环境 */
  const accounts = JSON.stringify([
    { role: "teacher", user: "teacher", pass: "x", name: "李老师", createdAt: 1 },
    { role: "student", user: "zhangsan", pass: "x", name: "张三", createdAt: 1780000000000 },
    { role: "student", user: "lisi", pass: "x", name: "李四", createdAt: 1780100000000 },
    { role: "student", user: "wangwu", pass: "x", name: "王五", createdAt: 1780200000000 },
  ]);
  const zsEnroll = JSON.stringify([
    { courseId: "ds", name: "数据结构与算法", code: "CS201", joinCode: "CS201-22DT", by: "李老师", at: 1780300000000 },
  ]);
  const lsEnroll = JSON.stringify([
    { courseId: "cs401", name: "编译原理", code: "CS401", joinCode: "CS401-UB7G", by: "李老师", at: 1780400000000 },
  ]);

  /* 本机有两门课：ds（张三在课里）、cs999（一个人都没有 —— 用来验空状态） */
  const courseList = JSON.stringify([
    { id: "ds", name: "数据结构与算法", code: "CS201", page: "class.html" },
    { id: "cs999", name: "还没人选的课", code: "CS999", page: "class.html" },
  ]);

  const open = async (q) => {
    const dom = load("class.html", {
      role: "teacher", query: q,
      restore: { ls: {
        st_courses: courseList,
        st_accounts: accounts,
        "st_enroll:student:zhangsan": zsEnroll,
        "st_enroll:student:lisi": lsEnroll,
        // 王五没选课 —— 应该出现在「还没进来」名单里
      } },
    });
    await settle(dom);
    return dom;
  };

  const dom = await open("?course=ds");
  const w = dom.window, d = w.document;
  w.confirm = () => true;
  w.alert = () => {};

  /* ---------- ⓪ 通往本课教案的入口（第 55 轮：把「人 → 课 → 教案」接上） ---------- */
  {
    const gl = d.getElementById("goLesson");
    gl ? P("课程成员页有「看这门课的教案」按钮") : F("缺 #goLesson 教案入口");
    d.getElementById("courseLinks") && !d.getElementById("courseLinks").hidden
      ? P("「这门课的其他页面」卡片在课程视角下显示") : F("教案入口卡片被隐藏了");
    if (gl) {
      let navTo = "";
      const orig = w.navigate;
      w.navigate = (p) => { navTo = p; };
      gl.dispatchEvent(new w.Event("click", { bubbles: true }));
      navTo === "lesson.html?course=ds"
        ? P("点它带着课程跳到教案页（lesson.html?course=ds）") : F("跳转目标不对: " + navTo);
      w.navigate = orig;
    }
  }

  /* ---------- ① 名单只有真加入的人 ---------- */
  const rows = [...d.querySelectorAll("#stuRows tr")];
  const rowText = (tr) => tr.textContent.replace(/\s+/g, " ").trim();
  rows.length === 1 && /张三/.test(rowText(rows[0]))
    ? P("在课名单只有真加入了这门课的人（张三）") : F("名单不对: " + rows.map(rowText).join(" | "));
  !/李四|王五/.test(d.getElementById("stuRows").textContent)
    ? P("没加入的学生不会出现在名单里（李四去的是编译原理）") : F("把没加入的学生也列进来了");
  // ⚠️ 只能扫 .page（可见区域）：`body.textContent` **包含 <script> 的文本**，
  //    页内注释里提到旧实现就会被误判成"还在展示"。
  !/其余 \d+ 名同学|平均掌握度|李同学|张同学/.test(d.querySelector(".page").textContent)
    ? P("旧版那套编造的学生（李同学/张同学/其余 N 名）已彻底消失")
    : F("还能看到旧的编造名单");

  /* ---------- ② 统计卡都是真实数字 ---------- */
  d.getElementById("stIn").textContent === "1"
    ? P("在课学生 = 1（真实）") : F("在课学生不对: " + d.getElementById("stIn").textContent);
  d.getElementById("stTotal").textContent === "3"
    ? P("本机学生账号 = 3（真实，来自账号库）") : F("学生账号数不对: " + d.getElementById("stTotal").textContent);
  d.getElementById("stMissing").textContent === "2"
    ? P("还没加入本课 = 2（李四 + 王五）") : F("未加入数不对: " + d.getElementById("stMissing").textContent);
  !/^—$/.test(d.getElementById("stLast").textContent)
    ? P("最近加入有值: " + d.getElementById("stLast").textContent) : F("最近加入没算出来");

  /* ---------- ③ 表头/表体都是真实字段，没有编造指标 ---------- */
  const heads = [...d.querySelectorAll("thead th")].map((t) => t.textContent.trim());
  heads.join("/") === "学生/账号/加入时间/加入用的邀请码/近期活跃/操作"
    ? P("表头是真实字段：" + heads.join(" / ")) : F("表头不对: " + heads.join("/"));
  /CS201-22DT/.test(rowText(rows[0]))
    ? P("行里记着他用的邀请码（与学生端输入的那个一致）") : F("行里没有邀请码: " + rowText(rows[0]));
  /zhangsan/.test(rowText(rows[0])) ? P("行里带着账号") : F("行里没有账号");
  !/掌握度|正确率|平均分|%/.test(d.getElementById("stuRows").textContent)
    ? P("名单里没有任何编造的指标（掌握度 / 正确率 / 平均分 / 百分比）")
    : F("名单里还在展示编造指标");
  /没有真实来源|不显示/.test(d.getElementById("rosterNote").textContent)
    ? P("说明里如实交代了「这些指标没有来源，所以不显示」") : F("没交代数据边界");

  /* ---------- ④ 底部不再有「演示数据（DEMO）」说明块 ---------- */
  !/演示数据/.test(d.querySelector(".page").textContent)
    ? P("底部那块「演示数据（DEMO）」说明已移除（用户要求）") : F("声明块还在");

  /* ---------- ⑤ 邀请码 + 「还没进来」名单 ---------- */
  // ⚠️ joinCodeOf 在**页面**的作用域里（nav.js），要用 w.eval 取，不能在 Node 里直接调
  d.getElementById("courseCode").textContent === w.eval("joinCodeOf({ id: 'ds', code: 'CS201' })")
    ? P("邀请码卡显示的就是 joinCodeOf(课程)") : F("邀请码不对: " + d.getElementById("courseCode").textContent);
  const missBox = d.getElementById("missingBox").textContent;
  /李四/.test(missBox) && /王五/.test(missBox)
    ? P("「还没进来」列出另外两个学生账号（可直接把码发给他们）")
    : F("未加入名单不对: " + missBox);
  /2 个学生账号/.test(missBox) ? P("未加入人数写成可读的话") : F("未加入人数文案不对");

  /* ---------- ⑥ 点学生姓名 → 个人详情（真实字段） ---------- */
  d.querySelector("#stuRows .link-btn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const host = d.getElementById("modalHost");
  host && !host.hidden ? P("点学生姓名弹出个人详情") : F("详情弹窗没出现");
  const mt = host.textContent.replace(/\s+/g, " ");
  /张三/.test(mt) && /zhangsan/.test(mt) ? P("详情里有姓名与账号") : F("详情缺姓名/账号");
  /CS201-22DT/.test(mt) ? P("详情里写明他是用哪张邀请码进来的") : F("详情没写邀请码");
  /数据结构与算法/.test(mt) ? P("详情里列出他加入的课堂") : F("详情没列课堂");
  /没有真实来源|没有服务端|不显示/.test(mt)
    ? P("详情如实说明学习数据（掌握度/作业）在本版没有来源，而不是编一个")
    : F("详情没说明数据边界");
  host.querySelector("[data-close]").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);

  /* ---------- ⑦ 一个人都没加入 → 空状态，不编造 ---------- */
  dom.window.close();
  const empty = await open("?course=cs999");
  const ed = empty.window.document;
  ed.querySelectorAll("#stuRows tr").length === 1 && /本机还没有学生加入这门课/.test(ed.getElementById("stuRows").textContent)
    ? P("没人加入时给空状态（不拿样本学生冒充）") : F("空状态不对");
  ed.getElementById("stIn").textContent === "0" ? P("在课学生如实为 0") : F("在课学生不是 0");
  empty.window.close();

  /* ---------- ⑧ ?cls= 视角：班级不编人数，只指向关联课程 ---------- */
  const cls = await open("?cls=cs2301");
  const cd = cls.window.document;
  /计科 2301 班/.test(cd.getElementById("crumbText").textContent)
    ? P("?cls=cs2301 → 面包屑显示班级") : F("班级面包屑不对");
  // ⚠️ 只扫 .page（可见区域）——inlineAssets 会把 nav.js/core.js 内联进 body，
  //    源码里的 `count: 48` 会被误判成"页面在展示人数"。
  !/48|45|52/.test(cd.querySelector(".page").textContent)
    ? P("页面里不再出现编造的班级人数（48/45/52）") : F("还能看到编造的班级人数");
  /班级在册名单与在册人数需要教务系统/.test(cd.getElementById("classCard").textContent)
    ? P("如实说明班级花名册需要教务系统（不编）") : F("没说明班级数据的边界");
  !cd.getElementById("classCard").hidden ? P("班级视角显示班级信息卡") : F("班级卡没显示");
  cls.window.close();

  /* ---------- ⑨ 非法 / 缺省参数都不能炸 ---------- */
  const fallback = await open("");
  const fd = fallback.window.document;
  fd.getElementById("crumbText").textContent
    ? P("不带参数时正常渲染: " + fd.getElementById("crumbText").textContent.trim())
    : F("无参数渲染异常");
  fallback.window.close();
  const bad = await open("?cls=not-exist&course=not-exist");
  bad.window.document.getElementById("crumbText").textContent
    ? P("非法参数安全回落，不报错") : F("非法参数渲染异常");
  bad.window.close();
}
console.log("\n=== 3c-5. 学情：学生自己看到的 == 老师点开学生看到的（同一份记录）===");
{
  /* 🔴 第 34 轮的核心不变量。用户原话：「点开看详细信息就是学生自己看详细信息的那个图表」。
     所以两边必须读同一份本机记录、用同一组聚合函数 —— 这里就用**同一个局**分别打开
     两个页面，把同一个数字抠出来对比。两边各算一套的话，这条断言立刻红。 */

  const D = 86400000;
  const now = Date.now();
  /** 张三的行为日志：提问 4（图 ×2 / 排序 ×2）、标记懂了 1、批注 2、阅读 1 → 共 8 条，都在 3 天内 */
  const beh = JSON.stringify([
    { kind: "ask",  label: "图的最短路径适用条件", at: now - 1 * D },
    { kind: "ask",  label: "图为什么不能有负权边", at: now - 1 * D + 60000 },
    { kind: "ask",  label: "快速排序怎么划分",     at: now - 2 * D },
    { kind: "ask",  label: "排序稳定性怎么判断",   at: now - 2 * D + 60000 },
    { kind: "got",  label: "排序稳定性",           at: now - 2 * D + 90000 },
    { kind: "note", label: "三路划分处理重复元素", at: now - 3 * D, seg: 6 },
    { kind: "note", label: "随机化 pivot 与洗牌",  at: now - 3 * D + 60000, seg: 4 },
    { kind: "read", label: "第 1 段",              at: now - 3 * D + 120000, seg: 1 },
  ]);
  const accounts = JSON.stringify([
    { role: "teacher", user: "teacher", pass: "x", name: "李老师", createdAt: 1 },
    { role: "student", user: "zhangsan", pass: "x", name: "张三", createdAt: now - 20 * D },
  ]);
  const enroll = JSON.stringify([
    { courseId: "ds", name: "数据结构与算法", code: "CS201", joinCode: "CS201-22DT", by: "李老师", at: now - 5 * D },
  ]);
  const courses = JSON.stringify([
    { id: "ds", name: "数据结构与算法", code: "CS201", term: "2026 秋季", page: "class.html" },
  ]);
  const shared = {
    st_courses: courses,
    st_accounts: accounts,
    "st_enroll:student:zhangsan": enroll,
    "st_behavior:student:zhangsan": beh,
  };

  /* ---------- ① 学生自己打开「我的学情」 ---------- */
  const domA = load("analysis.html", {
    role: "student", query: "?course=ds",
    restore: { ls: Object.assign({ st_current_user: "student:zhangsan" }, shared) },
  });
  await settle(domA);
  const ad = domA.window.document;
  const askSelf = parseInt(ad.getElementById("stAsk").textContent, 10);
  const weekSelf = parseInt(ad.getElementById("stWeek").textContent, 10);
  askSelf === 4 ? P("学生自己的学情：答疑提问 = 4（真实统计）") : F("提问数不对: " + askSelf);
  weekSelf === 8 ? P("学生自己的学情：近 7 天行为 = 8") : F("近 7 天不对: " + weekSelf);
  ad.querySelectorAll("#days .daybar").length === 14
    ? P("近 14 天活跃画了 14 根柱（没有记录的天也占位）") : F("柱子数不对");
  [...ad.querySelectorAll("#ring circle")].length >= 3
    ? P("环形图按行为类型现画（不是写死的 dasharray）") : F("环形图没渲染");
  ad.querySelectorAll("#traits .trait").length === 5
    ? P("学习方式画像 5 个维度都由数据渲染") : F("画像维度不对");
  /图/.test(ad.getElementById("weak").textContent)
    ? P("「我该补的地方」列出了反复问过的「图」") : F("薄弱话题没算出来");

  /* ---------- ② 老师打开 class.html 点开同一个学生 ---------- */
  const domB = load("class.html", {
    role: "teacher", query: "?course=ds",
    restore: { ls: shared },
  });
  await settle(domB);
  const bd = domB.window.document;
  const row = [...bd.querySelectorAll("#stuRows tr")].find((tr) => /张三/.test(tr.textContent));
  row ? P("在课名单里有张三") : F("名单里没有张三");
  const rowCells = [...row.querySelectorAll("td")].map((td) => td.textContent.replace(/\s+/g, " ").trim());
  /8 次/.test(rowCells[4] || "")
    ? P("名单「近期活跃」= 8 次（与他自己的学情同源）") : F("近期活跃列不对: " + rowCells[4]);

  row.querySelector(".link-btn").dispatchEvent(new domB.window.Event("click", { bubbles: true }));
  await settle(domB);
  const modal = bd.getElementById("modalHost");
  modal && !modal.hidden ? P("点姓名弹出学生详情") : F("详情弹窗没出现");
  const mtext = modal.textContent.replace(/\s+/g, " ");
  const statVal = (label) => {
    const el = [...modal.querySelectorAll(".stu-stat")]
      .find((x) => x.querySelector(".k") && x.querySelector(".k").textContent.trim() === label);
    return el ? parseInt(el.querySelector(".v").textContent, 10) : NaN;
  };
  statVal("答疑提问") === 4
    ? P("弹窗里「答疑提问」= 4 —— 与学生自己看到的是同一个数") : F("两边的提问数不一致: " + statVal("答疑提问"));
  statVal("近 7 天行为") === 8
    ? P("弹窗里「近 7 天行为」= 8 —— 与学生自己看到的一致") : F("两边的近 7 天不一致");
  statVal("课件批注") === 2
    ? P("弹窗里「课件批注」= 2（批注条数两边一致）") : F("批注数不一致: " + statVal("课件批注"));
  modal.querySelectorAll(".stu-day").length === 14
    ? P("弹窗里也有近 14 天活跃柱") : F("弹窗里没有活跃柱");
  [...modal.querySelectorAll(".stu-bar")].length >= 8
    ? P("弹窗里有行为类型 / 话题 / 画像三组横条图") : F("弹窗里的图表不足");
  modal.querySelectorAll(".stu-tl li").length >= 4
    ? P("弹窗里列出最近的学习轨迹") : F("弹窗里没有轨迹");
  // ⚠️ 弹窗只取最近 5 条轨迹（behaviorTimeline(list, 5)），别拿第 6 条去断言 ——
  //    断言要盯着"最新的那条"，不然改个条数就红，而产品其实没错。
  /图的最短路径适用条件/.test(mtext)
    ? P("轨迹里是他真实提过的那句问题（不是示例文案）") : F("轨迹内容不对");
  /从没标记|反复问/.test(mtext)
    ? P("「我要提醒他去补的」写明了推断口径（反复问且没标懂了）") : F("薄弱话题没写口径");
  // ⚠️ 只扫**图表区**（.stu-* 那些块）。整段文本里必然出现"掌握度 / 作业提交率…
  //    本版没有来源，因此不显示"这类**如实说明**的句子，扫全文必然误报（第 33 轮同款坑）。
  const chartText = [...modal.querySelectorAll(".stu-stats, .stu-bar, .stu-tl, .stu-days")]
    .map((x) => x.textContent).join(" ");
  !/掌握度|正确率|平均分|成绩|%/.test(chartText)
    ? P("图表区里没有编造指标（掌握度 / 正确率 / 平均分 / 百分比）") : F("图表区出现了编造指标");
  /同一份本机记录|同一份数据/.test(mtext)
    ? P("弹窗明说「同一份记录」（老师与学生看到的是同一份）") : F("没说明数据同源");
  modal.querySelector("[data-close]").dispatchEvent(new domB.window.Event("click", { bubbles: true }));
  await settle(domB);

  /* ---------- ②b 跨课堂：他在别的课里的动作不能混进本课的数 ---------- */
  const multi = JSON.parse(beh).concat([
    { kind: "ask", label: "编译原理的词法分析", at: now - 1 * D + 1000, courseId: "cs401" },
    { kind: "ask", label: "语法分析怎么建树",   at: now - 1 * D + 2000, courseId: "cs401" },
  ]);
  const shared2 = {
    st_accounts: accounts,
    st_courses: JSON.stringify(JSON.parse(courses).concat([
      { id: "cs401", name: "编译原理", code: "CS401", term: "2026 秋季", page: "class.html" }])),
    "st_enroll:student:zhangsan": JSON.stringify(JSON.parse(enroll).concat([
      { courseId: "cs401", name: "编译原理", code: "CS401", joinCode: "CS401-UB7G", at: now - 4 * D }])),
    "st_behavior:student:zhangsan": JSON.stringify(multi),
  };

  const domD = load("analysis.html", {
    role: "student", query: "?course=ds",
    restore: { ls: Object.assign({ st_current_user: "student:zhangsan" }, shared2) },
  });
  await settle(domD);
  const dd = domD.window.document;
  parseInt(dd.getElementById("stAsk").textContent, 10) === 4
    ? P("学生自己的学情只算本课（他在编译原理里的 2 次提问没混进来）")
    : F("跨课堂串数: " + dd.getElementById("stAsk").textContent);
  /另有 2 条记录属于其它课堂/.test(dd.getElementById("srcNote").textContent)
    ? P("并如实说明「本机另有 N 条记录属于其它课堂」") : F("没有交代被排除的记录");
  domD.window.close();

  const domE = load("class.html", {
    role: "teacher", query: "?course=ds", restore: { ls: shared2 },
  });
  await settle(domE);
  const ed = domE.window.document;
  const rowE = [...ed.querySelectorAll("#stuRows tr")].find((tr) => /张三/.test(tr.textContent));
  /8 次/.test(rowE.textContent)
    ? P("老师的「近期活跃」也只算本课（8 次，不是 10 次）") : F("跨课堂串数: " + rowE.textContent);
  rowE.querySelector(".link-btn").dispatchEvent(new domE.window.Event("click", { bubbles: true }));
  await settle(domE);
  const statE = (label) => {
    const el = [...ed.querySelectorAll("#modalHost .stu-stat")]
      .find((x) => x.querySelector(".k") && x.querySelector(".k").textContent.trim() === label);
    return el ? parseInt(el.querySelector(".v").textContent, 10) : NaN;
  };
  statE("答疑提问") === 4
    ? P("弹窗同样只算本课（两边数字仍然一致：4 = 4）") : F("弹窗跨课堂串数: " + statE("答疑提问"));
  domE.window.close();

  /* ---------- ③ 没有行为记录的学生 → 空状态，不画空白图表 ---------- */
  const domC = load("class.html", {
    role: "teacher", query: "?course=ds",
    restore: { ls: Object.assign({}, shared, {
      "st_behavior:student:zhangsan": "[]",           // 明确"这个账号没有记录"
    }) },
  });
  await settle(domC);
  const cd = domC.window.document;
  const rowC = [...cd.querySelectorAll("#stuRows tr")].find((tr) => /张三/.test(tr.textContent));
  /还没有记录/.test(rowC.textContent)
    ? P("没有行为记录时「近期活跃」如实写「还没有记录」") : F("没有记录却显示了数字");
  rowC.querySelector(".link-btn").dispatchEvent(new domC.window.Event("click", { bubbles: true }));
  await settle(domC);
  const modalC = cd.getElementById("modalHost");
  /还没有任何学习行为记录/.test(modalC.textContent)
    ? P("没有记录时给的是空状态文案（不画一个空白图表凑数）") : F("空状态缺失");
  !modalC.querySelector(".stu-day")
    ? P("空状态下确实没有图表（不是画了一排 0）") : F("空状态还画了图表");
  domC.window.close();

  /* ---------- ④ 陌生学生（不在名单里）不能被读出别人的数据 ---------- */
  cd.getElementById("modalHost").hidden = true;
  const before = cd.getElementById("stuRows").textContent;
  /张三/.test(before) && !/李四/.test(before)
    ? P("本机没加入这门课的学生不会出现在名单里") : F("名单里混进了别人");

  domA.window.close();
  domB.window.close();
}

console.log("\n=== 3c-6. 行为日志是「真记」的：答疑页 / 课件页的动作会写进去 ===");
{
  const D = 86400000;
  const now = Date.now();

  /* ---------- ① 答疑页：问一句 → 进日志 ---------- */
  const dom = load("chat.html", {
    role: "student", query: "?course=ds",
    restore: { ls: {
      st_current_user: "student:zhangsan",
      st_courses: JSON.stringify([{ id: "ds", name: "数据结构与算法", code: "CS201", page: "class.html" }]),
      "st_enroll:student:zhangsan": JSON.stringify([
        { courseId: "ds", name: "数据结构与算法", code: "CS201", joinCode: "CS201-22DT", at: now - 3 * D },
      ]),
      "st_behavior:student:zhangsan": "[]",
    } },
  });
  await settle(dom);
  const w = dom.window, d = w.document;
  w.prompt = () => "这个问题不该被忽略";

  const emptyShown = /还没有任何学习记录/.test(d.getElementById("traits").textContent);
  emptyShown ? P("没有记录时右栏画像如实说「还没有记录」") : F("空画像提示缺失");

  d.getElementById("input").value = "为什么快速排序最坏是 O(n²)？";
  d.getElementById("sendBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));            // 等那 700ms 的"正在输入"

  const logged = String(w.localStorage.getItem("st_behavior:student:zhangsan") || "");
  /为什么快速排序最坏/.test(logged)
    ? P("答疑页提问 → 写进 st_behavior:student:zhangsan") : F("提问没有落进行为日志: " + logged);
  /"kind":"ask"/.test(logged) ? P("记的是 ask 类型") : F("类型不对");
  /"topic":"复杂度"|"topic":"排序"/.test(logged)
    ? P("写入时按关键词归了话题（不是空话题）") : F("话题没归类: " + logged);

  /* 参考：调用日志的入口是页面自己的 rec()，别在页面里另写一套存储 */
  /function rec\(/.test(w.document.documentElement.innerHTML)
    ? P("页面通过 rec() → logBehavior 记录，没有自己另存一份") : F("页面自己另写了存储");

  const foot = d.querySelector(".bubble-foot a[data-act='got']");
  foot ? P("AI 回答下方有操作栏") : F("操作栏缺失");
  foot.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  /"kind":"got"/.test(String(w.localStorage.getItem("st_behavior:student:zhangsan") || ""))
    ? P("点「懂了」真的记一条 got（以前这些链接点了没反应）") : F("「懂了」没有记录");
  /已标记懂了/.test(foot.textContent)
    ? P("点过之后按钮给出状态反馈") : F("点了没有视觉反馈");
  dom.window.close();

  /* ---------- ② 课件页：正文来自数据层，阅读 / 批注都进同一份日志 ---------- */
  const cwForZhangsan = {
    id: "cw-t1", title: "7.2 快速排序的复杂度分析", courseId: "ds", courseName: "数据结构与算法",
    chapters: [{ id: "ds-c7", title: "第 7 章 · 排序" }],
    body: "快速排序的平均时间复杂度为 O(n log n)，最坏情况下会退化为 O(n²)。\n\n划分不平衡时递归深度从 log n 变成 n。",
    source: "write", status: "published", createdBy: "teacher:teacher",
    publishedTo: [{ who: "student:zhangsan", at: now - 2 * D }],
  };
  const dom2 = load("reader.html", {
    role: "student",
    restore: { ls: {
      st_current_user: "student:zhangsan",
      st_courses: JSON.stringify([{ id: "ds", name: "数据结构与算法", code: "CS201", page: "class.html" }]),
      "st_enroll:student:zhangsan": JSON.stringify([
        { courseId: "ds", name: "数据结构与算法", code: "CS201", joinCode: "CS201-22DT", at: now - 3 * D },
      ]),
      "st_behavior:student:zhangsan": "[]",
      "st_courseware:student:zhangsan": JSON.stringify([cwForZhangsan]),
    } },
  });
  await settle(dom2);
  const w2 = dom2.window, d2 = w2.document;

  /7.2 快速排序/.test(d2.getElementById("paperTitle").textContent)
    ? P("课件正文来自数据层（标题读出来了，不再是写死的 HTML）") : F("标题没读出来");
  d2.querySelectorAll("#paperBody .annot").length === 2
    ? P("🔴 段落由 cwSections() 渲染（2 段，与老师端同一规则）")
    : F("段落没渲染: " + d2.querySelectorAll("#paperBody .annot").length);
  // 第 54 轮：课程选择器（只列已加入且真有课件的课）
  const cwCourseBox = d2.getElementById("cwCourses");
  !cwCourseBox.hidden && /数据结构与算法/.test(cwCourseBox.textContent)
    ? P("🔴 有「选课程」栏，列出学生加入的课（数据结构与算法）") : F("课程选择器没出来");
  /老师发布/.test(d2.getElementById("paperMeta").textContent)
    ? P("老师真发来的课件标「老师发布」（不是「预置示例」）") : F("来源标记不对");

  /还没有批注/.test(d2.getElementById("noteList").textContent)
    ? P("没有批注时列表给空状态") : F("批注空状态缺失");

  d2.querySelector('.annot[data-idx="1"]').dispatchEvent(new w2.Event("click", { bubbles: true }));
  await settle(dom2);
  let logged2 = String(w2.localStorage.getItem("st_behavior:student:zhangsan") || "");
  /"kind":"read"/.test(logged2) ? P("选中一段 → 记一条 read（阅读行为）") : F("阅读没有记录");

  // 写批注走 pageModalHost（不再是 window.prompt）
  d2.querySelector('.annot[data-idx="1"] .tool-btn[data-act="note"]')
    .dispatchEvent(new w2.Event("click", { bubbles: true }));
  await settle(dom2);
  const noteInput = d2.getElementById("noteInput");
  noteInput ? P("写批注弹出了输入框（pageModalHost，不用 window.prompt）") : F("批注输入框没出来");
  noteInput.value = "划分不平衡 → 递归深度变 n";
  d2.querySelector('#modalHost [data-mc="ok"]').dispatchEvent(new w2.Event("click", { bubbles: true }));
  await settle(dom2);
  logged2 = String(w2.localStorage.getItem("st_behavior:student:zhangsan") || "");
  /划分不平衡/.test(logged2) ? P("写批注 → 落进行为日志") : F("批注没有记录");
  /"seg":1/.test(logged2) ? P("批注带上段落号（能挂回第几段）") : F("批注没带段落号");
  /"cwId":"cw-t1"/.test(logged2) ? P("🔴 批注带上 cwId（哪一份课件的第几段）") : F("批注没带 cwId");
  /划分不平衡/.test(d2.getElementById("noteList").textContent)
    ? P("批注列表跟着数据刷新出来了") : F("列表没刷新");
  d2.querySelector('.annot[data-idx="1"]').classList.contains("has-note")
    ? P("段落上的「已有批注」标记由数据驱动") : F("段落标记没跟上");
  w2.localStorage.getItem("st_notes") === null
    ? P("批注没有第二份存储（只有行为日志那一份）") : F("又多了一份批注存储");

  /* 同一段重复点选不会刷屏 */
  const n1 = (JSON.parse(logged2) || []).filter((e) => e.kind === "read").length;
  d2.querySelector('.annot[data-idx="1"]').dispatchEvent(new w2.Event("click", { bubbles: true }));
  await settle(dom2);
  const n2 = (JSON.parse(String(w2.localStorage.getItem("st_behavior:student:zhangsan"))) || [])
    .filter((e) => e.kind === "read").length;
  n1 === n2 ? P("同一段重复点选只记一次（不刷屏）") : F("阅读被重复记录: " + n1 + " → " + n2);
  dom2.window.close();

  /* ---------- ③ 教师端发布课件页：写 → 保存 → 发布 → 学生能读 ---------- */
  const dom3 = load("courseware.html", {
    role: "teacher",
    restore: { ls: {
      st_current_user: "teacher:teacher",
      st_accounts: JSON.stringify([
        { role: "teacher", user: "teacher", pass: "x", name: "李老师" },
        { role: "student", user: "student", pass: "x", name: "李同学" },
      ]),
    } },
  });
  await settle(dom3);
  const w3 = dom3.window, d3 = w3.document;
  /保存为草稿/.test(d3.getElementById("cwSaveBtn").textContent)
    ? P("打开课件页停在「新建」态") : F("初始状态不对");
  d3.getElementById("cwTitle").value = "图的最短路径";
  d3.getElementById("cwBody").value = "Dijkstra 处理非负权。\n\nBellman-Ford 能处理负权边。";
  d3.getElementById("cwBody").dispatchEvent(new w3.Event("input", { bubbles: true }));
  await settle(dom3);
  /会切成 2 段/.test(d3.getElementById("cwSecs").textContent)
    ? P("🔴 实时切段预览（写 2 段 → 提示会切成 2 段）") : F("切段预览没出来: " + d3.getElementById("cwSecs").textContent.slice(0, 60));
  d3.getElementById("cwSaveBtn").dispatchEvent(new w3.Event("click", { bubbles: true }));
  await settle(dom3);
  const cws3 = JSON.parse(String(w3.localStorage.getItem("st_courseware:teacher:teacher")) || "[]");
  cws3.length === 1 && cws3[0].title === "图的最短路径" && cws3[0].status === "draft"
    ? P("保存为草稿落库（status=draft，未发布；🔴 无预置种子，初始为空）")
    : F("保存没落库: " + JSON.stringify(cws3.map((c) => c.title)));
  /图的最短路径/.test(d3.getElementById("cwList").textContent)
    ? P("课件列表里出现刚存的这份") : F("列表没刷新");

  // 发布（种子课程「数据结构与算法」里有预置学生 student）
  const pubBtn = d3.querySelector('#cwList [data-cw] [data-act="publish"]');
  pubBtn ? P("列表卡片有「发布到班级」") : F("卡片没有发布入口");
  pubBtn.dispatchEvent(new w3.Event("click", { bubbles: true }));
  await settle(dom3);
  const pick = d3.querySelector('#modalHost [data-who="student:student"]');
  pick ? P("发布名单来自真实在课学生（student:student 在列）") : F("名单没有真实学生");
  pick.checked = true;
  d3.querySelector('#modalHost [data-mc="ok"]').dispatchEvent(new w3.Event("click", { bubbles: true }));
  await settle(dom3);
  const cws3b = JSON.parse(String(w3.localStorage.getItem("st_courseware:teacher:teacher")) || "[]");
  cws3b[0].status === "published" && cws3b[0].publishedTo.length === 1
    ? P("发布后 status=published + 下发 1 人（落库）") : F("发布没生效");
  dom3.window.close();
}

console.log("\n=== 3d. 课表与事项 / 教案（真实 DOM 交互）===");{
  const dom = load("schedule.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const w = dom.window;

  // 课表：脚本渲染出的格子真的在 DOM 里
  const cells = d.querySelectorAll("#weekGrid .week-cell");
  cells.length >= 20 ? P(`课表渲染出 ${cells.length} 个格子`) : F("课表格子过少: " + cells.length);
  d.querySelectorAll("#weekGrid .week-cell.empty").length >= 5
    ? P("空堂格正常渲染") : F("空堂格缺失");
  // ⚠️ 高亮是**按当前真实时间**算的，「正在上课」还是「下一节」取决于跑测试的时刻。
  //    所以这里只断言「恰有一格被高亮且带合法状态」，不假定是哪一种。
  const hl = d.querySelectorAll("#weekGrid .week-cell.now, #weekGrid .week-cell.next");
  hl.length === 1
    ? P("按当前时间高亮：恰有一格（" + hl[0].className.replace(/week-cell\s*/, "") + "）")
    : F(`高亮格数量异常: ${hl.length}`);
  hl.length === 1 && hl[0].querySelector(".c-flag")
    ? P("高亮格带「正在上课 / 下一节」标签") : F("高亮格缺状态标签");

  // 待办：动态渲染的勾选框
  const checks = d.querySelectorAll("#todoList .todo-check");
  checks.length >= 4 ? P(`待办渲染出 ${checks.length} 个勾选框`) : F("待办勾选框过少");

  const pendingBefore = Number(d.getElementById("pendingCount").textContent);
  const firstUnchecked = [...checks].find((c) => c.getAttribute("aria-checked") === "false");
  firstUnchecked
    ? P("存在未完成待办可勾选") : F("无可勾选待办");
  if (firstUnchecked) {
    firstUnchecked.click();
    await settle(dom);
    const after = d.querySelector("#todoList .todo-check[aria-checked='true']");
    const nowChecked = [...d.querySelectorAll("#todoList .todo-check")]
      .filter((c) => c.getAttribute("aria-checked") === "true").length;
    nowChecked >= 1 ? P("点击后勾选框变为已勾选") : F("点击后未勾选");
    const pendingAfter = Number(d.getElementById("pendingCount").textContent);
    pendingAfter === pendingBefore - 1
      ? P(`未完成计数同步减一（${pendingBefore} → ${pendingAfter}）`)
      : F(`计数未同步: ${pendingBefore} → ${pendingAfter}`);
    const li = d.querySelector("#todoList .todo-item[data-done='1']");
    li ? P("对应待办标为已完成（.todo-item[data-done=1]）") : F("待办未标完成");
    void after;
  }
  // 再点一次 → 反向切换（证明是 toggle 而非单向）
  const checkedNow = d.querySelector("#todoList .todo-check[aria-checked='true']");
  if (checkedNow) {
    const idBefore = checkedNow.id;
    checkedNow.click();
    await settle(dom);
    const back = d.getElementById(idBefore);
    back && back.getAttribute("aria-checked") === "false"
      ? P("再点一次可取消勾选（toggle 双向）") : F("无法取消勾选");
  }
  dom.window.close();
}

{
  /* ============ 3d-1. 教案页：课程 → 大纲 → 课时（真实 DOM） ============ */
  const dom = load("lesson.html", { role: "teacher" });
  await settle(dom);
  const w = dom.window, d = w.document;

  const sel = d.getElementById("courseSel");
  // 不写死数字：跟着当前账号的课程目录走
  sel && w.COURSES.length > 0 && sel.options.length === w.COURSES.length
    ? P("课程下拉列出全部课程（" + sel.options.length + " 门）") : F("课程下拉项数异常");
  sel && sel.value === "ds" ? P("默认选中有大纲的课程") : F("默认课程不对: " + (sel && sel.value));
  /4 章/.test(d.getElementById("courseMeta").textContent)
    ? P("课程信息条显示章数/教案数") : F("课程信息条内容异常");

  const chs = [...d.querySelectorAll("#outlineTree .ch-row")];
  chs.length === 4 ? P("大纲树渲染 4 章") : F("章数不对: " + chs.length);
  const lss = [...d.querySelectorAll("#outlineTree .ls-row")];
  lss.length === 6 ? P("大纲树渲染 6 份课时教案") : F("课时数不对: " + lss.length);
  /第 7 章/.test(chs[2] ? chs[2].textContent : "") ? P("章顺序与大纲一致") : F("章顺序异常");

  const dots = [...new Set([...d.querySelectorAll("#outlineTree .ls-dot")]
    .map((x) => String(x.className).split(" ").pop()))].sort();
  dots.length >= 2 ? P("课时状态点有区分（" + dots.join(" / ") + "）") : F("状态点无区分: " + dots);

  const panel = d.getElementById("planPanel");
  const html1 = panel.innerHTML;
  /教学目标/.test(html1) && /课堂流程/.test(html1) && /教学难点/.test(html1) && /学情提示/.test(html1)
    ? P("默认打开课时教案，六个分节齐全") : F("详情分节缺失");

  const firstAct = d.querySelector("#outlineTree .ls-row.active");
  firstAct && firstAct.dataset.ls === "ds-c6-1"
    ? P("默认选中第一份课时教案（ds-c6-1）") : F("默认选中异常: " + (firstAct && firstAct.dataset.ls));

  d.querySelector("#outlineTree .ls-row[data-ls='ds-c7-2']").click();
  await settle(dom);
  const html2 = panel.innerHTML;
  html2 !== html1 ? P("切换课时后详情真的更新") : F("切换后详情未变");
  /快速排序/.test(html2) ? P("详情切到所选课时（快速排序）") : F("详情内容不对");
  d.querySelector("#outlineTree .ls-row.active").dataset.ls === "ds-c7-2"
    ? P("大纲树高亮跟随选中课时") : F("高亮未跟随");

  d.querySelector("#outlineTree .ch-row[data-ch='ds-c7']").click();
  await settle(dom);
  /本章核心知识点/.test(panel.innerHTML) && /本章课时教案/.test(panel.innerHTML)
    ? P("点章进入章概览") : F("章概览未渲染");
  !/编辑教案/.test(panel.innerHTML) ? P("章概览下没有课时详情的按钮残留") : F("章概览残留课时按钮");

  d.querySelector("#outlineTree .ls-row[data-ls='ds-c7-3']").click();
  await settle(dom);
  const stSel = d.getElementById("statusSel");
  stSel.value = "ready";
  stSel.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(dom);
  w.LESSONS["ds-c7-3"].status === "ready" ? P("状态下拉直接改状态") : F("状态未改: " + w.LESSONS["ds-c7-3"].status);
  /待上/.test(d.querySelector("#outlineTree .ls-row[data-ls='ds-c7-3']").textContent)
    ? P("大纲树上的状态标签同步更新") : F("大纲树状态未同步");

  dom.window.close();
}

{
  /* ============ 3d-2. 教案页：编辑 → 新版本 → 对比 → 回退 → 反思 → AI 交接 ============ */
  const dom = load("lesson.html", { role: "teacher" });
  const w = dom.window, d = w.document;
  await settle(dom);
  w.confirm = () => true;                 // 回退会问一次，测试里直接同意

  const L = w.LESSONS["ds-c6-1"];
  const before = L.commits.length;

  d.getElementById("editBtn").click();
  await settle(dom);
  const host = d.getElementById("modalHost");
  host.querySelector(".modal") ? P("点「编辑教案」弹出编辑弹窗") : F("编辑弹窗未出现");
  host.querySelector("#fSteps .step-row") ? P("课堂流程用行式表单（不用记格式）") : F("课堂流程表单缺失");

  const rows0 = host.querySelectorAll("#fSteps .step-row").length;
  host.querySelector("#stepAdd").click();
  host.querySelectorAll("#fSteps .step-row").length === rows0 + 1
    ? P("可以加一步课堂流程") : F("加步骤没生效");
  // ⚠️ 上面刚加过一行，所以总数是 rows0 + 1 —— 别按 rows0 算，
  //    直接「删到只剩一行」更稳（不依赖初始行数）
  let guard = 0;
  while (host.querySelectorAll("#fSteps .step-row").length > 1 && guard++ < 20) {
    const b = host.querySelector("#fSteps [data-step-del]");
    if (!b) break;
    b.click();
  }
  host.querySelectorAll("#fSteps .step-row").length === 1
    ? P("可以一路删到只剩一行（含刚加的那行）") : F("删行结果不对");
  host.querySelector("#fSteps [data-step-del]").click();
  host.querySelectorAll("#fSteps .step-row").length === 1
    && /至少保留一行/.test(host.querySelector("#formError").textContent)
    ? P("只剩一行时再删会被拦下并提示") : F("没有拦住空流程");

  host.querySelector(".modal-x").click();
  await settle(dom);
  d.getElementById("modalHost").hidden ? P("点 ✕ 能关闭并清理弹窗") : F("弹窗未关闭");

  // 重新打开，正常改内容提交
  d.getElementById("editBtn").click();
  await settle(dom);
  const h2 = d.getElementById("modalHost");
  h2.querySelector("#fGoals").value += " 能用随机化主元把最坏情况变成概率事件。";
  h2.querySelector("#fKey").value += "\n主元选取对递归深度的影响";
  h2.querySelector("#fMsg").value = "补充随机化主元与主元选取";
  h2.querySelector("#formSave").click();
  await settle(dom);

  L.commits.length === before + 1 ? P("提交后版本 +1") : F("版本数不对: " + L.commits.length);
  L.commits[L.head].kind === "edit" ? P("提交类型记为「编辑」") : F("类型不对: " + L.commits[L.head].kind);
  L.head === L.commits.length - 1 ? P("head 指向新版本") : F("head 没前移");
  d.getElementById("modalHost").hidden ? P("提交后自动关闭弹窗") : F("弹窗未关");
  /随机化主元/.test(d.getElementById("planPanel").innerHTML) ? P("详情立刻显示新内容") : F("详情未更新");
  /随机化主元/.test(String(w.localStorage.getItem("st_lessons")))
    ? P("新版本已写入本机存储") : F("未落库");

  // 内容没变 → 不该靠「改说明」刷版本
  d.getElementById("editBtn").click();
  await settle(dom);
  const h3 = d.getElementById("modalHost");
  h3.querySelector("#fMsg").value = "只是改个说明";
  h3.querySelector("#formSave").click();
  await settle(dom);
  L.commits.length === before + 1
    ? P("内容没改时不产生新版本（不靠说明刷版本）") : F("内容没变却产生了新版本");

  // ---- 版本时间线 ----
  d.querySelector("[data-tab='version']").click();
  await settle(dom);
  const vers = [...d.querySelectorAll("#tabBody .ver-item")];
  vers.length === L.commits.length ? P("版本时间线列出全部 " + vers.length + " 版") : F("版本条数不对: " + vers.length);
  /当前版本/.test(vers[0].textContent) ? P("最新一版标为「当前版本」") : F("当前版本未标出");
  vers[0].querySelector(".mono").textContent === L.commits[L.head].id
    ? P("时间线倒序（最新在最上）") : F("顺序不对");
  /编辑|新建|课后改进/.test(vers[0].innerHTML) ? P("每条版本带类型徽标") : F("缺类型徽标");

  // ---- 对比 ----
  const diffBtn = vers[0].querySelector("[data-diff]");
  diffBtn ? P("非首版都提供「与上一版对比」") : F("缺对比按钮");
  diffBtn.click();
  await settle(dom);
  const diffBox = d.getElementById("diffBox");
  diffBox.querySelectorAll(".diff-line").length > 0 ? P("对比面板渲染出逐行差异") : F("对比面板为空");
  diffBox.querySelectorAll(".diff-line.add").length > 0 ? P("有新增行（+ 侧）") : F("没有新增行");
  // 注意比对的是**改动后的内容**，不是提交说明（说明不进 diff）
  /随机化主元/.test(diffBox.textContent) ? P("对比内容就是本次改动（含新加的那句）") : F("对比内容不对");
  diffBox.querySelector("#aiDiffBtn") ? P("对比面板提供「让 AI 解读」入口") : F("缺 AI 解读入口");
  diffBox.querySelector("#diffClose").click();
  await settle(dom);
  d.getElementById("diffBox").innerHTML.trim() === "" ? P("可以收起对比面板") : F("对比面板未收起");

  // ---- 任意两版对比（第 57 轮：不再只能「与上一版」比）----
  {
    const vs = [...d.querySelectorAll("#tabBody .ver-item")];
    vs.length >= 2 && vs.every((x) => x.querySelector("[data-pick]"))
      ? P("每一版都提供「选作对比」（任意两版都能比）") : F("缺「选作对比」按钮");

    // ① 选最早一版作起点 → 出现提示条
    vs[vs.length - 1].querySelector("[data-pick]").click();
    await settle(dom);
    d.querySelector("#tabBody .pick-bar")
      ? P("选了起点后出现提示条（当前选了哪一版）") : F("选起点后没有提示条");

    // ② 再点最新一版 → 出这两版的差异
    const pickEnd = [...d.querySelectorAll("#tabBody .ver-item")][0].querySelector("[data-pick]");
    pickEnd.click();
    await settle(dom);
    const db2 = d.getElementById("diffBox");
    db2 && /→/.test(db2.textContent) && db2.querySelector(".diff-fld")
      ? P("再点另一版即出两版差异（任意两版，不必相邻）") : F("任意两版对比没出结果: " + (db2 ? db2.textContent.slice(0, 40) : "无面板"));
    const cc = d.getElementById("diffBox").querySelector("#diffClose");
    if (cc) { cc.click(); await settle(dom); }

    // ③ 再选一次起点，用「取消」清掉
    [...d.querySelectorAll("#tabBody .ver-item")][0].querySelector("[data-pick]").click();
    await settle(dom);
    const cancelPick = d.querySelector("#tabBody .pick-bar [data-pick]");
    cancelPick ? P("提示条上有「取消」") : F("提示条没有取消按钮");
    if (cancelPick) {
      cancelPick.click();
      await settle(dom);
      !d.querySelector("#tabBody .pick-bar")
        ? P("点「取消」能清掉对比起点") : F("取消后提示条还在");
    }
  }

  // ---- 回退 ----
  const cnt0 = L.commits.length;
  const last = [...d.querySelectorAll("#tabBody .ver-item")].slice(-1)[0];
  const revBtn = last.querySelector("[data-revert]");
  revBtn ? P("历史版本提供「回到这版」") : F("缺回退按钮");
  revBtn.click();
  await settle(dom);
  L.commits.length === cnt0 + 1 ? P("回退是新增一版（历史只增不减）") : F("回退改动了历史条数: " + L.commits.length);
  L.commits[L.head].kind === "revert" ? P("回退类型记为 revert") : F("类型不对");
  w.snapEqual(w.lessonSnap(L), L.commits[0].snap) ? P("回退后内容等于目标版本") : F("内容没回到目标版本");
  L.commits[1].snap && L.commits[1].snap.goals ? P("被回退掉的那些版本原样保留") : F("历史被破坏");
  d.querySelector("[data-tab='plan']").click();
  await settle(dom);
  !/随机化主元/.test(d.getElementById("planPanel").innerHTML) ? P("页面内容也跟着回到旧版") : F("页面还留着已回退的内容");

  // ---- 课后反思 ----
  d.querySelector("[data-tab='reflect']").click();
  await settle(dom);
  const cnt1 = L.commits.length;
  d.getElementById("addReflectBtn").click();
  await settle(dom);
  const rh = d.getElementById("modalHost");
  rh.querySelector("#rSaw").value = "学生对指针移动卡住，反复问指针什么时候停";
  rh.querySelector("#rTodo").value = "下次先发指针轨迹图，再两人一组互讲一遍";
  rh.querySelector("#rDate").value = "第 5 教学周 周三";
  rh.querySelector("#formSave").click();
  await settle(dom);
  L.commits.length === cnt1 + 1 ? P("记录反思留下一个新版本") : F("反思没有留下版本");
  L.commits[L.head].kind === "reflect" ? P("类型记为「课后改进」") : F("类型不对");
  L.status === "taught" ? P("记了反思 → 状态自动变「已上」") : F("状态没变: " + L.status);
  L.taughtAt === "第 5 教学周 周三" ? P("上课日期记下来了") : F("日期没记: " + L.taughtAt);
  /指针移动卡住/.test(d.getElementById("tabBody").innerHTML) ? P("反思列表显示课堂观察") : F("观察未显示");
  /指针轨迹图/.test(d.getElementById("tabBody").innerHTML) ? P("反思列表显示下次改进") : F("改进未显示");
  String(L.commits[L.head].msg).indexOf("课后改进") === 0
    ? P("提交说明自动生成：" + L.commits[L.head].msg.slice(0, 24)) : F("说明没生成: " + L.commits[L.head].msg);

  d.getElementById("addReflectBtn").click();
  await settle(dom);
  const rh2 = d.getElementById("modalHost");
  rh2.querySelector("#rSaw").value = "只写了观察";
  rh2.querySelector("#formSave").click();
  await settle(dom);
  (rh2.querySelector(".modal") && !rh2.querySelector("#formError").hidden)
    ? P("反思缺「下次怎么改」时被拦下，弹窗不关") : F("校验没拦住半截反思");
  rh2.querySelector(".modal-x").click();
  await settle(dom);

  // ---- AI 交接 ----
  let navTo = "";
  w.navigate = (p) => { navTo = p; };

  d.getElementById("aiImproveBtn").click();
  const t1 = JSON.parse(String(w.localStorage.getItem("st_agent_task") || "null"));
  t1 && t1.task === "improve-lesson" ? P("AI 任务标记为 improve-lesson") : F("任务标记不对");
  t1 && t1.from === "lesson.html" ? P("交接记下来源页") : F("缺来源页");
  t1 && /改进建议/.test(t1.prompt || "") ? P("交接带上了提示词") : F("缺提示词");
  t1 && /指针移动卡住/.test(t1.text || "") ? P("交接带上了最近一次课后反思（跳转不丢上下文）") : F("上下文没带上");
  navTo === "agent.html?task=improve-lesson" ? P("跳转目标正确") : F("跳转不对: " + navTo);

  d.querySelector("#outlineTree .ch-row[data-ch='ds-c7']").click();
  await settle(dom);
  d.getElementById("aiGenBtn").click();
  const t2 = JSON.parse(String(w.localStorage.getItem("st_agent_task") || "null"));
  t2.task === "gen-lesson" ? P("章概览的 AI 起草任务标记正确") : F("任务标记不对: " + t2.task);
  /核心知识点/.test(t2.text || "") ? P("起草上下文带上了本章核心知识点") : F("上下文缺知识点");
  navTo === "agent.html?task=gen-lesson" ? P("起草的跳转目标正确") : F("跳转不对: " + navTo);

  // ---- 重开后一切还在 ----
  const lsDump = String(w.localStorage.getItem("st_lessons"));
  const syDump = String(w.localStorage.getItem("st_syllabus"));
  const snapshotLen = L.commits.length;
  dom.window.close();

  const dom9 = load("lesson.html", { role: "teacher", restore: { ls: { st_lessons: lsDump, st_syllabus: syDump } } });
  await settle(dom9);
  const w9 = dom9.window;
  w9.LESSONS["ds-c6-1"].commits.length === snapshotLen
    ? P("重开后台账版本数一致（" + snapshotLen + " 版）") : F("重开后版本数不一致");
  w9.LESSONS["ds-c6-1"].status === "taught" ? P("重开后课后反思带来的状态仍在") : F("状态丢了");
  /指针轨迹图/.test(JSON.stringify(w9.lessonReflects(w9.LESSONS["ds-c6-1"])))
    ? P("重开后反思内容仍在") : F("反思丢了");
  dom9.window.close();
}

{
  /* ============ 3d-3. 教案页：无大纲的课程（不编造）+ 新建流程 ============ */
  /* 用「刚建好、还没排教案」的课程来测 —— 这才是真实场景：
     演示课程现在只有数据结构一门（而且它有完整大纲）。 */
  const fresh = JSON.stringify([{ id: "cs401", name: "编译原理", code: "CS401", page: "class.html" }]);
  const dom = load("lesson.html", {
    role: "teacher",
    query: "?course=cs401",
    restore: { ls: { st_current_user: "teacher:zhangsan", "st_courses:teacher:zhangsan": fresh } },
  });
  await settle(dom);
  const w = dom.window, d = w.document;

  d.getElementById("courseSel").value === "cs401" ? P("?course=cs401 深链生效") : F("深链未生效");
  const tree = d.getElementById("outlineTree");
  tree.innerHTML.trim() === "" ? P("还没排教案的课程：大纲树为空")
    : F("渲染了不该有的章: " + tree.textContent.slice(0, 30));
  !/数据结构/.test(tree.innerHTML + d.getElementById("planPanel").innerHTML)
    ? P("不会串到别的课程的教案（不编造）") : F("出现了别的课程的内容");
  !d.getElementById("outlineEmpty").hidden ? P("给出空状态提示") : F("没有空状态");
  /还没有教案大纲/.test(d.getElementById("planPanel").innerHTML) ? P("右栏也提示先建大纲") : F("右栏提示缺失");
  d.getElementById("addChapterBtn").hidden ? P("没有大纲时不显示「＋ 章节」") : F("无大纲却显示加章节");

  d.getElementById("createSylBtn").click();
  await settle(dom);
  w.SYLLABUS.cs401 ? P("点「按课程新建大纲」真的建了大纲") : F("大纲没建出来");
  w.SYLLABUS.cs401.chapters.length === 1 ? P("空骨架只有 1 章（不预填内容）") : F("章数不对");
  w.syllabusStats("cs401").lessons === 0 ? P("空骨架 0 份教案（不凭空造教案）") : F("凭空冒出教案");
  d.getElementById("addChapterBtn").hidden === false ? P("建完大纲后出现「＋ 章节」") : F("加章节按钮未出现");

  d.getElementById("addChapterBtn").click();
  await settle(dom);
  const h = d.getElementById("modalHost");
  h.querySelector("#cTitle").value = "第 2 章 · 词法分析";
  h.querySelector("#cHours").value = "6";
  h.querySelector("#cPoints").value = "正规式、有限自动机、词法分析器构造";
  h.querySelector("#formSave").click();
  await settle(dom);
  w.SYLLABUS.cs401.chapters.length === 2 ? P("新建章节成功") : F("章节没加上");
  w.SYLLABUS.cs401.chapters[1].hours === 6 ? P("课时数存下来了") : F("课时数不对");
  w.SYLLABUS.cs401.chapters[1].points === "正规式、有限自动机、词法分析器构造"
    ? P("核心知识点存下来了（AI 起草要用）") : F("知识点没存");
  /第 2 章/.test(d.getElementById("outlineTree").textContent) ? P("大纲树立刻多出一章") : F("大纲树未更新");

  d.getElementById("addLessonBtn").click();
  await settle(dom);
  const h2 = d.getElementById("modalHost");
  h2.querySelector("#nTitle").value = "第 2 章 · 第 1 课时：词法分析器";
  h2.querySelector("#formSave").click();
  await settle(dom);
  const newId = "cs401-c2-1";
  w.LESSONS[newId] ? P("新建课时教案成功（" + newId + "）")
    : F("课时没建出来: " + Object.keys(w.LESSONS).filter((k) => /^cs401/.test(k)));
  w.LESSONS[newId].status === "draft" ? P("新教案默认是草稿") : F("默认状态不对");
  w.LESSONS[newId].commits.length === 1 && w.LESSONS[newId].commits[0].kind === "init"
    ? P("新教案自带 v1（初稿）") : F("初始版本不对");
  /词法分析器/.test(d.getElementById("planPanel").innerHTML) ? P("新建后自动切到这份教案") : F("没有切过去");

  d.getElementById("addLessonBtn").click();
  await settle(dom);
  const h3 = d.getElementById("modalHost");
  h3.querySelector("#nTitle").value = "第 2 章 · 第 1 课时：词法分析器";
  h3.querySelector("#formSave").click();
  await settle(dom);
  (h3.querySelector(".modal") && !h3.querySelector("#formError").hidden)
    ? P("同名课时被拦下（弹窗保持打开）") : F("同名课时没被拦");
  h3.querySelector(".modal-x").click();
  await settle(dom);

  // 章里有教案时不许删章
  w.confirm = () => true;
  d.querySelector("#outlineTree .ch-row[data-ch='cs401-c2']").click();
  await settle(dom);
  d.getElementById("chDelBtn").click();
  await settle(dom);
  w.SYLLABUS.cs401.chapters.length === 2
    ? P("章里还有教案时删章被拦下（不会连带删掉教案）") : F("章节被误删");

  dom.window.close();
}

console.log("\n=== 3d-4. 课程目录变化：左侧栏建的课，右侧要能选到 ===");
{
  /* 壳里新建课程 → 广播 → 教案页的课程下拉跟着更新 */
  const dom = load("lesson.html", { role: "teacher" });
  const w = dom.window, d = w.document;
  await settle(dom);
  const n0 = [...d.getElementById("courseSel").options].length;

  w.dispatchEvent(new w.MessageEvent("message", {
    data: { type: "st-courses-changed", courses: [
      { id: "ds", name: "数据结构与算法", page: "class.html" },
      { id: "os", name: "操作系统", page: "" },
      { id: "cs401", name: "编译原理", page: "class.html" },
    ] },
    origin: "http://localhost",
  }));
  await settle(dom);

  const opts = [...d.getElementById("courseSel").options];
  // 广播过来的是 3 门课，与「广播前有几门」无关 —— 直接对齐广播的内容
  opts.length === 3 ? P("收到壳的课程变化广播后，下拉按新目录重建（3 门）")
    : F("下拉没更新: " + n0 + " → " + opts.length);
  opts.some((o) => /编译原理/.test(o.textContent)) ? P("新建的课程出现在下拉里（左边建的，右边选得到）")
    : F("下拉里没有新课程");
  opts.some((o) => /未建大纲/.test(o.textContent)) ? P("没有大纲的课带「未建大纲」标记") : F("缺标记");
  opts.some((o) => /^数据结构与算法$/.test(o.textContent))
    ? P("已有大纲的课不带该标记") : F("已有大纲的课被误标");
  d.getElementById("courseSel").value === "ds" ? P("当前选中的课程不受影响") : F("选中被误改");
  /第 7 章/.test(d.getElementById("outlineTree").textContent)
    ? P("当前课程的内容没被这次广播重置") : F("内容被误重置");

  // 当前课程从目录里消失（被删）→ 自动重选，别停在不存在的课程上
  w.dispatchEvent(new w.MessageEvent("message", {
    data: { type: "st-courses-changed", courses: [{ id: "os", name: "操作系统", page: "" }] },
    origin: "http://localhost",
  }));
  await settle(dom);
  d.getElementById("courseSel").value === "os"
    ? P("当前课程从目录消失时会自动重选") : F("仍停在已消失的课程: " + d.getElementById("courseSel").value);
  /还没有教案大纲/.test(d.getElementById("planPanel").innerHTML)
    ? P("内容区跟着切到新课程的状态") : F("内容区没跟着切");
  dom.window.close();
}

{
  /* 独立模式：在页面里建课 → 侧栏与课程下拉同时更新 */
  const dom = load("lesson.html", { role: "teacher" });
  const w = dom.window, d = w.document;
  await settle(dom);
  const n0 = [...d.getElementById("courseSel").options].length;

  d.getElementById("addCourseBtn").click();
  await settle(dom);
  const host = d.getElementById("modalHost");
  host.querySelector("#cName").value = "编译原理";
  host.querySelector("#cCode").value = "CS401";
  host.querySelector("#courseSave").click();
  await settle(dom);

  const opts = [...d.getElementById("courseSel").options];
  opts.length === n0 + 1 ? P("独立模式建课后，课程下拉立刻更新")
    : F("下拉没更新: " + n0 + " → " + opts.length);
  opts.some((o) => /^cs401\|/.test(o.value + "|") || /^编译原理/.test(o.textContent))
    ? P("新建的课出现在下拉里") : F("下拉里没有新课程");
  [...d.querySelectorAll(".standalone-side .side-item")].some((b) => /编译原理/.test(b.textContent))
    ? P("独立模式侧栏也同步多出这一项") : F("侧栏没同步");
  dom.window.close();
}

console.log("\n=== 3d-5. 课程按账号分开存（换账号看到自己的课）===");
{
  const myCourses = JSON.stringify([
    { id: "cs401", name: "编译原理", code: "CS401", page: "class.html" },
    { id: "db", name: "数据库系统", code: "CS302", page: "class.html" },
  ]);

  /* 预置演示账号 → 给演示课程（方便一眼看到效果） */
  {
    const dom = load("lesson.html", { role: "teacher", restore: { ls: { st_current_user: "teacher:teacher" } } });
    await settle(dom);
    const ids = dom.window.COURSES.map((c) => c.id).join(",");
    const seedIds = dom.window.SEED_COURSES.map((c) => c.id).join(",");
    ids === seedIds && ids.length > 0
      ? P("演示账号：看到预置的演示课程（" + ids + "）")
      : F("演示账号课程与种子不一致: " + ids + " vs " + seedIds);
    dom.window.close();
  }

  /* 自己注册的账号、还没有数据 → 空的，不再永远看到演示的那两门 */
  {
    const dom = load("lesson.html", { role: "teacher", restore: { ls: { st_current_user: "teacher:zhangsan" } } });
    const d = dom.window.document;
    await settle(dom);
    dom.window.COURSES.length === 0
      ? P("自建账号：从空课程开始（不再塞演示数据）")
      : F("自建账号仍看到演示课程: " + dom.window.COURSES.map((c) => c.id).join(","));
    d.getElementById("courseSel").options.length === 0 ? P("课程下拉也是空的") : F("下拉里有幽灵选项");
    !/数据结构|操作系统/.test(d.getElementById("outlineTree").textContent + d.getElementById("planPanel").textContent)
      ? P("页面没有假装有课程（不编造别人的数据）") : F("出现了别人的课程内容");
    dom.window.close();
  }

  /* 自建账号有自己的数据 → 只看到自己的 */
  {
    const dom = load("lesson.html", {
      role: "teacher",
      restore: { ls: { st_current_user: "teacher:zhangsan", "st_courses:teacher:zhangsan": myCourses } },
    });
    await settle(dom);
    const names = dom.window.COURSES.map((c) => c.name).join("/");
    names === "编译原理/数据库系统" ? P("自建账号：读到自己存的课程") : F("读到别的了: " + names);
    dom.window.close();
  }

  /* 没有账号标识（直接双击打开页面）→ 给演示课程 */
  {
    const dom = load("lesson.html", { role: "teacher" });
    await settle(dom);
    dom.window.COURSES.length === dom.window.SEED_COURSES.length && dom.window.COURSES.length > 0
      ? P("未登录直接打开页面 → 给演示课程方便看效果")
      : F("无账号标识时课程数异常: " + dom.window.COURSES.length);
    dom.window.close();
  }

  /* 新建课程要写进「当前账号」的桶，不能污染全局桶或别人的桶 */
  {
    const dom = load("lesson.html", { role: "teacher", restore: { ls: { st_current_user: "teacher:zhangsan" } } });
    const w = dom.window, d = w.document;
    await settle(dom);
    d.getElementById("addCourseBtn").click();
    await settle(dom);
    const host = d.getElementById("modalHost");
    host.querySelector("#cName").value = "编译原理";
    host.querySelector("#cCode").value = "CS401";
    host.querySelector("#courseSave").click();
    await settle(dom);

    [...d.getElementById("courseSel").options].some((o) => /编译原理/.test(o.textContent))
      ? P("建课后下拉里出现新课程") : F("下拉里没有新课程");
    /编译原理/.test(String(w.localStorage.getItem("st_courses:teacher:zhangsan") || ""))
      ? P("写进了当前账号的桶（st_courses:teacher:zhangsan）")
      : F("没写进账号桶: " + w.localStorage.getItem("st_courses:teacher:zhangsan"));
    w.localStorage.getItem("st_courses") === null
      ? P("没有污染全局桶") : F("全局桶被写了");
    w.localStorage.getItem("st_courses:teacher:lisi") === null
      ? P("没有写进别人的桶") : F("写进了别人的桶");

    // 同一账号重开 → 数据还在
    const dump = String(w.localStorage.getItem("st_courses:teacher:zhangsan"));
    dom.window.close();
    const dom2 = load("lesson.html", {
      role: "teacher",
      restore: { ls: { st_current_user: "teacher:zhangsan", "st_courses:teacher:zhangsan": dump } },
    });
    await settle(dom2);
    dom2.window.COURSES.some((c) => c.name === "编译原理")
      ? P("同一账号重开后，新建的课还在（不是每次都回到演示数据）")
      : F("重开后课程丢了");
    dom2.window.close();
  }

  /* 老版本的全局存档 → 迁到当前账号名下 */
  {
    const legacy = JSON.stringify([{ id: "old1", name: "老版本建的课", page: "class.html" }]);
    const dom = load("lesson.html", {
      role: "teacher",
      restore: { ls: { st_current_user: "teacher:zhangsan", st_courses: legacy } },
    });
    await settle(dom);
    dom.window.COURSES.map((c) => c.name).join("/") === "老版本建的课"
      ? P("老版本的全局存档会迁到当前账号名下") : F("老数据没迁过来");
    dom.window.localStorage.getItem("st_courses") === null
      ? P("迁完删掉全局键（不会被别的账号再复制一遍）") : F("全局键还留着");
    dom.window.close();
  }
}

console.log("\n=== 3d-6. 教案大纲的「⋯」：章 / 课时 / 整份大纲 都能删 ===");
{
  const courses = JSON.stringify([{ id: "cs401", name: "编译原理", code: "CS401", page: "class.html" }]);
  const mkSyl = () => JSON.stringify({ cs401: { courseId: "cs401", goal: "", chapters: [
    { id: "cs401-c1", title: "第 1 章 · 引论", hours: 4, points: "编译流程", lessonIds: ["cs401-c1-1"] },
    { id: "cs401-c2", title: "第 2 章 · 词法分析", hours: 6, points: "", lessonIds: [] },
  ] } });
  const mkLsn = () => JSON.stringify({ "cs401-c1-1": {
    id: "cs401-c1-1", courseId: "cs401", chapterId: "cs401-c1", title: "第 1 章 · 第 1 课时：引论",
    minutes: 45, status: "draft", head: 1, commits: [
      { id: "v1", kind: "init", msg: "新建课时教案", snap: {} },
      { id: "v2", kind: "edit", msg: "补教学目标", snap: {} },
    ] } });

  const open = () => load("lesson.html", {
    role: "teacher",
    query: "?course=cs401",
    restore: { ls: { st_current_user: "teacher:zhangsan", "st_courses:teacher:zhangsan": courses,
                     st_syllabus: mkSyl(), st_lessons: mkLsn() } },
  });

  /* ---------- 1. 树行都有「⋯」 ---------- */
  let dom = await open();
  await settle(dom);
  let w = dom.window, d = w.document;

  const rows = d.querySelectorAll("#outlineTree .tree-row");
  const mores = d.querySelectorAll("#outlineTree .tree-more");
  rows.length === 3 && mores.length === 3
    ? P("每行都带「⋯」：2 章 + 1 课时 = 3 个")
    : F("「⋯」数量不对: 行 " + rows.length + " / 按钮 " + mores.length);
  d.querySelectorAll("#outlineTree .ch-row .tree-more, #outlineTree .ls-row .tree-more").length === 0
    ? P("「⋯」在行按钮外面（没有 button 嵌 button）") : F("出现了按钮嵌套");

  const cs = w.getComputedStyle;
  const moreEl = d.querySelector("#outlineTree .tree-more");
  cs(moreEl).position === "absolute" && cs(moreEl).pointerEvents === "none"
    ? P("「⋯」绝对定位且隐形时不接点击（与侧栏课程项同一套）")
    : F("「⋯」样式不对: " + cs(moreEl).position + " / " + cs(moreEl).pointerEvents);
  const chRow = d.querySelector("#outlineTree .ch-row");
  const lsRow = d.querySelector("#outlineTree .ls-row");
  cs(chRow).width === "100%" && cs(lsRow).width === "100%"
    ? P("章行 / 课时行仍是整行宽（胶囊没被「⋯」挤窄）")
    : F("行宽被挤窄了: " + cs(chRow).width + " / " + cs(lsRow).width);
  d.getElementById("sylMoreBtn") && !d.getElementById("sylMoreBtn").hidden
    ? P("卡片头有「⋯」（整份大纲的操作）") : F("缺卡片头的「⋯」");

  /* ---------- 1b. 教案面板有**显式**的「删除教案」按钮（第 55 轮） ---------- */
  {
    // ⚠️ `.ls-row` 本身就是那个带 data-ls 的按钮（不是它的祖先）
    const lsBtn = d.querySelector("#outlineTree .ls-row[data-ls]");
    lsBtn ? P("树里有课时行可点") : F("树里没有课时行");
    if (lsBtn) {
      lsBtn.click();
      await settle(dom);
      const lsDel = d.getElementById("lsDelBtn");
      lsDel ? P("选中课时后，教案面板有显式的「删除教案」按钮") : F("教案面板没有显式删除按钮");
      if (lsDel) {
        let asked = "";
        w.confirm = (m) => { asked = String(m); return false; };
        lsDel.click();
        await settle(dom);
        /删除课时教案/.test(asked)
          ? P("点「删除教案」先弹二次确认") : F("删除教案没有二次确认: " + asked);
        /删除后无法撤销/.test(asked) ? P("确认框说明不可撤销") : F("确认框没提后果");
        w.LESSONS["cs401-c1-1"] ? P("点「取消」后教案还在") : F("取消了还是删了");
      }
    }
  }

  /* ---------- 2. 课时行菜单 → 删除教案 ---------- */
  d.querySelector('#outlineTree .tree-more[data-more="ls"]').click();
  await settle(dom);
  let menu = d.getElementById("treeMenu");
  menu ? P("点「⋯」弹出菜单") : F("菜单没出现");
  menu && menu.parentNode === d.body ? P("菜单挂在 body 上（不会被卡片裁掉）") : F("菜单挂错位置");
  /编辑教案/.test(menu.textContent) && /删除教案/.test(menu.textContent)
    ? P("课时菜单：编辑教案 / 删除教案") : F("课时菜单项不对: " + menu.textContent);

  // 取消 → 不删
  w.confirm = () => false;
  menu.querySelector('[data-act="del"]').click();
  await settle(dom);
  w.LESSONS["cs401-c1-1"] ? P("确认框点「取消」不会删除教案") : F("取消了还是删了");
  w.SYLLABUS.cs401.chapters[0].lessonIds.includes("cs401-c1-1")
    ? P("取消后章里仍挂着这份教案") : F("章里的引用被提前摘掉了");

  // 确定 → 删掉，并摘掉章里的引用；选中项自动挪走
  let confirmMsg = "";
  w.confirm = (m) => { confirmMsg = String(m); return true; };
  d.querySelector('#outlineTree .tree-more[data-more="ls"]').click();
  await settle(dom);
  d.getElementById("treeMenu").querySelector('[data-act="del"]').click();
  await settle(dom);
  /删除后无法撤销/.test(confirmMsg) ? P("确认框说明不可撤销") : F("确认框没提后果");
  /2 个版本记录/.test(confirmMsg) ? P("确认框说清了会删掉几个版本记录") : F("没提版本记录: " + confirmMsg);
  !w.LESSONS["cs401-c1-1"] ? P("删掉课时教案后数据真的没了") : F("教案还在");
  !w.SYLLABUS.cs401.chapters[0].lessonIds.includes("cs401-c1-1")
    ? P("章里的引用也摘干净了（不留悬挂 id）") : F("章里还留着已删教案的 id");
  d.getElementById("planPanel").textContent.length > 0
    ? P("选中项自动挪到还存在的对象上（右栏没空着）") : F("右栏空了");
  /这份教案已不存在/.test(d.getElementById("planPanel").textContent)
    ? F("右栏还停在被删掉的教案上") : P("右栏没有停在已删教案上");

  /* ---------- 3. 章里有教案时：直接说原因，不弹无效确认 ---------- */
  dom.window.close();
  dom = await open();
  await settle(dom);
  w = dom.window; d = w.document;

  let asked = false;
  w.confirm = () => { asked = true; return true; };
  d.querySelector('#outlineTree .tree-more[data-more="ch"]').click();
  await settle(dom);
  menu = d.getElementById("treeMenu");
  /编辑本章/.test(menu.textContent) && /新建课时教案/.test(menu.textContent) && /删除本章/.test(menu.textContent)
    ? P("章菜单：编辑本章 / 新建课时教案 / 删除本章") : F("章菜单项不对: " + menu.textContent);
  menu.querySelector('[data-act="del"]').click();
  await settle(dom);
  asked ? F("章里还有教案却弹了确认框（点了也会失败）") : P("章里还有教案时不弹确认框");
  w.SYLLABUS.cs401 && w.SYLLABUS.cs401.chapters.length === 2
    ? P("章没有被删掉") : F("章被误删了");
  const fb = d.getElementById("flash");
  fb && /还有 1 份课时教案/.test(fb.textContent)
    ? P("给出了可读原因（" + fb.textContent.replace(/\s+/g, " ").trim() + "）")
    : F("没有说明为什么删不了: " + (fb && fb.textContent));

  /* ---------- 4. 空章可以删 ---------- */
  let msg2 = "";
  w.confirm = (m) => { msg2 = String(m); return true; };
  // 第 2 章是空的 → 直接找到它的「⋯」
  const moreBtns = [...d.querySelectorAll("#outlineTree .tree-more")];
  const chMore = moreBtns.filter((b) => b.dataset.more === "ch");
  chMore[1].click();
  await settle(dom);
  d.getElementById("treeMenu").querySelector('[data-act="del"]').click();
  await settle(dom);
  /确定删除章节/.test(msg2) ? P("空章可以删（弹确认框）") : F("空章删除流程不对: " + msg2);
  w.SYLLABUS.cs401.chapters.length === 1 ? P("空章已删除") : F("章数不对: " + w.SYLLABUS.cs401.chapters.length);

  /* ---------- 5. 删除整份大纲 ---------- */
  dom.window.close();
  dom = await open();
  await settle(dom);
  w = dom.window; d = w.document;

  let msg3 = "";
  w.confirm = (m) => { msg3 = String(m); return false; };
  d.getElementById("sylMoreBtn").click();
  await settle(dom);
  menu = d.getElementById("treeMenu");
  /删除整份大纲/.test(menu.textContent) ? P("卡片头菜单：删除整份大纲") : F("菜单项不对: " + menu.textContent);
  menu.querySelector('[data-act="del"]').click();
  await settle(dom);
  /删除后无法撤销/.test(msg3) ? P("删整份大纲也有二次确认") : F("没有二次确认: " + msg3);
  w.SYLLABUS.cs401 ? P("点「取消」不会删除大纲") : F("取消了还是删了");

  w.confirm = (m) => { msg3 = String(m); return true; };
  d.getElementById("sylMoreBtn").click();
  await settle(dom);
  d.getElementById("treeMenu").querySelector('[data-act="del"]').click();
  await settle(dom);
  /会一起删除：2 章大纲、1 份课时教案/.test(msg3)
    ? P("确认框讲清了会连带删掉多少（" + msg3.split("\n").filter((x) => x.trim())[1] + "）")
    : F("确认框没讲清连带删除的量: " + msg3);
  !w.SYLLABUS.cs401 ? P("整份大纲已删除") : F("大纲还在");
  Object.keys(w.LESSONS).every((k) => w.LESSONS[k].courseId !== "cs401")
    ? P("该课下的课时教案一起清干净（不留孤儿数据）") : F("还有孤儿教案残留");
  !d.getElementById("outlineEmpty").hidden
    ? P("回到「还没有教案大纲」的空状态") : F("没回到空状态");
  d.getElementById("sylMoreBtn").hidden && d.getElementById("addChapterBtn").hidden
    ? P("没有大纲时两个入口都隐藏") : F("没大纲却还显示入口");

  dom.window.close();
}

console.log("\n=== 3d-7. 教案大纲调序：拖动 + 上移 / 下移 ===");
{
  const courses = JSON.stringify([{ id: "cs401", name: "编译原理", code: "CS401", page: "class.html" }]);
  const SYL = () => JSON.stringify({ cs401: { courseId: "cs401", goal: "", chapters: [
    { id: "cs401-c1", title: "第 1 章 · 引论", hours: 4, points: "", lessonIds: ["cs401-c1-1", "cs401-c1-2"] },
    { id: "cs401-c2", title: "第 2 章 · 词法分析", hours: 6, points: "", lessonIds: ["cs401-c2-1"] },
    { id: "cs401-c3", title: "第 3 章 · 语法分析", hours: 8, points: "", lessonIds: [] },
  ] } });
  const mkL = (id, ch, title) => [id, { id: id, courseId: "cs401", chapterId: ch, title: title,
    minutes: 45, status: "draft", head: 0, commits: [{ id: "v1", kind: "init", msg: "新建课时教案", snap: {} }] }];
  const LSN = () => JSON.stringify(Object.fromEntries([
    mkL("cs401-c1-1", "cs401-c1", "第 1 章 · 第 1 课时：L1"),
    mkL("cs401-c1-2", "cs401-c1", "第 1 章 · 第 2 课时：L2"),
    mkL("cs401-c2-1", "cs401-c2", "第 2 章 · 第 1 课时：L3"),
  ]));
  const open = () => load("lesson.html", {
    role: "teacher", query: "?course=cs401",
    restore: { ls: { st_current_user: "teacher:zhangsan", "st_courses:teacher:zhangsan": courses,
                     st_syllabus: SYL(), st_lessons: LSN() } },
  });
  const chIds = (w) => w.SYLLABUS.cs401.chapters.map((c) => c.id).join(",");
  const lsIds = (w, ch) => (w.SYLLABUS.cs401.chapters.find((c) => c.id === ch) || {}).lessonIds.join(",");

  /* ---------- 1. 行可拖动 + 菜单有上移下移 ---------- */
  let dom = await open();
  await settle(dom);
  let w = dom.window, d = w.document;

  // 不写死行数：章行 + 课时行都该可拖
  const rowN = d.querySelectorAll("#outlineTree .ch-row").length + d.querySelectorAll("#outlineTree .ls-row").length;
  d.querySelectorAll('#outlineTree [draggable="true"]').length === rowN && rowN === 6
    ? P("大纲树 " + rowN + " 行（3 章 + 3 课时）全部可拖动")
    : F("可拖动行数不对: " + d.querySelectorAll('#outlineTree [draggable="true"]').length + " / 共 " + rowN);
  d.querySelector('#outlineTree .ch-row').dataset.drag === "ch"
    && d.querySelector('#outlineTree .ls-row').dataset.drag === "ls"
    ? P("行上用 data-drag 标出类型（章 / 课时）") : F("缺 data-drag 标记");

  d.querySelector('#outlineTree .tree-more[data-more="ch"]').click();
  await settle(dom);
  let menu = d.getElementById("treeMenu");
  /上移本章/.test(menu.textContent) && /下移本章/.test(menu.textContent)
    ? P("章菜单：上移本章 / 下移本章") : F("章菜单缺上移下移");
  menu.querySelector('[data-act="down"]').click();
  await settle(dom);
  chIds(w) === "cs401-c2,cs401-c1,cs401-c3"
    ? P("点「下移本章」真的换了顺序（" + chIds(w) + "）") : F("顺序没变: " + chIds(w));
  d.querySelector("#outlineTree .ch-row.active")
    && d.querySelector("#outlineTree .ch-row.active").dataset.ch === "cs401-c1"
    ? P("调序后被调的那一章仍保持选中") : F("选中项跑掉了");
  dom.window.close();

  /* ---------- 2. 边界：到顶了给提示而不是乱动 ---------- */
  dom = await open();
  await settle(dom);
  w = dom.window; d = w.document;
  const order0 = chIds(w);
  d.querySelector('#outlineTree .tree-more[data-more="ch"]').click();
  await settle(dom);
  d.getElementById("treeMenu").querySelector('[data-act="up"]').click();
  await settle(dom);
  const fb = d.getElementById("flash");
  fb && /已经是第一章了/.test(fb.textContent) ? P("第一章再上移 → 提示「" + fb.textContent.trim() + "」")
    : F("边界提示缺失: " + (fb && fb.textContent));
  chIds(w) === order0 ? P("边界操作没有改动数据") : F("边界操作却改动了顺序");
  dom.window.close();

  /* ---------- 3. 拖动：章节重排 ---------- */
  dom = await open();
  await settle(dom);
  w = dom.window; d = w.document;
  // jsdom 不做布局 → 自己给个假矩形，用 clientY 控制「拖到上半边还是下半边」
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 0, height: 40, left: 0, right: 0, bottom: 40, width: 0, x: 0, y: 0 };
  };
  const mouse = (type, y) => new w.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y });
  const marks = () => d.querySelectorAll("#outlineTree .drop-before, #outlineTree .drop-after, #outlineTree .drop-into").length;

  const ch1 = d.querySelector('#outlineTree [data-ch="cs401-c1"]');
  const ch3 = d.querySelector('#outlineTree [data-ch="cs401-c3"]');
  ch1.dispatchEvent(mouse("dragstart", 10));
  ch1.classList.contains("dragging") ? P("拖动开始时该行标记为 dragging") : F("没有 dragging 标记");
  ch3.dispatchEvent(mouse("dragover", 30));      // 下半边 → 插到后面
  marks() === 1 && !!d.querySelector("#outlineTree .drop-after")
    ? P("拖到下半边 → 显示「插到其后」的落点指示") : F("落点指示不对（" + marks() + " 处）");
  ch3.dispatchEvent(mouse("drop", 30));
  chIds(w) === "cs401-c2,cs401-c3,cs401-c1"
    ? P("拖放后章节顺序变成 " + chIds(w)) : F("拖放没生效: " + chIds(w));
  marks() === 0 && d.querySelectorAll("#outlineTree .dragging").length === 0
    ? P("放完清掉落点指示与 dragging") : F("拖放后状态没清干净");

  /* ---------- 4. 拖动：课时跨章移动 ---------- */
  const ls1 = d.querySelector('#outlineTree [data-ls="cs401-c1-1"]');
  const ch2 = d.querySelector('#outlineTree [data-ch="cs401-c2"]');
  ls1.dispatchEvent(mouse("dragstart", 10));
  ch2.dispatchEvent(mouse("dragover", 20));
  d.querySelector("#outlineTree .drop-into")
    ? P("拖课时落在「章行」上 → 显示「移入本章」的整行指示") : F("没有移入指示");
  ch2.dispatchEvent(mouse("drop", 20));
  lsIds(w, "cs401-c2") === "cs401-c2-1,cs401-c1-1" && lsIds(w, "cs401-c1") === "cs401-c1-2"
    ? P("课时被移入第 2 章末尾，原章不残留（" + lsIds(w, "cs401-c1") + " / " + lsIds(w, "cs401-c2") + "）")
    : F("跨章移动结果不对: " + lsIds(w, "cs401-c1") + " | " + lsIds(w, "cs401-c2"));
  w.LESSONS["cs401-c1-1"].chapterId === "cs401-c2"
    ? P("跨章移动后教案的 chapterId 同步改了") : F("chapterId 没同步");
  d.querySelector("#outlineTree .ls-row.active")
    && d.querySelector("#outlineTree .ls-row.active").dataset.ls === "cs401-c1-1"
    ? P("跨章移动后被移的课时仍保持选中") : F("选中项跑掉了");

  /* ---------- 5. 拖动：不该接受的情况要静默拒绝 ---------- */
  const chA = d.querySelector('#outlineTree [data-ch="cs401-c1"]');
  const anyLs = d.querySelector("#outlineTree .ls-row");
  const orderBefore = chIds(w);
  chA.dispatchEvent(mouse("dragstart", 10));
  anyLs.dispatchEvent(mouse("dragover", 30));
  marks() === 0 ? P("拖「章」落在课时行上 → 不显示落点（章只在章之间排序）") : F("章落到了课时行上");
  anyLs.dispatchEvent(mouse("drop", 30));
  chIds(w) === orderBefore ? P("拖章落到课时行上被忽略（顺序没变）") : F("顺序被误改了");
  chA.dispatchEvent(mouse("dragstart", 10));
  chA.dispatchEvent(mouse("dragover", 30));
  marks() === 0 ? P("拖到自己身上 → 不显示落点") : F("拖到自己身上却显示了落点");
  chA.dispatchEvent(mouse("dragend", 10));
  marks() === 0 && d.querySelectorAll("#outlineTree .dragging").length === 0
    ? P("dragend 清空全部拖动状态") : F("dragend 没清干净");

  /* ---------- 6. 拖动结果要落库（重开还在） ---------- */
  const savedSyl = String(w.localStorage.getItem("st_syllabus"));
  const savedLsn = String(w.localStorage.getItem("st_lessons"));
  dom.window.close();
  const dom2 = load("lesson.html", {
    role: "teacher", query: "?course=cs401",
    restore: { ls: { st_current_user: "teacher:zhangsan", "st_courses:teacher:zhangsan": courses,
                     st_syllabus: savedSyl, st_lessons: savedLsn } },
  });
  await settle(dom2);
  const w2 = dom2.window, d2 = w2.document;
  d2.querySelectorAll("#outlineTree .ch-block").length
    && d2.querySelector("#outlineTree .ch-block").querySelector(".ch-row").dataset.ch === "cs401-c2"
    ? P("重开后章节顺序还是拖动后的（第 1 项是第 2 章）") : F("顺序没保住");
  w2.LESSONS["cs401-c1-1"] && w2.LESSONS["cs401-c1-1"].chapterId === "cs401-c2"
    ? P("重开后课时的归属也保住了") : F("课时归属没保住");
  dom2.window.close();
}

console.log("\n=== 3d-8. 教案大纲的版本链（结构变更留痕 / 对比 / 回退）===");
{
  /* 用户原话：「开始做版本管理功能实现吧」→ 选定「先补教案大纲的版本」。
     原来只有课时教案有版本链，大纲（章 / 课时的结构）改了查不到。
     现在结构也快照化：加章 / 删章 / 调序 / 改章信息都追加一版，可对比可回退。 */
  const courses = JSON.stringify([{ id: "ds", name: "数据结构与算法", code: "CS201", page: "class.html" }]);
  const dom = load("lesson.html", {
    role: "teacher", query: "?course=ds",
    restore: { ls: { st_current_user: "teacher:teacher", "st_courses:teacher:teacher": courses } },
  });
  const w = dom.window, d = w.document;
  await settle(dom);
  w.confirm = () => true;

  const chk = (n, c, x) => { c ? P(n) : F(n + (x === undefined ? "" : "   " + JSON.stringify(x))); };
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

  /* ---------- 1. 入口 ---------- */
  const verBtn = d.getElementById("sylVerBtn");
  verBtn ? chk("卡片头有「版本」入口", true) : chk("缺版本入口", false);
  /^版本 \d+$/.test(txt(verBtn)) ? chk("按钮上带版本数（" + txt(verBtn) + "）", true) : chk("按钮没有版本数", false, txt(verBtn));
  chk("初始是 1 个版本（种子）", /版本 1/.test(txt(verBtn)), txt(verBtn));

  verBtn.click();
  await settle(dom);
  const panel = d.getElementById("planPanel");
  /教案大纲 · 版本历史/.test(txt(panel)) ? chk("点开后右栏切到版本历史", true) : chk("没切过去", false, txt(panel).slice(0, 40));
  d.getElementById("sylHistBackBtn") ? chk("有「返回教案」按钮", true) : chk("缺返回按钮", false);
  /历史只增不减/.test(txt(panel)) ? chk("写明了「历史只增不减」", true) : chk("缺说明", false);
  /课时教案的内容有它自己的版本链/.test(txt(panel))
    ? chk("说明了这里只管结构（与课时版本链分工清楚）", true) : chk("没说明分工", false);
  d.querySelectorAll("#planPanel .ver-item").length === 1 ? chk("时间线列出 1 个版本", true)
    : chk("版本条数不对", false, d.querySelectorAll("#planPanel .ver-item").length);

  /* ---------- 2. 结构改动 → 出版本 ---------- */
  d.getElementById("addChapterBtn").click();
  await settle(dom);
  const m = d.getElementById("modalHost");
  m.querySelector("#cTitle").value = "第 9 章 · 文件";
  m.querySelector("#formSave").click();
  await settle(dom);

  verBtn.click();
  await settle(dom);
  const items = [...d.querySelectorAll("#planPanel .ver-item")];
  items.length === 2 ? chk("加了一章之后，时间线变 2 版", true) : chk("版本数不对", false, items.length);
  /新增章节「第 9 章 · 文件」/.test(txt(items[0])) ? chk("最新一版写着「新增章节「第 9 章 · 文件」」", true)
    : chk("说明不对", false, txt(items[0]));
  /调整结构/.test(txt(items[0])) ? chk("类型徽标是「调整结构」", true) : chk("类型徽标不对", false, txt(items[0]));
  /当前结构/.test(txt(items[0])) ? chk("最新一版标了「当前结构」", true) : chk("没标当前结构", false);
  /版本 2/.test(txt(verBtn)) ? chk("按钮计数跟着变（" + txt(verBtn) + "）", true) : chk("按钮没跟着变", false, txt(verBtn));

  /* ---------- 3. 对比 ---------- */
  const diffBtn = items[0].querySelector("[data-sdiff]");
  diffBtn ? chk("最新一版有「与上一版对比」", true) : chk("缺对比按钮", false);
  items[1].querySelector("[data-sdiff]") === null ? chk("最早一版没有对比按钮（没有上一版）", true)
    : chk("第一版不该有对比按钮", false);
  diffBtn.click();
  await settle(dom);
  const box = d.getElementById("sylDiffBox");
  /1 处结构变化/.test(txt(box)) ? chk("对比摘要显示「1 处结构变化」", true) : chk("摘要不对", false, txt(box).slice(0, 40));
  const line = box.querySelector(".diff-line");
  line && /add/.test(line.className) ? chk("新增的章标为 add（绿底 + 号）", true) : chk("diff 行不对", false, line && line.className);
  /第 9 章 · 文件/.test(txt(line)) ? chk("写出章名", true) : chk("没写章名", false, txt(line));
  /放在第 5 章/.test(txt(line)) ? chk("写出落点「放在第 5 章」", true) : chk("没写落点", false, txt(line));
  d.getElementById("sylDiffClose") ? chk("对比面板可收起", true) : chk("缺收起按钮", false);
  d.getElementById("aiSylDiffBtn") ? chk("对比面板有「让 AI 解读」入口", true) : chk("缺 AI 入口", false);

  /* ---------- 3b. 大纲任意两版对比（第 57 轮） ---------- */
  {
    const vsA = [...d.querySelectorAll("#planPanel .ver-item")];
    vsA.length >= 2 && vsA.every((x) => x.querySelector("[data-spick]"))
      ? chk("大纲每一版都有「选作对比」", true) : chk("大纲缺「选作对比」", false);
    vsA[vsA.length - 1].querySelector("[data-spick]").click();
    await settle(dom);
    d.querySelector("#planPanel .pick-bar")
      ? chk("大纲选起点后出现提示条", true) : chk("大纲选起点没有提示条", false);
    const other = [...d.querySelectorAll("#planPanel .ver-item")][0].querySelector("[data-spick]");
    if (other) {
      other.click();
      await settle(dom);
      /→/.test(txt(d.getElementById("sylDiffBox")))
        ? chk("任意两版大纲对比出结果（不必相邻）", true) : chk("任意两版大纲对比没出结果", false);
    }
  }

  /* ---------- 4. AI 交接 ---------- */
  d.getElementById("aiSylDiffBtn").click();
  await settle(dom);
  const task = JSON.parse(String(w.localStorage.getItem("st_agent_task") || "{}"));
  task.task === "explain-outline-diff" ? chk("AI 任务类型正确", true) : chk("任务类型不对", false, task.task);
  /第 9 章 · 文件/.test(task.text || "") ? chk("交接文本带上了改动内容", true) : chk("交接文本没带内容", false, task.text);
  task.payload && task.payload.changed === 1 ? chk("交接附带结构化 payload", true) : chk("缺 payload", false, task.payload);

  /* ---------- 5. 回退：追加一版，结构还原 ---------- */
  verBtn.click();
  await settle(dom);
  const last = [...d.querySelectorAll("#planPanel .ver-item")].pop();
  const revBtn = last.querySelector("[data-srevert]");
  revBtn ? chk("旧版本有「回到这版」", true) : chk("缺回退按钮", false);
  chk("当前版本没有「回到这版」", items[0].querySelector("[data-srevert]") === null);
  let confirmText = "";
  w.confirm = (msg) => { confirmText = String(msg); return true; };
  revBtn.click();
  await settle(dom);
  /回到 v1/.test(confirmText) ? chk("确认框写明回到哪一版", true) : chk("确认框不对", false, confirmText);
  /历史不会被删掉/.test(confirmText) ? chk("确认框讲清「历史不会被删」", true) : chk("没讲清", false, confirmText);
  /不会因此恢复/.test(confirmText) ? chk("确认框提醒「删掉的教案不会恢复」", true) : chk("没提醒", false, confirmText);

  verBtn.click();
  await settle(dom);
  const items2 = [...d.querySelectorAll("#planPanel .ver-item")];
  items2.length === 3 ? chk("回退也是新增一版（2 → 3）", true) : chk("版本数不对", false, items2.length);
  /回到 v1/.test(txt(items2[0])) ? chk("回退版的说明写着「回到 v1」", true) : chk("说明不对", false, txt(items2[0]));
  /回退/.test(txt(items2[0])) ? chk("类型徽标是「回退」", true) : chk("徽标不对", false, txt(items2[0]));
  w.syllabusChapters("ds").length === 4 ? chk("结构回到 4 章（第 9 章没了）", true)
    : chk("结构没还原", false, w.syllabusChapters("ds").length);
  !/第 9 章/.test(txt(d.getElementById("outlineTree"))) ? chk("左栏大纲树也跟着还原", true)
    : chk("左栏没还原", false, txt(d.getElementById("outlineTree")));

  /* ---------- 6. 返回 / 退出 ---------- */
  d.getElementById("sylHistBackBtn").click();
  await settle(dom);
  !/版本历史/.test(txt(d.getElementById("planPanel"))) ? chk("点「返回教案」退出历史视图", true)
    : chk("没退出", false, txt(d.getElementById("planPanel")).slice(0, 30));

  verBtn.click();
  await settle(dom);
  /版本历史/.test(txt(d.getElementById("planPanel"))) ? chk("再次进入历史视图", true) : chk("进不去", false);
  d.querySelector("#outlineTree .ch-row").click();
  await settle(dom);
  !/版本历史/.test(txt(d.getElementById("planPanel"))) ? chk("点左栏的章行会自动退出历史视图", true)
    : chk("点章行没退出", false);

  /* ---------- 7. 拖动调序也会出版本 ---------- */
  const before = w.SYLLABUS.ds.commits.length;
  w.moveChapterBy("ds", w.syllabusChapters("ds")[0].id, 1);
  chk("拖动 / 上移下移同样走版本链（" + before + " → " + w.SYLLABUS.ds.commits.length + "）",
    w.SYLLABUS.ds.commits.length === before + 1);
  /调整章节顺序/.test(w.SYLLABUS.ds.commits[w.SYLLABUS.ds.head].msg)
    ? chk("调序版本的说明是「调整章节顺序」", true)
    : chk("调序说明不对", false, w.SYLLABUS.ds.commits[w.SYLLABUS.ds.head].msg);


  dom.window.close();
}

console.log("\n=== 3e. 课表：导入 / 设置（真实 DOM 交互）===");
{
  /* ---- 解析器（纯逻辑，但用真 DOM 环境跑，确保与页面同一份实现）---- */
  const dom0 = load("schedule.html", { role: "teacher" });
  await settle(dom0);
  const w0 = dom0.window;
  const parse = (t) => w0.parseSchedule(t);

  {
    const a = parse([
      "\t周一\t周二\t周三\t周四\t周五",
      "第1-2节\t数据结构与算法/6A-301\t\t操作系统/6B-105\t\t算法设计",
    ].join("\n"));
    a && a.week && a.week[0][0] && a.week[0][0].name === "数据结构与算法"
      ? P("二维表：列对齐正确（行首制表符不错位）") : F("二维表错位: " + JSON.stringify(a));
    a && a.week[0][2] && a.week[0][2].name === "操作系统"
      ? P("二维表：第 3 列落到周三") : F("二维表列映射错误");
    a && a.week[0][1] === null ? P("二维表：空单元格为空堂") : F("空单元格未识别");
    a && a.week[0][0].room === "6A-301" ? P("二维表：单元格内 / 分隔出教室") : F("教室未解析");

    const a2 = parse(["节次\t周一\t周二", "第1-2节\t数据结构与算法", "6A-301", "一班", "第3-4节\t操作系统"].join("\n"));
    a2 && a2.week[0][0] && a2.week[0][0].name === "数据结构与算法" && a2.week[0][0].room === "6A-301" && a2.week[0][0].cls === "一班"
      ? P("单元格内换行被正确合并成 课程/教室/班级") : F("单元格内换行未合并: " + JSON.stringify(a2.week && a2.week[0]));
    a2 && a2.slots.length === 2 ? P("后续节次行未被误并进上一行") : F("节次行被误并");

    const b = parse("周一,第1-2节,数据结构与算法,6A-301,计科2301\n周二,第3-4节,算法设计");
    b && b.days.length === 2 && b.slots.length === 2 && b.count === 2
      ? P("逐行 CSV：天数 / 节次 / 课数均正确") : F("逐行格式异常: " + JSON.stringify(b));
    b && b.week[0][0] && b.week[0][0].cls === "计科2301" ? P("逐行 CSV：班级列解析正确") : F("班级列未解析");
    b && b.week[1][1] && b.week[1][1].room === "" ? P("逐行 CSV：可省略教室 / 班级") : F("省略列处理异常");

    const b2 = parse("星期一\t第1-2节 08:00\t操作系统\t6B-105");
    b2 && !b2.error && b2.slots[0].label === "第1-2节" && b2.slots[0].time === "08:00"
      ? P("制表符逐行：正确回落，且节次名与时间分离") : F("制表符逐行误判: " + JSON.stringify(b2));

    const c = parse(["节次\t周一\t周二\t周三\t周四\t周五\t周六\t周日", "第1-2节\tA\t\tB\t\tC\t\tD"].join("\n"));
    c && c.days.length === 7 && c.week[0][6] && c.week[0][6].name === "D"
      ? P("7 天课表：识别到周日") : F("7 天课表解析异常: " + JSON.stringify(c && c.days));

    const d = parse(["节次\t周一\t周二\t周三", "第1-2节\t-\t无\t休息"].join("\n"));
    d && d.week[0].every((x) => x === null)
      ? P("「-」「无」「休息」都当空堂") : F("空堂写法未识别: " + JSON.stringify(d.week[0]));

    parse("").error ? P("空输入给出可读报错") : F("空输入未报错");
    parse("随便写点什么").error ? P("无法识别的输入给出可读报错") : F("垃圾输入未报错");

    const s = parse(w0.eval("IMPORT_SAMPLE"));
    s && !s.error && s.count === 9
      ? P(`「填入示例」的文本自身可解析（${s.count} 节课 / ${s.days.length} 天）`)
      : F("示例文本不可解析: " + JSON.stringify(s));
  }
  dom0.window.close();

  /* ---- 入口按钮 + 设置课表 ---- */
  const dom = load("schedule.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const w = dom.window;

  const importBtn = d.getElementById("importBtn");
  const configBtn = d.getElementById("configBtn");
  importBtn && configBtn ? P("卡片头渲染出「导入课表」「设置课表」两个按钮") : F("入口按钮缺失");
  importBtn && /导入课表/.test(importBtn.textContent) ? P("导入按钮文案正确") : F("导入按钮文案错误");
  configBtn && /设置课表/.test(configBtn.textContent) ? P("设置按钮文案正确") : F("设置按钮文案错误");

  const cellsOf = () => d.querySelectorAll("#weekGrid .week-cell").length;
  const rowsOf = () => d.querySelectorAll("#weekGrid .week-slot-label").length;
  const headCols = () => d.querySelectorAll("#weekHead span").length;

  rowsOf() === 4 && headCols() === 6
    ? P(`默认课表 4 节次 × 5 天（${cellsOf()} 格）`) : F(`默认课表结构异常: ${rowsOf()} 行 / ${headCols()} 列`);
  d.getElementById("weekHours").textContent === "9"
    ? P("本周课时按课表算出（9 节，非写死）") : F("课时数不对: " + d.getElementById("weekHours").textContent);
  d.getElementById("weekBody").dataset.source === "预置课表"
    ? P("数据来源记为「预置课表」（挂在 data-source 上，界面不再占位）")
    : F("来源记录错误: " + d.getElementById("weekBody").dataset.source);
  // 用户要求去掉卡片头那个「本机保存」小胶囊 —— 确认视觉上真的没了
  !/week-src|weekSource/.test(d.body.innerHTML)
    ? P("卡片头已无「本机保存」胶囊（原 #weekSource 已移除）") : F("胶囊仍在");
  d.getElementById("weekNo").textContent === "5" ? P("默认第 5 教学周") : F("默认教学周不对");

  /* 设置课表：改教学周 + 删节次 */
  configBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.querySelector("#modalHost .modal") ? P("点「设置课表」弹出弹窗") : F("设置弹窗未出现");
  d.getElementById("modalHost").hidden === false ? P("弹窗挂载点解除隐藏") : F("挂载点仍隐藏");
  // ⚠️ 壳内的 #modalHost 在壳文档里，内容页取不到 → 必须自己建一个
  d.getElementById("modalHost") === d.body.lastElementChild
    ? P("内容页自建了弹窗挂载点（未依赖壳的 #modalHost）") : info("挂载点位置: 非 body 末尾");
  d.getElementById("cfgWeekNo") ? P("设置弹窗含教学周输入") : F("缺教学周输入");
  const slotRows = d.querySelectorAll("#cfgSlots .slot-row");
  slotRows.length === 4 ? P("设置弹窗列出当前 4 个节次") : F("节次行数异常: " + slotRows.length);
  d.getElementById("cfgAddSlot") ? P("提供「＋ 添加节次」") : F("缺添加节次按钮");

  // 添加一个节次 → 5 行
  d.getElementById("cfgAddSlot").dispatchEvent(new w.Event("click", { bubbles: true }));
  d.querySelectorAll("#cfgSlots .slot-row").length === 5
    ? P("添加节次后变 5 行") : F("添加节次无效");
  // 删掉刚加的
  const delBtns = d.querySelectorAll("#cfgSlots .slot-del");
  delBtns[4].dispatchEvent(new w.Event("click", { bubbles: true }));
  d.querySelectorAll("#cfgSlots .slot-row").length === 4
    ? P("删除节次后回到 4 行") : F("删除节次无效");

  // 改教学周为 9 + 改第一个节次时间 → 保存
  d.getElementById("cfgWeekNo").value = "9";
  const firstLabel = d.querySelector("#cfgSlots .slot-row [data-f='label']");
  firstLabel.value = "第 1–2 节";
  const firstTime = d.querySelector("#cfgSlots .slot-row [data-f='time']");
  firstTime.value = "07:50";
  d.getElementById("cfgSave").dispatchEvent(new w.Event("click", { bubbles: true }));

  d.getElementById("modalHost").hidden ? P("保存后弹窗关闭") : F("保存后弹窗未关");
  d.getElementById("weekNo").textContent === "9"
    ? P("表头教学周更新为 9") : F("教学周未更新: " + d.getElementById("weekNo").textContent);
  /07:50/.test(d.getElementById("weekGrid").innerHTML)
    ? P("节次时间改动反映到课表左列") : F("节次时间未更新");
  d.getElementById("weekBody").dataset.source === "本机设置"
    ? P("来源记录变为「本机设置」") : F("来源未更新: " + d.getElementById("weekBody").dataset.source);
  JSON.parse(w.localStorage.getItem("st_schedule")).weekNo === 9
    ? P("设置已持久化到 localStorage") : F("设置未持久化");

  /* 空校验：教学周填 0 → 拦下 */
  configBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.getElementById("cfgWeekNo").value = "0";
  d.getElementById("cfgSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  const cerr = d.getElementById("cfgError");
  cerr && !cerr.hidden ? P("非法教学周被拦下并提示") : F("非法教学周未被拦下");
  d.getElementById("modalHost").hidden === false ? P("校验失败时弹窗保持打开") : F("校验失败却关了弹窗");

  /* Esc 关闭 */
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  d.getElementById("modalHost").hidden ? P("按 Esc 关闭设置弹窗") : F("Esc 未关闭");
  !d.body.classList.contains("modal-open") ? P("关闭后解除滚动锁") : F("滚动锁未解除");

  /* 恢复预置课表 */
  configBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.getElementById("cfgReset").dispatchEvent(new w.Event("click", { bubbles: true }));
  d.getElementById("weekNo").textContent === "5" && rowsOf() === 4
    ? P("「恢复预置课表」还原教学周与节次") : F("恢复预置课表无效");
  d.getElementById("weekBody").dataset.source === "预置课表"
    ? P("恢复后来源记录回到「预置课表」") : F("来源未复位");

  /* ---- 导入课表 ---- */
  importBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.querySelector("#modalHost .modal") ? P("点「导入课表」弹出弹窗") : F("导入弹窗未出现");
  d.querySelector("#modalHost .modal.modal-wide") ? P("导入弹窗用加宽版式（模态类 .modal-wide）") : F("导入弹窗未加宽");
  d.getElementById("impText") ? P("提供粘贴框 #impText") : F("缺粘贴框");
  const fileEl = d.getElementById("impFile");
  fileEl ? P("提供文件选择 #impFile") : F("缺文件选择");
  fileEl && /\.csv/.test(fileEl.getAttribute("accept")) ? P("文件选择限定 .csv/.txt") : F("未限定文件类型");
  d.getElementById("impSample") ? P("提供「填入示例」") : F("缺填入示例按钮");

  // 先给一段坏内容 → 报错且不能导入
  d.getElementById("impText").value = "随便写点什么";
  d.getElementById("impText").dispatchEvent(new w.Event("input", { bubbles: true }));
  const ierr = d.getElementById("impError");
  ierr && !ierr.hidden ? P("无法识别的内容当场报错") : F("坏内容未报错");
  d.getElementById("impPreview").hidden ? P("解析失败时不显示可导入预览") : F("失败时仍显示预览");

  // 填入示例 → 实时预览
  d.getElementById("impSample").dispatchEvent(new w.Event("click", { bubbles: true }));
  const pv = d.getElementById("impPreview");
  !pv.hidden && /9/.test(pv.textContent) ? P("填入示例后实时预览「9 节课」") : F("预览异常: " + pv.textContent);
  ierr.hidden ? P("解析成功后清除报错") : F("成功后报错未清除");

  // 真导入
  d.getElementById("impApply").dispatchEvent(new w.Event("click", { bubbles: true }));
  d.getElementById("modalHost").hidden ? P("导入后弹窗关闭") : F("导入后弹窗未关");
  rowsOf() === 4 ? P("导入后仍是 4 个节次（来自导入内容）") : F("导入后节次异常: " + rowsOf());
  cellsOf() === 20 ? P("导入后 4 × 5 = 20 个格子") : F("导入后格子数异常: " + cellsOf());
  d.getElementById("weekHours").textContent === "9"
    ? P("导入后本周课时重新计算为 9 节") : F("导入后课时未重算");
  /导入/.test(d.getElementById("weekBody").dataset.source)
    ? P("来源记录显示为导入（含课数）") : F("来源未反映导入");
  /6A-301/.test(d.getElementById("weekGrid").innerHTML)
    ? P("导入的教室信息渲染进了课表") : F("导入内容未渲染");

  // 导入 7 天课表 → 列数跟着变
  importBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.getElementById("impText").value = [
    "节次\t周一\t周二\t周三\t周四\t周五\t周六\t周日",
    "第1-2节\t数据结构与算法\t\t操作系统\t\t算法设计\t\t答疑与辅导",
  ].join("\n");
  d.getElementById("impApply").dispatchEvent(new w.Event("click", { bubbles: true }));
  headCols() === 8 ? P("导入 7 天课表后表头变 8 列（含「节次」）") : F("表头列数未跟随: " + headCols());
  cellsOf() === 7 ? P("7 天 × 1 节次 = 7 个格子") : F("格子数异常: " + cellsOf());
  /答疑与辅导/.test(d.getElementById("weekGrid").innerHTML)
    ? P("周日的内容也渲染出来了（未被丢掉）") : F("7 天课表末列丢失");

  dom.window.close();
}

console.log("\n=== 3f. 课表设置的持久化（模拟下次打开）===");
{
  const jar = new CookieJar();
  const dom1 = load("schedule.html", { role: "teacher", jar });
  await settle(dom1);
  const d1 = dom1.window.document;
  const w1 = dom1.window;
  d1.getElementById("configBtn").dispatchEvent(new w1.Event("click", { bubbles: true }));
  d1.getElementById("cfgWeekNo").value = "12";
  d1.getElementById("cfgSave").dispatchEvent(new w1.Event("click", { bubbles: true }));
  const saved = w1.localStorage.getItem("st_schedule");
  d1.getElementById("weekNo").textContent === "12" ? P("改成第 12 教学周并保存") : F("保存失败");
  dom1.window.close();

  // 重新打开 → 读回上次的设置，而不是回到演示数据
  const dom2 = load("schedule.html", { role: "teacher", jar, restore: { ls: { st_schedule: saved } } });
  await settle(dom2);
  const d2 = dom2.window.document;
  d2.getElementById("weekNo").textContent === "12"
    ? P("下次打开读回第 12 教学周（未被打回演示数据）") : F("持久化失效: " + d2.getElementById("weekNo").textContent);
  d2.getElementById("weekBody").dataset.source === "本机保存"
    ? P("来源记录为「本机保存」") : F("来源记录错误: " + d2.getElementById("weekBody").dataset.source);
  dom2.window.close();

  // 存档损坏时不能白屏
  const dom3 = load("schedule.html", { role: "teacher", jar, restore: { ls: { st_schedule: "{oops not json" } } });
  await settle(dom3);
  const d3 = dom3.window.document;
  d3.querySelectorAll("#weekGrid .week-slot-label").length === 4
    ? P("存档损坏时安全回落到演示数据（不白屏）") : F("坏存档导致课表渲染失败");
  dom3.window.close();
}

console.log("\n=== 3g. 随附样例文件必须真的能导入（读磁盘真实字节）===");
{
  // ⚠️ 这一节故意从磁盘读真实文件、用真实解析器跑一遍。
  //    样例文件是最容易「悄悄烂掉」的东西 —— 改了格式却没人发现，
  //    演示时才发现导不进去。所以让它们进回归。
  const dom = load("schedule.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const w = dom.window;

  const samples = [
    { file: "sample-schedule.csv",        kind: "逐行 CSV" },
    { file: "sample-schedule-grid.txt",   kind: "二维表" },
  ];

  for (const s of samples) {
    const full = path.join(SITE, s.file);
    if (!fs.existsSync(full)) { F(`样例文件缺失: ${s.file}`); continue; }
    const text = fs.readFileSync(full, "utf8");        // 与页面 readAsText 一致
    const p = w.parseSchedule(text);
    if (p.error) { F(`${s.file}（${s.kind}）无法解析: ${p.error}`); continue; }

    P(`${s.file}（${s.kind}）可解析：${p.count} 节课 / ${p.slots.length} 节次 × ${p.days.length} 天`);
    !p.skipped ? P(`${s.file} 没有被跳过的行`) : F(`${s.file} 有无法识别的行: ${JSON.stringify(p.skipped)}`);
    // 🔴 BOM：CSV 带 BOM 才方便用 Excel 打开，但绝不能污染第一格
    p.days[0] === "周一" ? P(`${s.file} 首列识别为「周一」（BOM 未污染数据）`)
      : F(`${s.file} 首格被污染: ${JSON.stringify(p.days[0])}`);
    p.week.flat().filter(Boolean).every((c) => !/[\uFEFF\uFFFD]/.test(c.name))
      ? P(`${s.file} 课程名无 BOM / 乱码`) : F(`${s.file} 课程名含 BOM 或乱码`);

    // 🔴 节次必须按时间升序：逐行格式按天分组写，首次出现顺序不是时间顺序
    const nums = p.slots.map((x) => Number((String(x.label).match(/\d+/) || [0])[0]));
    nums.every((n, i) => i === 0 || nums[i - 1] <= n)
      ? P(`${s.file} 节次按时间升序（${nums.join(" ≤ ")}）`)
      : F(`${s.file} 节次顺序乱跳: ${JSON.stringify(nums)}`);

    p.week.flat().filter(Boolean).every((c) => c.name && c.room && c.cls)
      ? P(`${s.file} 每格都有课程 / 教室 / 班级`) : F(`${s.file} 有格子缺字段`);

    // 真灌进页面渲染一遍，确认所见即所得
    w.setState({ weekNo: 5, slots: p.slots, days: p.days, week: p.week }, "导入");
    d.querySelectorAll("#weekGrid .week-slot-label").length === p.slots.length
      ? P(`${s.file} 渲染出 ${p.slots.length} 行节次`) : F(`${s.file} 渲染行数不符`);
    d.querySelectorAll("#weekGrid .week-cell").length === p.slots.length * p.days.length
      ? P(`${s.file} 渲染出完整网格（${p.slots.length}×${p.days.length}）`) : F(`${s.file} 网格不完整`);
    d.getElementById("weekHours").textContent === String(p.count)
      ? P(`${s.file} 课时统计与解析结果一致`) : F(`${s.file} 课时统计不符`);
    /数据结构与算法/.test(d.getElementById("weekGrid").innerHTML)
      ? P(`${s.file} 内容真渲染进课表`) : F(`${s.file} 内容未渲染`);
  }

  // 弹窗里要能直接下载样例（否则演示时观众找不到文件）
  d.getElementById("importBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  const links = [...d.querySelectorAll("#modalHost a[download]")].map((a) => a.getAttribute("href"));
  links.includes("sample-schedule.csv") && links.includes("sample-schedule-grid.txt")
    ? P("导入弹窗提供两个样例文件的下载链接") : F("弹窗缺样例下载链接: " + JSON.stringify(links));
  dom.window.close();
}

console.log("\n=== 3h. 导入课表「方式三：AI 解析」→ 跳转 AI 助手 ===");
{
  /* ---- 壳内：内容页发出的 st-navigate 必须连 query 一起切过去 ---- */
  const shell = load("app.html", { role: "teacher" });
  await settle(shell);
  const sd = shell.window.document;
  const sw = shell.window;

  sw.dispatchEvent(new sw.MessageEvent("message", {
    data: { type: "st-navigate", page: "agent.html?task=parse-schedule" },
    origin: "http://localhost",
  }));
  await settle(shell);

  const src = sd.getElementById("contentFrame").getAttribute("src");
  src === "agent.html?task=parse-schedule"
    ? P("深链跳转保留 query（iframe.src = agent.html?task=parse-schedule）")
    : F("跳转丢了 query: " + src);
  /agent\.html\?task=parse-schedule/.test(sw.location.hash)
    ? P("hash 同步带 query") : F("hash 未同步: " + sw.location.hash);

  // 深链没有精确对应的菜单项 → 必须退回让「AI 助手」高亮，而不是一个都不亮
  const deepAct = [...sd.querySelectorAll("#shellSide .side-item.active")];
  deepAct.length === 1 && /AI 助手/.test((deepAct[0].querySelector(".side-label") || {}).textContent || "")
    ? P("带 query 的深链仍能让「AI 助手」高亮（退回比对裸页名）")
    : F("深链高亮异常: " + deepAct.map((b) => b.dataset.page).join(",") + " / 共 " + deepAct.length);

  // 班级项必须仍然精确匹配，不能被上面那条规则弄成「都亮」
  sw.go("class.html?cls=cs2302");
  const clsAct = [...sd.querySelectorAll("#shellSide .side-item.active")];
  clsAct.length === 1 && /cs2302/.test(clsAct[0].dataset.page)
    ? P("班级项仍精确高亮（退回规则不会让多个班一起亮）")
    : F("班级高亮被破坏: " + clsAct.map((b) => b.dataset.page).join(","));
  // 精确命中优先：切到另一个班不能残留
  sw.go("class.html?cls=cs2301");
  const clsAct2 = [...sd.querySelectorAll("#shellSide .side-item.active")];
  clsAct2.length === 1 && /cs2301/.test(clsAct2[0].dataset.page)
    ? P("切到另一个班后高亮唯一切换") : F("班级高亮未唯一切换");
  // 越权拦截不受 query 影响
  sw.go("reader.html?x=1");
  /reader\.html\?x=1/.test(sd.getElementById("contentFrame").getAttribute("src") || "")
    ? F("带 query 的跨端目标未被拦截: " + sd.getElementById("contentFrame").getAttribute("src"))
    : P("带 query 的跨端目标同样被拦下（归属判断只看裸页名）");
  shell.window.close();

  /* ---- 内容页：方式三按钮 + 任务交接 ---- */
  const dom = load("schedule.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const w = dom.window;

  d.getElementById("importBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  const modalHtml = d.getElementById("modalHost").innerHTML;
  !/跨域/.test(modalHtml) ? P("顶部「无法跨域」提示栏已删除") : F("跨域提示栏仍存在");
  !/浏览器跨域取不到教务系统/.test(modalHtml) ? P("跨域解释文案已彻底移除") : F("仍残留跨域文案");

  const aiBtn = d.getElementById("impAi");
  aiBtn ? P("弹窗里有「方式三」入口（#impAi）") : F("缺方式三入口");
  aiBtn && /AI 助手/.test(aiBtn.textContent) ? P("方式三按钮指向 AI 助手") : F("方式三按钮文案不对");
  const alt = d.querySelector(".imp-alt-text");
  alt && /格式/.test(alt.textContent) ? P("方式三有格式转换的说明文字") : F("方式三说明缺失");
  d.querySelector(".imp-alt") ? P("方式三有独立分区（视觉上与方式一/二分开）") : F("方式三未分区");

  // 方式一/二 仍然完好（别为了加三把前两个弄坏）
  d.getElementById("impText") && d.getElementById("impFile") && d.getElementById("impSample")
    ? P("方式一（粘贴）/ 方式二（文件）/ 填入示例 均未受影响") : F("方式一或二被破坏");

  // 点方式三 → 写入任务 + 跳转（jsdom 不真导航，改为拦截 navigate 的入参）
  d.getElementById("impText").value = "周一 1-2 高数 A101 计科2301 张三\n周二 3-4 大物";
  const origNavigate = w.navigate;
  let askedFor = null;
  w.navigate = (p) => { askedFor = p; return origNavigate.call(w, p); };
  aiBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  w.navigate = origNavigate;

  askedFor === "agent.html?task=parse-schedule"
    ? P("点方式三请求跳转到 agent.html?task=parse-schedule")
    : F("跳转目标不对: " + askedFor);
  d.getElementById("modalHost").hidden ? P("跳转前先关掉弹窗") : F("弹窗未关闭");
  !d.body.classList.contains("modal-open") ? P("跳转前解除滚动锁") : F("滚动锁未解除");

  const raw = w.localStorage.getItem("st_agent_task");
  raw ? P("任务写入 st_agent_task（交给 AI 助手的交接点）") : F("未写入 st_agent_task");
  const task = raw ? JSON.parse(raw) : {};
  task.task === "parse-schedule" ? P("任务标记 task=parse-schedule") : F("task 标记错误: " + task.task);
  task.from === "schedule.html" ? P("记录了来源页") : F("未记录来源页");
  /高数 A101/.test(task.text || "")
    ? P("用户粘过的原文被一起带走（跳转不丢内容）") : F("原文丢失: " + task.text);
  /格式一/.test(task.prompt || "") && /格式二/.test(task.prompt || "")
    ? P("提示词已随任务带走，且指明两种目标格式") : F("提示词缺失或不完整");
  /教室/.test(task.prompt || "") && /不要编造/.test(task.prompt || "")
    ? P("提示词写明了要保留的字段与不编造的要求") : F("提示词约束不完整");

  // 没粘内容也应该能跳（有人会直接跟 AI 讲）
  d.getElementById("importBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  w.navigate = (p) => { askedFor = p; };
  d.getElementById("impAi").dispatchEvent(new w.Event("click", { bubbles: true }));
  askedFor === "agent.html?task=parse-schedule" && JSON.parse(w.localStorage.getItem("st_agent_task")).text === ""
    ? P("内容为空时同样能跳转（不留旧内容）") : F("空内容跳转异常");
  w.navigate = origNavigate;

  /* ---- 第 57 轮：AI 转好的文本，打开导入框时自动填入（闭环真正合上） ---- */
  w.localStorage.setItem("st_schedule_import", "周一,第1-2节,数据结构与算法,6A-301,计科2301");
  d.getElementById("importBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  const ta57 = d.getElementById("impText");
  ta57 && /数据结构与算法/.test(ta57.value)
    ? P("打开导入框时自动填入 AI 转好的课表文本（不用再粘一遍）") : F("导入框没有自动填入");
  !w.localStorage.getItem("st_schedule_import")
    ? P("用过即删（不残留）") : F("回填后没清掉残留");

  dom.window.close();
}

console.log("\n=== 3h-2. agent 的动作执行层（第 55 轮：确认执行真的落地）===");
{
  const dom = load("agent.html", { role: "teacher" });
  await settle(dom);
  const w = dom.window, d = w.document;
  w.navigate = () => {};          // 别让 jsdom 真去跳页
  w.confirm = () => true;

  /* ① 执行层本身：直接调它，看返回值（点击那条端到端在 3i 段验，这里只验逻辑） */
  const r1 = w.eval("runAgentStep({ skill:'atom-gen-quiz', layer:'atomic', kind:'write',"
    + " name:'等待确认', arg:'action=publish_exam', wait:true }, { role:'teacher' })");
  r1 && typeof r1.ok === "boolean"
    ? P("runAgentStep 返回 {ok, …} —— 动作执行层真的接上了")
    : F("runAgentStep 没返回结果: " + JSON.stringify(r1));

  /* ② 没有可发的卷子时必须**如实拒绝**，而不是假装成功 */
  if (r1 && !r1.ok) {
    /没有|还没|先/.test(String(r1.reason || ""))
      ? P("没执行时给出可读原因：" + String(r1.reason).slice(0, 34))
      : F("拒绝时没说清为什么: " + r1.reason);
  }
  /* ③ 结果自带可直接显示的文案（界面拿它渲染，不需要再翻译一遍） */
  (r1 && (r1.detail || r1.reason))
    ? P("结果自带可显示文案（detail / reason）") : F("结果里没有可显示文案");
  dom.window.close();
}

console.log("\n=== 3i. agent.html：三层技能链 + 画像 + 任务交接（第 35 轮实现）===");
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** ⚠️ 别用固定 sleep 猜动作链跑完的时间：步数一多就超时（第 35 轮：7 步 × 320ms 撞上了 1600ms 的等待）。
      等"结果卡出现"，或等到超时上限。 */
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) { if (fn()) return true; await sleep(60); }
    return false;
  };
  const handoff = JSON.stringify({
    task: "parse-schedule", from: "schedule.html",
    text: "周一 第1-2节 数据结构与算法 6A-301 计科2301\n周二,第3-4节,操作系统,6B-105,计科2301\n这一行缺少节次",
    prompt: "（课表转换提示词）", at: Date.now(),
  });
  const dom = load("agent.html", { role: "teacher", restore: { ls: { st_agent_task: handoff } } });
  await settle(dom);
  const w = dom.window, d = w.document;

  /* ---------- ① 接住别的页面交过来的任务 ---------- */
  !d.getElementById("taskBar").hidden ? P("读到 st_agent_task 后显示任务条") : F("任务条没显示");
  /解析课表文本/.test(d.getElementById("taskName").textContent)
    ? P("任务条写明是哪个任务") : F("任务名不对: " + d.getElementById("taskName").textContent);
  /周一 第1-2节/.test(d.getElementById("taskText").textContent) ? P("任务条列出原文（跳转时不会丢）") : F("没带原文");

  /* ---------- ② 左栏技能库：一棵可勾选的树 ---------- */
  const tree = d.getElementById("skillTree");
  d.querySelectorAll("#skillTree .sp-layer").length >= 4
    ? P("左栏画出技能树（三层 + 我的分组）") : F("技能树没渲染: " + d.querySelectorAll("#skillTree .sp-layer").length);
  /系统层/.test(tree.textContent) && /原子层/.test(tree.textContent)
    ? P("三层名字都在（系统层 / 群组层 / 原子层）") : F("缺层名");
  const spBoxes = [...d.querySelectorAll("#skillTree .sp-row input")];
  spBoxes.length >= 10 ? P("每个技能一行、带勾选框（" + spBoxes.length + " 个）") : F("技能行不对: " + spBoxes.length);
  spBoxes.every((b) => b.checked) ? P("默认全部开着") : F("默认不是全开");
  d.querySelector("#skillTree .sp-row input[disabled]")
    ? P("锁定的技能勾选框是禁用的（改前确认那道闸）") : F("没有锁定项");
  // 布局：左栏一列装技能库 + 画像，对话区独占剩下的宽度
  const rail = d.querySelector(".agent-rail");
  rail && rail.querySelector(".skill-pane") && rail.querySelector(".rail-body")
    ? P("左栏一列同时装「技能库」与「画像」（不再夹着对话区）") : F("左栏结构不对");
  !d.querySelector(".agent-side") ? P("原来的右侧独立栏已去掉") : F("还留着旧的右侧栏");
  /现在这么讲/.test(d.getElementById("personaFit").textContent) ? P("画像卡画出当前讲法") : F("画像没渲染");
  /开口/.test(d.getElementById("personaBase").textContent) ? P("画像卡列出基础画像（开口 / 步子 / 常用 / 避免）") : F("基础画像没渲染");
  d.querySelector(".rail-mini") ? P("「操作授权」收成可折叠的一块（不占地方）") : F("授权卡没折叠");
  // 样式真的生效（getComputedStyle 不实现优先级，但能读到声明值 —— 比查 CSS 文本更近真相）
  w.getComputedStyle(rail).position === "sticky"
    ? P("左栏整列 sticky（对话滚动时它不跟着跑）") : F("左栏没 sticky: " + w.getComputedStyle(rail).position);
  w.getComputedStyle(d.getElementById("skillTree")).overflowY === "auto"
    ? P("技能树自己滚（技能一多也不会把画像顶下去）") : F("技能树没独立滚动");
  w.getComputedStyle(d.querySelector(".rail-scroll")).overflowY === "auto"
    ? P("画像自己滚") : F("画像没独立滚动");

  /* ---------- ②b 勾选 / 关掉：立刻生效 + 落盘 + 路由不再挂它 ---------- */
  const skRow = (name) => [...d.querySelectorAll("#skillTree .sp-row")]
    .find((r) => (r.querySelector(".sp-name") || {}).textContent === name);
  const cbOff = skRow("校对").querySelector("input");
  cbOff.checked = false;
  cbOff.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(dom);
  skRow("校对").classList.contains("off") ? P("取消勾选后这一行变灰") : F("关掉没体现");
  /已关掉/.test(d.getElementById("libCount").textContent) ? P("概览报出「已关掉 N 条」") : F("概览没更新");
  /atom-proofread/.test(String(w.localStorage.getItem("st_skills")) || "") ? P("开关状态落盘（st_skills）") : F("没落盘");
  w.eval("JSON.stringify(routeSkills('帮我校对这段',{role:'teacher'}).atomic.map(s=>s.id))") === "[]"
    ? P("关掉后路由真的不再挂它") : F("关掉了还挂: " + w.eval("JSON.stringify(routeSkills('帮我校对这段',{role:'teacher'}).atomic)"));
  /校对/.test(w.eval("JSON.stringify(routeSkills('帮我校对这段',{role:'teacher'}).offHit)"))
    ? P("路由如实报告「本来会命中，但你关掉了」") : F("offHit 没报");
  skRow("校对") ? P("关掉不等于删除：这一行还在树里（还能再打开）") : F("关掉后行没了");
  const cbOn = skRow("校对").querySelector("input");
  cbOn.checked = true;
  cbOn.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(dom);
  !skRow("校对").classList.contains("off") ? P("再勾上就恢复（开关是双向的）") : F("打不开了");

  /* ---------- ②c 锁定的技能关不掉 ---------- */
  const lockRow = [...d.querySelectorAll("#skillTree .sp-row")].find((r) => r.querySelector("input[disabled]"));
  lockRow.querySelector(".sp-more").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  let spm = d.getElementById("spMenu");
  /锁定，不能关/.test(spm ? spm.textContent : "") ? P("锁定项在菜单里说清「为什么不能关」") : F("锁定项没说原因");
  !/关掉这条技能/.test(spm ? spm.textContent : "") ? P("锁定项不给「关掉」入口") : F("锁定项还能关");
  spm.parentElement === d.body && w.getComputedStyle(spm).position === "fixed"
    ? P("「⋯」菜单挂在 body + fixed（面板滚动也不会裁掉它）") : F("菜单挂错地方");
  d.dispatchEvent(new w.Event("mousedown", { bubbles: true }));
  await settle(dom);
  !d.getElementById("spMenu") ? P("点别处菜单自动关") : F("菜单没关");

  /* ---------- ②d 新建分组 / 收技能进组 ---------- */
  d.getElementById("newGroupBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const nInput = d.querySelector("#skillTree .sp-newrow input");
  nInput ? P("「＋ 新建分组」就地出输入行（不弹窗）") : F("没有输入行");
  nInput.value = "备课时用";
  d.querySelector("#skillTree .sp-newrow button").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  /备课时用/.test(w.eval("JSON.stringify(skillGroups())")) ? P("分组建好了") : F("分组没建上");
  d.querySelectorAll("#skillTree .sp-subgroup").length === 1
    ? P("树上出现这个分组（可折叠的一层）") : F("分组没画出来");
  /备课时用/.test(String(w.localStorage.getItem("st_skills")) || "") ? P("分组也落盘了") : F("分组没落盘");

  const target = [...d.querySelectorAll("#skillTree .sp-row")].find((r) => /教案自查/.test(r.textContent));
  target.querySelector(".sp-more").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  spm = d.getElementById("spMenu");
  /收进我的分组/.test(spm ? spm.textContent : "") ? P("技能菜单里有「收进我的分组」") : F("菜单缺分组入口");
  const gLab = spm.querySelector("label input");
  gLab.checked = true;
  gLab.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(dom);
  /"skills":\["atom-lesson-check"\]/.test(w.eval("JSON.stringify(skillGroups())"))
    ? P("技能收进分组了") : F("没收到分组: " + w.eval("JSON.stringify(skillGroups())"));
  d.querySelectorAll("#skillTree .sp-subgroup .sp-row").length === 1
    ? P("分组里出现这条技能（引用，不是复制）") : F("分组里没显示");
  !d.getElementById("spMenu") ? P("点完菜单自动关") : F("菜单没关");

  /* ---------- ②e 分组管理：改名 / 删除（删组不删技能） ---------- */
  d.querySelector("#skillTree .sp-subgroup .sp-row-head .sp-more")
    .dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  spm = d.getElementById("spMenu");
  /重命名/.test(spm.textContent) && /删除这个分组/.test(spm.textContent)
    ? P("分组菜单有「重命名 / 删除」") : F("分组菜单不全: " + spm.textContent);
  [...spm.querySelectorAll("button")].find((b) => /重命名/.test(b.textContent))
    .dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const rn = d.querySelector("#skillTree .sp-subgroup .sp-input");
  rn ? P("改名是就地输入（标题变输入框）") : F("改名没进入编辑态");
  rn.value = "备课常用";
  rn.dispatchEvent(new w.Event("blur", { bubbles: true }));
  await settle(dom);
  /备课常用/.test(w.eval("JSON.stringify(skillGroups())")) ? P("改名生效") : F("改名没生效");
  d.querySelector("#skillTree .sp-subgroup .sp-row-head .sp-more")
    .dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  w.confirm = () => true;
  [...d.getElementById("spMenu").querySelectorAll("button")].find((b) => /删除这个分组/.test(b.textContent))
    .dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  w.eval("skillGroups().length") === 0 ? P("分组删掉了") : F("分组没删掉");
  skRow("教案自查") ? P("删分组不删技能：它还在原来的层里") : F("技能被连带删了");

  /* ---------- ②f 重开页面：开关与分组都还在 ---------- */
  const domR = load("agent.html", { role: "teacher", restore: { ls: {
    st_skills: JSON.stringify({ off: { "atom-rubric": 1 },
      groups: [{ id: "g9", name: "我的常用", skills: ["atom-proofread"] }] }),
  } } });
  await settle(domR);
  const dR = domR.window.document;
  /我的常用/.test(dR.getElementById("skillTree").textContent) ? P("重开后分组还在（落盘了）") : F("分组没持久化");
  const rowR = [...dR.querySelectorAll("#skillTree .sp-row")].find((r) => r.querySelector(".sp-name").textContent === "评分标准");
  rowR && rowR.classList.contains("off") ? P("重开后被关掉的技能仍是关着的") : F("开关状态没持久化: " + (rowR ? rowR.className : "找不到那行"));
  domR.window.close();

  /* ---------- ③ 开始处理：技能链 + 动作链 + 结果 ---------- */
  d.getElementById("taskRun").dispatchEvent(new w.Event("click", { bubbles: true }));
  await waitFor(() => d.querySelector("#chatLog .res-card"), 8000);
  const log = d.getElementById("chatLog").textContent;
  d.querySelectorAll("#chatLog .skill-chain").length >= 1 ? P("对话里出现技能链卡片") : F("没有技能链");
  d.querySelectorAll("#chatLog .skill-chain .lg").length === 3
    ? P("技能链按三层分组渲染") : F("技能链层数不对: " + d.querySelectorAll("#chatLog .skill-chain .lg").length);
  /命中：|系统层/.test(log) ? P("技能卡片标出「命中」了什么") : F("没有命中说明");
  /周一,第1-2节,数据结构与算法,6A-301,计科2301/.test(log)
    ? P("真的解析出了标准格式那行（不是假动作）") : F("没有解析结果");
  /没认出来/.test(log) ? P("认不出的那行原样还回来（不猜）") : F("没说认不出的行");
  /回到课表页导入/.test(log) ? P("给出「回课表页导入」的闭环入口") : F("缺闭环入口");
  w.localStorage.getItem("st_agent_task") === null
    ? P("处理完把交接键删掉（下次进来不会重复触发）") : F("交接键没清");

  /* ---------- 第 57 轮：结果回填导入框 + 技能真的接上模型 ---------- */
  const stash57 = w.localStorage.getItem("st_schedule_import");
  stash57 ? P("课表解析结果写回 st_schedule_import（回去就是接着干，不用再粘一遍）")
    : F("课表解析结果没有回填导入框");

  // 未接模型：技能链是同步的、给的是骨架（绝不假装生成）
  const syncRun57 = w.runSkillChain(["atom-lesson-draft"], { chapterTitle: "第 7 章" }, { role: "teacher" });
  syncRun57 && typeof syncRun57.then !== "function"
    ? P("未接模型时技能链是同步的（走规则骨架，不假装在生成）") : F("未接模型却走了异步路径");
  /结构|待补充|六个小节/.test((syncRun57.secs[0].lines || []).join("\n"))
    ? P("未接模型给的是**结构骨架**（如实说明，不塞假内容）")
    : F("未接模型返回了不该有的内容: " + (syncRun57.secs[0].lines || []).join(" ").slice(0, 50));

  // 配了 Key：同一个技能真的去调模型（返回 Promise，且结果是模型写的）
  try {
    // ⚠️ LS.get 走 JSON.parse → 这里必须写 JSON 字符串（写裸串会被当成解析失败）
    w.localStorage.setItem("st_provider", JSON.stringify("deepseek"));
    w.localStorage.setItem("st_api_key", JSON.stringify("sk-test-123"));
    w.llmReady() ? P("配了服务商 + Key 后 llmReady() 为真") : F("llmReady() 没反应");
    let aiCalled57 = 0;
    w.fetch = function () {
      aiCalled57++;
      return Promise.resolve({ ok: true, json: function () {
        return Promise.resolve({ choices: [{ message: { content: "## 教学目标\n- 模型写的目标（验证用）" } }] });
      } });
    };
    const pAsync57 = w.runSkillChain(["atom-lesson-draft"], { chapterTitle: "第 7 章" }, { role: "teacher" });
    pAsync57 && typeof pAsync57.then === "function"
      ? P("接了模型后技能链返回 Promise（调用方 then 接住）") : F("接了模型却没走异步路径");
    const resAsync57 = await pAsync57;
    aiCalled57 === 1 ? P("真的向模型发了一次请求（fetch 被调用）") : F("没有真的调模型: " + aiCalled57);
    /模型写的目标/.test((resAsync57.secs[0].lines || []).join("\n"))
      ? P("结果里是**模型生成的内容**（不再只是骨架）") : F("结果里没有模型输出");
  } catch (e) {
    F("模型链路测试抛错: " + (e && e.message));
  }

  dom.window.close();

  /* ---------- ④ 出题：写操作必须停下来问一次 ---------- */
  const dom2 = load("agent.html", { role: "teacher" });
  await settle(dom2);
  const w2 = dom2.window, d2 = w2.document;
  d2.getElementById("input").value = "圈第 6、7 章出 8 道题";
  d2.getElementById("sendBtn").dispatchEvent(new w2.Event("click", { bubbles: true }));
  await waitFor(() => d2.querySelector("#chatLog .tc-step.wait") || d2.querySelector("#chatLog .res-card"), 8000);
  await sleep(120);
  const waits = [...d2.querySelectorAll("#chatLog .tc-step.wait")];
  waits.length >= 1 ? P("出题这类写操作在动作链里停下来等确认") : F("写操作没有确认步");
  /等待确认/.test(d2.getElementById("chatLog").textContent)
    ? P("确认步写着「等待确认」（教师端硬规则）") : F("没有等待确认那一步");
  /出题/.test(d2.querySelector("#chatLog .skill-chain").textContent)
    ? P("出题技能被挂上（按你说的活路由）") : F("没挂上出题技能");
  waits[0].querySelector(".btn-primary").dispatchEvent(new w2.Event("click", { bubbles: true }));
  // 🔴 第 55 轮：确认后给的是**真实结果**（已把… / 没有执行：…），不再是干巴巴的「已确认」
  await waitFor(() => /已把|没有执行/.test(d2.getElementById("chatLog").textContent), 6000);
  /已把|没有执行/.test(d2.getElementById("chatLog").textContent)
    ? P("点确认后给出真实执行结果，并继续往下走") : F("确认后没继续");
  dom2.window.close();

  /* ---------- ⑤ 授权：可以选「只给建议」 ---------- */
  const dom3 = load("agent.html", { role: "teacher" });
  await settle(dom3);
  const w3 = dom3.window, d3 = w3.document;
  const ghostBtn = () => { const ws = [...d3.querySelectorAll("#chatLog .tc-step.wait")]; return ws[0] && ws[0].querySelector(".btn-ghost"); };
  d3.getElementById("input").value = "帮我出 5 道题";
  d3.getElementById("sendBtn").dispatchEvent(new w3.Event("click", { bubbles: true }));
  await waitFor(() => ghostBtn(), 8000);
  ghostBtn() ? P("确认步同时给了「只给我建议」这条路") : F("只有确认一条路");
  ghostBtn().dispatchEvent(new w3.Event("click", { bubbles: true }));
  await waitFor(() => /已改为只给建议/.test(d3.getElementById("chatLog").textContent), 6000);
  /已改为只给建议/.test(d3.getElementById("chatLog").textContent)
    ? P("选「只给建议」后动作被跳过，且写明不动数据") : F("降级没生效");
  const pub = [...d3.querySelectorAll("[data-perm]")].find((b) => b.dataset.perm === "publish");
  pub.getAttribute("aria-checked") === "false" ? P("授权开关默认关闭（发布作业与考试）") : F("默认授权不对");
  pub.dispatchEvent(new w3.Event("click", { bubbles: true }));
  await settle(dom3);
  pub.getAttribute("aria-checked") === "true" ? P("开关可切换（是真开关，不是装饰）") : F("开关点不动");
  dom3.window.close();

  /* ---------- ⑥ 学生端：同一套技能库，但全只读 ---------- */
  const dom4 = load("agent-student.html", {
    role: "student",
    restore: { ls: {
      st_current_user: "student:zhangsan",
      "st_enroll:student:zhangsan": JSON.stringify([
        { courseId: "ds", name: "数据结构与算法", code: "CS201", joinCode: "CS201-22DT", at: Date.now() - 86400000 },
      ]),
      "st_behavior:student:zhangsan": JSON.stringify([
        { kind: "ask", label: "图的最短路径适用条件", topic: "图", courseId: "ds", at: Date.now() - 86400000 },
        { kind: "ask", label: "图为什么不能有负权边", topic: "图", courseId: "ds", at: Date.now() - 72000000 },
        { kind: "ask", label: "树怎么遍历", topic: "树", courseId: "ds", at: Date.now() - 60000000 },
        { kind: "got", label: "树怎么遍历", topic: "树", courseId: "ds", at: Date.now() - 50000000 },
      ]),
    } },
  });
  await settle(dom4);
  const w4 = dom4.window, d4 = w4.document;
  d4.querySelectorAll("#skillTree .sp-layer").length >= 3 ? P("学生端技能库也是三层") : F("学生端技能库层数不对");
  /没有会改动数据的技能/.test(d4.getElementById("libCount").textContent)
    ? P("学生端明说「没有会改动数据的技能」") : F("没说明只读");
  !d4.querySelector("#skillTree .sp-flag") ? P("学生端树上一个「会改动」标记都没有") : F("学生端出现了会改动的技能");
  !d4.querySelector("#skillTree .sp-row input[disabled]")
    ? P("学生端没有锁定项（「改前确认」那道闸只挂教师端）") : F("学生端出现了锁定项");
  d4.querySelector(".agent-rail .skill-pane") && d4.querySelector(".agent-rail .rail-body")
    ? P("学生端同样是「技能库 + 画像」一列") : F("学生端左栏结构不对");
  d4.getElementById("input").value = "发布作业并删除章节";
  d4.getElementById("sendBtn").dispatchEvent(new w4.Event("click", { bubbles: true }));
  await waitFor(() => d4.querySelector("#chatLog .res-card"), 8000);
  d4.querySelectorAll("#chatLog .tc-step.wait").length === 0
    ? P("学生端即使被要求发布 / 删除，也不会出现确认步（因为没有写技能）") : F("学生端出现了写操作");
  !/publish_|delete_/.test(d4.getElementById("chatLog").textContent)
    ? P("学生端动作链里没有 publish_ / delete_") : F("学生端出现了写动作");
  /不会改你的任何数据/.test(d4.body.textContent) ? P("学生端把「不会改你的数据」写在明面上") : F("少了这条说明");
  dom4.window.close();

  /* ---------- ⑦ 学生端画像：从他会的到他想会的 ---------- */
  const dom5 = load("agent-student.html", {
    role: "student",
    restore: { ls: {
      st_current_user: "student:zhangsan",
      "st_enroll:student:zhangsan": JSON.stringify([
        { courseId: "ds", name: "数据结构与算法", code: "CS201", joinCode: "CS201-22DT", at: Date.now() - 86400000 },
      ]),
      "st_behavior:student:zhangsan": JSON.stringify([
        { kind: "ask", label: "图的最短路径适用条件", topic: "图", courseId: "ds", at: Date.now() - 86400000 },
        { kind: "ask", label: "图为什么不能有负权边", topic: "图", courseId: "ds", at: Date.now() - 72000000 },
        { kind: "ask", label: "树怎么遍历", topic: "树", courseId: "ds", at: Date.now() - 60000000 },
        { kind: "got", label: "树怎么遍历", topic: "树", courseId: "ds", at: Date.now() - 50000000 },
      ]),
    } },
  });
  await settle(dom5);
  const w5 = dom5.window, d5 = w5.document;
  /树/.test(d5.getElementById("personaKnown").textContent) ? P("画像：把标过「懂了」的树放进「已经懂的」") : F("已知话题没渲染");
  /图/.test(d5.getElementById("personaGaps").textContent) ? P("画像：把反复问的图放进「反复卡住的」") : F("待补话题没渲染");
  const pathTxt = d5.getElementById("personaPath").textContent;
  /树 → 图|树→图/.test(pathTxt) ? P("画出路线：树 → 图（从他会的到他想会的）") : F("路线不对: " + pathTxt.slice(0, 60));
  /类比/.test(pathTxt) ? P("路线上带了一句类比（这条是预置的，页面会标明）") : F("没有类比说明");
  const sug = d5.getElementById("suggests").textContent;
  /图/.test(sug) ? P("建议问题是按他自己的薄弱话题生成的（不是写死的清单）") : F("建议问题没个性化");
  dom5.window.close();
}

console.log("\n=== 3j. 按当前时间自动高亮（正在上课 / 下一节）===");
{
  const dom = load("schedule.html", { role: "teacher" });
  await settle(dom);
  const w = dom.window;
  const d = w.document;
  // ⚠️ SLOTS / FOCUS 是 let 声明 → 不是 window 属性，必须用 eval 取词法绑定
  const S = () => w.eval("SLOTS");
  const F = (dt) => w.computeFocus(dt);
  const J = JSON.stringify;
  /* 2026-09/10 里挑星期确定的日期：9/28 周一、9/30 周三、10/2 周五、10/3 周六、10/4 周日 */
  const at = (mo, dy, h, mi) => new Date(2026, mo - 1, dy, h, mi);

  /* ---- 时间解析 ---- */
  w.hhmm("08:00") === 480 ? P("hhmm 把 08:00 解析为 480 分钟") : F("hhmm 解析错误");
  [["8:5", null], ["25:00", null], ["", null], ["abc", null]].forEach(([v, e]) => {
    w.hhmm(v) === e ? P(`hhmm 拒绝非法值 ${JSON.stringify(v)}`) : F(`hhmm 未拒绝 ${JSON.stringify(v)}`);
  });
  J(w.slotRange(0)) === "[480,580]" ? P("第 1–2 节 = 08:00–09:40") : F("slotRange(0)=" + J(w.slotRange(0)));
  J(w.slotRange(1)) === "[610,710]" ? P("第 3–4 节 = 10:10–11:50") : F("slotRange(1)=" + J(w.slotRange(1)));

  /* ---- 结束时间缺省：不能被课间吞掉 ---- */
  w.setState({ weekNo: 5, days: ["周一"], slots: [
      { label: "第1节", time: "08:00" },               // 没写 end，下一节 10:10
      { label: "第2节", time: "10:10" },               // 没写 end，没有下一节
    ], week: [[{ name: "A", room: "", cls: "" }], [{ name: "B", room: "", cls: "" }]] }, "测试");
  J(w.slotRange(0)) === "[480,580]"
    ? P("没填结束时间时按「开始 + 默认时长」封顶（08:00 的课不管到 10:10，课间不算上课）")
    : F("缺省结束时间算错: " + J(w.slotRange(0)));
  J(w.slotRange(1)) === "[610,710]"
    ? P("没填结束时间且没有下一节 → 开始 + 默认时长（10:10–11:50）")
    : F("缺省结束时间算错: " + J(w.slotRange(1)));

  /* ---- 正在上课 ---- */
  w.setState(w.demoState(), "预置课表");
  let f = F(at(9, 30, 8, 30));
  f.state === "now" && f.slot === 0 && f.day === 2
    ? P("周三 08:30 → 正在上课（第 1–2 节 / 周三）") : F("周三 08:30 判断错误: " + J(f));
  f = F(at(9, 30, 8, 0));
  f.state === "now" ? P("开始瞬间（08:00 整）算正在上课（闭区间左端）") : F("开始瞬间判断错误: " + J(f));
  f = F(at(9, 30, 9, 40));
  f.state === "next" ? P("结束瞬间（09:40 整）不算正在上课（闭区间右端开）") : F("结束瞬间判断错误: " + J(f));
  f = F(at(9, 30, 11, 0));
  f.state === "next"
    ? P("时段内但该格是空堂 → 不当作正在上课，改为下一节") : F("空堂被误判为正在上课: " + J(f));
  f = F(at(9, 29, 10, 30));
  f.state === "now" && f.slot === 1 && f.day === 1
    ? P("周二 10:30 → 正在上课（第 3–4 节 / 周二）") : F("周二 10:30 判断错误: " + J(f));

  /* ---- 没课 → 下一节 ---- */
  f = F(at(9, 30, 7, 0));
  f.state === "next" && f.slot === 0 && f.day === 2
    ? P("当天还没开始 → 高亮当天第一节") : F("当天未开始判断错误: " + J(f));
  f = F(at(9, 28, 9, 50));
  f.state === "next" && f.slot === 3 && f.day === 0
    ? P("周一 09:50 → 下一节跳过空堂，落到 16:10 的答疑") : F("跳过空堂失败: " + J(f));

  /* ---- 今天没课了 → 顺延 ---- */
  f = F(at(10, 1, 18, 30));
  f.state === "next" && f.day === 4
    ? P("周四课后 → 顺延到周五第一节") : F("顺延到次日失败: " + J(f));
  f = F(at(10, 2, 18, 30));
  f.state === "next" && f.day === 0
    ? P("周五课后 → 绕回下周一第一节") : F("绕回本周开头失败: " + J(f));
  f = F(at(10, 4, 10, 0));
  f.state === "next" && f.day === 0
    ? P("周日（不在课表天数内）→ 从周一第一节找起") : F("非上课日判断错误: " + J(f));

  /* ---- 纯函数不受跨 realm 影响（instanceof 陷阱）---- */
  w.computeFocus(at(9, 30, 8, 30)).slot === 0
    ? P("computeFocus 接受外部（跨 realm）的 Date —— 未写成 instanceof（那会静默退回当前时间）")
    : F("跨 realm 的 Date 被忽略，功能退化成读系统时钟");
  !/instanceof\s+Date/.test(fs.readFileSync(path.join(SITE, "schedule.html"), "utf8"))
    ? P("源码里没有 instanceof Date（跨 realm 会失效）") : F("仍在使用 instanceof Date");

  /* ---- 没有时间信息 → 不高亮，且要提示 ---- */
  w.setState({ weekNo: 5, days: ["周一", "周二"], slots: [{ label: "第1节" }, { label: "第2节" }],
               week: [[{ name: "X", room: "", cls: "" }, null], [null, { name: "Y", room: "", cls: "" }]] }, "测试");
  w.computeFocus(at(9, 28, 9, 0)).state === ""
    ? P("节次没填时间 → 判定为「无法高亮」而不是瞎猜") : F("无时间信息时仍给出了高亮");
  d.querySelectorAll("#weekGrid .week-cell.now, #weekGrid .week-cell.next").length === 0
    ? P("无时间信息时课表里没有任何高亮格") : F("无时间信息却出现了高亮");
  /上课时间/.test(d.getElementById("weekFocus").textContent)
    ? P("卡片头提示去补上课时间") : F("缺提示: " + d.getElementById("weekFocus").textContent);

  /* ---- 渲染与状态一致 ---- */
  w.setState(w.demoState(), "预置课表");
  const flagged = [...d.querySelectorAll("#weekGrid .week-cell .c-flag")];
  flagged.length === 1 && ["正在上课", "下一节"].includes(flagged[0].textContent)
    ? P("渲染出且只渲染出一个状态标签：" + flagged[0].textContent) : F("状态标签异常: " + flagged.length);
  const txt = d.getElementById("weekFocus").textContent;
  const st = w.eval("FOCUS").state;
  (st === "now") === /正在上课/.test(txt) && (st === "next") === /下一节/.test(txt)
    ? P("卡片头状态行与高亮格一致：" + txt) : F("状态行与高亮不一致: " + txt);
  w.eval("FOCUS").state === "next" && /下一节：\S+\s/.test(txt)
    ? P("「下一节」文案带上了星期与节次") : info("当前是「正在上课」，文案为: " + txt);

  /* ---- 导入的课表也能自动高亮（时间来自节次名）---- */
  const p = w.parseSchedule(fs.readFileSync(path.join(SITE, "sample-schedule.csv"), "utf8"));
  p.slots.every((s) => s.time && s.end)
    ? P("样例 CSV 的节次都带上了开始/结束时间") : F("样例时间缺失: " + J(p.slots.map((s) => [s.label, s.time, s.end])));
  S(); // 保持 SLOTS 词法绑定被引用（避免 lint 误报未使用）
  w.setState({ weekNo: 5, slots: p.slots, days: p.days, week: p.week }, "导入");
  w.eval("SLOTS").map((_, i) => w.slotRange(i)).every(Boolean)
    ? P("导入后可算时间段（能自动高亮）") : F("导入后时间段算不出");
  const g = w.computeFocus(at(9, 30, 8, 30));
  g.state === "now" && g.day === 2
    ? P("导入数据也能判断「正在上课」（周三 08:30）") : F("导入数据判断失败: " + J(g));

  /* ---- 时间会往前走 → 必须有刷新机制 ---- */
  const src = fs.readFileSync(path.join(SITE, "schedule.html"), "utf8");
  /visibilitychange/.test(src) && /addEventListener\("focus", refreshFocus\)/.test(src)
    ? P("切回标签页 / 窗口聚焦时重算高亮") : F("缺少回到页面时的重算");
  /setInterval\(refreshFocus/.test(src)
    ? P("页面长开时有兜底重算（每分钟）") : F("缺少兜底重算");
  /visibilityState === "hidden"\) return/.test(src)
    ? P("不可见时跳过高亮重算（不白烧 CPU）") : F("未跳过不可见状态");
  dom.window.close();
}

console.log("\n=== 3k. 待办事项：添加 / 删除 / 持久化（真实 DOM）===");
{
  const dom = load("schedule.html", { role: "teacher" });
  await settle(dom);
  const w = dom.window, d = w.document;

  /* ---- dueInfo 是纯函数，可喂固定「今天」 ---- */
  const T = new Date(2026, 8, 30);            // 2026-09-30 周三
  const DI = (s, t) => w.dueInfo(s, t || T);
  DI("2026-09-30").text === "今天" && DI("2026-09-30").urgent === "urgent"
    ? P("dueInfo：当天 → 「今天」+ 标红") : F("当天判断错误: " + JSON.stringify(DI("2026-09-30")));
  DI("2026-09-29").urgent === "urgent" && /已过期/.test(DI("2026-09-29").text)
    ? P("dueInfo：过期 → 「已过期 MM-DD」+ 标红") : F("过期判断错误: " + JSON.stringify(DI("2026-09-29")));
  DI("2026-10-01").text === "明天" && DI("2026-10-01").urgent === "soon"
    ? P("dueInfo：次日 → 「明天」+ 标黄") : F("次天判断错误: " + JSON.stringify(DI("2026-10-01")));
  DI("2026-10-02").text === "后天" ? P("dueInfo：隔天 → 「后天」") : F("隔天判断错误");
  DI("2026-10-05").urgent === "soon" && /周/.test(DI("2026-10-05").text)
    ? P("dueInfo：7 天内 → 显示星期几 + 标黄（" + DI("2026-10-05").text + "）")
    : F("一周内判断错误: " + JSON.stringify(DI("2026-10-05")));
  DI("2026-11-20").urgent === "" && DI("2026-11-20").text === "11-20"
    ? P("dueInfo：远期 → 显示 MM-DD，不标色") : F("远期判断错误: " + JSON.stringify(DI("2026-11-20")));
  DI("").text === "未设截止" && DI("未设截止").text === "未设截止" && DI("乱写").urgent === ""
    ? P("dueInfo：空值 / 认不出的值都能安全兜底") : F("兜底异常");

  /* ---- 入口按钮 ---- */
  const addBtn = d.getElementById("todoAddBtn");
  addBtn ? P("待办卡片有「＋ 添加事项」按钮（#todoAddBtn）") : F("缺少添加按钮");
  addBtn && /＋/.test(addBtn.textContent) ? P("按钮文案带加号") : F("按钮没有加号: " + addBtn.textContent);

  /* ---- 打开弹窗 ---- */
  const before = d.querySelectorAll("#todoList .todo-item").length;
  // ⚠️ 统计卡片数的是「未完成」条数，不是总条数（演示数据里有 1 条已完成）
  const pendingBefore = Number(d.getElementById("pendingCount").textContent);
  addBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.querySelector("#modalHost .modal") ? P("点「＋ 添加事项」弹出弹窗") : F("弹窗未出现");
  ["dTitle", "dDue", "dTag"].every((id) => d.getElementById(id))
    ? P("弹窗含标题 / 截止日期 / 分类三个字段") : F("弹窗字段不全");
  d.getElementById("dDue").getAttribute("type") === "date"
    ? P("截止日期用原生日期选择器") : F("截止日期不是 date 类型");

  /* ---- 空标题必须被拦下 ---- */
  d.getElementById("todoSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  const err = d.getElementById("todoError");
  err && !err.hidden && /事项内容/.test(err.textContent)
    ? P("空标题提交被拦下并提示") : F("空标题未被拦下");
  d.querySelectorAll("#todoList .todo-item").length === before && d.getElementById("modalHost").hidden === false
    ? P("校验失败时不新增、弹窗保持打开") : F("校验失败却改了列表或关了弹窗");

  /* ---- 正常添加：截止=今天 → 应显示「今天」并标红 ---- */
  const today = w.fmtDate(new Date());
  d.getElementById("dTitle").value = "给软工2301 补一次实验课";
  d.getElementById("dDue").value = today;
  d.getElementById("dTag").value = "备课";
  d.getElementById("todoSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);

  const items = [...d.querySelectorAll("#todoList .todo-item")];
  items.length === before + 1 ? P(`添加后列表 ${before} → ${items.length} 条`) : F("条数没变: " + items.length);
  d.getElementById("modalHost").hidden ? P("添加后弹窗自动关闭") : F("添加后弹窗未关");
  const last = items[items.length - 1];
  /给软工2301 补一次实验课/.test(last.textContent) ? P("新事项出现在列表里") : F("新事项没出现");
  /备课/.test(last.textContent) ? P("分类写入正确") : F("分类不对");
  const dueEl = last.querySelector(".todo-meta .due");
  dueEl && dueEl.textContent === "今天" ? P("截止显示为「今天」（由日期现算，不是存死的文案）") : F("截止显示: " + (dueEl && dueEl.textContent));
  dueEl && /urgent/.test(dueEl.className) ? P("当天截止自动标红（紧急度是算出来的）") : F("未标红: " + (dueEl && dueEl.className));
  d.getElementById("pendingCount").textContent === String(pendingBefore + 1)
    ? P(`统计卡片「待办事项」同步 ${pendingBefore} → ${pendingBefore + 1}`)
    : F("统计未同步: " + d.getElementById("pendingCount").textContent);

  /* ---- 持久化 ---- */
  const saved = JSON.parse(w.localStorage.getItem("st_todos") || "null");
  Array.isArray(saved) && saved.length === before + 1 && /软工2301/.test(JSON.stringify(saved))
    ? P("写入 localStorage 的 st_todos") : F("未持久化: " + JSON.stringify(saved));

  /* ---- 勾选新事项 ---- */
  const newId = last.querySelector(".todo-check").id;
  last.querySelector(".todo-check").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.getElementById(newId).getAttribute("aria-checked") === "true"
    ? P("新事项也能勾选完成") : F("新事项勾选无效");
  JSON.parse(w.localStorage.getItem("st_todos")).find((t) => /软工2301/.test(t.title)).done === true
    ? P("完成状态也被持久化") : F("完成状态未持久化");

  /* ---- 删除 ---- */
  const n2 = d.querySelectorAll("#todoList .todo-item").length;
  const delBtn = d.getElementById(newId).closest(".todo-item").querySelector(".todo-del");
  delBtn ? P("每条待办右侧有删除按钮（.todo-del）") : F("缺删除按钮");
  delBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.querySelectorAll("#todoList .todo-item").length === n2 - 1
    ? P(`删除后 ${n2} → ${n2 - 1} 条`) : F("删除无效");
  !/软工2301/.test(d.getElementById("todoList").innerHTML) ? P("被删条目从列表消失") : F("删除后仍在");
  JSON.parse(w.localStorage.getItem("st_todos")).some((t) => /软工2301/.test(t.title)) === false
    ? P("删除也写回了存储") : F("删除未持久化");
  // 勾选与删除共用一个委托监听，别串味
  const firstChk = d.querySelector("#todoList .todo-check");
  const wasDone = firstChk.getAttribute("aria-checked") === "true";
  firstChk.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.getElementById(firstChk.id).getAttribute("aria-checked") === String(!wasDone)
    ? P("删除按钮加上后，勾选仍工作（同一个委托监听按目标分派）")
    : F("勾选被删除按钮弄坏了");

  /* ---- Esc 关闭 ---- */
  addBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  d.getElementById("modalHost").hidden ? P("按 Esc 关闭添加弹窗") : F("Esc 未关闭");

  /* ---- 全部删完后要有空状态提示 ---- */
  while (d.querySelector("#todoList .todo-del")) {
    d.querySelector("#todoList .todo-del").dispatchEvent(new w.Event("click", { bubbles: true }));
    await settle(dom);
  }
  /还没有待办/.test(d.getElementById("todoList").innerHTML)
    ? P("列表清空后显示空状态提示（不是一片空白）") : F("清空后没有提示");
  d.getElementById("pendingCount").textContent === "0"
    ? P("清空后计数为 0") : F("清空后计数错误");

  /* ---- 已完成的事项不该继续报警 ---- */
  {
    const dom2 = load("schedule.html", { role: "teacher" });
    await settle(dom2);
    const d2 = dom2.window.document;
    const doneItem = d2.querySelector('#todoList .todo-item[data-done="1"]');
    const due2 = doneItem && doneItem.querySelector(".due");
    due2 && !/urgent|soon/.test(due2.className)
      ? P("已完成的事项不标红/标黄（做完了就别再催）") : F("已完成事项仍在报警: " + (due2 && due2.className));
    const openItem = d2.querySelector('#todoList .todo-item[data-done="0"] .due');
    openItem && /urgent|soon/.test(openItem.className)
      ? P("未完成事项仍按日期正常标色") : F("未完成事项没标色: " + (openItem && openItem.className));
    dom2.window.close();
  }

  dom.window.close();
}

console.log("\n=== 3l. 待办的持久化：重开后不退回演示数据 ===");
{
  const jar = new CookieJar();
  const dom1 = load("schedule.html", { role: "teacher", jar });
  await settle(dom1);
  const d1 = dom1.window.document, w1 = dom1.window;
  // 演示数据是 5 条
  d1.querySelectorAll("#todoList .todo-item").length === 5
    ? P("首次打开用演示待办（5 条）") : F("演示条数异常: " + d1.querySelectorAll("#todoList .todo-item").length);
  // 加一条自己的
  d1.getElementById("todoAddBtn").dispatchEvent(new w1.Event("click", { bubbles: true }));
  d1.getElementById("dTitle").value = "我的私人事项";
  d1.getElementById("todoSave").dispatchEvent(new w1.Event("click", { bubbles: true }));
  await settle(dom1);
  const saved = w1.localStorage.getItem("st_todos");
  dom1.window.close();

  const dom2 = load("schedule.html", { role: "teacher", jar, restore: { ls: { st_todos: saved } } });
  await settle(dom2);
  const d2 = dom2.window.document;
  /我的私人事项/.test(d2.getElementById("todoList").innerHTML)
    ? P("重开后自己加的事项还在") : F("重开后自加事项丢了");
  d2.querySelectorAll("#todoList .todo-item").length === 6
    ? P("重开后是 6 条（5 演示 + 1 自加），未被重置") : F("重开后条数异常");
  dom2.window.close();

  // 存档损坏 → 安全回落演示数据
  const dom3 = load("schedule.html", { role: "teacher", jar, restore: { ls: { st_todos: "{坏掉的 JSON" } } });
  await settle(dom3);
  dom3.window.document.querySelectorAll("#todoList .todo-item").length === 5
    ? P("待办存档损坏时安全回落到演示数据（不白屏）") : F("坏存档导致待办渲染失败");
  dom3.window.close();

  // 存了一个「空数组」→ 必须尊重（用户删光了，不该把演示数据又塞回来）
  const dom4 = load("schedule.html", { role: "teacher", jar, restore: { ls: { st_todos: "[]" } } });
  await settle(dom4);
  /还没有待办/.test(dom4.window.document.getElementById("todoList").innerHTML)
    ? P("用户删光后重开仍是空的（不会把演示数据塞回来）") : F("空数组被当成了「没有记录」");
  dom4.window.close();
}

console.log("\n=== 3m. 新建课程：持久化 / 独立模式 / class.html 联动 ===");
{
  const jar = new CookieJar();
  /** 取「我的课程」分组里的全部菜单项（现在每一项都该可点；不可点的会被渲染成 .side-item.disabled） */
  const courseItems = (doc) => {
    const g = [...doc.querySelectorAll("#shellSide .side-group")]
      .find((x) => /我的课程/.test((x.querySelector("h4 span") || {}).textContent || ""));
    return g ? [...g.querySelectorAll(".side-item")] : [];
  };

  /* ---- ① 壳内建一门课，取出存档 ---- */
  const dom1 = load("app.html", { role: "teacher", jar });
  await settle(dom1);
  const w1 = dom1.window, d1 = w1.document;
  d1.getElementById("addCourseBtn").dispatchEvent(new w1.Event("click", { bubbles: true }));
  d1.getElementById("cName").value = "编译原理";
  d1.getElementById("cCode").value = "CS401";
  d1.getElementById("cDesc").value = "词法、语法、语义分析与代码生成";
  d1.getElementById("courseSave").dispatchEvent(new w1.Event("click", { bubbles: true }));
  await settle(dom1);
  const savedCourses = w1.localStorage.getItem("st_courses");
  savedCourses ? P("建课后 st_courses 已写入") : F("未写 st_courses");
  dom1.window.close();

  /* ---- ② 重开壳：课程还在，且排在「我的课程」里 ---- */
  const dom2 = load("app.html", { role: "teacher", jar, restore: { ls: { st_courses: savedCourses } } });
  await settle(dom2);
  const d2 = dom2.window.document;
  // 分组里的每一项现在都该是可点的（带 ?course=）；「可点项数 === 全部项数」就是这条保证。
  // ⚠️ 第 23 轮之前这里还要分两个数看 —— 因为当时有一条 page 为空的灰显「操作系统」占位。
  const items2 = courseItems(d2);
  const linkable2 = items2.filter((b) => /^class\.html\?course=/.test(b.dataset.page || ""));
  // 预置课程 + 新建的那门；预置课程现在全部可点（第 24 轮去掉了 page 为空的「操作系统」）
  items2.length === linkable2.length && items2.length >= 2
    ? P(`重开后「我的课程」共 ${items2.length} 项，且都可点击`)
    : F("重开后分组项数异常: " + items2.length + "（可点 " + linkable2.length + "）");
  const mine = linkable2.find((b) => /cs401/.test(b.dataset.page));
  mine && /编译原理/.test(mine.textContent) ? P("新建的课程重开后仍显示在侧栏") : F("新建课程丢了");
  dom2.window.close();

  /* ---- ③ 点课程 → class.html（课程成员）读到 ?course= ---- */
  const dom3 = load("class.html", {
    role: "teacher", jar, query: "?course=cs401",
    restore: { ls: { st_courses: savedCourses } },
  });
  await settle(dom3);
  const d3 = dom3.window.document;
  const crumb = d3.getElementById("crumbText").textContent;
  /编译原理/.test(crumb) ? P("class.html 页头显示课程名：" + crumb) : F("页头没认课程: " + crumb);
  d3.getElementById("stIn").textContent === "0"
    ? P("刚建的课还没有学生 → 在课学生如实为 0") : F("在课学生不对: " + d3.getElementById("stIn").textContent);
  /本机还没有学生加入这门课/.test(d3.getElementById("stuRows").innerHTML)
    ? P("没人加入时给空状态 + 指路邀请码（不拿样本学生冒充）")
    : F("仍在展示伪造的学生名单");
  !/李同学|张同学/.test(d3.getElementById("stuRows").innerHTML)
    ? P("空状态里没有任何虚构学生") : F("空状态里还有虚构学生");
  d3.getElementById("courseCode").textContent.trim().length >= 5
    ? P("空状态也给出这门课的邀请码：" + d3.getElementById("courseCode").textContent.trim())
    : F("没有邀请码");
  dom3.window.close();

  /* ---- ④ 有学生真的加入后，名单就出现他 ---- */
  const dom4 = load("class.html", {
    role: "teacher", jar, query: "?course=cs401",
    restore: { ls: {
      st_courses: savedCourses,
      st_accounts: JSON.stringify([
        { role: "student", user: "zhangsan", pass: "x", name: "张三", createdAt: 1780000000000 },
      ]),
      "st_enroll:student:zhangsan": JSON.stringify([
        { courseId: "cs401", name: "编译原理", code: "CS401", joinCode: "CS401-UB7G", by: "李老师", at: 1780300000000 },
      ]),
    } },
  });
  await settle(dom4);
  const d4 = dom4.window.document;
  /数据结构与算法/.test(d4.getElementById("crumbText").textContent) === false
    ? P("?course=cs401 显示的就是这门课（没有被预置课顶掉）") : F("课程解析串了");
  d4.querySelectorAll("#stuRows tr").length === 1 && /张三/.test(d4.getElementById("stuRows").textContent)
    ? P("有学生加入后名单里就出现他（真实选课记录驱动）") : F("名单没跟上");
  d4.getElementById("stIn").textContent === "1" ? P("在课学生变成 1") : F("在课学生没更新");
  dom4.window.close();

  /* ---- ⑤ 独立模式（双击 html）建课也要能重挂侧栏 ---- */
  const dom5 = load("exam.html", { role: "teacher" });
  await settle(dom5);
  const w5 = dom5.window, d5 = w5.document;
  const before5 = d5.querySelectorAll(".standalone-side .side-item").length;
  d5.getElementById("addCourseBtn").dispatchEvent(new w5.Event("click", { bubbles: true }));
  d5.getElementById("cName").value = "离散数学";
  d5.getElementById("courseSave").dispatchEvent(new w5.Event("click", { bubbles: true }));
  await settle(dom5);
  const after5 = d5.querySelectorAll(".standalone-side .side-item").length;
  after5 === before5 + 1
    ? P(`独立模式建课后侧栏重挂成功（${before5} → ${after5} 项）`)
    : F(`独立模式侧栏没更新: ${before5} → ${after5}`);
  // ⚠️ mountStandaloneSide() 有「已存在就 return」的短路，必须先去旧再挂新
  d5.querySelectorAll(".standalone-side").length === 1
    ? P("独立模式侧栏没有重复渲染（仍然只有一套）") : F("独立模式出现了多套侧栏");
  /离散数学/.test(d5.querySelector(".standalone-side").textContent)
    ? P("独立模式新课程出现在菜单里") : F("独立模式菜单没更新");
  dom5.window.close();

  /* ---- ⑥ 存档坏掉 / 空数组 ---- */
  const dom6 = load("app.html", { role: "teacher", jar, restore: { ls: { st_courses: "{坏 JSON" } } });
  await settle(dom6);
  const items6 = courseItems(dom6.window.document);
  items6.length === dom6.window.SEED_COURSES.length && /数据结构与算法/.test(items6[0].textContent)
    ? P("课程存档损坏时回落到预置课程（" + items6.length + " 项、不白屏）")
    : F("坏存档导致课程渲染失败: " + items6.length + " 项");
  dom6.window.close();

  const dom7 = load("app.html", { role: "teacher", jar, restore: { ls: { st_courses: "[]" } } });
  await settle(dom7);
  const items7 = courseItems(dom7.window.document);
  items7.length === 0 ? P("课程被清空后重开仍是空的（不复活预置课程）")
    : F("空数组被当成「没有记录」: " + items7.length);
  dom7.window.close();

  /* ---- ⑦ 旧存档里残留的演示课程「操作系统」（没有 page → 灰的、点不动）----
     第 24 轮把 SEED_COURSES 里那条删掉了，但**存过盘的旧存档优先于种子**
     （loadCourses 先读存档、读不到才回落种子），所以改种子清不掉它 ——
     侧栏会一直挂着一条灰的「操作系统」，看着就像"没删掉"。
     第 30 轮改成读档时清掉（nav.js 的 dropLegacyDemoCourses）。 */
  const stale = JSON.stringify([
    { id: "ds", name: "数据结构与算法", code: "CS201", page: "class.html" },
    { id: "os", name: "操作系统", code: "CS301", page: "" },      // 旧版演示残留
  ]);
  const dom8 = load("app.html", { role: "teacher", jar, restore: { ls: { st_courses: stale } } });
  await settle(dom8);
  const w8 = dom8.window;
  const items8 = courseItems(w8.document);
  const names8 = items8.map((b) => b.textContent.replace(/\s+/g, "")).join("/");
  !/操作系统/.test(names8) && items8.length === 1
    ? P("旧存档里残留的「操作系统」不会再显示（读档时清掉）")
    : F("旧演示课程还在侧栏: " + names8);
  items8.every((b) => b.dataset.page)
    ? P("清完之后「我的课程」每一项都可点") : F("还有点不动的课程项");
  !w8.COURSES.some((c) => c.id === "os")
    ? P("COURSES 里也真的没有它（不是只藏起来）") : F("COURSES 里还留着 os");
  !/操作系统/.test(String(w8.localStorage.getItem("st_courses") || ""))
    ? P("再次落库时也不会把它写回去") : F("存档里还留着旧演示课程");
  dom8.window.close();
}

console.log("\n=== 3m-3. 教师端看学生的真实进度与推导 + 跨桶删除（第 55 轮）===");
{
  const ACC = JSON.stringify([
    { role: "teacher", user: "zhangsan", name: "李老师", createdAt: 1 },
    { role: "student", user: "lisi", name: "李四", createdAt: 2 },
  ]);
  const AID = "act-share-1";
  const ACT = JSON.stringify([{
    id: AID, title: "圆的面积", goal: "圆面积是怎么来的", status: "open", origin: "teacher",
    courseId: "", participants: [], findings: [], messages: [],
    skeleton: { stages: [{ id: "s1", prompt: "先问", hint: "线索", tryIt: "动手" }] },
    createdAt: 1, updatedAt: 1,
  }]);
  const PROG = JSON.stringify({
    "act-share-1": {
      activityId: AID, currentStage: "s1", done: false,
      notes: [{ at: 5, text: "我先量了半径" }],
      deductions: [{ at: 6, text: "半径翻倍，面积变四倍", source: "me" }],
      updatedAt: 7,
    },
  });

  const dom = load("training.html", { role: "teacher", restore: { ls: {
    st_accounts: ACC,
    st_current_user: "teacher:zhangsan",
    "st_activities:teacher:zhangsan": ACT,
    "st_activities:student:lisi": ACT,
    "st_training_progress:student:lisi": PROG,
  } } });
  await settle(dom);
  const w = dom.window, d = w.document;
  w.confirm = () => true;

  const paneTxt = () => d.getElementById("actPane").textContent;
  /学生做到哪了/.test(paneTxt())
    ? P("教师端实训详情有「学生做到哪了」区块") : F("缺「学生做到哪了」区块");
  /李四/.test(paneTxt())
    ? P("跨桶读到了学生的进度记录（显示学生姓名）") : F("没读到学生进度记录");
  /半径翻倍，面积变四倍/.test(paneTxt())
    ? P("能看到学生推导出来的结论（不只是「参没参与」）") : F("看不到学生推导内容");
  /1 人留下进度/.test(d.getElementById("actList").textContent)
    ? P("「N 人」是真实留下进度的人数（不是被圈进名单的人数）") : F("名单人数口径没换");

  /* 跨桶删除：教师桶删掉 → 学生桶里的同一副本也要没 */
  /act-share-1/.test(String(w.localStorage.getItem("st_activities:student:lisi") || ""))
    ? P("（前置）学生桶里确实有一份副本") : F("学生桶里没有副本，这条测不到");
  d.getElementById("actDel").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  !/act-share-1/.test(String(w.localStorage.getItem("st_activities:teacher:zhangsan") || ""))
    ? P("删除后教师桶里没有了") : F("教师桶没删掉");
  !/act-share-1/.test(String(w.localStorage.getItem("st_activities:student:lisi") || ""))
    ? P("学生桶里的同一副本也一并清掉（跨桶，不留孤儿）") : F("学生桶里还留着已删的活动");

  dom.window.close();
}

console.log("\n=== 3n. 实训管理：发布 → 引导骨架 → 发布状态 → 删除（真实 DOM）===");
{
  /* 独立模式打开（内容页自己渲染），数据走 nav.js 的预置演示实训。
     🔴 这一节要守的核心：界面上**不出现终点结论** —— 「不给答案，给路径」是产品主张，
        不能只在注释里成立。 */
  const dom = load("training.html", { role: "teacher" });
  await settle(dom);
  const w = dom.window, d = w.document;
  w.confirm = () => true;
  w.alert = () => {};

  const listItems = () => [...d.querySelectorAll("#actList .act-item")];
  const stageEls = () => [...d.querySelectorAll("#actStages .stage")];
  const chip = (k) => d.querySelector(`#actFilters [data-filter="${k}"]`);

  /* ---------- ① 列表与详情 ---------- */
  listItems().length === 2
    ? P("左侧列出 2 条预置实训（教师发布 / 学生发起）") : F("实训列表条数异常: " + listItems().length);
  /圆面积/.test(listItems()[0].textContent)
    ? P("列表项显示标题") : F("列表项没显示标题");
  /进行中|草案|已归档/.test(listItems()[0].textContent)
    ? P("列表项带状态标签") : F("列表项缺状态标签");
  /学生发起/.test(d.getElementById("actList").textContent)
    ? P("学生发起的活动也在这张表里（灵感 02：发起权不只属于教师）") : F("看不到学生发起的活动");
  const metaTxt = d.getElementById("actMeta").textContent;
  /共 2 条/.test(metaTxt) && !/待确认/.test(metaTxt)
    ? P("工具条概览：共 2 条（学生发起直接开启，不再有「待确认」）") : F("概览文案不对: " + metaTxt);

  /* ---------- ② 🔴 「不给答案」在界面上可验 ---------- */
  const stageTxt = () => d.getElementById("actStages").textContent;
  !/πr²|π r²|半径平方|S\s*=/.test(stageTxt())
    ? P("骨架区不出现终点结论（πr² / S=）—— 只给路径不给答案")
    : F("骨架区出现了结论，等于把答案给了学生");
  const srcLine = d.getElementById("actSkelSrc").textContent;
  /命中预置路径库/.test(srcLine) && /割圆|阿基米德/.test(srcLine)
    ? P("如实标注骨架来源（命中预置路径库 + 是哪条路径）") : F("来源标注不对: " + srcLine);
  stageEls().length === 4 ? P("详情里渲染出 4 步引导骨架") : F("骨架步数异常: " + stageEls().length);
  /引导问题|往哪想/.test(stageEls()[0].textContent) && /动手做/.test(stageEls()[0].textContent)
    ? P("每一步都能看到「引导问题 + 线索 + 动手做」三个抓手") : F("步骤结构不完整");
  const firstTitle = stageEls()[0].querySelector('[data-field="title"]').value;
  /先问/.test(firstTitle) ? P("步骤标题可编辑（输入框里是真实内容）") : F("步骤标题异常: " + firstTitle);

  /* ---------- ③ 字段编辑 → 落盘 ---------- */
  const titleInput = d.getElementById("actTitle");
  titleInput.value = "圆面积公式是怎么被创造出来的（改）";
  titleInput.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(dom);
  /（改）/.test(String(w.localStorage.getItem("st_activities")))
    ? P("改标题后立刻落盘（st_activities）") : F("标题没持久化");
  /（改）/.test(listItems()[0].textContent) ? P("列表同步更新了标题") : F("列表没跟着更新");

  const goalBox = d.getElementById("actGoal");
  goalBox.value = "想搞清公式是怎么来的";
  goalBox.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(dom);
  w.eval("ACTIVITIES.filter((a) => /想搞清公式/.test(a.goal)).length") === 1
    ? P("目标（学生看到的那句话）可改并保存") : F("目标没保存");

  /* ---------- ③b 讨论区（群聊）：老师能发信息 → 落盘 + 回显 ---------- */
  const paneC = d.getElementById("actPane");
  /讨论区/.test(paneC.textContent)
    ? P("右栏有「讨论区」群聊块") : F("讨论区块没渲染");
  /李老师|王同学/.test(paneC.textContent)
    ? P("讨论区里看得到预置消息（师生都有）") : F("讨论区没有预置消息");
  const chatInput = d.getElementById("chatInput");
  const chatSend = d.getElementById("chatSend");
  chatInput && chatSend ? P("讨论区有输入框与「发送」按钮") : F("讨论区控件缺失");
  chatInput.value = "今天先到这一步，明天各自说说自己的猜想。";
  chatSend.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  /明天各自说说/.test(d.getElementById("actPane").textContent)
    ? P("老师发的消息立刻回显") : F("老师消息没回显");
  /明天各自说说/.test(String(w.localStorage.getItem("st_activities")))
    ? P("🔴 老师消息写回了活动记录（落盘）") : F("老师消息没落盘");

  /* ---------- ④ 骨架步骤：加 / 删 / 调序（改完就落盘） ---------- */
  const before = stageEls().length;
  d.getElementById("actAddStep").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  stageEls().length === before + 1 ? P("「＋ 加一步」：骨架多一步") : F("加一步无效");

  // 把新加的（最后一步）挪到最前
  const last = stageEls()[stageEls().length - 1];
  last.querySelector('[data-act="up"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  w.eval("ACTIVITIES[0].skeleton.stages.length") === before + 1
    ? P("上移后步数不变（没有复制自己）") : F("上移把步骤弄丢了");

  const delBtn = stageEls()[stageEls().length - 1].querySelector('[data-act="del"]');
  delBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  stageEls().length === before ? P("删除这一步后回到原来的步数") : F("删除步骤无效: " + stageEls().length);

  const s0 = stageEls()[0].querySelector('[data-field="clue"]');
  s0.value = "可以查一查《九章算术》里的写法";
  s0.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle(dom);
  /九章算术/.test(String(w.localStorage.getItem("st_activities")))
    ? P("改某一步的「线索」也会落盘") : F("步骤字段没落盘");

  /* ---------- ⑤ 状态机：草案 → 进行中 → 已归档 ---------- */
  d.querySelector('#actPane [data-status="done"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  w.eval("ACTIVITIES[0].status") === "done" ? P("状态可切到「已归档」") : F("状态没切过去");
  /已归档/.test(listItems()[0].textContent) ? P("列表项的状态标签同步") : F("列表状态没同步");

  /* ---------- ⑥ 发布流程：一句话 → 骨架预览 → 建草案 ---------- */
  d.getElementById("btnNewAct").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const host = d.getElementById("modalHost");
  host && !host.hidden ? P("点「＋ 发布实训」弹出弹窗") : F("弹窗没出现");
  host && host.parentNode === d.body
    ? P("弹窗挂在自己的 body 上（内容页不能用壳的 #modalHost）") : F("弹窗挂错地方");
  /一句话目标/.test(host.textContent) ? P("弹窗含「一句话目标」输入") : F("缺目标输入");

  const mkGoal = d.getElementById("mkGoal");
  mkGoal.value = "勾股定理是怎么被发现的";
  mkGoal.dispatchEvent(new w.Event("input", { bubbles: true }));
  await settle(dom);
  const mkStages = d.getElementById("mkStages");
  mkStages.querySelectorAll(".mk-step").length >= 3
    ? P("一边写目标，一边就给出引导骨架预览（" + mkStages.querySelectorAll(".mk-step").length + " 步）")
    : F("骨架预览没生成");
  /命中预置路径库/.test(d.getElementById("mkSrc").textContent)
    ? P("预览标注命中了哪条路径") : F("预览没标来源");
  !/a²\s*\+\s*b²|c²\s*=/.test(mkStages.textContent)
    ? P("预览里也没有终点结论（a²+b²=c² 不在里面）—— 预览同样守着「不给答案」")
    : F("预览里出现了结论");

  // 换个不沾边的目标 → 通用骨架
  mkGoal.value = "怎么泡一杯好喝的咖啡";
  mkGoal.dispatchEvent(new w.Event("input", { bubbles: true }));
  await settle(dom);
  /通用/.test(d.getElementById("mkSrc").textContent)
    ? P("没命中路径库时明说「通用骨架」（不硬套、也不假装联网搜过）") : F("未命中时来源说明不对");

  // 建一条
  mkGoal.value = "排序算法为什么会有这么多种";
  mkGoal.dispatchEvent(new w.Event("input", { bubbles: true }));
  d.getElementById("mkCreate").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.getElementById("modalHost").hidden ? P("创建后弹窗自动关闭") : F("弹窗没关");
  w.eval("ACTIVITIES.length") === 3 ? P("新实训进了列表（3 条）") : F("新建失败: " + w.eval("ACTIVITIES.length"));
  w.eval("ACTIVITIES[2].status") === "draft" ? P("新建的是草案（骨架先给教师过一眼）") : F("新建状态不对");
  /排序算法/.test(d.getElementById("actTitle").value)
    ? P("创建后自动选中它，接着就能改骨架") : F("没有自动选中新建的实训");
  /排序算法/.test(String(w.localStorage.getItem("st_activities") || ""))
    ? P("新建后落盘（重开还在）") : F("新建的活动没落盘");

  /* ---------- ⑦ 空目标要拦住 ---------- */
  d.getElementById("btnNewAct").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.getElementById("mkCreate").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const mkErr = d.getElementById("mkErr");
  mkErr && !mkErr.hidden && /目标/.test(mkErr.textContent)
    ? P("空目标被拦下并给出可读提示") : F("空目标没拦住");
  d.querySelector('#modalHost [data-close]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);

  /* ---------- ⑧ 学生的新发现 + 推荐方向 ---------- */
  // 选中那条有「新发现」的演示活动（可能已被上一步改了状态，直接按标题选）
  const fItem = listItems().find((b) => /圆面积/.test(b.textContent));
  fItem.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.querySelectorAll("#actFindings .finding").length === 2
    ? P("展示 2 条学生「新发现」（演示数据）") : F("新发现列表异常");
  const pinnedBefore = d.querySelectorAll("#actFindings .finding.pinned").length;
  const pinBtn = d.querySelector("#actFindings .finding:not(.pinned) [data-pin]");
  pinBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.querySelectorAll("#actFindings .finding.pinned").length === pinnedBefore + 1
    ? P("可把某条发现标为「推荐方向」（学生的新方向能被认出来）")
    : F("推荐方向没生效");

  /* ---------- ⑨ 删除：先讲清后果 ---------- */
  const nBefore = w.eval("ACTIVITIES.length");
  d.getElementById("actDel").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  w.eval("ACTIVITIES.length") === nBefore - 1
    ? P("删除实训后列表少一条") : F("删除无效: " + w.eval("ACTIVITIES.length"));
  w.eval("ACTIVITIES.filter((a) => /圆面积/.test(a.title)).length") === 0
    ? P("删掉的那条真的没了（不是只从界面藏起来）") : F("删了还在");

  dom.window.close();
}

console.log("\n=== 3o. 侧栏「实训管理」：学生发起直接开启 → 不再挂「待确认」徽标 ===");
{
  /* 学生发起直接 open（不等老师确认）→ pendingStudentActivities 恒 0 →
     教师端侧栏「实训管理」不再有「待确认」徽标。 */
  const dom = load("app.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document, w = dom.window;

  const navItem = () => [...d.querySelectorAll("#shellSide .side-item")]
    .find((b) => /实训管理/.test(b.textContent));

  const it = navItem();
  it ? P("教师侧栏出现「实训管理」") : F("侧栏没有实训管理");
  it && it.dataset.page === "training.html"
    ? P("点击它跳 training.html（带 data-page，可路由）") : F("菜单项没指向 training.html: " + (it && it.dataset.page));
  it && !/待确认/.test(it.textContent)
    ? P("学生发起直接开启 → 教师端不再挂「待确认」徽标")
    : F("不该有「待确认」徽标: " + (it && it.textContent));

  // 种子里的学生发起活动已经是 open（直接开启），不是 draft
  const acts = JSON.parse(w.eval("JSON.stringify(ACTIVITIES)"));
  const studentAct = acts.filter((a) => a.origin === "student")[0];
  studentAct && studentAct.status === "open"
    ? P("学生发起的活动 status=open（直接开启，不等老师确认）")
    : F("学生发起的活动状态不对: " + (studentAct && studentAct.status));

  dom.window.close();
}

console.log("\n=== 3o-b. 学生端实训：跨桶读 → 推进 → 记路线 → 新发现 → 发起（真实 DOM）===");
{
  /* 学生端「实训」页。核心：老师发布的活动在**老师桶**里，学生必须跨桶才读得到；
     学生的进度/笔记落**学生桶**，新发现写回**老师桶**。 */
  const crossAct = {
    id: "act-cross", title: "圆面积公式是怎么来的", goal: "圆的面积公式怎么被创造出来的", courseId: "ds",
    origin: "teacher", createdBy: "", status: "open", openEnded: true,
    skeleton: { source: "path", pathId: "circle-area", pathTitle: "圆的面积", era: "", goal: "圆的面积", stages: [
      { id: "s1", title: "先问：凭什么知道它", prompt: "往哪想", clue: "内接正多边形", tryIt: "画个内接正六边形" },
      { id: "s2", title: "让误差看得见", prompt: "边数加倍会怎样", clue: "割圆术", tryIt: "算正十二边形比值" },
    ] },
    participants: ["李同学"], findings: [],
    messages: [
      { id: "m-cross-1", who: "李老师", role: "teacher", at: 1000, text: "先想一想：现在会算哪些图形的面积？" },
    ],
    createdAt: 1, updatedAt: 2,
  };
  const dom = load("training-student.html", { role: "student", restore: { ls: {
    st_current_user: "student:student",
    st_accounts: JSON.stringify([
      { role: "teacher", user: "teacher", pass: "x", name: "李老师" },
      { role: "student", user: "student", pass: "x", name: "李同学" },
    ]),
    "st_activities:teacher:teacher": JSON.stringify([crossAct]),
  } } });
  await settle(dom);
  const w = dom.window, d = w.document;
  w.confirm = () => true;

  const items = () => [...d.querySelectorAll("#stList .act-item")];

  /* ---------- ① 列表：跨桶读到老师发的 + 自己发起的 ---------- */
  items().length >= 3
    ? P("学生端列表有实训（预置 + 老师跨桶发来的，共 " + items().length + " 条）")
    : F("实训列表条数异常: " + items().length);
  /圆面积公式是怎么来的/.test(d.getElementById("stList").textContent)
    ? P("跨账号桶读到了老师发布的实训（记录在老师桶里）")
    : F("读不到老师桶里的实训");
  /我发起的/.test(d.getElementById("stList").textContent)
    ? P("自己发起的也列出来了")
    : F("看不到自己发起的活动");

  /* ---------- ② 点开 → 参与视图：三栏（列表 / 聊天 / 进度）/ 不显示骨架 ---------- */
  d.querySelector('#stList [data-act-id="act-cross"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const pane = d.getElementById("stChat");     // 中栏：标题 + 目标 + 讨论区
  const side = d.getElementById("stSide");     // 右栏：进度 / 灵感 / 推导
  pane && side ? P("学生端是左中右三栏（#stList / #stChat / #stSide）") : F("三栏容器缺失");
  /圆面积公式是怎么来的/.test(pane.textContent)
    ? P("点开实训看到标题与参与视图") : F("详情没渲染");
  /圆的面积公式怎么被创造出来的/.test(pane.textContent)
    ? P("中栏能看到「我们要探究什么」（目标）") : F("看不到目标");
  !/引导路径|引导问题|往哪想|动手做|内接正多边形|割圆术/.test(pane.textContent + side.textContent)
    ? P("学生端不显示引导骨架（不透露答案）") : F("学生端仍显示了骨架内容");
  /探究进度/.test(side.textContent) && /已积累 0 条成果/.test(side.textContent)
    ? P("右栏有「探究进度」且从 0 条成果开始") : F("进度初始不对");
  /保存的猜想灵感/.test(side.textContent)
    ? P("右栏有「保存的猜想灵感」区") : F("猜想灵感区没渲染");
  /目前推导出来有帮助的信息/.test(side.textContent)
    ? P("右栏有「目前推导出来有帮助的信息」区") : F("推导信息区没渲染");
  !/探究进度|保存的猜想灵感/.test(pane.textContent)
    ? P("中栏只放聊天（进度类块没堆在中栏）") : F("进度块仍堆在中栏");

  /* ---------- ③ 存为灵感 → 落学生桶进度层 ---------- */
  const ii = d.getElementById("ideaInput");
  const ia = d.getElementById("ideaAdd");
  ii && ia ? P("有「存为灵感」输入框与按钮") : F("灵感控件缺失");
  ii.value = "我把它切成 8 个扇形，拼起来像长方形";
  ia.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  /拼起来像长方形/.test(d.getElementById("stSide").textContent)
    ? P("存的灵感立刻回显") : F("灵感没回显");
  w.localStorage.getItem("st_training_progress:student:student") !== null
    ? P("🔴 灵感落盘到学生桶进度层（st_training_progress:student:student）")
    : F("灵感没落盘");

  /* ---------- ④ 标记新发现 → 写回老师桶 ---------- */
  const fi2 = d.getElementById("ideaInput");
  fi2.value = "我试了割补法，和割圆术是两条路";
  d.getElementById("findAdd").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  /割补法/.test(d.getElementById("stSide").textContent)
    ? P("标记新发现后立刻回显") : F("新发现没回显");
  /割补法/.test(String(w.localStorage.getItem("st_activities:teacher:teacher")))
    ? P("🔴 新发现写回了老师桶（老师看得到）") : F("新发现没落到老师桶");

  /* ---------- ⑤b 讨论区（群聊）：中栏 + 老师消息跨桶可读 + 学生发消息写回老师桶 ---------- */
  const paneC = d.getElementById("stChat");
  /讨论区/.test(paneC.textContent)
    ? P("中栏有「讨论区」群聊块") : F("讨论区块没渲染");
  /李老师/.test(paneC.textContent)
    ? P("讨论区里看得到老师发的消息（跨桶读）") : F("讨论区看不到老师消息");
  const chatInput = d.getElementById("chatInput");
  const chatSend = d.getElementById("chatSend");
  chatInput && chatSend ? P("讨论区有输入框与「发送」按钮") : F("讨论区控件缺失");
  chatInput.value = "老师，我卡在第二步了，能再给个线索吗？";
  chatSend.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  /卡在第二步/.test(d.getElementById("stChat").textContent)
    ? P("学生发的消息立刻回显") : F("学生消息没回显");
  /卡在第二步/.test(String(w.localStorage.getItem("st_activities:teacher:teacher")))
    ? P("🔴 学生消息写回了老师桶（老师看得到）") : F("学生消息没写回老师桶");

  /* ---------- ⑥ 发起实训：预览 → 创建 → 落学生桶 + 同步教师桶 ---------- */
  d.getElementById("btnNewAct").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const host = d.getElementById("modalHost");
  host && !host.hidden ? P("点「＋ 发起实训」弹出弹窗") : F("弹窗没出现");
  const mkGoal = d.getElementById("mkGoal");
  mkGoal.value = "勾股定理是怎么被发现的";
  mkGoal.dispatchEvent(new w.Event("input", { bubbles: true }));
  await settle(dom);
  d.getElementById("mkStages").querySelectorAll(".mk-step").length >= 3
    ? P("写目标时实时给出引导骨架预览") : F("发起预览没生成");
  d.getElementById("mkCreate").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  w.eval("localStorage.getItem('st_activities:student:student') || ''").indexOf("勾股定理") >= 0
    ? P("🔴 学生发起的写进了学生桶") : F("学生发起的没落学生桶");
  w.eval("localStorage.getItem('st_activities:teacher:teacher') || ''").indexOf("勾股定理") >= 0
    ? P("🔴 学生发起的同步到了本机教师桶（老师也能看到这条）")
    : F("学生发起的没同步给老师");
  /进行中/.test(d.getElementById("stList").textContent)
    ? P("发起后列表里出现「进行中」（学生发起直接开启，不等老师确认）") : F("发起后状态不对");

  /* ---------- ⑦ 让 AI 验证 → 结论记入「推导信息」（第 50/52 轮） ---------- */
  const gi2 = d.getElementById("guessInput");
  const gg = d.getElementById("guessGo");
  gi2 && gg ? P("「推导信息」区有「让 AI 验证」输入框与按钮") : F("AI 验证控件缺失");
  gi2.value = "我猜：先分两半各自排序再合并，是不是归并排序？";
  gg.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  /预置示例/.test(d.getElementById("stSide").textContent)
    ? P("未接模型/未配搜索时，结论标「预置示例」记入推导信息")
    : F("AI 验证没给出预置示例结论");
  /先分两半各自排序再合并/.test(d.getElementById("stSide").textContent)
    ? P("猜想本身也存成了灵感（保存的猜想灵感区能看到）")
    : F("猜想没存成灵感");

  dom.window.close();
}

console.log("\n=== 3p. 学生「加入课堂」：邀请码 / 加入 / 退出（真实 DOM）===");
{
  /* 本机有一个教师账号建过的课（放在全局桶里，学生因此"看得到"它）；
     学生用邀请码加入 —— 这是纯静态站里唯一能演示的跨账号协作路径。 */
  const teacherCourses = JSON.stringify([
    { id: "cs401", name: "编译原理", code: "CS401", term: "2026 秋季", page: "class.html" },
  ]);
  const dom = load("app.html", { role: "student", restore: { ls: { st_courses: teacherCourses } } });
  await settle(dom);
  const w = dom.window, d = w.document;
  w.confirm = () => true;
  w.alert = () => {};

  const courseGroup = () => [...d.querySelectorAll("#shellSide .side-group")]
    .find((g) => /我的课程/.test((g.querySelector("h4 span") || {}).textContent || ""));
  const courseItems = () => [...courseGroup().querySelectorAll(".side-item")];
  const code = w.eval("joinCodeOf(classroomCatalog().find((x) => x.course.id === 'cs401').course)");

  /* ---------- ① 加号与初始课程表 ---------- */
  const addBtn = d.getElementById("joinCourseBtn");
  addBtn ? P("学生端「我的课程」右侧有 ＋ 按钮") : F("学生端没有加入课堂的加号");
  addBtn && addBtn.dataset.action === "joinCourse"
    ? P("加号带 data-action=joinCourse（数据驱动，渲染侧不用改）") : F("加号没带 action");
  courseItems().length === 1 && /数据结构与算法/.test(courseItems()[0].textContent)
    ? P("初始课程表：预置的「数据结构与算法」（演示账号才有）") : F("初始课程表异常");
  courseGroup().querySelectorAll(".side-item.disabled").length === 0
    ? P("学生课程项都可点（没有灰的、点不动的占位）") : F("出现了灰显课程项");

  /* ---------- ② 输入错码 ---------- */
  addBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const host = d.getElementById("modalHost");
  host && !host.hidden ? P("点 ＋ 弹出「加入课堂」弹窗") : F("弹窗没出现");
  d.getElementById("joinCode") ? P("弹窗里有邀请码输入框") : F("缺邀请码输入框");
  d.getElementById("joinCode").value = "ZZZ-0000";
  d.getElementById("joinSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const err = d.getElementById("joinError");
  err && !err.hidden && /没找到/.test(err.textContent)
    ? P("错码被拦下并给出可读提示") : F("错码没拦住: " + (err && err.textContent));
  !host.hidden ? P("出错时弹窗保持打开（不用重新输入）") : F("出错把弹窗关了");

  /* ---------- ③ 输入对码（故意写歪：小写 + 去掉横线 + 空格）---------- */
  d.getElementById("joinCode").value = "  " + code.toLowerCase().replace("-", "") + " ";
  d.getElementById("joinSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.getElementById("modalHost").hidden ? P("加入成功后弹窗自动关闭") : F("弹窗没关");
  const names = courseItems().map((b) => b.textContent.replace(/\s+/g, ""));
  names.length === 2 && names.some((t) => /编译原理/.test(t))
    ? P("侧栏课程表里多了「编译原理」") : F("侧栏没更新: " + names.join("/"));
  /cs401/.test(String(w.localStorage.getItem("st_enroll") || ""))
    ? P("加入的课堂落盘（st_enroll）") : F("没落盘");
  const frame = d.getElementById("contentFrame");
  /chat\.html\?course=cs401/.test(frame.getAttribute("src") || "")
    ? P("加入后直接跳到这门课的答疑页（chat.html?course=cs401）") : F("没跳过去: " + frame.getAttribute("src"));
  w.eval("currentPage") === "chat.html?course=cs401"
    ? P("壳记住了当前页（带查询串，多门课不会一起高亮）") : F("currentPage 不对: " + w.eval("currentPage"));

  /* ---------- ④ 重复加入要拦下 ---------- */
  d.getElementById("joinCourseBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.getElementById("joinCode").value = code;
  d.getElementById("joinSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const err2 = d.getElementById("joinError");
  err2 && !err2.hidden && /已经/.test(err2.textContent)
    ? P("重复加入同一门课被拦下（不静默复制一条）") : F("重复加入没拦住: " + (err2 && err2.textContent));
  d.querySelector('#modalHost [data-close]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);

  /* ---------- ⑤ 退出课堂 ---------- */
  const moreBtn = [...courseGroup().querySelectorAll(".side-more")]
    .find((b) => b.dataset.more === "cs401");
  moreBtn ? P("学生课程项也带「⋯」（退出课堂）") : F("学生课程项没有「⋯」");
  moreBtn.dataset.moreKind === "joinCourse"
    ? P("「⋯」带 data-more-kind=joinCourse（与教师端菜单区分开）") : F("data-more-kind 不对");
  moreBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const menu = d.getElementById("sideMenu");
  menu && /退出课堂/.test(menu.textContent) ? P("菜单里是学生端的「退出课堂」") : F("菜单项不对");
  menu && !/删除课程|编辑课程信息|查看邀请码/.test(menu.textContent)
    ? P("没有把教师端菜单项泄漏给学生（两份菜单分开了）") : F("学生菜单里混进了教师端项");
  menu.querySelector('[data-act="leave"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  courseItems().length === 1 ? P("退出后课程表回到 1 门") : F("退出无效: " + courseItems().length);
  !/cs401/.test(String(w.localStorage.getItem("st_enroll") || ""))
    ? P("退出后存档里也没了") : F("存档没更新");

  dom.window.close();
}

console.log("\n=== 3q. 教师端「查看邀请码」与课堂页课程名（真实 DOM）===");
{
  /* 教师端：课程「⋯」→ 查看邀请码 */
  const dom = load("app.html", { role: "teacher" });
  await settle(dom);
  const w = dom.window, d = w.document;
  const more = [...d.querySelectorAll("#shellSide .side-more")]
    .find((b) => b.dataset.moreKind === "addCourse");
  more ? P("教师课程项「⋯」带 data-more-kind=addCourse") : F("教师「⋯」缺 kind");
  more.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const menu = d.getElementById("sideMenu");
  /查看邀请码/.test(menu ? menu.textContent : "")
    ? P("教师菜单里多了「查看邀请码」") : F("教师菜单缺「查看邀请码」");
  menu.querySelector('[data-act="code"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const codeText = d.getElementById("joinCodeText");
  const expect = w.eval("joinCodeOf(COURSES[0])");
  codeText && codeText.textContent.trim() === expect
    ? P("弹窗显示的邀请码 = joinCodeOf(课程)（老师看到的码就是学生要输的码：" + expect + "）")
    : F("邀请码不一致: " + (codeText && codeText.textContent) + " vs " + expect);
  /数据结构与算法/.test(d.querySelector("#modalHost").textContent)
    ? P("弹窗里写清了这是哪门课的码") : F("弹窗没标课程名");
  d.querySelector('#modalHost [data-close]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  dom.window.close();

  /* 答疑页：带 ?course= 显示这门课；不带就落到课程表第一门 */
  const dom2 = load("chat.html", { role: "student", query: "?course=ds" });
  await settle(dom2);
  const d2 = dom2.window.document;
  d2.getElementById("courseName").textContent === "数据结构与算法"
    ? P("?course=ds → 页头显示当前课堂名") : F("课程名没跟着走: " + d2.getElementById("courseName").textContent);
  /第 7 章/.test(d2.getElementById("crumbText").textContent)
    ? P("面包屑带上章节（演示课程才有章节）") : F("面包屑不对");
  /已加载 4 个知识点/.test(d2.getElementById("chatSub").textContent)
    ? P("副标题与课程匹配") : F("副标题不对");
  dom2.window.close();

  /* 没加入任何课堂 → 如实说，不硬撑 */
  const dom3 = load("chat.html", { role: "student", restore: { ls: { st_enroll: "[]" } } });
  await settle(dom3);
  const d3 = dom3.window.document;
  /还没有加入课堂/.test(d3.getElementById("crumbText").textContent)
    ? P("课程表为空时明说「还没有加入课堂」") : F("空课程表没提示: " + d3.getElementById("crumbText").textContent);
  /邀请码/.test(d3.getElementById("chatSub").textContent)
    ? P("并指路到「我的课程 ＋ 输入邀请码」") : F("没指路");
  dom3.window.close();
}

console.log("\n=== 3r. 独立打开时的加入课堂（不经过壳）===");
{
  /* 双击 chat.html 直接打开：core.js 自己渲染顶部栏与侧栏。
     ⚠️ 这条路单独验：core.js 的侧栏有「已存在就 return」的短路，
        加入课堂后必须走 remountStandaloneSide() 才刷得出来。 */
  const teacherCourses = JSON.stringify([
    { id: "cs401", name: "编译原理", code: "CS401", page: "class.html" },
  ]);
  const dom = load("chat.html", { role: "student", restore: { ls: { st_courses: teacherCourses } } });
  await settle(dom);
  const w = dom.window, d = w.document;
  w.confirm = () => true;
  w.alert = () => {};

  const side = d.querySelector(".standalone-side");
  side ? P("独立模式自己渲染了侧栏") : F("独立模式没有侧栏");
  const btn = d.getElementById("joinCourseBtn");
  btn ? P("独立模式的侧栏也有「加入课堂」加号") : F("独立模式缺加号");
  d.querySelectorAll(".standalone-side").length === 1
    ? P("侧栏只有一套（没有重复渲染）") : F("独立模式出现了多套侧栏");

  const code = w.eval("joinCodeOf(classroomCatalog().find((x) => x.course.id === 'cs401').course)");
  btn.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.getElementById("joinCode") ? P("独立模式也能弹出加入课堂弹窗") : F("独立模式弹窗没出现");
  d.getElementById("joinCode").value = code;
  d.getElementById("joinSave").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const labels = [...d.querySelectorAll(".standalone-side .side-item .side-label")].map((x) => x.textContent);
  labels.includes("编译原理")
    ? P("加入后独立模式的侧栏也刷新了（走了 remountStandaloneSide）") : F("独立模式侧栏没更新: " + labels.join("/"));
  d.querySelectorAll(".standalone-side").length === 1
    ? P("重挂后仍然只有一套侧栏（没叠加）") : F("重挂出了多套侧栏");
  dom.window.close();
}

console.log("\n=== 3s. 工作台（第 43 轮）：AI 工作台 —— 说需求 / 生成 / 打开 / 下发 / 跨桶 ===");
{
  const waitForCard = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 60));
    }
    return null;
  };

  /* ---------- 教师端 ---------- */
  const dom = load("workbench.html", { role: "teacher", restore: { ls: { st_current_user: "teacher:teacher" } } });
  await settle(dom);
  const w = dom.window, d = w.document;

  /* --- 页面就该长这样：只有 AI 工作台 --- */
  d.getElementById("appAsk") && d.getElementById("appMake") && d.getElementById("appGrid")
    ? P("生成区与列表都在（需求输入 / 生成按钮 / 工作台列表）") : F("页面结构不对");
  !d.getElementById("tabDesk") && !d.getElementById("tabTools")
    ? P("🔴 事务台与教学模拟的视图已移除（只剩 AI 工作台）") : F("还有别的视图");
  !d.querySelector(".dk-tabs") ? P("页签条已移除（只剩一个视图，不需要它）") : F("页签条还在");
  !d.getElementById("chatLog") && !d.getElementById("sendBtn") ? P("没有对话式布局") : F("出现了对话布局");
  d.getElementById("appBannerBox") ? P("有 toast 宿主（#appBannerBox）") : F("缺 toast 宿主");

  /* --- 种子工作台 --- */
  const cards = [...d.querySelectorAll("#appGrid .sm-card")];
  cards.length >= 1 ? P("列表里有演示种子工作台（" + cards.length + " 个）") : F("列表空");
  cards.some((c) => /作业提交跟踪/.test(c.textContent))
    ? P("种子是「作业提交跟踪」（演示点开就能动）") : F("种子不对");
  const card = cards[0];
  card.querySelector('[data-a="app-open"]') ? P("卡片有「打开」") : F("缺打开");
  card.querySelector('[data-a="app-send"]') ? P("卡片有「下发给学生」") : F("缺下发");
  card.querySelector('[data-a="app-rename"]') ? P("卡片有「改名」") : F("缺改名");
  card.querySelector('[data-a="app-del"]') ? P("卡片有「删除」") : F("缺删除");

  /* --- 示例 chips --- */
  const egs = d.querySelectorAll("#appExamples .app-eg");
  egs.length >= 3 ? P("示例 chips 有 " + egs.length + " 个（不知道写什么时点一下）") : F("示例太少");
  egs[0].dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  d.getElementById("appAsk").value.trim().length > 0 ? P("点示例 chip 会填进输入框") : F("chip 没填进去");

  /* --- 生成：演示模式如实拒绝，不塞假卡片 --- */
  const n0 = d.querySelectorAll("#appGrid .sm-card").length;
  d.getElementById("appMake").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const prog = d.getElementById("appProgress");
  prog && prog.hidden === false && /设置|Key|演示模式/.test(prog.textContent)
    ? P("🔴 未接模型时如实说明原因 + 指路设置（不假装生成了）") : F("没如实拒绝");
  d.querySelectorAll("#appGrid .sm-card").length === n0
    ? P("🔴 生成失败不往列表塞假卡片") : F("塞了假卡片");

  /* --- 打开：pageModalHost + 同源沙箱 --- */
  card.querySelector('[data-a="app-open"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const host = d.getElementById("modalHost");
  const fr = host && host.querySelector("iframe.sm-frame");
  fr ? P("点「打开」开出弹窗 + iframe") : F("没开出来");
  fr && /allow-same-origin/.test(fr.getAttribute("sandbox") || "")
    ? P("🔴 工作台给同源沙箱（要 localStorage 存数据，刷新不丢）") : F("没给同源，数据存不住");
  fr && (fr.getAttribute("srcdoc") || "").length > 200 ? P("用 srcdoc 载入（不落磁盘）") : F("没用 srcdoc");
  host.querySelector('[data-app-act="reload"]') ? P("弹窗有「重载」") : F("缺重载");
  host.querySelector('[data-app-act="code"]') ? P("弹窗有「看代码」") : F("缺看代码");
  host.querySelector('[data-app-act="send"]') ? P("弹窗里也有「下发给学生」") : F("弹窗缺下发");
  host.querySelector('[data-app-act="close"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  host.hidden === true ? P("能关掉弹窗") : F("弹窗没关");

  /* --- 下发名单：没有在课学生就如实说 --- */
  card.querySelector('[data-a="app-send"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const sh = d.getElementById("modalHost");
  sh && sh.hidden === false ? P("点「下发给学生」开出名单弹窗") : F("名单弹窗没开");
  /还没有学生加入|发给谁/.test(sh ? sh.textContent : "")
    ? P("名单弹窗：要么给选人、要么如实说没学生（不假装发出去了）") : F("名单弹窗内容不对");
  const cbtn = sh.querySelector('[data-mc="no"]') || sh.querySelector('[data-mc="ok"]');
  if (cbtn) { cbtn.dispatchEvent(new w.Event("click", { bubbles: true })); await settle(dom); }

  /* --- 改名：走 pageModalHost（不用 window.prompt） --- */
  card.querySelector('[data-a="app-rename"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const rh = d.getElementById("modalHost");
  rh && rh.hidden === false && rh.querySelector("#dkAskInput")
    ? P("改名走页面弹窗（不是 window.prompt —— jsdom 与沙箱里没有）") : F("改名没走弹窗");
  const rcancel = rh.querySelector('[data-mc="no"]');
  if (rcancel) { rcancel.dispatchEvent(new w.Event("click", { bubbles: true })); await settle(dom); }

  /* --- 删除：先确认，再落库 --- */
  const before = d.querySelectorAll("#appGrid .sm-card").length;
  const delBtn = d.querySelector('#appGrid [data-a="app-del"]');
  const delId = delBtn.closest("[data-app]").getAttribute("data-app");
  delBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const dh = d.getElementById("modalHost");
  dh && dh.hidden === false ? P("删除先弹确认（不可逆操作要拦一下）") : F("删除没确认");
  const okb = dh.querySelector('[data-mc="ok"]');
  if (okb) { okb.dispatchEvent(new w.Event("click", { bubbles: true })); await settle(dom); }
  d.querySelectorAll("#appGrid .sm-card").length === before - 1
    ? P("确认后真删掉了（列表少一张）") : F("删除没生效");
  w.eval("simOfAnywhere('" + delId + "') === null") ? P("数据层里也没了") : F("数据层还在");

  /* --- 存档能读回（第 42 轮修的根因：loadSims 顶层用 LS → TDZ） --- */
  dom.window.close();
  const savedTool = {
    id: "app-saved-1", title: "我存过的工作台", goal: "验证存档读回", kind: "workbench",
    html: "<!DOCTYPE html><html><body><p>" + "x".repeat(500) + "</p></body></html>",
    status: "ready", provider: "deepseek", model: "m", createdBy: "teacher:teacher",
    createdAt: Date.now(), sentTo: [], feedback: [],
  };
  const domSaved = load("workbench.html", {
    role: "teacher",
    restore: {
      ls: {
        st_current_user: "teacher:teacher",
        st_accounts: JSON.stringify([{ role: "teacher", user: "teacher", pass: "x", name: "老师" }]),
        "st_sim:teacher:teacher": JSON.stringify(JSON.stringify([savedTool])),   // 老档的双重编码
      },
    },
  });
  await settle(domSaved);
  const dSaved = domSaved.window.document;
  /我存过的工作台/.test(dSaved.getElementById("appGrid").textContent)
    ? P("🔴 重新打开读回了存档（不是回到种子）—— 第 42 轮修的 TDZ 根因")
    : F("存档没读回来（又回到种子了）");
  domSaved.window.close();

  /* ---------- 学生端 ---------- */
  const domS = load("workbench.html", { role: "student", restore: { ls: { st_current_user: "student:student" } } });
  await settle(domS);
  const wS = domS.window, dS = wS.document;
  dS.getElementById("appAsk") && dS.getElementById("appMake")
    ? P("🔴 学生端也能自己造工作台（「让 AI 造一个」对两端开放）") : F("学生端没有生成入口");
  const cardsS = [...dS.querySelectorAll("#appGrid .sm-card")];
  cardsS.length >= 1 ? P("学生端有内容（" + cardsS.length + " 个）") : F("学生端列表空");
  /老师发来的/.test(dS.getElementById("appGrid").textContent)
    ? P("学生端分区显示「老师发来的」") : F("学生端没分区");
  !dS.querySelector('#appGrid [data-a="app-send"]')
    ? P("🔴 学生端卡片没有「下发给学生」（那是教师的动作）") : F("学生端有下发");
  !dS.querySelector('#appGrid [data-a="app-del"]')
    ? P("🔴 学生端卡片没有「删除」（不是他的东西）") : F("学生端有删除");
  !dS.querySelector('#appGrid [data-a="app-rename"]')
    ? P("🔴 学生端卡片没有「改名」") : F("学生端有改名");
  /* 打开「老师发来的」那份：记录不在学生桶里 → 必须走跨桶取数 */
  const openS = dS.querySelector('#appGrid [data-a="app-open"]');
  if (openS) {
    openS.dispatchEvent(new wS.Event("click", { bubbles: true }));
    await settle(domS);
    const hs = dS.getElementById("modalHost");
    const frs = hs && hs.querySelector("iframe.sm-frame");
    frs ? P("学生端能打开老师发来的工作台（跨桶取数没挡住）")
        : F("学生端点「打开」没反应 —— 卡在 simOf 只认本桶");
    !hs.querySelector('[data-app-act="send"]')
      ? P("🔴 学生端的工作台弹窗里也没有下发按钮") : F("学生端弹窗有下发");
    const cs = hs.querySelector('[data-app-act="close"]');
    if (cs) { cs.dispatchEvent(new wS.Event("click", { bubbles: true })); await settle(domS); }
  }
  domS.window.close();

  /* ---------- 跨页：AI 助手的结果「收进工作台」 ---------- */
  const domA = load("agent.html", {
    role: "teacher",
    restore: { ls: { st_current_user: "teacher:teacher", st_workbench: "[]" } },
  });
  await settle(domA);
  const dA = domA.window.document;
  dA.getElementById("input").value = "帮我校对这段：快排和快速排序都出现了。。";
  dA.getElementById("sendBtn").dispatchEvent(new domA.window.Event("click", { bubbles: true }));
  await waitForCard(() => dA.querySelector('#chatLog [data-act="save"]'), 8000);
  const saveBtn = dA.querySelector('#chatLog [data-act="save"]');
  saveBtn ? P("AI 助手的结果卡上有「收进工作台」") : F("结果卡没有收进工作台的入口");
  if (saveBtn) {
    saveBtn.dispatchEvent(new domA.window.Event("click", { bubbles: true }));
    await settle(domA);
    const stored = String(domA.window.localStorage.getItem("st_workbench:teacher:teacher") || "");
    /校对/.test(stored) ? P("收进去的卡片记着来源技能（校对）") : F("没收到工作台: " + stored.slice(0, 90));
    /已收进工作台/.test(saveBtn.textContent)
      ? P("收完入口就不可再点（同一份结果不会变成两张一样的卡）") : F("还能重复收");
  }
  domA.window.close();
}
console.log("\n=== 3t. 出题与组卷（第 44 轮）：真章节 / 逐题审核 / 组卷 / 发布 ===");
{
  const dom = load("exam.html", { role: "teacher", restore: { ls: { st_current_user: "teacher:teacher" } } });
  await settle(dom);
  const w = dom.window, d = w.document;

  /* --- 章节来自**真实教案大纲**，不是写死的 --- */
  const chaps = d.querySelectorAll("#chapters .chap-item");
  chaps.length >= 3 ? P("章节列表渲染出来了（" + chaps.length + " 章）") : F("章节没渲染出来: " + chaps.length);
  const sylCh = JSON.parse(w.eval("JSON.stringify(((syllabusOf('ds')||{}).chapters)||[])"));
  chaps.length === sylCh.length
    ? P("🔴 章节数与 syllabusOf('ds').chapters 一致（来自教案大纲）") : F("章节数与大纲不符");
  w.eval("typeof CHAPTERS") === "undefined"
    ? P("页面里不再有写死的 CHAPTERS") : F("还有写死的 CHAPTERS");

  /* --- 种卷 --- */
  const cards = [...d.querySelectorAll("#qList .q-card")];
  cards.length >= 4 ? P("打开就接着最近一份卷（" + cards.length + " 题）") : F("没加载出题目: " + cards.length);
  /预置示例/.test(d.getElementById("srcTag").textContent)
    ? P("🔴 种卷明确标了「预置示例」（不冒充 AI 现出的）") : F("没标示例来源");

  /* --- 点章节能切换范围 --- */
  const c0 = chaps[0];
  const wasOn = c0.className.indexOf("on") >= 0;
  c0.dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const nowOn = d.querySelectorAll("#chapters .chap-item")[0].className.indexOf("on") >= 0;
  nowOn !== wasOn ? P("点章节能切换选中（范围跟着变）") : F("章节点不动");
  // 选回来，别影响后面的断言
  d.querySelectorAll("#chapters .chap-item")[0].dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);

  /* --- 🔴 题型勾选：单选 / 多选 / 填空 / 简答（**不做编程题**） --- */
  const typeBtns = () => [...d.querySelectorAll("#qtypes .ex-type")];
  const onKeys = () => typeBtns().filter((b) => b.className.indexOf("on") >= 0).map((b) => b.getAttribute("data-type"));
  const allKeys = () => typeBtns().map((b) => b.getAttribute("data-type"));
  const clickType = async (k) => {
    const b = typeBtns().find((x) => x.getAttribute("data-type") === k);
    if (b) b.dispatchEvent(new w.Event("click", { bubbles: true }));
    await settle(dom);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // 期望值从数据层取，不在测试里写死 —— 以后加/减题型只改 nav.js
  const defKeys = JSON.parse(w.eval("JSON.stringify(EXAM_QTYPES.filter(function(t){return t.on;}).map(function(t){return t.key;}))"));
  const TYPES4 = ["single", "multi", "blank", "short"];

  same(allKeys(), TYPES4)
    ? P("题型勾选区渲染出四种（" + allKeys().join(" / ") + "）") : F("题型勾选区不对: " + JSON.stringify(allKeys()));
  !allKeys().includes("code")
    ? P("🔴 没有「编程题」（用户明确要求：其他四种就够）") : F("编程题还在: " + JSON.stringify(allKeys()));
  same(onKeys(), defKeys)
    ? P("🔴 默认四种全部勾上") : F("默认题型不对: " + JSON.stringify(onKeys()));
  /题型：单选/.test(d.getElementById("scopeNote").textContent)
    ? P("范围说明里带上了当前勾选的题型") : F("范围说明没写题型");

  await clickType("blank");
  same(onKeys(), ["single", "multi", "short"])
    ? P("点一下能取消勾选（简答以外的填空被关掉）") : F("取消勾选没生效: " + JSON.stringify(onKeys()));
  await clickType("blank");
  same(onKeys(), defKeys)
    ? P("再点一下能勾回来") : F("勾不回来: " + JSON.stringify(onKeys()));

  // 至少留一种：关到只剩一种后再点 → 拦住
  await clickType("multi");
  await clickType("blank");
  await clickType("short");
  same(onKeys(), ["single"])
    ? P("🔴 一种都不勾时被拦下（至少留一种题型，没法出一份没题型的卷）")
    : F("居然能被全部关掉: " + JSON.stringify(onKeys()));
  await clickType("multi");
  await clickType("blank");
  await clickType("short");
  same(onKeys(), defKeys)
    ? P("恢复成四种（后面的用例接着跑）") : F("恢复失败: " + JSON.stringify(onKeys()));

  /* --- 🔴 题目数量是**输入框**不是下拉（用户要求） --- */
  const numEl = d.getElementById("numQ");
  numEl && numEl.tagName === "INPUT" && numEl.getAttribute("type") === "number"
    ? P("题目数量是数字输入框（不是下拉选择）") : F("题目数量还是: " + (numEl ? numEl.tagName : "缺元素"));
  numEl.value = "12";
  const cfg12 = JSON.parse(w.eval("JSON.stringify((function(){ var v=document.getElementById('numQ').value; return { n: Number(v) }; })())"));
  cfg12.n === 12 ? P("输入框能被程序读到（12 题）") : F("输入框读值不对: " + JSON.stringify(cfg12));
  numEl.value = "999";                    // 乱填 → 出题时会被夹到上限
  d.getElementById("genBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  numEl.value === "30"
    ? P("🔴 乱填 999 被夹到上限 30（并写回输入框让人看见）") : F("没夹住: " + numEl.value);
  numEl.value = "8";
  await settle(dom);

  /* --- 采纳：状态与计数都要真动 --- */
  const accNum = () => Number((/(\d+)\s*\/\s*(\d+)/.exec(d.getElementById("accLine").textContent) || [0, 0])[1]);
  const before = accNum();
  const pend = cards.find((c) => c.className.indexOf("pending") >= 0);
  if (pend) {
    pend.querySelector('[data-act="accept"]').dispatchEvent(new w.Event("click", { bubbles: true }));
    await settle(dom);
    const after = accNum();
    after === before + 1 ? P("点「采纳」计数 +1（" + before + "→" + after + "）") : F("采纳没联动: " + before + "→" + after);
    const eid = w.eval("EXAMS[0].id");
    w.eval('examQuestionAt("' + eid + '", 3).state') === "accepted"
      ? P("采纳写进了数据层（不是只换个样式）") : F("采纳没落库");
  } else F("种卷里没有待审的题，测不了采纳");

  /* --- 弃用（⚠️ 每步都要**重新查询**：上一步 renderQuestions() 已经把整列重建过了，
         拿着旧引用点等于点一个脱离文档的元素，事件委托收不到 —— 踩过） --- */
  const acceptedCard = [...d.querySelectorAll("#qList .q-card")].find((c) => c.className.indexOf("accepted") >= 0);
  if (acceptedCard) {
    acceptedCard.querySelector('[data-act="drop"]').dispatchEvent(new w.Event("click", { bubbles: true }));
    await settle(dom);
    [...d.querySelectorAll("#qList .q-card")].some((c) => c.className.indexOf("dropped") >= 0)
      ? P("点「弃用」题目变灰（状态落库）") : F("弃用没生效");
  } else F("没有已采纳的题，测不了弃用");

  /* --- 修改题干：走页面弹窗，不是 window.prompt --- */
  const editBtn = d.querySelector('#qList .q-card [data-act="edit"]');
  if (editBtn) {
    editBtn.dispatchEvent(new w.Event("click", { bubbles: true }));
    await settle(dom);
    const host = d.getElementById("modalHost");
    host && host.hidden === false && host.querySelector("[data-f]")
      ? P("🔴 修改题干走页面弹窗（老版这里用的是 window.prompt）") : F("改题干没走弹窗");
    const cancel = host.querySelector('[data-mc="no"]');
    if (cancel) { cancel.dispatchEvent(new w.Event("click", { bubbles: true })); await settle(dom); }
  }

  /* --- 生成：未接模型时如实拒绝 --- */
  d.getElementById("genBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const prog = d.getElementById("exProgress");
  prog && prog.hidden === false && /设置|Key|演示模式/.test(prog.textContent)
    ? P("🔴 未接模型时如实说明 + 指路（不编题）") : F("没如实拒绝: " + (prog ? prog.textContent.slice(0, 40) : "无"));
  !d.getElementById("sampleBtn").hidden
    ? P("同时给了「先看一套示例题」的入口（明确标注是示例）") : F("缺示例入口");

  /* --- 🔴 没接模型时「让 AI 补一道」也不许塞假题 --- */
  {
    const beforeAI = d.querySelectorAll("#qList .q-card").length;
    d.getElementById("addQBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
    await settle(dom);
    d.getElementById("modalHost").querySelector('[data-mc="ai"]')
      .dispatchEvent(new w.Event("click", { bubbles: true }));
    await settle(dom);
    const p2 = d.getElementById("exProgress");
    (p2 && p2.hidden === false && /设置|Key|模型/.test(p2.textContent))
      ? P("🔴 没接模型时「让 AI 出一道」如实说明 + 指路") : F("AI 加题没如实拒绝");
    d.querySelectorAll("#qList .q-card").length === beforeAI
      ? P("🔴 没接模型时不往卷子里塞题（列表没变）") : F("居然塞了题");
  }

  /* --- 预览：弹窗只列「已采纳」的题 --- */
  d.getElementById("previewBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const ph = d.getElementById("modalHost");
  const ptext = ph ? ph.textContent : "";
  /试卷预览/.test(ptext) ? P("预览开出弹窗") : F("预览没开");
  const accCount = w.eval("examStats(EXAMS[0]).accepted");
  new RegExp("试卷预览（" + accCount + " 题）").test(ptext)
    ? P("🔴 预览只含「已采纳」的题（" + accCount + " 题）") : F("预览题数与采纳数不符");
  const pc = ph.querySelector('[data-mc="ok"]');
  if (pc) { pc.dispatchEvent(new w.Event("click", { bubbles: true })); await settle(dom); }

  /* --- 发布：没有在课学生时如实说 --- */
  d.getElementById("publishBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const sh = d.getElementById("modalHost");
  sh && sh.hidden === false ? P("点「发布到班级」开出名单弹窗") : F("发布弹窗没开");
  /还没有学生加入|发给谁/.test(sh ? sh.textContent : "")
    ? P("名单弹窗要么给选人、要么如实说没学生") : F("发布弹窗内容不对");
  const sc = sh.querySelector('[data-mc="no"]') || sh.querySelector('[data-mc="ok"]');
  if (sc) { sc.dispatchEvent(new w.Event("click", { bubbles: true })); await settle(dom); }

  /* --- 删除：确认后落库 --- */
  d.getElementById("delExamBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const dh = d.getElementById("modalHost");
  dh && dh.hidden === false ? P("删除先弹确认") : F("删除没确认");
  const okb = dh.querySelector('[data-mc="ok"]');
  if (okb) { okb.dispatchEvent(new w.Event("click", { bubbles: true })); await settle(dom); }
  d.querySelectorAll("#qList .q-card").length === 0
    ? P("确认后卷子没了（列表空）") : F("删除没生效");

  /* --- 🔴 出题时把勾选的题型传下去 + 三种题型各自的卡片长相（桩替换真调用，只看参数与渲染） --- */
  let gotCfg = null;
  w.llmReady = function () { return true; };                    // 绕过「未接模型」分支，专测题型
  w.generateExamQuestions = function (scope, cfg) {
    gotCfg = cfg;
    return Promise.resolve({ ok: true, questions: [
      { type: "single", text: "单选桩题", options: ["A 甲", "B 乙"], answer: "b" },
      { type: "multi",  text: "多选桩题", options: ["A 甲", "B 乙", "C 丙"], answer: "a、c" },
      { type: "blank",  text: "填空桩题 ___ 与 ___", answer: "甲||乙" },
    ] });
  };
  d.getElementById("genBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  gotCfg && JSON.stringify(gotCfg.types) === JSON.stringify(defKeys)
    ? P("🔴 出题时把勾选的题型传给数据层（cfg.types）") : F("没传题型: " + JSON.stringify(gotCfg && gotCfg.types));

  const cards2 = [...d.querySelectorAll("#qList .q-card")];
  cards2.length === 3 ? P("桩出题后三张卡片都渲染出来") : F("卡片数不对: " + cards2.length);
  cards2.some((c) => /答全才给分/.test(c.textContent))
    ? P("🔴 多选题卡上标了「答全才给分」") : F("多选没标");
  cards2.some((c) => /共 2 个空/.test(c.textContent))
    ? P("🔴 填空题卡上标了「共 2 个空」") : F("填空没标空数");
  cards2.some((c) => /参考答案：1）甲/.test(c.textContent))
    ? P("🔴 填空题答案按空的先后编号（1）甲　2）乙）")
    : F("填空答案没编号: " + cards2.map((c) => c.textContent).join("|").slice(0, 90));
  cards2.some((c) => /参考答案：AC/.test(c.textContent))
    ? P("多选答案归一后显示（a、c → AC）") : F("多选答案没归一");
  Number(w.eval("(examQuestionAt(EXAMS[0].id, 2).blanks || []).length")) === 2
    ? P("填空题的多空真的落库了（blanks 长度 2）") : F("填空没落库");

  /* --- 🔴 添加一题 / 删除一题（用户要求：能增能删） --- */
  const qCount = () => d.querySelectorAll("#qList .q-card").length;
  const beforeAdd = qCount();

  const openAdd = async () => {
    d.getElementById("addQBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
    await settle(dom);
    return d.getElementById("modalHost");
  };

  /* ① 先弹「选来源」：题型 + AI 出 / 自己填 */
  const ah = await openAdd();
  const pickSel = ah.querySelector("#addTypeSel");
  pickSel && pickSel.tagName === "SELECT" && pickSel.querySelectorAll("option").length === 4
    ? P("点「添加一题」先选题型与来源（题型下拉四项，来自 EXAM_QTYPES）")
    : F("选来源弹窗不对: " + (pickSel ? pickSel.tagName + "/" + pickSel.querySelectorAll("option").length : "没出来"));
  (ah.querySelector('[data-mc="ai"]') && ah.querySelector('[data-mc="manual"]'))
    ? P("两条路都在：「让 AI 出一道」「自己填一道」") : F("缺来源按钮");

  /* ② 手填分支：先看表单，再用空题干试一次 */
  const ah2 = await openAdd();
  ah2.querySelector('[data-mc="manual"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const mh = d.getElementById("modalHost");
  mh.querySelector('[data-f="type"]') ? P("点「自己填一道」切到手填表单") : F("手填表单没出来");
  mh.querySelector('[data-mc="ok"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  qCount() === beforeAdd ? P("题干空着不让加（如实拦下，不塞废题）") : F("空题干居然加进去了");

  /* ④ 正式手填一道 */
  const ah3 = await openAdd();
  ah3.querySelector('[data-mc="manual"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const mh3 = d.getElementById("modalHost");
  mh3.querySelector('[data-f="type"]').value = "multi";
  mh3.querySelector('[data-f="text"]').value = "手加的多选题";
  mh3.querySelector('[data-f="options"]').value = "A 甲\nB 乙\nC 丙";
  mh3.querySelector('[data-f="answer"]').value = "a、c";
  mh3.querySelector('[data-f="key"]').value = "手加的解析";
  mh3.querySelector('[data-mc="ok"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  qCount() === beforeAdd + 1 ? P("能手工加一道题（列表 +1）") : F("加题没生效: " + qCount());
  const added = JSON.parse(w.eval("JSON.stringify((function(){var qs=EXAMS[0].questions;var q=qs[qs.length-1];return {type:q.type,answer:q.answer,state:q.state,opts:q.options.length};})())"));
  (added.type === "multi" && added.answer === "AC" && added.state === "pending" && added.opts === 3)
    ? P("手工加的题落库并过归一（多选 a、c → AC，状态待审，三个选项）")
    : F("加题落库不对: " + JSON.stringify(added));

  [...d.querySelectorAll("#qList .q-card")][0].querySelector('[data-act="del"]')
    .dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  const dh2 = d.getElementById("modalHost");
  dh2 && dh2.hidden === false && /删掉第 1 题/.test(dh2.textContent)
    ? P("点「删除」先弹确认（不直接删）") : F("删除没确认");
  dh2.querySelector('[data-mc="ok"]').dispatchEvent(new w.Event("click", { bubbles: true }));
  await settle(dom);
  qCount() === beforeAdd ? P("确认后题被真删掉（列表回到原来的数量）") : F("删除没生效: " + qCount());
  Number(w.eval("EXAMS[0].questions.length")) === beforeAdd
    ? P("删除落库了（不是只从界面拿掉）") : F("删除没落库");

  /* --- 🔴 AI 加题：只出一题、只出所选题型（桩替换真调用，看参数） --- */
  {
    const qBefore = qCount();
    gotCfg = null;
    const ah4 = await openAdd();
    ah4.querySelector("#addTypeSel").value = "multi";           // 在弹窗里选「多选」
    ah4.querySelector('[data-mc="ai"]').dispatchEvent(new w.Event("click", { bubbles: true }));
    await settle(dom);
    (gotCfg && gotCfg.count === 1 && JSON.stringify(gotCfg.types) === '["multi"]')
      ? P("🔴 AI 加题只出一题、只出所选题型（cfg.types = [\"multi\"]）")
      : F("AI 加题参数不对: " + JSON.stringify(gotCfg && { c: gotCfg.count, t: gotCfg.types }));
    qCount() === qBefore + 1 ? P("AI 加的题进了列表（+1，不动已有的题）") : F("AI 加题没生效: " + qCount());
    Number(w.eval("EXAMS[0].questions.length")) === qBefore + 1
      ? P("AI 加的题落库了") : F("AI 加题没落库");
    w.eval("EXAMS[0].questions[EXAMS[0].questions.length-1].state") === "pending"
      ? P("🔴 AI 加的题是「待审」（不自动采纳）") : F("AI 加的题被自动采纳了");
  }

  /* --- 🔴 用户要求删掉的那条初始提示 --- */
  !/没接模型时我不会编题/.test(d.body.textContent)
    ? P("🔴 初始不再显示「还没接入模型…」那条提示")
    : F("那条提示还在页面上");

  dom.window.close();
}

console.log("\n=== 4. 内容页独立打开（无壳环境）===");
{
  const dom = load("chat.html", { role: "student" });
  await settle(dom);
  const d = dom.window.document;
  d.querySelector(".shell-top") ? P("自动渲染顶部栏") : F("无顶部栏");
  const side = d.querySelector(".shell-side");
  side ? P("自动渲染侧栏") : F("无侧栏");
  const items = side ? side.querySelectorAll(".side-item") : [];
  items.length >= 6 ? P("独立模式侧栏 " + items.length + " 个菜单项") : F("独立模式侧栏过少: " + items.length);
  d.body.classList.contains("standalone-body") ? P("body 带 .standalone-body") : F("缺 standalone-body");
  d.querySelector(".shell-content .page-wrap") ? P("内容被包进内容区") : F("page-wrap 未包裹");
  const labels = [...items].map((b) => (b.querySelector(".side-label") || {}).textContent || "");
  !labels.some((l) => /出题|组卷|班级学情/.test(l)) ? P("独立模式同样无跨端菜单泄漏") : F("独立模式泄漏教师菜单");
  dom.window.close();
}

console.log("\n=== 5. 各内容页独立打开 ===");
/* 🔴 界面可见文本里不许再出现「演示 XX」这类提示（用户明确要求全部清掉）。
   ⚠️ 只匹配「演示 + 名词」的组合词 —— 教案内容里的**动词**用法（"动画演示冒泡排序"）
      不是提示，保留了；用 `/演示/` 一刀切会把它误伤（踩过这种误报）。 */
const DEMO_RE = /演示(模式|账号|数据|课程|回复|题库|内容|条目|记录|选课|卡片)/;
function visibleText(d) {
  const c = d.body.cloneNode(true);
  Array.prototype.forEach.call(c.querySelectorAll("script"), (s) => s.remove());
  return c.textContent || "";
}
for (const f of ["chat.html", "reader.html", "analysis.html", "exam.html", "homework.html", "class.html", "courseware.html", "schedule.html", "lesson.html", "training.html", "training-student.html", "agent.html", "agent-student.html", "workbench.html", "settings.html"]) {
  const before = errors.length;
  const dom = load(f, { role: ROLE_OF[f] || "student" });
  await settle(dom);
  const d = dom.window.document;
  const hasTop = !!d.querySelector(".shell-top");
  const hasSide = !!d.querySelector(".shell-side");
  const newErr = errors.length - before;
  hasTop && hasSide && newErr === 0
    ? P(f + ": 顶栏+侧栏正常，无错误")
    : F(f + ": top=" + hasTop + " side=" + hasSide + " errs=" + newErr);
  const dm = DEMO_RE.exec(visibleText(d));
  !dm
    ? P("  " + f + " 可见文本无「演示 XX」字样")
    : F("  " + f + " 又出现了「演示」字样: …" + visibleText(d).slice(Math.max(0, dm.index - 10), dm.index + 12).replace(/\s+/g, " ") + "…");
  dom.window.close();
}

console.log("\n=== 6. 主题切换（壳内点按钮）===");
{
  const dom = load("app.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const snowBtn = d.querySelector('[data-theme-btn="snow"]');
  if (snowBtn) snowBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  d.documentElement.getAttribute("data-theme") === "snow"
    ? P("点按钮后 <html data-theme=snow>") : F("主题未切换: " + d.documentElement.getAttribute("data-theme"));
  /st_theme=snow/.test(d.cookie) ? P("主题写入 Cookie 持久化") : F("主题未持久化: " + d.cookie);

  // 按钮 aria-pressed 跟随（真实 DOM 才能验 —— 桩的对象是一次性的）
  const snowPressed = d.querySelector('[data-theme-btn="snow"]').getAttribute("aria-pressed");
  const creamPressed = d.querySelector('[data-theme-btn="cream"]').getAttribute("aria-pressed");
  snowPressed === "true" && creamPressed === "false"
    ? P("顶部栏按钮 aria-pressed 跟随当前主题")
    : F(`按钮状态未同步: snow=${snowPressed} cream=${creamPressed}`);
  d.querySelector('[data-theme-btn="snow"]').classList.contains("active")
    ? P("当前主题按钮带 .active 高亮") : F("按钮未高亮");

  // localStorage 也写了（刷新/换页都靠它）
  d.defaultView.localStorage.getItem("st_theme") === "snow"
    ? P("主题同时写入 localStorage")
    : F("localStorage 未写: " + d.defaultView.localStorage.getItem("st_theme"));
  dom.window.close();
}

console.log("\n=== 6b. 默认深色 + 持久化（模拟下次打开）===");
{
  // 全新会话（无任何本机记录）→ 默认应为深色
  const fresh = load("app.html", { role: "teacher" });
  await settle(fresh);
  fresh.window.document.documentElement.getAttribute("data-theme") === "dark"
    ? P("全新打开：壳默认深色")
    : F("壳默认不是深色: " + fresh.window.document.documentElement.getAttribute("data-theme"));
  fresh.window.close();

  const freshLogin = load("index.html");
  await settle(freshLogin);
  freshLogin.window.document.documentElement.getAttribute("data-theme") === "dark"
    ? P("全新打开：登录页默认深色")
    : F("登录页默认不是深色: " + freshLogin.window.document.documentElement.getAttribute("data-theme"));
  freshLogin.window.close();
}
{
  // 复用一个 cookie jar / storage：先切 cream，再「重新打开」应还是 cream
  const jar = new CookieJar();
  const dom1 = load("app.html", { role: "teacher", jar });
  await settle(dom1);
  const d1 = dom1.window.document;
  d1.querySelector('[data-theme-btn="cream"]').dispatchEvent(new dom1.window.Event("click", { bubbles: true }));
  d1.documentElement.getAttribute("data-theme") === "cream"
    ? P("切到 Cream 生效") : F("切 Cream 未生效");
  const savedLs = dom1.window.localStorage.getItem("st_theme");
  dom1.window.close();

  // 重新打开（带同一份存档）→ 应读回 cream，而不是被打回默认深色
  const dom2 = load("app.html", { role: "teacher", jar, restore: { ls: { st_theme: savedLs } } });
  await settle(dom2);
  const d2 = dom2.window.document;
  d2.documentElement.getAttribute("data-theme") === "cream"
    ? P("下次打开读回上次所选主题（Cream）")
    : F("重开后主题被打回: " + d2.documentElement.getAttribute("data-theme"));
  const btn = d2.querySelector('[data-theme-btn="cream"]');
  btn && btn.getAttribute("aria-pressed") === "true"
    ? P("重开后按钮状态也对（aria-pressed=true）") : F("重开后按钮状态不对");
  dom2.window.close();
}

console.log("\n=== 6c. 登录页同样读取已保存主题 ===");
{
  // 登录页无主题按钮，但必须读本机偏好：存了 snow 就该是 snow
  const dom = load("index.html", { restore: { cookie: "st_theme=snow", ls: { st_theme: "snow" } } });
  await settle(dom);
  const d = dom.window.document;
  d.documentElement.getAttribute("data-theme") === "snow"
    ? P("登录页读取已保存主题（snow）")
    : F("登录页未读取保存主题: " + d.documentElement.getAttribute("data-theme"));
  dom.window.close();

  // 没有任何记录 → 深色
  const dom2 = load("index.html");
  await settle(dom2);
  dom2.window.document.documentElement.getAttribute("data-theme") === "dark"
    ? P("登录页无记录时默认深色")
    : F("登录页无记录非深色");
  dom2.window.close();
}

console.log("\n=== 7. 侧栏跳转（iframe 路由）===");
{
  const dom = load("app.html", { role: "teacher" });
  await settle(dom);
  const d = dom.window.document;
  const examBtn = [...d.querySelectorAll("#shellSide .side-item")]
    .find((b) => b.dataset.page === "exam.html");
  if (examBtn) examBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  const src = d.getElementById("contentFrame").getAttribute("src");
  src === "exam.html" ? P("点侧栏后 iframe.src 切到 exam.html") : F("iframe 未切页: " + src);
  examBtn && examBtn.classList.contains("active") ? P("当前菜单项高亮") : F("菜单项未高亮");
  /#exam\.html/.test(dom.window.location.hash) ? P("URL hash 同步") : F("hash 未同步: " + dom.window.location.hash);
  dom.window.close();
}

console.log("\n=== 8. 越权拦截（学生身份）===");
{
  const dom = load("app.html", { role: "student" });
  await settle(dom);
  const d = dom.window.document;
  if (dom.window.go) dom.window.go("class.html");
  const src = d.getElementById("contentFrame").getAttribute("src");
  src !== "class.html" ? P("越权跳转被拦下（未切到 class.html）") : F("越权未被拦截");
  // 侧栏中教师项根本不存在 → 无入口
  const hasTeacherItem = [...d.querySelectorAll("#shellSide .side-item")]
    .some((b) => b.dataset.page === "class.html");
  !hasTeacherItem ? P("侧栏中无教师端入口（双重防护）") : F("侧栏出现了教师端入口");
  dom.window.close();
}

console.log("\n=== 9. 内容页的主题 / 无障碍接收通道（壳下发 → 内容页生效）===");
{
  // 说明：jsdom 顶层文档满足 self===top，无法真实模拟「在 iframe 内」。
  // 「在壳内不得重复渲染导航」这条由 verify-site.cjs 的桩验证器覆盖
  // （它把 self / top / frameElement 都桩化了，能精确构造壳内环境）。
  // 这里验证另一条独立的契约：core.js 必须能「收」到壳下发的设置变更——
  // 上轮就是这条通道缺失，导致壳切深色时中间不变色。
  const dom = load("chat.html", { role: "student" });
  await settle(dom);
  const d = dom.window.document;

  // 初始：未收到消息前，不应有 standalone 之外的多余导航
  !d.querySelector("#saSide") || P("独立页仅一套 #saSide（正常）");

  // 派发壳的主题变更
  d.documentElement.setAttribute("data-theme", "cream");
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    data: { type: "st-theme-changed", theme: "dark" },
    origin: "http://localhost",
  }));
  d.documentElement.getAttribute("data-theme") === "dark"
    ? P("收到 st-theme-changed → 页面切到 dark")
    : F("未响应主题广播: " + d.documentElement.getAttribute("data-theme"));

  // 派发壳的无障碍变更
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    data: { type: "st-a11y-changed", vars: { "--a11y-font-size": "19px" }, contrast: true },
    origin: "http://localhost",
  }));
  d.documentElement.style.getPropertyValue("--a11y-font-size") === "19px"
    ? P("收到 st-a11y-changed → 字号同步")
    : F("未响应无障碍广播");
  d.documentElement.hasAttribute("data-contrast")
    ? P("收到 st-a11y-changed → 高对比属性同步")
    : F("高对比属性未同步");

  dom.window.close();
}

console.log("\n=== 10. 壳内不得出现第二套导航（结构不变量）===");
{
  // 内容页正文永远只能有一份 .page-wrap；导航要么来自壳、要么来自独立模式，
  // 绝不能两者同时出现。用真实解析验证「正文不会被导航结构重复包裹」。
  const dom = load("chat.html", { role: "student" });
  await settle(dom);
  const d = dom.window.document;
  const wraps = d.querySelectorAll(".page-wrap");
  wraps.length === 1 ? P("正文 .page-wrap 恰好一份") : F(".page-wrap 数量异常: " + wraps.length);
  const tops = d.querySelectorAll("header.shell-top");
  tops.length <= 1 ? P("顶部栏至多一份（未重复渲染）") : F("出现了 " + tops.length + " 份顶部栏");
  const sides = d.querySelectorAll("nav.shell-side");
  sides.length <= 1 ? P("侧栏至多一份（未重复渲染）") : F("出现了 " + sides.length + " 份侧栏");
  dom.window.close();
}

console.log("\n=== 运行时错误汇总 ===");
if (errors.length === 0) console.log("  无任何运行时错误 ✓");
else { errors.forEach((e) => console.log("  ! " + e)); fail += errors.length; }

console.log("\n" + "=".repeat(62));
console.log(fail === 0 ? "结果: 全部通过 ✓（" + ok + " 项）" : "结果: " + fail + " 项失败 ✗ / 通过 " + ok + " 项");
console.log("=".repeat(62));
process.exit(fail === 0 ? 0 : 1);

}

main().catch((e) => { console.error("测试器异常:", e); process.exit(1); });
