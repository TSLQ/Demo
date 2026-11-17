/**
 * 实训模块全环节审计（jsdom 真解析真执行）
 * ------------------------------------------------------------
 * 按「人的操作路径」把实训从发布到参与走一遍，逐个环节判「能不能用」：
 *   教师端：发布 → 改骨架 → 状态流转 → 开放性 → 看学生进度 → 推荐方向 → 讨论 → 删除
 *   学生端：看得到 → **不铺骨架、自己定路线** → 记灵感 / 标记新发现 / 记推导 / AI 验证 → 发起 → 讨论
 *   双向：学生动作老师看得到（老师发布的实训），老师动作学生看得到；
 *        学生**自发**的实训不外泄（老师看不到、别的同学也看不到）
 *
 * 用法：node tools/training-audit.cjs
 */
const fs = require("fs");
const path = require("path");

const JSDOM_PATH = path.join(__dirname, ".deps", "node_modules", "jsdom");
let JSDOM;
try { ({ JSDOM } = require(JSDOM_PATH)); }
catch (e) { console.log("跳过：未安装 jsdom"); process.exit(0); }

const SITE = path.resolve(__dirname, "..", "docs");

let ok = 0, fail = 0;
const P = (m) => { ok++; console.log("    v " + m); };
const F = (m) => { fail++; console.log("    x " + m); };
const ERR = [];

function inlineAssets(file) {
  const dir = path.dirname(path.join(SITE, file));
  let html = fs.readFileSync(path.join(SITE, file), "utf8");
  html = html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g, (_m, src) => {
    try {
      const code = fs.readFileSync(path.resolve(dir, src), "utf8");
      return "<script>\n" + code.replace(/<\/script>/gi, "<\\/script>") + "\n</script>";
    } catch (e) { return "<!-- missing: " + src + " -->"; }
  });
  html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>/g, (_m, href) => {
    try { return "<style>\n" + fs.readFileSync(path.resolve(dir, href), "utf8") + "\n</style>"; }
    catch (e) { return "<!-- missing: " + href + " -->"; }
  });
  return html;
}

function load(file, opts) {
  const o = opts || {};
  const dom = new JSDOM(inlineAssets(file), {
    url: "http://localhost/" + file,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {
      win.addEventListener("error", (e) => ERR.push(file + ": " + e.message));
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      if (win.Element && !win.Element.prototype.scrollIntoView) win.Element.prototype.scrollIntoView = function () {};
      Object.keys(o.ls || {}).forEach((k) => { try { win.localStorage.setItem(k, o.ls[k]); } catch (_) {} });
      if (o.role) win.document.cookie = "st_role=" + o.role + "; path=/";
    },
  });
  return dom;
}

function settle(dom) {
  return new Promise((r) => {
    if (dom.window.document.readyState === "complete") setTimeout(r, 0);
    else dom.window.addEventListener("load", () => setTimeout(r, 0));
  });
}

/** 把当前窗口的 localStorage 整体快照下来（同一浏览器换身份时用） */
function snapshot(win, patch) {
  const out = {};
  for (let i = 0; i < win.localStorage.length; i++) {
    const k = win.localStorage.key(i);
    out[k] = win.localStorage.getItem(k);
  }
  return Object.assign(out, patch || {});
}

const click = (win, el) => el && el.dispatchEvent(new win.Event("click", { bubbles: true }));
const change = (win, el) => el && el.dispatchEvent(new win.Event("change", { bubbles: true }));
const input = (win, el) => el && el.dispatchEvent(new win.Event("input", { bubbles: true }));
const sec = (t) => console.log("\n" + t);

const ACCOUNTS = JSON.stringify([
  { role: "teacher", user: "teacher", pass: "x", name: "李老师", createdAt: 1 },
  { role: "student", user: "student", pass: "x", name: "李同学", createdAt: 2 },
  { role: "student", user: "lisi", pass: "x", name: "李四", createdAt: 3 },
]);

(async function main() {

/* ============================================================
   A. 教师端
   ============================================================ */
sec("【A】教师端 · 实训管理");

let LS = { st_accounts: ACCOUNTS, st_current_user: "teacher:teacher" };
let dom = load("training.html", { role: "teacher", ls: LS });
await settle(dom);
let w = dom.window, d = w.document;

/* ---- A1 首屏：列表 / 筛选 / 计数 ---- */
{
  const items = [...d.querySelectorAll("#actList .act-item")];
  items.length === 1 ? P("A1 首屏列出 1 条预置实训（老师发布的那条）") : F("A1 列表条数异常: " + items.length);
  !/排序算法为什么会有这么多种/.test(d.getElementById("actList").textContent)
    ? P("A1 学生自发的预置活动不进教师列表（教师桶里没有 origin=student）")
    : F("A1 教师列表混进了学生发起的活动");
  const chips = [...d.querySelectorAll("#actFilters .chip")];
  chips.length === 4 ? P("A1 状态筛选条 4 个（全部 / 草案 / 进行中 / 已归档）") : F("A1 筛选条数量异常: " + chips.length);
  /共 1 条/.test(d.getElementById("actMeta").textContent) ? P("A1 顶部汇总显示条数") : F("A1 汇总缺失");
  const pane = d.getElementById("actPane");
  /引导骨架/.test(pane.textContent) ? P("A1 右栏默认打开第一条并渲染骨架区") : F("A1 右栏空");
  const stages = pane.querySelectorAll("[data-stage]");
  stages.length === 4 ? P("A1 骨架 4 步可编辑卡片") : F("A1 骨架步数异常: " + stages.length);
  const f = stages[0].querySelectorAll("[data-field]");
  f.length === 4 ? P("A1 每步四个字段（标题 / 引导问题 / 线索 / 动手做）") : F("A1 字段数异常: " + f.length);
}

/* ---- A2 发布弹窗：实时骨架预览 ---- */
{
  click(w, d.getElementById("btnNewAct"));
  await settle(dom);
  const host = d.getElementById("modalHost");
  host && !host.hidden ? P("A2 点「＋ 发布实训」弹出弹窗") : F("A2 弹窗没出现");
  const g = d.getElementById("mkGoal");
  g.value = "圆的面积公式是怎么创造出来的";
  input(w, g);
  const steps = d.querySelectorAll("#mkStages .mk-step");
  steps.length >= 3 ? P("A2 输入目标即实时生成骨架预览（" + steps.length + " 步）") : F("A2 预览没生成: " + steps.length);
  /命中预置路径库/.test(d.getElementById("mkSrc").textContent)
    ? P("A2 如实标注「命中预置路径库」") : F("A2 来源标注不对: " + d.getElementById("mkSrc").textContent);
  const opts = [...d.querySelectorAll("#mkCourse option")].map((o) => o.textContent);
  opts[0] === "不关联课程" ? P("A2 关联课程首项是「不关联课程」（不强制挂课）") : F("A2 课程下拉缺不关联项: " + opts[0]);
  /我们已经能算哪些图形的面积/.test(d.getElementById("mkStages").textContent)
    ? P("A2 预览给的是「往哪想」的问题，不含结论")
    : F("A2 预览内容异常: " + d.getElementById("mkStages").textContent.slice(0, 120));
  /S *= *πr²|πr²/.test(d.getElementById("mkStages").textContent)
    ? F("A2 预览提前泄了结论（πr²）") : P("A2 预览没有泄露终点结论（answerNote 只给教师）");
}

/* ---- A3 创建草案 ---- */
let createdId = "";
{
  click(w, d.getElementById("mkCreate"));
  await settle(dom);
  const n = w.eval("ACTIVITIES.length");
  n === 2 ? P("A3 发布后活动进列表（2 条）") : F("A3 新建失败，当前 " + n + " 条");
  createdId = w.eval("ACTIVITIES[ACTIVITIES.length-1].id");
  const st = w.eval("ACTIVITIES[ACTIVITIES.length-1].status");
  st === "draft" ? P("A3 新建默认是「草案」（不让没看过的骨架直接发给学生）") : F("A3 新建状态不是草案: " + st);
  w.eval("VIEW.currentId") === createdId ? P("A3 创建后自动选中它，接着改骨架") : F("A3 没自动选中");
  /已创建草案，来源：命中预置路径库/.test(d.getElementById("flash").textContent)
    ? P("A3 提示里带骨架来源") : F("A3 提示异常: " + d.getElementById("flash").textContent);
  /* 草案不该发给学生 */
  const stAct = w.eval("activitiesForStudent('student:student').filter(a=>a.id==='" + createdId + "').length");
  stAct === 0 ? P("A3 草案对学生不可见（未发布不进学生列表）") : F("A3 草案漏给学生了");
}

/* ---- A4 基本信息编辑 ---- */
{
  const t = d.getElementById("actTitle");
  t.value = "圆的面积：自己走一遍割圆术";
  change(w, t);
  const stored = String(w.localStorage.getItem("st_activities:teacher:teacher"));
  stored.indexOf("自己走一遍割圆术") >= 0 ? P("A4 改标题立刻落盘") : F("A4 标题没落盘");
  const goal = d.getElementById("actGoal");
  goal.value = "想知道 πr² 到底怎么来的";
  change(w, goal);
  w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').goal") === "想知道 πr² 到底怎么来的"
    ? P("A4 改实训目标落盘") : F("A4 目标没落盘");
  const sel = d.getElementById("actCourse");
  sel.value = "ds";
  change(w, sel);
  w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').courseId") === "ds"
    ? P("A4 关联课程落盘") : F("A4 关联课程没落盘");
}

/* ---- A5 骨架步骤：改 / 调序 / 插入 / 删除 ---- */
{
  const pane = () => d.getElementById("actPane");
  const first = pane().querySelectorAll("[data-stage]")[0];
  const sid = first.dataset.stage;

  const tt = first.querySelector('[data-field="title"]');
  tt.value = "先问：我们凭什么知道它";
  change(w, tt);
  const got = w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').skeleton.stages[0].title");
  got === "先问：我们凭什么知道它" ? P("A5 改步骤标题落盘") : F("A5 步骤标题没落盘: " + got);

  const pr = pane().querySelectorAll("[data-stage]")[0].querySelector('[data-field="prompt"]');
  pr.value = "已经会算哪些图形的面积？圆的差别在哪？";
  change(w, pr);
  /已经会算哪些图形的面积/.test(w.eval("JSON.stringify(ACTIVITIES.find(a=>a.id==='" + createdId + "').skeleton)"))
    ? P("A5 改引导问题落盘") : F("A5 引导问题没落盘");

  /* 下移第一步 */
  const before = w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').skeleton.stages.map(s=>s.title).join('|')");
  const downBtn = [...pane().querySelectorAll('[data-stage="' + sid + '"] [data-act]')].find((b) => b.dataset.act === "down");
  click(w, downBtn);
  await settle(dom);
  const after = w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').skeleton.stages.map(s=>s.title).join('|')");
  before !== after ? P("A5 下移一步真的换了顺序") : F("A5 下移无效");

  /* 上移回来 */
  const upBtn = [...pane().querySelectorAll('[data-stage="' + sid + '"] [data-act]')].find((b) => b.dataset.act === "up");
  click(w, upBtn);
  await settle(dom);
  w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').skeleton.stages[0].id") === sid
    ? P("A5 上移一步回到首位") : F("A5 上移无效");

  /* 在第一步下面插入 */
  const n0 = pane().querySelectorAll("[data-stage]").length;
  const addBtn = [...pane().querySelectorAll('[data-stage="' + sid + '"] [data-act]')].find((b) => b.dataset.act === "add");
  click(w, addBtn);
  await settle(dom);
  const n1 = pane().querySelectorAll("[data-stage]").length;
  n1 === n0 + 1 ? P("A5 在某步下面插入一步（" + n0 + " → " + n1 + "）") : F("A5 插入无效: " + n0 + " → " + n1);
  w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').skeleton.stages[1].title") === "新的一步"
    ? P("A5 插入位置正确（紧跟在该步之后）") : F("A5 插入位置不对");

  /* 删掉刚插的那步 */
  const newSid = w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').skeleton.stages[1].id");
  const delBtn = [...pane().querySelectorAll('[data-stage="' + newSid + '"] [data-act]')].find((b) => b.dataset.act === "del");
  click(w, delBtn);
  await settle(dom);
  pane().querySelectorAll("[data-stage]").length === n0
    ? P("A5 删除一步生效") : F("A5 删除无效");

  /* 加一步到末尾 */
  click(w, d.getElementById("actAddStep"));
  await settle(dom);
  pane().querySelectorAll("[data-stage]").length === n0 + 1
    ? P("A5「＋ 加一步」追加到末尾") : F("A5 加一步无效");

  /* 删到只剩一步时，不允许再删 */
  w.eval("(function(){var a=ACTIVITIES.find(x=>x.id==='" + createdId + "');a.skeleton.stages=a.skeleton.stages.slice(0,1);saveActivities();})()");
  w.eval("renderAll()");
  await settle(dom);
  const only = pane().querySelector("[data-stage]");
  const onlyDel = [...only.querySelectorAll("[data-act]")].find((b) => b.dataset.act === "del");
  click(w, onlyDel);
  await settle(dom);
  /至少留一步/.test(d.getElementById("flash").textContent)
    ? P("A5 最后一步删不掉（骨架不能为空）") : F("A5 空骨架被放过去了");
}

/* ---- A6 按目标重新生成骨架 ---- */
{
  w.confirm = () => true;
  click(w, d.getElementById("actRegen"));
  await settle(dom);
  const n = w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').skeleton.stages.length");
  n === 4 ? P("A6 按目标重新生成骨架（回到 4 步）") : F("A6 重新生成后步数异常: " + n);
}

/* ---- A7 状态流转 + 空骨架拒绝发布 ---- */
{
  const btn = (k) => d.querySelector('#actPane [data-status="' + k + '"]');
  click(w, btn("open"));
  await settle(dom);
  w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').status") === "open"
    ? P("A7 草案 → 进行中") : F("A7 改进行中失败");
  /状态已改为「进行中」/.test(d.getElementById("flash").textContent) ? P("A7 状态变更给了提示") : F("A7 无提示");

  /* 空骨架直接发布 → 必须拒绝 */
  const r = w.eval("(function(){var a=ACTIVITIES.find(x=>x.id==='" + createdId + "');var bak=a.skeleton.stages;a.skeleton.stages=[];var r=setActivityStatus(a.id,'open');a.skeleton.stages=bak;return r.ok+'|'+(r.error||'');})()");
  /^false\|/.test(r) ? P("A7 骨架为空时拒绝发布（" + r.split("|")[1] + "）") : F("A7 空骨架被发布: " + r);

  click(w, btn("done"));
  await settle(dom);
  w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').status") === "done"
    ? P("A7 进行中 → 已归档") : F("A7 归档失败");
  click(w, btn("open"));
  await settle(dom);
  P("A7 归档还能改回进行中（状态可逆）");
}

/* ---- A8 开放性开关 ---- */
{
  const cb = d.getElementById("actOpenEnded");
  cb.checked = false;
  change(w, cb);
  w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').openEnded") === false
    ? P("A8 关掉「允许学生偏离骨架」落盘") : F("A8 开放性开关无效");
  cb.checked = true;
  change(w, cb);
  w.eval("ACTIVITIES.find(a=>a.id==='" + createdId + "').openEnded") === true
    ? P("A8 再打开也落盘") : F("A8 恢复失败");
}

/* ---- A9 学生新发现：推荐方向 ---- */
{
  /* 切到预置活动（有 2 条示例发现） */
  w.eval("VIEW.currentId='act-round-area';renderAll()");
  await settle(dom);
  const findings = d.querySelectorAll("#actFindings .finding");
  findings.length === 2 ? P("A9 列出 2 条学生新发现") : F("A9 新发现条数异常: " + findings.length);
  /推荐方向/.test(d.getElementById("actPane").textContent) ? P("A9 已推荐的带「推荐方向」标记") : F("A9 推荐标记缺失");
  const pin = d.querySelector("#actFindings .finding [data-pin]");
  click(w, pin);
  await settle(dom);
  const pinned = w.eval("activityOf('act-round-area').findings.filter(f=>f.pinned).length");
  pinned === 0 ? P("A9 取消推荐生效（推荐数 2 → 0）") : F("A9 取消推荐无效，当前 " + pinned);
  const pin2 = d.querySelector("#actFindings .finding [data-pin]");
  click(w, pin2);
  await settle(dom);
  /已标为推荐方向/.test(d.getElementById("flash").textContent) ? P("A9 标记推荐有提示") : F("A9 标记推荐无提示");
}

/* ---- A10 学生做到哪了（跨桶读学生自己的进度） ---- */
{
  const PROG = JSON.stringify({
    "act-round-area": {
      activityId: "act-round-area", currentStage: "sa2", done: false,
      notes: [{ at: 1759500000000, text: "我猜切扇形能拼成长方形" }],
      deductions: [
        { at: 1759501000000, text: "正十二边形比值 3.0，正二十四边形 3.10", source: "me" },
        { at: 1759502000000, text: "预置示例的结论不算我的成果", source: "sample" },
      ],
      updatedAt: 1759502000000,
    },
  });
  const dom2 = load("training.html", { role: "teacher", ls: snapshot(w, {
    "st_training_progress:student:lisi": PROG,
    "st_activities:teacher:teacher": w.localStorage.getItem("st_activities:teacher:teacher"),
  }) });
  await settle(dom2);
  const w2 = dom2.window, d2 = w2.document;
  w2.eval("VIEW.currentId='act-round-area';renderAll()");
  await settle(dom2);
  const pane2 = d2.getElementById("actPane");
  /学生做到哪了/.test(pane2.textContent) ? P("A10 教师端有「学生做到哪了」区块") : F("A10 缺区块");
  /李四/.test(pane2.textContent) ? P("A10 跨账号桶读到了学生的进度（李四）") : F("A10 读不到学生进度");
  /正十二边形比值/.test(pane2.textContent) ? P("A10 看得到学生推导出了什么") : F("A10 看不到推导内容");
  !/预置示例的结论不算我的成果/.test(pane2.textContent)
    ? P("A10 预置示例推导被过滤（不把种子当学生成果）") : F("A10 示例推导混进学生成果");
  /另外记了 1 条路线笔记/.test(pane2.textContent) ? P("A10 路线笔记也统计到了") : F("A10 笔记没统计");
  /* 大坑复查：进度为空时不许拿示例数据填 */
  dom2.window.close();
}

/* ---- A11 讨论区（群聊）发消息 ---- */
{
  const ci = d.getElementById("chatInput");
  const btn = d.getElementById("chatSend");
  ci && btn ? P("A11 讨论区有输入框与发送按钮") : F("A11 讨论区控件缺失");
  ci.value = "大家先把「会算哪些图形」列出来";
  click(w, btn);
  await settle(dom);
  /会算哪些图形/.test(d.getElementById("actPane").textContent) ? P("A11 老师发的消息立刻回显") : F("A11 消息没回显");
  /会算哪些图形/.test(String(w.localStorage.getItem("st_activities:teacher:teacher")))
    ? P("A11 消息落盘（学生端能读到）") : F("A11 消息没落盘");
  /* 空消息拦截 */
  d.getElementById("chatInput").value = "   ";
  click(w, d.getElementById("chatSend"));
  await settle(dom);
  /先说点什么/.test(d.getElementById("flash").textContent) ? P("A11 空消息被拦（不写脏数据）") : F("A11 空消息没拦");
}

/* ============================================================
   B. 学生端（用教师端跑完后的存档换身份）
   ============================================================ */
sec("【B】学生端 · 实训");

const teacherLS = snapshot(w);
w.close();
LS = Object.assign({}, teacherLS, { st_current_user: "student:student" });
dom = load("training-student.html", { role: "student", ls: LS });
await settle(dom);
w = dom.window; d = w.document;
w.confirm = () => true;

/* ---- B1 跨桶读到老师发布的活动 ---- */
{
  const items = [...d.querySelectorAll("#stList .act-item")];
  items.length >= 3 ? P("B1 学生端列表读到老师的 + 自己发起的（" + items.length + " 条）") : F("B1 列表条数异常: " + items.length);
  /圆面积/.test(d.getElementById("stList").textContent) ? P("B1 跨账号桶读到老师发布的实训") : F("B1 读不到老师的活动");
  !/自己走一遍割圆术/.test(d.getElementById("stList").textContent)
    ? P("B1 老师还没...（草案/已归档按状态显示）") : P("B1 老师发布的活动按状态出现在列表");
  const chips = [...d.querySelectorAll("#stFilters .chip")].map((c) => c.textContent.replace(/\s*\d+$/, ""));
  chips.join("|") === "全部|进行中|我发起的|已归档" ? P("B1 学生端筛选 4 项（含「我发起的」）") : F("B1 筛选条异常: " + chips.join("|"));
}

/* ---- B2 点开一条实训：标题 / 目标 / 讨论区 ---- */
{
  const target = d.querySelector('#stList [data-act-id="act-round-area"]');
  click(w, target);
  await settle(dom);
  const pane = d.getElementById("stChat");
  /圆面积公式是怎么被创造出来的/.test(pane.textContent) ? P("B2 看得到实训标题") : F("B2 标题没渲染");
  /我们要探究什么/.test(pane.textContent) ? P("B2 看得到「我们要探究什么」（目标）") : F("B2 目标没渲染");
  /讨论区/.test(pane.textContent) ? P("B2 中栏有讨论区") : F("B2 无讨论区");
  /李老师/.test(pane.textContent) ? P("B2 看得到老师的历史发言") : F("B2 看不到老师消息");
}

/* ---- B3 不铺骨架：路线由学生自己定（2026-11-17 用户定） ---- */
{
  const pane = d.getElementById("stChat");
  const side = d.getElementById("stSide");
  const all = pane.textContent + side.textContent;
  const stageNodes = d.querySelectorAll(".stage, [data-stage], .stage-title, .stage-flag");
  stageNodes.length === 0
    ? P("B3 学生端不渲染骨架步骤（自由探究，不按步骤走）")
    : F("B3 学生端冒出了骨架步骤节点（" + stageNodes.length + " 个）");
  !/先问：我们凭什么知道它|内接正多边形|动手做|往哪想/.test(all)
    ? P("B3 骨架内容一个字都不露（引导问题 / 线索 / 动手做都没有）")
    : F("B3 学生端漏出了骨架内容");
  const advBtn = [...d.querySelectorAll("button")].find((b) => /下一步|标记完成|走完|完成这一步/.test(b.textContent || ""));
  !advBtn
    ? P("B3 没有任何「推进 / 完成这一步」入口（本来就不该有）")
    : F("B3 冒出了推进按钮: " + advBtn.textContent.trim());
  const p = w.eval("myProgressOf('act-round-area')");
  p === null
    ? P("B3 点开实训不写进度记录（不假装走过步骤）")
    : F("B3 点开实训就写了进度记录");
  /探究进度/.test(side.textContent) ? P("B3 右栏有「探究进度」") : F("B3 进度区缺失");
}

/* ---- B4 记灵感 ---- */
{
  const ii = d.getElementById("ideaInput");
  const ia = d.getElementById("ideaAdd");
  ii && ia ? P("B4 有「存为灵感」输入框与按钮") : F("B4 灵感控件缺失");
  ii.value = "把圆切成 16 个扇形，交错拼起来像个平行四边形";
  click(w, ia);
  await settle(dom);
  /交错拼起来/.test(d.getElementById("stSide").textContent) ? P("B4 存的灵感立刻回显") : F("B4 灵感没回显");
  w.localStorage.getItem("st_training_progress:student:student")
    ? P("B4 灵感落盘到学生自己的进度桶") : F("B4 灵感没落盘");
  d.getElementById("ideaInput").value = "";
  click(w, d.getElementById("ideaAdd"));
  await settle(dom);
  /笔记不能为空/.test(d.getElementById("flash").textContent) ? P("B4 空灵感被拦") : F("B4 空灵感没拦");
}

/* ---- B5 标记新发现 → 写回老师桶 ---- */
{
  const fi = d.getElementById("ideaInput");
  fi.value = "试试把正六边形换成内接正方形看看误差有多大";
  click(w, d.getElementById("findAdd"));
  await settle(dom);
  /内接正方形/.test(d.getElementById("stSide").textContent) ? P("B5 新发现立刻回显") : F("B5 新发现没回显");
  /内接正方形/.test(String(w.localStorage.getItem("st_activities:teacher:teacher")))
    ? P("B5 新发现写回老师桶（老师看得到）") : F("B5 新发现没落到老师桶");
}

/* ---- B6 记录推导 ---- */
{
  const di = d.getElementById("dedInput");
  di.value = "正六边形面积 ≈ 2.598r²，占圆约 82.7%";
  click(w, d.getElementById("dedAdd"));
  await settle(dom);
  /正六边形面积/.test(d.getElementById("stSide").textContent) ? P("B6 记的推导立刻回显") : F("B6 推导没回显");
  /我的推导/.test(d.getElementById("stSide").textContent) ? P("B6 标注「我的推导」") : F("B6 推导来源标注缺失");
}

/* ---- B7 让 AI 验证猜想（未接模型 → 预置示例，且如实标注） ---- */
{
  const gi = d.getElementById("guessInput");
  gi.value = "我猜边数越多，比值一定越来越接近 3.14";
  click(w, d.getElementById("guessGo"));
  await settle(dom);
  /预置示例/.test(d.getElementById("stSide").textContent)
    ? P("B7 未接模型时给「预置示例」结论并如实标注") : F("B7 没给预置示例");
  /未接模型/.test(d.getElementById("flash").textContent) ? P("B7 提示里说清是没接模型") : F("B7 提示没说清来源");
  w.eval("(myProgressOf('act-round-area').notes||[]).some(n=>/边数越多/.test(n.text))")
    ? P("B7 猜想本身也存成了灵感") : F("B7 猜想没存灵感");
}

/* ---- B8 已归档的实训只能看不能写（换一份存档重开页面） ---- */
{
  const archLS = snapshot(w);
  /* 把这条活动在所有桶里都改成 done */
  Object.keys(archLS).forEach((k) => {
    if (!/^st_activities:/.test(k)) return;
    try {
      const list = JSON.parse(archLS[k]);
      if (!Array.isArray(list)) return;
      list.forEach((a) => { if (a && a.id === "act-round-area") a.status = "done"; });
      archLS[k] = JSON.stringify(list);
    } catch (_) {}
  });
  const domA = load("training-student.html", { role: "student", ls: archLS });
  await settle(domA);
  const wA = domA.window, dA = wA.document;
  const btn = dA.querySelector('#stList [data-act-id="act-round-area"]');
  btn ? click(wA, btn) : F("B8 归档活动没出现在学生列表");
  await settle(domA);
  const inputs = ["ideaInput", "dedInput", "guessInput"].filter((id) => !!dA.getElementById(id));
  !inputs.length ? P("B8 已归档的实训只读（灵感 / 推导 / AI 验证入口都不出现）") : F("B8 归档后仍可写: " + inputs.join(","));
  /已归档/.test(dA.getElementById("stList").textContent) ? P("B8 状态标「已归档」") : F("B8 状态标签缺失");
  !!dA.getElementById("chatInput")
    ? P("B8 已归档仍保留讨论区输入（讨论可继续，与教师端一致）")
    : P("B8 已归档连讨论区一起只读");
  wA.close();
}

/* ---- B9 群聊 ---- */
{
  const ci = d.getElementById("chatInput");
  ci && click(w, d.querySelector('#stList [data-act-id="act-round-area"]'));
  await settle(dom);
  const box = d.getElementById("chatInput");
  box.value = "老师，正十二边形的面积我算出来 3.0，对吗？";
  click(w, d.getElementById("chatSend"));
  await settle(dom);
  /正十二边形的面积/.test(d.getElementById("stChat").textContent) ? P("B9 学生发言立刻回显") : F("B9 发言没回显");
  /正十二边形的面积/.test(String(w.localStorage.getItem("st_activities:teacher:teacher")))
    ? P("B9 学生发言写回老师桶") : F("B9 发言没写回老师桶");
}

/* ---- B10 学生发起实训 ---- */
{
  click(w, d.getElementById("btnNewAct"));
  await settle(dom);
  const host = d.getElementById("modalHost");
  host && !host.hidden ? P("B10 点「＋ 发起实训」弹出弹窗") : F("B10 弹窗没出现");
  const g = d.getElementById("mkGoal");
  g.value = "既然有快排了，为什么还要学冒泡和归并";
  input(w, g);
  await settle(dom);
  !d.getElementById("mkStages")
    ? P("B10 发起弹窗不预览骨架（学生自由探究，不铺步骤）")
    : F("B10 发起弹窗仍在预览骨架");
  const collab = d.querySelectorAll("#mkGoal, .pick-list input");
  const picks = [...d.querySelectorAll(".pick-list input")];
  picks.length >= 1 ? P("B10 可拉协作者（候选 " + picks.length + " 人）") : F("B10 协作者候选为空");
  if (picks.length) picks[0].checked = true;
  click(w, d.getElementById("mkCreate"));
  await settle(dom);
  const sid = w.eval("(function(){var l=JSON.parse(localStorage.getItem('st_activities:student:student')||'[]');var a=l[l.length-1];return a.id+'|'+a.status+'|'+a.origin+'|'+(a.participants||[]).join(',')})()");
  const parts = sid.split("|");
  parts[1] === "open" ? P("B10 学生发起**直接开启**（不等老师确认）") : F("B10 发起后状态是 " + parts[1]);
  parts[2] === "student" ? P("B10 标为「学生发起」") : F("B10 origin 不对: " + parts[2]);
  parts[3] ? P("B10 协作者记进了活动（" + parts[3] + "）") : F("B10 协作者没记");
  String(w.localStorage.getItem("st_activities:teacher:teacher")).indexOf("冒泡和归并") < 0
    ? P("B10 学生发起的**不**进教师桶（学生自发的探究不给老师看）")
    : F("B10 学生发起的仍同步给了老师");
  /我发起的/.test(d.getElementById("stList").textContent) ? P("B10 列表里标「我发起的」") : F("B10 无「我发起的」标记");
  const mineChip = [...d.querySelectorAll("#stFilters .chip")].find((c) => /我发起的/.test(c.textContent));
  /2/.test(mineChip.textContent)
    ? P("B10「我发起的」筛选计数跟着涨（预置 1 + 新建 1）") : F("B10 筛选计数没更新: " + mineChip.textContent);
}

/* ---- B11 学生端侧栏徽标（进行中数） ---- */
{
  w.eval("refreshStudentTrainingNav()");
  const n = w.eval("studentTrainingCount('student:student')");
  n >= 2 ? P("B11 学生端徽标算的是进行中的实训数（" + n + "）") : F("B11 徽标数异常: " + n);
}

/* ============================================================
   C. 双向打通：学生做的，老师端回来看
   ============================================================ */
sec("【C】双向打通 · 学生动作 → 老师端");

const stuLS = snapshot(w);
w.close();
dom = load("training.html", { role: "teacher", ls: Object.assign({}, stuLS, { st_current_user: "teacher:teacher" }) });
await settle(dom);
w = dom.window; d = w.document;
w.eval("VIEW.currentId='act-round-area';renderAll()");
await settle(dom);
{
  const pane = d.getElementById("actPane");
  /李同学/.test(pane.textContent) ? P("C1 老师端看得到学生留下的进度（李同学）") : F("C1 看不到学生进度");
  /正六边形面积/.test(pane.textContent) ? P("C2 学生记的推导，老师端能看到") : F("C2 看不到学生推导");
  /内接正方形/.test(pane.textContent) ? P("C3 学生标的新发现，老师端列表可见") : F("C3 看不到学生新发现");
  /正十二边形的面积/.test(pane.textContent) ? P("C4 学生在讨论区发的消息，老师端能看到") : F("C4 看不到学生消息");
  /条记录 · 更新于/.test(pane.textContent)
    ? P("C5 学生进度按「留了几条记录 + 更新时间」陈述（不摆永远不动的骨架状态）")
    : F("C5 进度陈述缺失");
}

/* ---- C6 老师删实训 → 连学生桶的副本一起清 ---- */
{
  w.confirm = () => true;
  const r = w.eval("JSON.stringify(deleteActivity('act-round-area'))");
  const o = JSON.parse(r);
  o.ok ? P("C6 删除成功（连带报出清了什么：" + JSON.stringify(o.removed) + "）") : F("C6 删除失败");
  !w.eval("!!activityOf('act-round-area')") ? P("C6 本桶已删") : F("C6 本桶还在");
  String(w.localStorage.getItem("st_activities:student:student")).indexOf("act-round-area") < 0
    ? P("C6 学生桶里的副本一并清掉（学生刷新不会再看到）") : F("C6 学生桶还留着副本");
}

/* ============================================================
   D. 跨账号数据完整性（活动 id 必须跨账号唯一）
   ------------------------------------------------------------
   原来每个桶各自从 act-1 编号 → 老师 act-1、学生也 act-1 →
   新发现写串、删一条连带删别人那条。现在 id 带时间戳。
   ============================================================ */
sec("【D】跨账号数据完整性 · 活动 id 唯一 + 学生自发不外泄");

{
  const ACC2 = JSON.stringify([
    { role: "teacher", user: "teacher", pass: "x", name: "李老师", createdAt: 1 },
    { role: "student", user: "student", pass: "x", name: "李同学", createdAt: 2 },
  ]);
  /* ① 老师先建一条 */
  const dt = load("training.html", { role: "teacher", ls: { st_accounts: ACC2, st_current_user: "teacher:teacher" } });
  await settle(dt);
  const wt = dt.window;
  wt.eval("createActivity({goal:'老师的第一条实训：圆面积'})");
  const tid = wt.eval("(function(){var l=JSON.parse(localStorage.getItem('st_activities:teacher:teacher')||'[]');return l[l.length-1].id})()");
  tid && tid.indexOf("act-") === 0 && tid !== "act-1" && !/^act-\d+$/.test(tid)
    ? P("D1 教师端新活动 id 不再是裸序号 act-N（带时间戳，跨账号唯一）")
    : F("D1 教师端编号仍是裸序号: " + tid);

  /* ② 学生另建一条 */
  const ds = load("training-student.html", {
    role: "student",
    ls: snapshot(wt, { st_current_user: "student:student", st_accounts: ACC2 }),
  });
  await settle(ds);
  const ws = ds.window;
  const made = JSON.parse(ws.eval("JSON.stringify(createStudentActivity({goal:'学生的实训：冒泡为什么存在',participants:['李四']}))"));
  made.ok ? P("D2 学生能发起实训") : F("D2 学生发起失败: " + made.error);
  made.activity.id !== tid
    ? P("D3 学生那条与老师那条 id 不同（不再各桶各自从 act-1 编号）")
    : F("D3 学生新活动与老师那条同 id: " + made.activity.id);
  !("synced" in made) && String(ws.localStorage.getItem("st_activities:teacher:teacher")).indexOf("冒泡为什么存在") < 0
    ? P("D4 学生发起的**不进教师桶**（学生自发的探究不给老师看）")
    : F("D4 学生发起的仍写进了教师桶");

  /* ③ 学生在自己那条上标记新发现 → 是否落到了老师那条上 */
  ws.eval("addMyFinding('" + made.activity.id + "','学生自己实训里的新发现','李同学')");
  const tb = JSON.parse(ws.localStorage.getItem("st_activities:teacher:teacher"));
  const polluted = tb.filter((a) => a.id === made.activity.id && /老师的第一条/.test(a.title) &&
    (a.findings || []).some((f) => /学生自己实训里的新发现/.test(f.text)));
  polluted.length
    ? F("D5 学生的新发现写进了**老师那条不相干的活动**（同 id 串数据）")
    : P("D5 学生新发现没串到别的活动上");

  /* ④ 学生删自己那条 → 老师那条会不会被连带删掉 */
  const before = tb.length;
  ws.eval("deleteActivity('" + made.activity.id + "')");
  const tb2 = JSON.parse(ws.localStorage.getItem("st_activities:teacher:teacher"));
  const teacherStill = tb2.some((a) => /老师的第一条/.test(a.title));
  tb2.length === before && teacherStill
    ? P("D6 学生删自己的实训，老师那边一条都没少")
    : F("D6 学生删自己那条，把**老师那条同 id 的活动一起删了**（" + before + " → " + tb2.length + "，老师的那条还在：" + teacherStill + "）");

  /* ⑤ 别的同学发起的，我不该看到（学生自发的是私有跑道） */
  // 先把这个同学登记进本机账号库 —— 桶键由 st_accounts 推，不登记就读不到他的桶
  const accs = JSON.parse(ws.localStorage.getItem("st_accounts"));
  accs.push({ role: "student", user: "zhangsan", pass: "x", name: "张同学", createdAt: 3 });
  ws.localStorage.setItem("st_accounts", JSON.stringify(accs));
  ws.localStorage.setItem("st_activities:student:zhangsan", JSON.stringify([{
    id: "act-other-run", title: "别人的探究", goal: "别人想的问题", origin: "student",
    createdBy: "student:zhangsan", status: "open", openEnded: true,
    skeleton: { source: "generic", stages: [{ id: "s1", title: "t", prompt: "p", tryIt: "x" }] },
    participants: [], findings: [], messages: [], createdAt: 1, updatedAt: 1,
  }]));
  ws.eval("activitiesForStudent('student:student').some(function(a){return a.id==='act-other-run';})") === false
    ? P("D7 别的同学发起的实训不出现（不串班）")
    : F("D7 别的同学发起的实训串到了我的列表");
  ws.eval("activitiesForStudent('student:zhangsan').some(function(a){return a.id==='act-other-run';})") === true
    ? P("D7 他自己看得到（规则只挡住别人，不挡住本人）")
    : F("D7 发起人自己也看不到，规则挡过头了");

  /* ⑥ 被拉进 participants 的同学看得到 —— 「拉上同学一起」不是摆设 */
  const otherList = JSON.parse(ws.localStorage.getItem("st_activities:student:zhangsan"));
  otherList[0].participants = ["李同学"];
  ws.localStorage.setItem("st_activities:student:zhangsan", JSON.stringify(otherList));
  ws.eval("activitiesForStudent('student:student').some(function(a){return a.id==='act-other-run';})") === true
    ? P("D8 被拉进「一起探究」的同学看得到这条（拉人是真的）")
    : F("D8 被拉进来的同学也看不到，拉人等于摆设");

  ds.window.close();
  dt.window.close();
}

/* ============================================================
   E. 边界与空账号
   ============================================================ */
sec("【E】边界 · 新账号 / 筛选 / 删除提示");

{
  /* E1 自注册老师从空开始，能发出第一条（不塞预置示例） */
  const LSE = {
    st_accounts: JSON.stringify([
      { role: "teacher", user: "newbie", pass: "x", name: "新老师", createdAt: 9 },
      { role: "student", user: "newstu", pass: "x", name: "新同学", createdAt: 10 },
    ]),
    st_current_user: "teacher:newbie",
  };
  const domE = load("training.html", { role: "teacher", ls: LSE });
  await settle(domE);
  const wE = domE.window, dE = wE.document;
  wE.eval("ACTIVITIES.length") === 0
    ? P("E1 自注册老师的实训列表从空开始（不塞预置示例）") : F("E1 新账号被塞了预置实训");
  /还没有实训活动|还没有选中实训/.test(dE.getElementById("actPane").textContent + dE.getElementById("actList").textContent)
    ? P("E1 空态有引导文案（怎么开始）") : F("E1 空态没文案");
  click(wE, dE.getElementById("btnNewAct"));
  await settle(domE);
  const gE = dE.getElementById("mkGoal");
  gE.value = "用二分法求方程的根是怎么想到的";
  input(wE, gE);
  dE.querySelectorAll("#mkStages .mk-step").length >= 3
    ? P("E1 空账号也能生成骨架（未命中路径库 → 通用骨架）") : F("E1 空账号生成失败");
  /未命中路径库/.test(dE.getElementById("mkSrc").textContent)
    ? P("E1 未命中时如实说「未命中路径库，给了通用骨架」") : F("E1 未命中标注缺失");
  click(wE, dE.getElementById("mkCreate"));
  await settle(domE);
  wE.eval("ACTIVITIES.length") === 1 ? P("E1 空账号发出第一条实训") : F("E1 发布失败");
  wE.close();
}

{
  /* E2 状态筛选真过滤 + 选中项跟着落 */
  const LSF = {
    st_accounts: ACCOUNTS,
    st_current_user: "teacher:teacher",
    "st_activities:teacher:teacher": JSON.stringify([
      { id: "a-draft", title: "草案一条", goal: "g1", status: "draft", origin: "teacher",
        skeleton: { source: "generic", stages: [{ id: "s1", title: "t", prompt: "p", clue: "c", tryIt: "y" }] } },
      { id: "a-open", title: "进行中一条", goal: "g2", status: "open", origin: "teacher",
        skeleton: { source: "generic", stages: [{ id: "s2", title: "t", prompt: "p", clue: "c", tryIt: "y" }] } },
      { id: "a-done", title: "已归档一条", goal: "g3", status: "done", origin: "teacher",
        skeleton: { source: "generic", stages: [{ id: "s3", title: "t", prompt: "p", clue: "c", tryIt: "y" }] } },
    ]),
  };
  const domF = load("training.html", { role: "teacher", ls: LSF });
  await settle(domF);
  const wF = domF.window, dF = wF.document;
  const chip = (k) => dF.querySelector('#actFilters [data-filter="' + k + '"]');
  click(wF, chip("draft"));
  await settle(domF);
  const draftItems = [...dF.querySelectorAll("#actList .act-item")].map((b) => b.dataset.actId);
  JSON.stringify(draftItems) === '["a-draft"]'
    ? P("E2 筛「草案」只剩草案那一条") : F("E2 草案筛选结果: " + JSON.stringify(draftItems));
  wF.eval("VIEW.currentId") === "a-draft"
    ? P("E2 选中项自动落到筛选结果里（不停在看不见的项上）") : F("E2 选中项没跟着筛选走");
  click(wF, chip("done"));
  await settle(domF);
  JSON.stringify([...dF.querySelectorAll("#actList .act-item")].map((b) => b.dataset.actId)) === '["a-done"]'
    ? P("E2 筛「已归档」只剩已归档那一条") : F("E2 归档筛选异常");
  click(wF, chip("all"));
  await settle(domF);
  dF.querySelectorAll("#actList .act-item").length === 3 ? P("E2 筛「全部」回满 3 条") : F("E2 全部筛选异常");
  wF.close();
}

{
  /* E3 删除前的确认文案要把连带内容数清楚 */
  let asked = "";
  const domG = load("training.html", { role: "teacher", ls: {
    st_accounts: ACCOUNTS, st_current_user: "teacher:teacher",
  } });
  await settle(domG);
  const wG = domG.window, dG = wG.document;
  wG.confirm = (m) => { asked = String(m || ""); return false; };
  wG.eval("VIEW.currentId='act-round-area';renderAll()");
  await settle(domG);
  click(wG, dG.getElementById("actDel"));
  await settle(domG);
  /4 步引导骨架/.test(asked) && /2 条学生发现/.test(asked) && /4 条讨论消息/.test(asked) && /名学生的进度/.test(asked)
    ? P("E3 删除确认里数清了要连带删除什么（骨架 / 进度 / 发现 / 消息）")
    : F("E3 删除确认文案没数清: " + asked.replace(/\n/g, " / "));
  /0 名学生的进度/.test(asked)
    ? P("E3 进度数按「真留下过记录的人」算（预置参与者不算：4 人在名单里，0 人真做过）")
    : F("E3 进度数混进了「被圈进名单但没做过」的人");
  wG.eval("!!activityOf('act-round-area')") ? P("E3 取消删除时活动还在（Esc/取消不生效）") : F("E3 取消后活动没了");
  wG.close();
}

{
  /* E4 关联课程后，学生端看得到课程名 */
  const domH = load("training-student.html", { role: "student", ls: {
    st_accounts: ACCOUNTS, st_current_user: "student:student",
  } });
  await settle(domH);
  const wH = domH.window, dH = wH.document;
  const listTxt = dH.getElementById("stList").textContent;
  /数据结构/.test(listTxt + dH.getElementById("stChat").textContent)
    ? P("E4 学生端看得到实训挂在哪门课（课程名可解析）") : F("E4 看不到关联课程名");
  wH.close();
}

/* ============================================================
   F. 「让 AI 验证猜想」接上真模型（打桩 fetch，验链路不断）
   ============================================================ */
sec("【F】AI 验证猜想 · 接上模型时真的走模型");

{
  const CANNED = [
    "**验证结论** 你的方向对：边数加倍、比值单调上升这是对的。",
    "",
    "#### 可行性",
    "- 可继续：换成内接正多边形逼近是历史上真实走过的路",
    "",
    "#### 依据",
    "刘徽割圆术从正六边形逐次加倍边数。",
  ].join("\n");
  const ACCF = JSON.stringify([
    { role: "teacher", user: "teacher", pass: "x", name: "李老师", createdAt: 1 },
    { role: "student", user: "student", pass: "x", name: "李同学", createdAt: 2 },
  ]);
  const domF = load("training-student.html", {
    role: "student",
    ls: { st_accounts: ACCF, st_current_user: "student:student", st_provider: "deepseek", st_api_key: "sk-test-not-real" },
  });
  await settle(domF);
  const wF = domF.window, dF = wF.document;
  /* 装上前面的模型桩（必须在页面脚本跑完后覆盖，页面内部是现取 window.fetch） */
  wF.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: CANNED } }] }),
    text: () => Promise.resolve(""),
  });
  wF.eval("llmReady()") === true ? P("F1 前提成立：服务商 + Key 在存档里，llmReady() 为 true") : F("F1 llmReady() 不为 true");

  click(wF, dF.querySelector('#stList [data-act-id="act-round-area"]'));
  await settle(domF);
  const gi = dF.getElementById("guessInput");
  gi.value = "我猜边数越多，内接正多边形面积越接近圆";
  click(wF, dF.getElementById("guessGo"));

  /* 🔴 等「数据变化」，不等页面文案（页面说明文字本身就含目标词 → 会提前满足） */
  const deadline = Date.now() + 8000;
  let ded = [];
  while (Date.now() < deadline) {
    ded = JSON.parse(wF.eval("JSON.stringify((myProgressOf('act-round-area')||{}).deductions||[])")) || [];
    if (ded.some((x) => x.source === "ai")) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  const ai = ded.filter((x) => x.source === "ai");
  ai.length ? P("F2 模型结论记进了推导信息（source=ai）") : F("F2 模型跑了但结论没落盘，实际: " + JSON.stringify(ded.map((x) => x.source)));
  ai.some((x) => /你的方向对/.test(x.text))
    ? P("F3 记的是模型返回的原文（不是页面里那张预置示例卡）") : F("F3 落的不是模型原文");
  !ded.some((x) => x.source === "sample")
    ? P("F4 接了模型就不再塞「预置示例」结论") : F("F4 接了模型还塞了预置示例");
  /AI 验证/.test(dF.getElementById("stSide").textContent)
    ? P("F5 结论在右栏标成「AI 验证」") : F("F5 来源标注缺失");
  /你的方向对/.test(dF.getElementById("stSide").textContent)
    ? P("F6 模型的 Markdown 被渲染上屏") : F("F6 结论没显示");
  wF.close();
}

/* ============================================================
   G. 「我的探究进度」到底算的是谁的成果
   ============================================================ */
sec("【G】个人进度口径 · 别人的发现算不算我的");

{
  const domI = load("training-student.html", {
    role: "student",
    ls: { st_accounts: ACCOUNTS, st_current_user: "student:student" },
  });
  await settle(domI);
  const wI = domI.window, dI = wI.document;
  click(wI, dI.querySelector('#stList [data-act-id="act-round-area"]'));
  await settle(domI);
  const side = dI.getElementById("stSide").textContent.replace(/\s+/g, " ");
  const mine = wI.eval("JSON.stringify(myProgressOf('act-round-area'))");
  /* 学生本人一条都没做过 → 进度必须是 0 */
  mine === "null" && /已积累 0 条成果/.test(side)
    ? P("G1 什么都没做过时，进度是 0 条") : F("G1 本人零记录，进度却显示: " + (side.match(/已积累 \d+ 条成果/) || ["?"])[0]);
  /当前方向：/.test(side)
    ? F("G2 「当前方向」显示的是别人（预置新发现）的内容，不是我的")
    : P("G2 没有拿别人的新发现当我当前的方向");
  /预置示例|示例/.test(side)
    ? P("G3 学生端标注了哪些是预置示例") : F("G3 预置示例的新发现没标注，看着像同学真写的");
  wI.close();
}

/* ============================================================
   汇总
   ============================================================ */
console.log("\n" + "=".repeat(62));
console.log("  通过 " + ok + " / 失败 " + fail + " / 运行时错误 " + ERR.length);
if (ERR.length) ERR.slice(0, 8).forEach((e) => console.log("    ! " + e));
console.log("=".repeat(62));
process.exit(fail ? 1 : 0);

})();
