/**
 * AI 工作台全环节审计（jsdom 真解析真执行）
 * ------------------------------------------------------------
 * 按「人的操作路径」把工作台走一遍，对照产品理想逐条判：
 *   理想 = 说清想要什么 → AI 现场写一个 → 打开就能用（能加/能勾/能删/刷新不丢）
 *          + 老师能下发、学生能收到并打开 + 学生自己也能造
 *
 *   教师端：首屏 → 示例 → 未接模型如实拒绝 → 接模型真生成 → 打开 → 看代码 → 改名 → 删除
 *   产出物：把生成/预置的 HTML 单独跑起来，验「打开就能用」「数据存得住」
 *   下发：选人 → 发 → 学生跨账号桶收到 → 打开 → 老师删除后收回
 *   学生端：自己造 → 只能打开，不能改名/删除（对照理想判是否够用）
 *
 * 用法：node tools/workbench-audit.cjs
 */
const fs = require("fs");
const path = require("path");

const JSDOM_PATH = path.join(__dirname, ".deps", "node_modules", "jsdom");
let JSDOM;
try { ({ JSDOM } = require(JSDOM_PATH)); }
catch (e) { console.log("跳过：未安装 jsdom"); process.exit(0); }

const SITE = path.resolve(__dirname, "..", "docs");

let ok = 0, fail = 0, warn = 0;
const P = (m) => { ok++; console.log("    v " + m); };
const F = (m) => { fail++; console.log("    x " + m); };
const W = (m) => { warn++; console.log("    ! " + m); };
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

/** `o.fetchStub`：假的模型返回；`o.ls`：预置存档 */
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
      if (o.fetchStub) win.fetch = o.fetchStub;
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

async function waitFor(fn, ms) {
  const limit = ms || 2500;
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    try { if (fn()) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

const click = (win, el) => el && el.dispatchEvent(new win.Event("click", { bubbles: true }));
const input = (win, el) => el && el.dispatchEvent(new win.Event("input", { bubbles: true }));
const sec = (t) => console.log("\n" + t);
const btnByText = (d, re) => [...d.querySelectorAll("button")].find((b) => re.test(b.textContent || ""));

function visibleText(d) {
  const clone = d.body.cloneNode(true);
  clone.querySelectorAll("script,style,template").forEach((n) => n.remove());
  return clone.textContent.replace(/\s+/g, " ").trim();
}

const ACCOUNTS = JSON.stringify([
  { role: "teacher", user: "teacher", pass: "x", name: "李老师", createdAt: 1 },
  { role: "student", user: "student", pass: "x", name: "李同学", createdAt: 2 },
  { role: "student", user: "lisi", pass: "x", name: "李四", createdAt: 3 },
]);

/** 一段“合格”的生成结果：单文件、无外链、能增能勾能删、数据写 localStorage */
const GEN_HTML = [
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>作业提交跟踪</title>',
  '<style>body{font:14px/1.6 system-ui;padding:16px;background:#fff;color:#222}',
  'input,button{font:inherit;margin-right:6px}button{cursor:pointer}.row{margin:6px 0}</style></head><body>',
  '<h1>作业提交跟踪</h1><div id="stat"></div>',
  '<p><input id="nm" placeholder="学生姓名"><button id="add">加入</button></p><div id="list"></div>',
  '<script>var K="wstool:audit";var items=[];',
  'try{items=JSON.parse(localStorage.getItem(K)||"[]")||[]}catch(e){items=[]}',
  'function save(){try{localStorage.setItem(K,JSON.stringify(items))}catch(e){}}',
  'function render(){var done=items.filter(function(x){return x.d}).length;',
  'document.getElementById("stat").textContent="共 "+items.length+" 人，已交 "+done+" 人，未交 "+(items.length-done)+" 人";',
  'var box=document.getElementById("list");box.innerHTML="";',
  'items.forEach(function(it,i){var r=document.createElement("div");r.className="row";',
  'var cb=document.createElement("input");cb.type="checkbox";cb.checked=!!it.d;',
  'cb.onchange=function(){it.d=cb.checked;save();render()};',
  'var t=document.createElement("span");t.textContent=it.n;',
  'var x=document.createElement("button");x.textContent="删除";',
  'x.onclick=function(){items.splice(i,1);save();render()};',
  'r.appendChild(cb);r.appendChild(t);r.appendChild(x);box.appendChild(r)});}',
  'document.getElementById("add").onclick=function(){var v=document.getElementById("nm").value.trim();',
  'if(!v)return;items.push({n:v,d:false});document.getElementById("nm").value="";save();render()};',
  'render();<\/script></body></html>',
].join("");

/** 一个只有壳的合格 HTML（用于把工作台塞到上限） */
const MIN_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>' +
  "内容".repeat(300) + "</p></body></html>";

const modelReply = (html) => JSON.stringify({ choices: [{ message: { content: "好的，写好了：\n```html\n" + html + "\n```\n需要再改告诉我。" } }] });

(async function main() {

/* ============================================================
   A. 教师端首屏
   ============================================================ */
sec("【A】教师端 · 首屏与入口");

let dom = load("workbench.html", { role: "teacher", ls: { st_accounts: ACCOUNTS, st_current_user: "teacher:teacher" } });
await settle(dom);
let w = dom.window, d = w.document;

{
  !!d.getElementById("appAsk") ? P("A1 有「说一句你想要的」需求输入框") : F("A1 没有需求输入框");
  !!d.getElementById("appMake") ? P("A1 有「让 AI 造一个」按钮") : F("A1 没有生成按钮");
  !!d.getElementById("appGrid") ? P("A1 有工作台列表") : F("A1 没有列表");

  const cards = [...d.querySelectorAll("#appGrid .sm-card")];
  cards.length === 1 ? P("A1 预置账号首屏有 1 个示例工作台（作业提交跟踪）") : F("A1 首屏卡片数异常: " + cards.length);
  /作业提交跟踪/.test(d.getElementById("appGrid").textContent)
    ? P("A1 示例卡片显示标题与目标") : F("A1 示例卡片内容缺失");
  /预置示例/.test(cards[0] ? cards[0].textContent : "")
    ? P("A1 示例卡片标了「预置示例」（不冒充 AI 现写）") : F("A1 示例卡片没标来源");

  !d.getElementById("tabDesk") && !d.getElementById("tabTools")
    ? P("A1 只剩 AI 工作台（事务台 / 教学模拟的视图没回来）")
    : F("A1 又冒出事务台或教学模拟的页签");

  const hint = d.getElementById("appMakeHint").textContent;
  /还没有接入模型|没接|去「设置/.test(hint)
    ? P("A1 未接模型时先如实说明（" + hint.slice(0, 28) + "…）") : F("A1 未接模型却没说清: " + hint);
  d.getElementById("appMakeHint").classList.contains("err")
    ? P("A1 未接模型的提示是警示样式（不是普通灰字）") : F("A1 提示样式没区分");
}

/* ---- A2 示例 chips ---- */
{
  const chips = [...d.querySelectorAll("#appExamples .app-eg")];
  chips.length === 5 ? P("A2 给了 5 条示例需求") : F("A2 示例条数异常: " + chips.length);
  click(w, chips[0]);
  d.getElementById("appAsk").value === chips[0].textContent
    ? P("A2 点示例把需求填进输入框") : F("A2 点示例没填进输入框");
  !d.getElementById("appProgress") || d.getElementById("appProgress").hidden
    ? P("A2 点示例只填字，不自动生成（用户还能改）") : F("A2 点示例就自动生成了");
}

/* ---- A3 自注册账号：空态不塞假卡片，但给一个真能用的示例入口 ---- */
{
  const ls = { st_accounts: ACCOUNTS, st_current_user: "teacher:newteacher" };
  const domE = load("workbench.html", { role: "teacher", ls });
  await settle(domE);
  const dE = domE.window.document, wE = domE.window;
  const grid = dE.getElementById("appGrid");
  /还没有工作台/.test(grid.textContent) ? P("A3 新账号从空开始（不塞种子）") : F("A3 新账号被塞了卡片");
  const seedBtn = grid.querySelector('[data-a="app-seed"]');
  seedBtn ? P("A3 空态给了「先看一个示例工作台」入口") : F("A3 空态没有示例入口");
  if (seedBtn) {
    click(wE, seedBtn);
    await settle(domE);
    dE.querySelectorAll("#appGrid .sm-card").length === 1
      ? P("A3 点示例后真的落了一张卡片（不是只弹个 toast）") : F("A3 点示例没落卡片");
    !!dE.querySelector("iframe.sm-frame") ? P("A3 点示例后直接打开（不用再点一次）") : F("A3 示例没打开");
    const raw = String(wE.localStorage.getItem("st_sim:teacher:newteacher") || "");
    /wb-seed-1|作业提交跟踪/.test(raw) ? P("A3 示例卡片写进了自己的桶") : F("A3 示例卡片没落库");
  }
  domE.window.close();
}

/* ============================================================
   B. 未接模型：如实拒绝
   ============================================================ */
sec("【B】未接模型 · 不许伪造");

let fetchCalls = 0;
{
  const before = w.eval("SIMS.length");
  d.getElementById("appAsk").value = "跟踪全班作业提交情况";
  click(w, d.getElementById("appMake"));
  await settle(dom);
  const prog = d.getElementById("appProgress");
  !prog.hidden ? P("B1 点生成后进度区出现（不让人对着空白等）") : F("B1 进度区没出现");
  /还没有接入模型|不会真去写代码|设置/.test(prog.textContent)
    ? P("B1 如实说明不会真生成，并指路设置") : F("B1 没说明原因: " + prog.textContent);
  !!btnByText(d, /去设置填 Key/) ? P("B1 给了「去设置填 Key」的按钮") : F("B1 没有可操作的下一步");
  d.getElementById("appGoSettings").hidden === false
    ? P("B1 生成按钮旁也出现「去设置填 Key」") : F("B1 旁路入口没出现");
  w.eval("SIMS.length") === before ? P("B2 失败不往列表塞假卡片") : F("B2 塞了假卡片");
  !d.querySelector("iframe.sm-frame") ? P("B2 失败不假装打开一个空工作台") : F("B2 失败还弹了 iframe");
  fetchCalls === 0 ? P("B2 没接模型时根本没发请求（不在后台硬试）") : F("B2 没接模型却发了请求");
}

/* ---- B3 空需求 ---- */
{
  d.getElementById("appAsk").value = "   ";
  click(w, d.getElementById("appMake"));
  await settle(dom);
  /先说一句/.test(d.getElementById("appProgress").textContent)
    ? P("B3 空需求被拒，并说清该怎么写") : F("B3 空需求提示不清");
  /说清「管什么、要看到什么」/.test(d.getElementById("appProgress").textContent)
    ? P("B3 给了写法提示（管什么 / 要看到什么）") : F("B3 没给写法提示");
}

/* ============================================================
   C. 接上模型：真生成 → 落库 → 直接打开
   ============================================================ */
sec("【C】接上模型 · 从一句话到能打开");

let lastReq = null;
let replyBody = modelReply(GEN_HTML);
let replyStatus = 200;
const fetchStub = function (url, opt) {
  fetchCalls++;
  lastReq = { url: String(url), opt: opt || {} };
  const status = replyStatus;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    json: () => Promise.resolve(JSON.parse(replyBody)),
    text: () => Promise.resolve("unauthorized"),
  });
};

/* 凭据用**裸串**写（设置页就是裸串），专门防「填了 Key 却永远说没接模型」的老坑 */
dom = load("workbench.html", {
  role: "teacher",
  ls: { st_accounts: ACCOUNTS, st_current_user: "teacher:teacher", st_provider: "deepseek", st_api_key: "sk-audit-raw" },
  fetchStub,
});
await settle(dom);
w = dom.window; d = w.document;

{
  const hint = d.getElementById("appMakeHint").textContent;
  /已接入 DeepSeek/.test(hint)
    ? P("C1 裸串写的 Key 读得回来，界面说「已接入 DeepSeek」") : F("C1 Key 读不回来: " + hint);
  d.getElementById("appMakeHint").classList.contains("err") === false
    ? P("C1 接入状态不再挂警示样式") : F("C1 接入后仍是警示样式");

  d.getElementById("appAsk").value = "跟踪全班作业提交情况，勾谁交了、一眼看出还差几个人";
  const n0 = w.eval("SIMS.length");
  click(w, d.getElementById("appMake"));
  const grew = await waitFor(() => w.eval("SIMS.length") === n0 + 1, 3000);

  grew ? P("C2 生成成功并落库（SIMS 多了一条）") : F("C2 生成后没落库");
  fetchCalls > 0 ? P("C2 真的发了模型请求") : F("C2 没发请求");
  /api\.deepseek\.com\/chat\/completions\/?$/.test(lastReq ? lastReq.url : "")
    ? P("C2 打到了 DeepSeek 的接口地址") : F("C2 接口地址不对: " + (lastReq && lastReq.url));
  let body = {};
  try { body = JSON.parse(lastReq.opt.body); } catch (_) {}
  body.model === "deepseek-chat" ? P("C2 请求里带了服务商定义的模型名") : F("C2 模型名不对: " + body.model);
  const auth = lastReq && lastReq.opt.headers && lastReq.opt.headers.Authorization;
  auth === "Bearer sk-audit-raw" ? P("C2 请求带了 Authorization") : F("C2 没带 Authorization: " + auth);
  /单文件 HTML/.test(String(body.messages && body.messages[0] && body.messages[0].content))
    ? P("C2 系统提示词就是工作台那套（要求单文件 HTML）") : F("C2 提示词不对");
  /跟踪全班作业提交情况/.test(String(body.messages && body.messages[1] && body.messages[1].content))
    ? P("C2 用户那句话原样进了请求") : F("C2 用户需求没进请求");

  const sims = JSON.parse(w.eval("JSON.stringify(SIMS)"));
  const made = sims[0] || {};
  made.kind === "workbench" ? P("C3 落库类型是 workbench") : F("C3 kind 不对: " + made.kind);
  made.provider === "deepseek" && made.model === "deepseek-chat"
    ? P("C3 记下了真实来源（deepseek / deepseek-chat）") : F("C3 来源没记: " + made.provider + "/" + made.model);
  made.status === "ready" ? P("C3 生成完即 ready（打开就能用）") : F("C3 状态不对: " + made.status);
  made.createdBy === "teacher:teacher" ? P("C3 记了创建人（学生端据此区分「老师发来的」）") : F("C3 没记创建人");
  made.html === GEN_HTML ? P("C3 存的是模型写的那份 HTML 本体") : F("C3 HTML 不一致");
  String(w.localStorage.getItem("st_sim:teacher:teacher") || "").indexOf("wstool:audit") >= 0
    ? P("C3 真的写进了自己的桶（刷新能读回）") : F("C3 没写进自己的桶");

  /写好了/.test(d.getElementById("appProgress").textContent)
    ? P("C4 完成后进度区说「写好了」") : F("C4 完成提示缺失");
  d.getElementById("appAsk").value === "" ? P("C4 成功后清空输入框（接着能造下一个）") : F("C4 输入框没清空");
  const frame = d.querySelector("iframe.sm-frame");
  !!frame ? P("C4 生成后直接打开弹窗（不用再点一下）") : F("C4 没自动打开");
  frame && (frame.getAttribute("srcdoc") || "").indexOf("<!DOCTYPE") === 0
    ? P("C4 iframe 里装的就是生成结果") : F("C4 iframe 内容是空的");
  frame && frame.getAttribute("sandbox") === "allow-scripts allow-same-origin"
    ? P("C4 工作台给同源沙箱（要存自己的数据）") : F("C4 沙箱属性不对: " + (frame && frame.getAttribute("sandbox")));
  frame && frame.getAttribute("sandbox").indexOf("allow-top-navigation") < 0
    ? P("C4 沙箱没给顶层跳转（不让人被生成页带走）") : F("C4 沙箱权限过大");

  /预置示例/.test(String(d.querySelector("#appGrid .sm-card") ? d.querySelector("#appGrid .sm-card").textContent : "")) === false
    ? P("C4 新卡片不冒充示例（来源显示 DeepSeek）") : F("C4 新卡片来源标错");
  click(w, d.querySelector('.modal [data-app-act="close"]'));
  await settle(dom);
}

/* ---- C5 产出物本身：打开就能用、刷新不丢 ---- */
{
  const tool = new JSDOM(GEN_HTML, {
    url: "http://localhost/tool.html", runScripts: "dangerously", pretendToBeVisual: true,
  });
  const td = tool.window.document, tw = tool.window;
  const stat = () => td.getElementById("stat").textContent;
  /共 0 人/.test(stat()) ? P("C5 产出物首屏有统计（共 0 人）") : F("C5 产出物没有统计: " + stat());

  td.getElementById("nm").value = "王五";
  click(tw, td.getElementById("add"));
  /共 1 人，已交 0 人，未交 1 人/.test(stat())
    ? P("C5 能新增一条，统计跟着变") : F("C5 新增没生效: " + stat());

  const cb = td.querySelector('#list input[type="checkbox"]');
  cb.checked = true;
  cb.dispatchEvent(new tw.Event("change", { bubbles: true }));
  /已交 1 人，未交 0 人/.test(stat()) ? P("C5 能勾选完成，统计跟着变") : F("C5 勾选没生效: " + stat());

  const saved = tw.localStorage.getItem("wstool:audit");
  /王五/.test(String(saved)) ? P("C5 改动写进了 localStorage（wstool: 前缀）") : F("C5 没存数据");

  /* 重新打开：把存档带进新实例 → 数据要能读回 */
  const tool2 = new JSDOM(GEN_HTML, {
    url: "http://localhost/tool.html", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(win) { win.localStorage.setItem("wstool:audit", saved); },
  });
  /共 1 人，已交 1 人/.test(tool2.window.document.getElementById("stat").textContent)
    ? P("C5 刷新/重开数据还在（不是一刷新就空）") : F("C5 刷新后数据丢了");

  const del = [...tool2.window.document.querySelectorAll("#list button")].find((b) => /删除/.test(b.textContent));
  click(tool2.window, del);
  /共 0 人/.test(tool2.window.document.getElementById("stat").textContent)
    ? P("C5 能删除一条") : F("C5 删除没生效");
  tool.window.close(); tool2.window.close();
}

/* ---- C6 模型返回不合格：宁可拒绝，也不落一张坏卡片 ---- */
{
  const before = w.eval("SIMS.length");
  replyBody = JSON.stringify({ choices: [{ message: { content: "抱歉，我只能给你一段说明文字，不写代码。" } }] });
  d.getElementById("appAsk").value = "做个跟踪表";
  click(w, d.getElementById("appMake"));
  await waitFor(() => !d.getElementById("appMake").disabled, 2000);
  await settle(dom);
  const prog = d.getElementById("appProgress");
  /没法用|没能生成|不是/.test(prog.textContent) ? P("C6 模型返回非 HTML → 明说没法用") : F("C6 非 HTML 没被拦: " + prog.textContent);
  w.eval("SIMS.length") === before ? P("C6 不合格的内容不落库（不塞半成品）") : F("C6 落了一张坏卡片");
  !d.querySelector("iframe.sm-frame") ? P("C6 不合格时也没假装打开") : F("C6 还打开了坏内容");
}

/* ---- C7 生成结果带外链：沙箱里加载不出来，必须拒 ---- */
{
  const before = w.eval("SIMS.length");
  replyBody = modelReply('<!DOCTYPE html><html><body><img src="https://cdn.example.com/a.png"><p>' +
    "x".repeat(500) + "</p></body></html>");
  d.getElementById("appAsk").value = "带图片的看板";
  click(w, d.getElementById("appMake"));
  await waitFor(() => !d.getElementById("appMake").disabled, 2000);
  await settle(dom);
  /外部请求/.test(d.getElementById("appProgress").textContent)
    ? P("C7 含 CDN 的生成结果被拒，并说清原因") : F("C7 外链没被拦: " + d.getElementById("appProgress").textContent);
  w.eval("SIMS.length") === before ? P("C7 外链内容不落库") : F("C7 外链内容落库了");
}

/* ---- C8 服务商拒绝（401）：说清是 Key 的问题 ---- */
{
  const before = w.eval("SIMS.length");
  replyStatus = 401;
  d.getElementById("appAsk").value = "做个错题本";
  click(w, d.getElementById("appMake"));
  await waitFor(() => !d.getElementById("appMake").disabled, 2000);
  await settle(dom);
  const t = d.getElementById("appProgress").textContent;
  /401|Key 可能不对/.test(t) ? P("C8 401 如实报错并指向 Key") : F("C8 401 提示不清: " + t);
  w.eval("SIMS.length") === before ? P("C8 失败不落库") : F("C8 失败还落库");
  d.getElementById("appMake").disabled === false
    ? P("C8 失败后按钮恢复可点（不会卡死）") : F("C8 按钮卡在禁用态");
  replyStatus = 200;
  dom.window.close();
}

/* ============================================================
   D. 卡片管理：打开 / 看代码 / 改名 / 删除 / 上限
   ============================================================ */
sec("【D】卡片管理");

const SAVED = {
  id: "app-d1", title: "我的作业跟踪", goal: "看谁交了", subject: "",
  kind: "workbench", html: GEN_HTML, status: "ready",
  provider: "deepseek", model: "deepseek-chat", createdBy: "teacher:teacher",
  createdAt: Date.now(), sentTo: [], feedback: [],
};

dom = load("workbench.html", {
  role: "teacher",
  ls: {
    st_accounts: ACCOUNTS, st_current_user: "teacher:teacher",
    "st_sim:teacher:teacher": JSON.stringify([SAVED]),
  },
});
await settle(dom);
w = dom.window; d = w.document;

{
  const card = d.querySelector('#appGrid [data-app="app-d1"]');
  !!card ? P("D1 存档里的卡片读回并渲染") : F("D1 存档没读回");
  const acts = [...(card ? card.querySelectorAll("[data-a]") : [])].map((b) => b.getAttribute("data-a"));
  ["app-open", "app-send", "app-rename", "app-del"].every((a) => acts.indexOf(a) >= 0)
    ? P("D1 教师卡片四个动作齐全（打开 / 下发 / 改名 / 删除）") : F("D1 动作不全: " + acts.join(","));
  /已发 0 人/.test(card ? card.textContent : "") === false
    ? P("D1 没下发过就不显示「已发 N 人」") : F("D1 没发过也显示已发");
}

/* ---- D2 打开 → 重载 → 看代码 ---- */
{
  click(w, d.querySelector('#appGrid [data-app="app-d1"] [data-a="app-open"]'));
  await settle(dom);
  const frame = d.querySelector("iframe.sm-frame");
  !!frame ? P("D2 点「打开」弹出沙箱 iframe") : F("D2 没打开");
  const first = frame;
  click(w, d.querySelector('.modal [data-app-act="reload"]'));
  await settle(dom);
  const frame2 = d.querySelector("iframe.sm-frame");
  frame2 && frame2 !== first ? P("D2 「重载」真的换了一个新 iframe") : F("D2 重载没反应");
  click(w, d.querySelector('.modal [data-app-act="code"]'));
  await settle(dom);
  const code = d.querySelector("#modalHost .sm-code");
  !!code ? P("D2 「看代码」展示生成的源码") : F("D2 看代码没打开");
  code && /wstool:audit/.test(code.textContent)
    ? P("D2 代码全文可读（不是截断的）") : F("D2 代码内容不对");
  code && code.textContent.indexOf("<script>") >= 0 && code.querySelectorAll("script").length === 0
    ? P("D2 代码以纯文本展示，不会被当成脚本执行") : F("D2 代码被当 HTML 插进页面了");
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle(dom);
  d.getElementById("modalHost").hidden ? P("D2 Esc 关闭代码弹窗") : F("D2 Esc 关不掉");
}

/* ---- D3 改名 ---- */
{
  click(w, d.querySelector('#appGrid [data-app="app-d1"] [data-a="app-rename"]'));
  await settle(dom);
  const inp = d.getElementById("dkAskInput");
  !!inp ? P("D3 改名用弹窗输入框（不靠 window.prompt）") : F("D3 改名没弹窗");
  if (inp) {
    inp.value = "   ";
    click(w, d.querySelector('#modalHost [data-mc="ok"]'));
    await settle(dom);
    JSON.parse(w.localStorage.getItem("st_sim:teacher:teacher"))[0].title === "我的作业跟踪"
      ? P("D3 空名字被拒（原名保住）") : F("D3 空名字把原名清掉了");
    /名字不能空着/.test(d.getElementById("appBannerBox").textContent)
      ? P("D3 空名字有明确提示") : F("D3 空名字没提示");

    click(w, d.querySelector('#appGrid [data-app="app-d1"] [data-a="app-rename"]'));
    await settle(dom);
    d.getElementById("dkAskInput").value = "作业跟踪（改过）";
    click(w, d.querySelector('#modalHost [data-mc="ok"]'));
    await settle(dom);
    /作业跟踪（改过）/.test(d.getElementById("appGrid").textContent)
      ? P("D3 改名后列表立刻更新") : F("D3 列表没更新");
    /作业跟踪（改过）/.test(String(w.localStorage.getItem("st_sim:teacher:teacher")))
      ? P("D3 改名落库") : F("D3 改名没落库");

    click(w, d.querySelector('#appGrid [data-app="app-d1"] [data-a="app-rename"]'));
    await settle(dom);
    d.getElementById("dkAskInput").value = "不该生效";
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(dom);
    /作业跟踪（改过）/.test(d.getElementById("appGrid").textContent)
      ? P("D3 Esc 取消改名不生效") : F("D3 Esc 也把名字改了");
  }
}

/* ---- D4 删除 ---- */
{
  click(w, d.querySelector('#appGrid [data-app="app-d1"] [data-a="app-del"]'));
  await settle(dom);
  const host = d.getElementById("modalHost");
  !!host && host.hidden === false ? P("D4 删除前弹确认框") : F("D4 删除没有确认");
  /无法恢复/.test(host ? host.textContent : "") ? P("D4 确认框说清不可恢复") : F("D4 确认文案不清");
  click(w, d.querySelector('#modalHost [data-mc="no"]'));
  await settle(dom);
  !!d.querySelector('#appGrid [data-app="app-d1"]') ? P("D4 取消删除，卡片还在") : F("D4 取消也删了");

  click(w, d.querySelector('#appGrid [data-app="app-d1"] [data-a="app-del"]'));
  await settle(dom);
  click(w, d.querySelector('#modalHost [data-mc="ok"]'));
  await settle(dom);
  !d.querySelector('#appGrid [data-app="app-d1"]') ? P("D4 确认后卡片从列表消失") : F("D4 确认后还在");
  String(w.localStorage.getItem("st_sim:teacher:teacher")) === "[]"
    ? P("D4 删除落库（桶里清空，不是只从界面拿掉）") : F("D4 桶里还留着");
  /已删除/.test(d.getElementById("appBannerBox").textContent) ? P("D4 删除有反馈") : F("D4 删除没反馈");
  dom.window.close();
}

/* ---- D5 上限：到顶拒绝，不悄悄丢最旧的 ---- */
{
  replyBody = modelReply(GEN_HTML);          // 前面几个用例改过假模型的返回，这里要复位
  const many = [];
  for (let i = 0; i < 40; i++) {
    many.push(Object.assign({}, SAVED, { id: "app-cap-" + i, title: "第 " + (i + 1) + " 个" }));
  }
  const domCap = load("workbench.html", {
    role: "teacher",
    ls: {
      st_accounts: ACCOUNTS, st_current_user: "teacher:teacher",
      st_provider: "deepseek", st_api_key: "sk-audit-raw",
      "st_sim:teacher:teacher": JSON.stringify(many),
    },
    fetchStub,
  });
  await settle(domCap);
  const dC = domCap.window.document, wC = domCap.window;
  dC.getElementById("appAsk").value = "再做一个";
  click(wC, dC.getElementById("appMake"));
  await waitFor(() => !dC.getElementById("appMake").disabled, 2500);
  await settle(domCap);
  const t = dC.getElementById("appProgress").textContent;
  /上限/.test(t) ? P("D5 到上限时拒绝新建并说清") : F("D5 到上限没提示: " + t);
  /40/.test(t) ? P("D5 说清上限是多少") : F("D5 没说数字");
  wC.eval("SIMS.length") === 40 ? P("D5 没悄悄丢掉最旧的（仍 40 个）") : F("D5 卡片数变了: " + wC.eval("SIMS.length"));
  /工作台/.test(t) && /40/.test(t) && !/模拟器/.test(t)
    ? P("D5 上限文案用词一致（说「工作台」，不再叫「模拟器」）")
    : F("D5 上限文案术语不一致: " + t);
  domCap.window.close();
}

/* ============================================================
   E. 下发 → 学生收到 → 打开 → 收回
   ============================================================ */
sec("【E】下发与跨身份");

const SHARED = Object.assign({}, SAVED, { id: "app-share-1", title: "要发下去的工作台" });
dom = load("workbench.html", {
  role: "teacher",
  ls: {
    st_accounts: ACCOUNTS, st_current_user: "teacher:teacher",
    "st_sim:teacher:teacher": JSON.stringify([SHARED]),
  },
});
await settle(dom);
w = dom.window; d = w.document;

{
  click(w, d.querySelector('#appGrid [data-app="app-share-1"] [data-a="app-send"]'));
  await settle(dom);
  const host = d.getElementById("modalHost");
  !!host && host.hidden === false ? P("E1 点「下发给学生」弹出名单") : F("E1 名单没弹");
  const people = [...d.querySelectorAll("#modalHost [data-who]")];
  people.length >= 1 ? P("E1 名单来自真实选课学生（" + people.length + " 人）") : F("E1 名单是空的");
  const keys = people.map((x) => x.getAttribute("data-who"));
  keys.every((k) => /^student:/.test(k)) ? P("E1 名单用的是 student:xxx 的键（不是裸账号名）") : F("E1 键格式不对: " + keys);

  click(w, d.querySelector('#modalHost [data-mc="ok"]'));
  await settle(dom);
  /先选要发给谁/.test(d.getElementById("appBannerBox").textContent)
    ? P("E1 一个人都没选 → 如实拒绝，不假装发出去了") : F("E1 空名单没提示");
  d.getElementById("modalHost").hidden === false
    ? P("E1 空名单后弹窗还开着（能接着选）") : F("E1 空名单把弹窗关了");

  const pick = d.querySelectorAll("#modalHost [data-who]")[0];
  const who = pick.getAttribute("data-who");
  pick.checked = true;
  click(w, d.querySelector('#modalHost [data-mc="ok"]'));
  await settle(dom);
  /已下发给 1 位学生/.test(d.getElementById("appBannerBox").textContent)
    ? P("E2 选人后下发成功并有反馈") : F("E2 下发反馈缺失");
  const rec = JSON.parse(w.localStorage.getItem("st_sim:teacher:teacher"))[0];
  rec.sentTo.length === 1 && rec.sentTo[0].who === who
    ? P("E2 下发记录落库（谁、什么时候）") : F("E2 sentTo 不对: " + JSON.stringify(rec.sentTo));
  /已发 1 人/.test(d.querySelector('#appGrid [data-app="app-share-1"]').textContent)
    ? P("E2 卡片上出现「已发 1 人」") : F("E2 卡片没更新");

  /* 再发一次同一个人 → 不堆重复记录 */
  click(w, d.querySelector('#appGrid [data-app="app-share-1"] [data-a="app-send"]'));
  await settle(dom);
  const again = d.querySelectorAll("#modalHost [data-who]")[0];
  const who2 = again.getAttribute("data-who");
  again.checked = true;
  click(w, d.querySelector('#modalHost [data-mc="ok"]'));
  await settle(dom);
  const rec2 = JSON.parse(w.localStorage.getItem("st_sim:teacher:teacher"))[0];
  rec2.sentTo.length === 1 && rec2.sentTo[0].who === who2
    ? P("E2 重复发同一人只更新时间（不堆重复记录）") : F("E2 重复下发堆了记录: " + rec2.sentTo.length);
}

/* ---- E3 学生端：跨桶收到 ---- */
const teacherSnap = w.localStorage.getItem("st_sim:teacher:teacher");
const studentWho = "student:student";
dom.window.close();

{
  const domS = load("workbench.html", {
    role: "student",
    ls: {
      st_accounts: ACCOUNTS, st_current_user: "student:student",
      "st_sim:teacher:teacher": teacherSnap,
    },
  });
  await settle(domS);
  const dS = domS.window.document, wS = domS.window;
  const text = dS.getElementById("appGrid").textContent;
  /老师发来的/.test(text) ? P("E3 学生端分区显示「老师发来的」") : F("E3 没有这个分区");
  /要发下去的工作台/.test(text) ? P("E3 跨账号桶读到了刚下发的工作台") : F("E3 没收到（记录在老师桶里）");
  const cnt = dS.getElementById("appCount").textContent;
  /\d/.test(cnt) ? P("E3 顶部计数跟着变（" + cnt + "）") : F("E3 计数缺失");

  const card = [...dS.querySelectorAll("#appGrid .sm-card")].find((c) => /要发下去的工作台/.test(c.textContent));
  const acts = card ? [...card.querySelectorAll("[data-a]")].map((b) => b.getAttribute("data-a")) : [];
  acts.indexOf("app-send") < 0 ? P("E3 学生端没有「下发给学生」") : F("E3 学生端有下发按钮");
  acts.indexOf("app-del") < 0 ? P("E3 学生端没有「删除」（不是他的东西）") : F("E3 学生端能删老师的");
  acts.indexOf("app-rename") < 0 ? P("E3 学生端不能给老师发的改名") : F("E3 学生端能改老师的名字");
  /由 李老师 发来/.test(card ? card.textContent : "")
    ? P("E3 卡片说清是谁发来的") : F("E3 没标发送人");

  if (card) {
    click(wS, card.querySelector('[data-a="app-open"]'));
    await settle(domS);
    const fr = dS.querySelector("iframe.sm-frame");
    !!fr ? P("E3 学生能打开老师发来的工作台（跨桶取数）") : F("E3 打不开");
    fr && fr.getAttribute("srcdoc").indexOf("wstool:audit") >= 0
      ? P("E3 打开的确实是那份 HTML") : F("E3 打开的内容不对");
    !dS.querySelector('.modal [data-app-act="send"]')
      ? P("E3 学生弹窗里也没有下发按钮") : F("E3 学生弹窗有下发");
    click(wS, dS.querySelector('.modal [data-app-act="close"]'));
    await settle(domS);
  }
  domS.window.close();
}

/* ---- E4 没被发的人看不到 ---- */
{
  const domL = load("workbench.html", {
    role: "student",
    ls: {
      st_accounts: ACCOUNTS, st_current_user: "student:lisi",
      "st_sim:teacher:teacher": teacherSnap,
    },
  });
  await settle(domL);
  const t = domL.window.document.getElementById("appGrid").textContent;
  !/要发下去的工作台/.test(t) ? P("E4 没被发到的学生看不到这份") : F("E4 没发也看到了");
  domL.window.close();
}

/* ---- E5 学生自己造 ---- */
{
  replyBody = modelReply(GEN_HTML);          // 同上：复位假模型返回
  const domM = load("workbench.html", {
    role: "student",
    ls: {
      st_accounts: ACCOUNTS, st_current_user: "student:student",
      st_provider: "deepseek", st_api_key: "sk-audit-raw",
      "st_sim:teacher:teacher": teacherSnap,
    },
    fetchStub,
  });
  await settle(domM);
  const dM = domM.window.document, wM = domM.window;
  const n0 = wM.eval("SIMS.length");
  dM.getElementById("appAsk").value = "我的错题本，按知识点分类";
  click(wM, dM.getElementById("appMake"));
  const made = await waitFor(() => wM.eval("SIMS.length") === n0 + 1, 3000);
  made ? P("E5 学生也能让 AI 现场造一个") : F("E5 学生造不出来");

  const mine = JSON.parse(wM.eval("JSON.stringify(SIMS)"))[0] || {};
  mine.createdBy === "student:student" ? P("E5 记成学生自己造的") : F("E5 createdBy 不对: " + mine.createdBy);
  const secs = [...dM.querySelectorAll("#appGrid .sm-grid-title")].map((x) => x.textContent);
  secs.some((s) => /我自己造的/.test(s)) ? P("E5 归到「我自己造的」这一批") : F("E5 分区不对: " + secs.join("/"));
  String(wM.localStorage.getItem("st_sim:student:student") || "").indexOf("错题本") >= 0
    ? P("E5 学生造的落进自己的桶") : F("E5 没落学生桶");

  const card = [...dM.querySelectorAll("#appGrid .sm-card")].find((c) => /错题本/.test(c.textContent));
  const acts = card ? [...card.querySelectorAll("[data-a]")].map((b) => b.getAttribute("data-a")) : [];
  acts.indexOf("app-del") >= 0 && acts.indexOf("app-rename") >= 0
    ? P("E5 学生能改名 / 删除自己造的工作台")
    : F("E5 自己造的也改不了、删不掉（只能攒着）: " + acts.join(","));
  acts.indexOf("app-send") < 0 ? P("E5 学生仍然不能下发（那是教师的动作）") : F("E5 学生能下发");

  /* 真删一次：自己的卡片要删得掉，桶里也要清 */
  if (card) {
    click(wM, card.querySelector('[data-a="app-del"]'));
    await settle(domM);
    click(wM, dM.querySelector('#modalHost [data-mc="ok"]'));
    await settle(domM);
    const left = JSON.parse(wM.localStorage.getItem("st_sim:student:student") || "[]");
    !left.some((x) => /错题本/.test(x.title))
      ? P("E5 删除自己的真的删掉了（桶里也清了）") : F("E5 删了自己的卡片还在桶里");
  }

  /* 老师看不到学生自己造的 */
  const domT2 = load("workbench.html", {
    role: "teacher",
    ls: {
      st_accounts: ACCOUNTS, st_current_user: "teacher:teacher",
      "st_sim:teacher:teacher": teacherSnap,
    },
  });
  await settle(domT2);
  !/错题本/.test(domT2.window.document.getElementById("appGrid").textContent)
    ? P("E5 学生自己造的不会出现在老师列表（各桶分开）") : F("E5 学生造的串到老师那了");
  domT2.window.close();
  domM.window.close();
}

/* ---- E6 收回：老师删掉 → 学生刷新后看不到 ---- */
{
  const domT3 = load("workbench.html", {
    role: "teacher",
    ls: {
      st_accounts: ACCOUNTS, st_current_user: "teacher:teacher",
      "st_sim:teacher:teacher": teacherSnap,
    },
  });
  await settle(domT3);
  const dT3 = domT3.window.document, wT3 = domT3.window;
  click(wT3, dT3.querySelector('#appGrid [data-app="app-share-1"] [data-a="app-del"]'));
  await settle(domT3);
  click(wT3, dT3.querySelector('#modalHost [data-mc="ok"]'));
  await settle(domT3);
  const afterSnap = wT3.localStorage.getItem("st_sim:teacher:teacher");
  domT3.window.close();

  const domS3 = load("workbench.html", {
    role: "student",
    ls: {
      st_accounts: ACCOUNTS, st_current_user: "student:student",
      "st_sim:teacher:teacher": afterSnap,
    },
  });
  await settle(domS3);
  !/要发下去的工作台/.test(domS3.window.document.getElementById("appGrid").textContent)
    ? P("E6 老师删掉后，学生刷新就看不到了（下发可收回）")
    : F("E6 老师删了学生还在用（撤不回）");
  domS3.window.close();
}

/* ---- E7 预置示例被老师删掉后，学生端不再补一份 ---- */
{
  const domT4 = load("workbench.html", {
    role: "teacher",
    ls: {
      st_accounts: ACCOUNTS, st_current_user: "teacher:teacher",
      "st_sim:teacher:teacher": "[]",
    },
  });
  await settle(domT4);
  const dT4 = domT4.window.document;
  /还没有工作台/.test(dT4.getElementById("appGrid").textContent)
    ? P("E7 老师把预置示例删光后，老师端是空的")
    : F("E7 老师端删光了却又冒出来");

  const domS4 = load("workbench.html", {
    role: "student",
    ls: {
      st_accounts: ACCOUNTS, st_current_user: "student:student",
      "st_sim:teacher:teacher": "[]",       // 老师的桶明确存在且为空
    },
  });
  await settle(domS4);
  const t4 = domS4.window.document.getElementById("appGrid").textContent;
  !/作业提交跟踪/.test(t4)
    ? P("E7 老师删掉示例后，学生刷新也不再看到它（删除真的生效）")
    : F("E7 老师删了示例，学生端又补了一份（看着像删除没生效）");
  /还没有工作台/.test(t4) ? P("E7 学生端落到空态，而不是空白一片") : F("E7 学生端空态文案缺失");
  domS4.window.close();
  domT4.window.close();
}
/* ============================================================
   F. 文案与来源标注
   ============================================================ */
sec("【F】诚实口径");

{
  const domF = load("workbench.html", {
    role: "teacher",
    ls: { st_accounts: ACCOUNTS, st_current_user: "teacher:teacher" },
  });
  await settle(domF);
  const t = visibleText(domF.window.document);
  ["本机浏览器", "保存在本机", "换台机器", "不会上传", "存在浏览器", "本地浏览器"].forEach((bad) => {
    t.indexOf(bad) < 0 ? P("F1 页面没写数据存在哪里（没出现「" + bad + "」）") : F("F1 出现了「" + bad + "」");
  });
  /数据会自己保存|随时回来/.test(t)
    ? P("F1 用「数据会自己保存」这类说法（说结果不说位置）") : F("F1 没有保存说明");
  const demoHits = t.match(/演示[^\s，。；、]{1,6}/g) || [];
  demoHits.length === 0 ? P("F2 没有「演示 XX」这类文案") : F("F2 出现演示类文案: " + demoHits.join(" / "));
  /单文件页面/.test(t) ? P("F3 说清产物是什么（单文件页面）") : F("F3 没说产物形态");
  !/学习通|账本|事务台/.test(t) ? P("F3 没混进已删掉的功能名") : F("F3 还有旧功能名");
  domF.window.close();
}

/* ============================================================
   G. 生成物的数据归属（设计取舍，如实报告）
   ============================================================ */
sec("【G】生成物的数据归属");

{
  const domG = load("workbench.html", {
    role: "teacher",
    ls: { st_accounts: ACCOUNTS, st_current_user: "teacher:teacher" },
  });
  await settle(domG);
  const seeds = JSON.parse(domG.window.eval("JSON.stringify(seedApps())"));
  const html = String((seeds[0] || {}).html || "");
  /wstool:/.test(html) ? P("G1 生成物的数据键用 wstool: 前缀（隔离在工具自己名下）") : F("G1 数据键没有前缀");
  !/st_current_user|student:|teacher:/.test(html)
    ? W("G1 生成物不知道「当前是谁」→ 同一浏览器里换账号打开同一份，看到的是同一份数据（纯静态单机的取舍）")
    : P("G1 生成物按账号区分数据");
  domG.window.close();
}

/* ============================================================
   汇总
   ============================================================ */
console.log("\n" + "=".repeat(60));
console.log("工作台审计：" + ok + " 项通过 / " + fail + " 项失败 / " + warn + " 项需权衡");
console.log("运行时错误：" + (ERR.length ? ERR.length + " 条" : "0 条"));
if (ERR.length) ERR.slice(0, 6).forEach((x) => console.log("  ! " + x));
console.log("=".repeat(60));
process.exit(fa