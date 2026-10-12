/**
 * 工作台闭环冒烟测试
 * ------------------------------------------------------------
 * 第 38 轮立、第 43 轮重写：**只测 AI 工作台 + 下发**（教学模拟与事务台已移除）。
 *
 * 用 jsdom **真解析真执行** workbench.html，把
 *   「说需求 → 生成（未接模型如实拒绝）→ 落库 → 打开 → 下发 → 学生收到 → 打开」
 * 这条闭环整条走一遍。
 *
 * 为什么单开一个脚本、不并进 dom-smoke.cjs：
 *   关键风险是**跨身份的数据流**（老师的桶 vs 学生的桶、下发给谁、谁收到了），
 *   这需要一个**能换身份重开页面 / 造多账号桶**的环境，
 *   与 dom-smoke 的「逐页结构检查」不是一类。
 *
 * 用法：node tools/sim-smoke.cjs
 * 退出码：0 全通过 / 1 有失败 / 2 环境不可用（缺 jsdom）
 * ------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const JSDOM_PATH = path.join(__dirname, ".deps", "node_modules", "jsdom");
let JSDOM;
try { ({ JSDOM } = require(JSDOM_PATH)); } catch (e) {
  console.log("跳过：未安装 jsdom。安装方法：");
  console.log("  cd tools && npm i --prefix .deps jsdom");
  process.exit(2);
}

const SITE = path.join(__dirname, "..", "docs");
const ok = [], bad = [];
const ck = (c, t) => (c ? ok : bad).push(t);

/** 把外链脚本内联后开一个指定身份的内容页。`extraLs` 可预置额外存档（测"跨桶 / 读回存档"用） */
function openPage(file, role, user, extraLs) {
  let html = fs.readFileSync(path.join(SITE, file), "utf8");
  html = html.replace(/<script src="assets\/([\w.]+)"><\/script>/g, (m, f) =>
    "<script>\n" + fs.readFileSync(path.join(SITE, "assets", f), "utf8") + "\n</script>");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://127.0.0.1:8123/" + file,
    pretendToBeVisual: true,
    beforeParse(w) {
      if (user) w.localStorage.setItem("st_current_user", user);
      w.document.cookie = "st_role=" + role + "; path=/";
      if (user) {   // 演示账号要能进「我是预置账号」分支，否则拿不到种子
        const acc = [{ role: role, user: user.split(":")[1], pass: "x", name: "测试" }];
        w.localStorage.setItem("st_accounts", JSON.stringify(acc));
      }
      if (extraLs) {
        Object.keys(extraLs).forEach(function (k) { w.localStorage.setItem(k, extraLs[k]); });
      }
    },
  });
  return dom;
}

function openWorkbench(role, user, extraLs) { return openPage("workbench.html", role, user, extraLs); }

const SIM_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
  "<p>" + "内容".repeat(300) + "</p></body></html>";

/** 等页面脚本把 DOM 渲染稳（jsdom 是异步的） */
const settle = (dom, ms) => new Promise((r) => setTimeout(r, ms || 90));

async function main() {
  /* ============================================================
     一、数据层：诚实口径与边界（不碰 DOM，最快也最关键）
     ============================================================ */
  const domD = openWorkbench("teacher", "teacher:teacher");
  const wD = domD.window;

  ["llmConfig", "llmReady", "llmStatusText", "wsSystemPrompt", "wsUserPrompt",
   "extractHtml", "validateSimHtml", "generateSimHtml",
   "createSim", "updateSim", "deleteSim", "simAssetCount",
   "sendSimTo", "simsForStudent", "appsOfKind", "simStoreKey", "normalizeSims", "simOf",
   "readSimBucket", "simBucketKeys", "simOfAnywhere", "simWriteTo", "seedApps"].forEach(function (f) {
    typeof wD[f] === "function" ? ok.push("数据层有 " + f + "()") : bad.push("缺函数 " + f + "()");
  });

  /* --- 🔴 已移除的两块不能再冒出来 --- */
  ["simSystemPrompt", "simUserPrompt", "SEED_SIM_TITRATION", "seedSims", "addSimFeedback",
   "recallSimFrom", "DESK_KEY", "deskSummary", "createDeskItem", "seedDesk"].forEach(function (f) {
    typeof wD[f] === "undefined" ? ok.push(f + " 已移除") : bad.push(f + " 还在（应该删掉）");
  });

  /* --- 🔴 演示模式绝不假装生成 --- */
  const g = await wD.generateSimHtml("一个跟踪作业提交的工作台", { kind: "workbench" });
  ck(g.ok === false, "无 Key 时 generateSimHtml 返回 ok:false");
  ck(g.demo === true, "无 Key 时标了 demo:true（页面据此解释原因）");
  ck(/演示模式|设置/.test(g.error), "无 Key 时给了可操作的下一步");
  ck(!g.html, "无 Key 时**没有**返回任何 HTML（不塞假货）");

  const g2 = await wD.generateSimHtml("");
  ck(g2.ok === false && /先说一句/.test(g2.error), "空目标被拒（如实说，不静默）");

  /* --- 提示词：工作台那套硬要求必须在 --- */
  const wsSys = wD.wsSystemPrompt("");
  ck(/工作台/.test(wsSys), "系统提示词是「工作台」那套");
  ck(/单文件 HTML/.test(wsSys), "提示词要求单文件 HTML");
  ck(/禁止任何外部请求/.test(wsSys), "提示词禁外部请求");
  ck(/localStorage/.test(wsSys) && /wstool:/.test(wsSys),
    "提示词要求自己存数据（localStorage + wstool: 前缀，刷新不丢）");
  ck(/新增|勾选/.test(wsSys) && /删除/.test(wsSys), "提示词要求可操作闭环（不是静态报表）");
  ck(/SVG/.test(wsSys) || /统计/.test(wsSys), "提示词要求带统计/图表");

  /* --- 校验：不合格的生成结果宁可拒绝 --- */
  const badExt = '<!DOCTYPE html><html><body><img src="https://cdn.example.com/x.png">' +
    "<p>" + "x".repeat(500) + "</p></body></html>";
  const v1 = wD.validateSimHtml(badExt);
  ck(v1.ok === false && /外部请求/.test(v1.error), "含 CDN 的 HTML 被拒（沙箱里加载不出来）");
  const badTrunc = '<!DOCTYPE html><html><body><p>' + "x".repeat(500) + "</p></body>";
  ck(wD.validateSimHtml(badTrunc).ok === false, "被截断的 HTML 被拒（结尾不完整）");
  ck(wD.validateSimHtml("<!DOCTYPE html><html><body>短</body></html>").ok === false,
    "过短的内容被拒（不像一个能用的工作台）");
  ck(wD.validateSimHtml("随便一段文字").ok === false, "非 HTML 被拒");
  ck(wD.validateSimHtml(SIM_HTML).ok === true, "合规 HTML 通过校验");

  /* --- 抽取：模型经常不听话 --- */
  const ex1 = wD.extractHtml("好的，代码如下：\n```html\n" + SIM_HTML + "\n```\n希望有帮助");
  ck(ex1.indexOf("<!DOCTYPE") === 0, "extractHtml 从 DOCTYPE 起截（去掉前言的废话）");
  ck(ex1.slice(-7).toLowerCase() === "</html>", "extractHtml 截到 </html>（去掉后记）");
  ck(wD.extractHtml("") === "", "空输入返回空串（不硬造）");

  /* --- 增删改 --- */
  const c1 = wD.createSim({ title: "作业跟踪", goal: "看谁交了", kind: "workbench", html: SIM_HTML, provider: "deepseek", model: "deepseek-chat" });
  ck(c1.ok === true && c1.sim.kind === "workbench", "createSim 成功且标了 kind");
  const id = c1.sim.id;
  ck(!wD.createSim({ title: "坏的", html: "不是 HTML" }).ok, "createSim 挡住不合规的 HTML（不落库）");
  ck(!wD.createSim({ title: "", goal: "", html: SIM_HTML }).ok, "没名字也没目标的被拒");
  ck(wD.updateSim(id, { title: "改过的名字" }).ok, "updateSim 能改名");
  ck(!wD.updateSim(id, { title: "  " }).ok, "空名字被拒");
  ck(!wD.updateSim("不存在", { title: "x" }).ok, "改不存在的返回 ok:false");

  /* --- 分拣：只按工作台取 --- */
  const wbOnly = JSON.parse(wD.eval("JSON.stringify(appsOfKind(SIMS, 'workbench'))"));
  ck(wbOnly.length >= 1 && wbOnly.every(function (s) { return s.kind === "workbench"; }),
    "appsOfKind(SIMS,'workbench') 只挑工作台（不混进别的）");

  /* --- 🔴 下发：重复发不重复记账 --- */
  const s1 = wD.sendSimTo(id, ["student:lisi"]);
  ck(s1.ok && s1.added === 1, "首次下发 added=1");
  const s2 = wD.sendSimTo(id, ["student:lisi"]);
  ck(s2.ok && s2.added === 0 && s2.updated === 1, "重复下发同一人只更新时间（不堆重复记录）");
  const s3 = wD.sendSimTo(id, ["student:lisi", "student:wangwu", "  "]);
  ck(s3.total === 2, "空身份被过滤掉，实际 total=" + s3.total);
  ck(!wD.sendSimTo(id, []).ok, "空名单被拒（不假装发出去了）");
  ck(!wD.sendSimTo(id, ["  "]).ok, "全是空白的名单被拒");

  /* --- 学生只看得到发给自己的 --- */
  ck(wD.simsForStudent("student:lisi").length === 1, "lisi 收到 1 个");
  ck(wD.simsForStudent("student:zhaoliu").length === 0, "没收到的人一个都看不到");
  ck(wD.simsForStudent("").length === 0, "没身份时什么也看不到（不泄露）");

  /* --- 删除前数影响 --- */
  ck(/已经发给|收到/.test(wD.simAssetCount(id)), "simAssetCount 说清了影响：" + wD.simAssetCount(id));
  ck(wD.deleteSim(id).ok, "deleteSim 成功");
  ck(wD.simOf(id) === null, "删除后取不到了");
  ck(!wD.deleteSim("不存在").ok, "删不存在的返回 ok:false");

  /* --- 种子：只有一个工作台种子，且真能用 --- */
  const seeds = JSON.parse(wD.eval("JSON.stringify(seedApps())"));
  ck(seeds.length === 1 && seeds[0].kind === "workbench", "种子只有工作台（共 " + seeds.length + " 个）");
  ck(/addEventListener/.test(seeds[0].html || ""), "种子工作台带真实交互（能勾、能加、能删）");
  ck(/localStorage/.test(seeds[0].html || ""), "种子工作台把数据存 localStorage（刷新不丢）");
  ck(Array.isArray(seeds[0].sentTo) && seeds[0].sentTo.length >= 1,
    "种子里带下发记录（切学生账号能看到「老师发来的」）");

  /* ============================================================
     一-B、第 42 轮：下发要**真跨账号桶**才生效
     ------------------------------------------------------------
     第 38 轮的 simsForStudent 只查自己的桶 → 老师在 A 桶发、学生在 B 桶读，
     根本看不到（当时靠"种子里就带下发记录"糊过去）。这里在**同一个 jsdom 实例**里
     手动造两个账号的桶来验：跨桶读、以及"没发给的人看不到"。
     ============================================================ */
  wD.localStorage.setItem("st_accounts", JSON.stringify([
    { role: "teacher", user: "teacher", pass: "x", name: "老师" },
    { role: "student", user: "lisi", pass: "x", name: "李思" },
  ]));
  const crossRec = {
    id: "app-cross-1", title: "跨桶测试", goal: "验证下发是否真的跨桶",
    subject: "", kind: "workbench", html: SIM_HTML, status: "ready",
    provider: "deepseek", model: "deepseek-chat", createdBy: "teacher:teacher",
    createdAt: Date.now(), sentTo: [{ who: "student:lisi", at: Date.now() }], feedback: [],
  };
  /* ⚠️ 用**双重编码**写入 —— 这才是真存档的样子 */
  wD.localStorage.setItem("st_sim:student:lisi", JSON.stringify(JSON.stringify([crossRec])));

  ck(wD.simBucketKeys().indexOf("st_sim:student:lisi") >= 0,
    "simBucketKeys 由 st_accounts 推出了学生桶（不靠枚举 localStorage 键）");
  ck(!wD.simOf("app-cross-1"), "simOf 只认本桶（跨桶记录取不到 —— 所以才需要 simOfAnywhere）");
  ck(!!wD.readSimBucket("st_sim:student:lisi"),
    "🔴 readSimBucket 读得懂真存档（双重编码）—— 单层 parse 会读成字符串而全丢");
  ck(wD.simsForStudent("student:lisi").some(function (s) { return s.id === "app-cross-1"; }),
    "🔴 跨桶读取：记录不在本桶、在学生的桶里 → 仍能读到（第 42 轮修的）");
  const anyRec = wD.simOfAnywhere("app-cross-1");
  ck(!!anyRec && anyRec.title === "跨桶测试", "simOfAnywhere 能跨桶找到记录（学生才打得开）");
  ck(wD.simsForStudent("student:wangwu").every(function (s) { return s.id !== "app-cross-1"; }),
    "没发给的人仍然看不到（跨桶不等于全放行）");
  ck(!wD.simOf("app-cross-1"), "跨桶读**不会**把别人的记录复制进我的桶（不污染本桶）");
  wD.localStorage.removeItem("st_sim:student:lisi");

  /* ============================================================
     一-C、存档要能读回（第 42 轮修掉的根因）
     ------------------------------------------------------------
     `loadSims()` 在 nav.js **顶层**跑，而 `LS` 定义在 `core.js`（后加载）→ TDZ 抛错被 catch 吞掉
     → 存档永远读不回来、每次打开都回到种子（第 38 轮起就这么坏着）。
     ============================================================ */
  const savedTool = {
    id: "app-saved-1", title: "我存过的工作台", goal: "验证存档能不能读回",
    kind: "workbench", html: SIM_HTML, status: "ready",
    provider: "deepseek", model: "m", createdBy: "teacher:teacher",
    createdAt: Date.now(), sentTo: [], feedback: [],
  };
  const domSaved = openWorkbench("teacher", "teacher:teacher", {
    "st_sim:teacher:teacher": JSON.stringify(JSON.stringify([savedTool])),   // 老档的双重编码
  });
  await settle(domSaved, 300);
  const simsSaved = JSON.parse(domSaved.window.eval("JSON.stringify(SIMS || [])"));
  ck(simsSaved.length === 1 && simsSaved[0].title === "我存过的工作台",
    "🔴 重新打开读回了存档（不是回到种子）—— 第 42 轮修的 TDZ 根因，实际=" +
    (simsSaved.map(function (s) { return s.title; }).join("/") || "(空)"));
  domSaved.window.close();

  const domSaved2 = openWorkbench("teacher", "teacher:teacher", {
    "st_sim:teacher:teacher": JSON.stringify([savedTool]),                   // 新写法（单层）
  });
  await settle(domSaved2, 300);
  const simsSaved2 = JSON.parse(domSaved2.window.eval("JSON.stringify(SIMS || [])"));
  ck(simsSaved2.length === 1 && simsSaved2[0].title === "我存过的工作台",
    "单层编码的存档也读得回（readSimBucket 两种编码都认）");
  domSaved2.window.close();

  /* ============================================================
     一-D、第 44 轮：出题与组卷 —— 「没采纳不发」+ 跨桶发布
     ============================================================ */
  const ce = JSON.parse(wD.eval('JSON.stringify(createExam({ title:"验证器卷", courseId:"ds", courseName:"数据结构与算法", questions:[{ text:"题干一", state:"pending" }], source:"ai" }))'));
  ck(ce.ok === true, "createExam 建卷成功（source=ai）");
  const eid = ce.exam.id;

  const pubNoAcc = JSON.parse(wD.eval('JSON.stringify(publishExam("' + eid + '", ["student:lisi"]))'));
  ck(pubNoAcc.ok === false && /采纳/.test(String(pubNoAcc.error || "")),
    "🔴 一道题都没采纳 → 拒绝发布（空卷发出去是事故）");

  wD.eval('setQuestionState("' + eid + '", 0, "accepted")');
  ck(wD.eval('examStats(examOf("' + eid + '")).accepted') === 1, "采纳落库，统计跟着变");

  const pub1 = JSON.parse(wD.eval('JSON.stringify(publishExam("' + eid + '", ["student:lisi"]))'));
  ck(pub1.ok === true && pub1.added === 1, "采纳之后能发布");
  const pub2 = JSON.parse(wD.eval('JSON.stringify(publishExam("' + eid + '", ["student:lisi"]))'));
  ck(pub2.added === 0 && pub2.updated === 1, "重复发布同一人只更新时间（不堆重复记录）");
  const pub3 = JSON.parse(wD.eval('JSON.stringify(publishExam("' + eid + '", []))'));
  ck(pub3.ok === false, "空名单被拒（不假装发出去了）");

  ck(wD.eval('examsForStudent("student:lisi").length') >= 1, "lisi 读到了发给他的卷子");
  ck(wD.eval('examsForStudent("student:wangwu").length') === 0, "没发给的人读不到");
  ck(wD.eval('examCountOf("student:lisi")') >= 1, "examCountOf 给出份数（菜单徽标）");

  /* 撤回：没发过的如实报错；全撤回 → 退回草稿 */
  const rec1 = JSON.parse(wD.eval('JSON.stringify(recallExamFrom("' + eid + '", "student:lisi"))'));
  ck(rec1.ok === true, "能撤回已发布的");
  const rec2 = JSON.parse(wD.eval('JSON.stringify(recallExamFrom("' + eid + '", "student:lisi"))'));
  ck(rec2.ok === false, "重复撤回如实报错");
  ck(wD.eval('examOf("' + eid + '").status') === "draft", "全部撤回后退回草稿");

  /* 🔴 splitPoints：大纲里的知识点是**顿号分隔的字符串**（直接 .slice() 会崩） */
  const pts = JSON.parse(wD.eval('JSON.stringify(splitPoints("图的存储结构、DFS/BFS、最短路径"))'));
  ck(Array.isArray(pts) && pts.length === 3, "splitPoints 把章节知识点字符串切成数组");

  /* 🔴 题型：选择 / 填空 / 多选 —— 提示词要说明白，答案形状要归一 */
  const upText = String(wD.eval('examUserPrompt({ courseName:"数据结构与算法", chapters:[{ title:"第 6 章 · 图", points:["DFS"] }] }, { count:3, types:["single","multi","blank"] })'));
  ck(/只出这几种/.test(upText) && /填空/.test(upText) && /ABD/.test(upText),
    "出题提示词把题型要求写清楚了（含多选答案写法）");
  ck(wD.eval('normalizeAnswerLetters("dba")') === "ABD", "多选答案归一（dba → ABD）");
  const nb = JSON.parse(wD.eval('JSON.stringify(normalizeExamQuestion({ type:"blank", text:"共 ___ 与 ___", answer:"甲||乙" }))'));
  ck(nb.blanks.length === 2 && nb.options.length === 0, "填空题归一成两个空，且不留选项");

  /* 未接模型时出题如实拒绝（异步） */
  const ge = await wD.generateExamQuestions({ courseName: "数据结构与算法", chapters: [{ title: "第 6 章 · 图", points: ["DFS"] }] }, { count: 3, difficulty: "mid" });
  ck(ge.ok === false && ge.demo === true, "无 Key 时出题如实拒绝（demo:true）");
  ck(!ge.questions, "无 Key 时**不返回任何题**（不编）");

  /* ============================================================
     一-E、第 44 轮：老师发卷 → 学生端跨桶收到（页面级）
     ============================================================ */
  const pubRec = {
    id: "exam-cross-1", title: "跨桶测验", courseId: "ds", courseName: "数据结构与算法",
    chapters: [{ id: "ds-c6", title: "第 6 章 · 图" }],
    config: { count: 1, difficulty: "mid" },
    questions: [
      { id: "q1", type: "single", diff: "mid", point: "图的遍历", text: "下面哪个是 DFS 的性质？",
        options: ["A 用队列", "B 用栈"], answer: "B", key: "DFS 用栈（或递归）", state: "accepted", warn: "" },
      { id: "q2", type: "multi", diff: "mid", point: "排序算法的稳定性", text: "下面哪些排序算法是稳定的？",
        options: ["A 冒泡排序", "B 快速排序", "C 归并排序", "D 直接插入排序"], answer: "acd",
        key: "稳定＝相等元素的相对次序不变", state: "accepted", warn: "" },
      { id: "q3", type: "blank", diff: "mid", point: "图的存储结构", text: "邻接矩阵需要 ___ 个单元，邻接表需要 ___ 个结点。",
        answer: "n²||2e", key: "一个与顶点数有关，一个与边数有关", state: "accepted", warn: "" },
    ],
    paper: { totalScore: 100, duration: 90 },
    status: "published", source: "ai", createdBy: "teacher:teacher",
    createdAt: Date.now(), updatedAt: Date.now(), publishedAt: Date.now(),
    publishedTo: [{ who: "student:student", at: Date.now() }],
  };
  const domHW = openPage("homework.html", "student", "student:student", {
    st_accounts: JSON.stringify([
      { role: "teacher", user: "teacher", pass: "x", name: "老师" },
      { role: "student", user: "student", pass: "x", name: "学生" },
    ]),
    // 🔴 卷子存在**老师的桶**里，学生自己的桶里没有 —— 必须跨桶才读得到
    "st_exam:teacher:teacher": JSON.stringify(JSON.stringify([pubRec])),
  });
  await settle(domHW, 300);
  const wHW = domHW.window, dHW = wHW.document;
  const hwText = dHW.getElementById("hwList").textContent;
  ck(/跨桶测验/.test(hwText), "🔴 学生端跨桶读到了老师发的卷子（记录在老师的桶里）");
  ck(/100 分/.test(hwText) && /90 分钟/.test(hwText), "卡片显示了总分与时长（来自数据，不是写死的）");
  ck(wHW.eval('examsForStudent("student:student").length') === 1, "数据层同一条路径也读得到");

  /* 点开看题：有题干选项，**没有参考答案** */
  dHW.querySelector('#hwList [data-act="open"]').click();
  await settle(domHW);
  const mHW = dHW.getElementById("modalHost");
  ck(mHW && mHW.hidden === false, "点「开始作答」开出作答弹窗");
  const mText = mHW ? mHW.textContent : "";
  ck(/DFS 的性质/.test(mText), "弹窗里有题干");
  ck(/A[\s\u3000]+用队列/.test(mText), "弹窗里有选项（含选项字母）");
  ck(/\[单选\]/.test(mText) && /\[多选\]/.test(mText) && /\[填空\]/.test(mText),
    "🔴 学生拿到的卷里三种题型都在（选择 / 多选 / 填空）");
  ck(/共 2 个空/.test(mText), "填空题标出「共 2 个空」（学生知道有几个空要填）");
  ck(mText.indexOf("DFS 用栈") < 0, "🔴 学生端**看不到参考答案与解析**（只在老师端）");
  ck(mText.indexOf("答全才给分") < 0, "批改口径（答全才给分）不给学生看");

  /* ---- 第 48 轮：在线作答 → 提交 → 记录落在**学生自己的桶** ---- */
  const ansBefore = wHW.eval("myExamAns().length");
  ck(ansBefore >= 1, "预置学生有预置示例提交（与预置行为日志同一个口径）");

  const subOK = JSON.parse(wHW.eval(
    'JSON.stringify(submitExamAnswer(examOfAnywhere("exam-cross-1"), {q1:"B", q2:["A","C","D"], q3:["n²","2e"]}))'));
  ck(subOK.ok === true, "学生提交成功");
  ck(subOK.grade.objectiveGot === subOK.grade.objectiveTotal,
    "全对 → 客观题满分（" + subOK.grade.objectiveGot + "/" + subOK.grade.objectiveTotal + "）");
  ck(wHW.eval("myExamAns().length") === ansBefore + 1, "提交后多了一条");
  ck(wHW.eval('myExamAnsOf("exam-cross-1")') !== null, "能按 examId 取回这次的提交");

  const subBad = JSON.parse(wHW.eval(
    'JSON.stringify(submitExamAnswer(examOfAnywhere("exam-cross-1"), {q1:"A", q2:["A","C"], q3:["n²","2e"]}))'));
  ck(subBad.record.attempts === 2, "同一份卷**重新提交** → attempts 累加到 2");
  ck(wHW.eval("myExamAns().length") === ansBefore + 1, "重新提交是**覆盖**，不新增记录");
  ck(subBad.grade.objectiveGot < subBad.grade.objectiveTotal,
    "🔴 单选答错 / 多选少选 → 客观题扣分（" + subBad.grade.objectiveGot + "/" + subBad.grade.objectiveTotal + "）");

  const ansRaw = wHW.eval('localStorage.getItem("st_exam_ans:student:student")');
  ck(!!ansRaw, "🔴 提交**真的写进了学生桶** st_exam_ans:student:student");
  domHW.window.close();

  /* ---- 老师端「学生管理」：把学生桶带过去，看跨桶读不读得到 ---- */
  const domSTU = openPage("stu.html", "teacher", "teacher:teacher", {
    st_accounts: JSON.stringify([
      { role: "teacher", user: "teacher", pass: "x", name: "老师" },
      { role: "student", user: "student", pass: "x", name: "学生" },
    ]),
    "st_exam:teacher:teacher": JSON.stringify(JSON.stringify([pubRec])),
    "st_exam_ans:student:student": ansRaw,
    "st_behavior:student:student": JSON.stringify([
      { kind: "ask", label: "DFS 的性质", topic: "图", courseId: "ds", at: Date.now() - 86400000 },
      { kind: "read", label: "第 6 章 · 图", topic: "图", courseId: "ds", at: Date.now() },
    ]),
  });
  await settle(domSTU, 300);
  const dSTU = domSTU.window.document;
  const stuText = dSTU.getElementById("stuRows").textContent;
  ck(/学生/.test(stuText), "学生管理页列出本机学生（以人为中心）");
  ck(dSTU.getElementById("stTotal").textContent === "1", "总览：本机学生 1 人");
  ck(/1\/1/.test(stuText), "🔴 作业列显示 已交/应交 = 1/1（**跨桶**读到了学生的提交）");
  ck(dSTU.querySelectorAll("#stuRows .act-days i.on").length >= 1,
    "🔴 近 7 天活跃格子有填充（读的是学生自己的行为桶）");
  ck(!!dSTU.querySelector('#stuRows [data-open="student:student"]'), "姓名是可点开的入口");

  /* 点开单人 → 跨课档案（作业明细 + 学习概况） */
  dSTU.querySelector('#stuRows [data-open="student:student"]').click();
  await settle(domSTU);
  const mSTU = dSTU.getElementById("modalHost");
  ck(mSTU && mSTU.hidden === false, "点姓名开出学生详情弹窗");
  const stuModal = mSTU ? mSTU.textContent : "";
  ck(/作业情况/.test(stuModal) && /已交/.test(stuModal), "详情里有作业明细（已交/未交）");
  ck(/学习概况/.test(stuModal), "详情里有跨课合并的学习概况");
  ck(stuModal.indexOf("课堂考勤") >= 0 || stuModal.indexOf("学习活跃") >= 0,
    "🔴 详情里如实说明「学习活跃」口径");
  domSTU.window.close();

  /* ============================================================
     一-F、第 47 轮：课件数据层 —— 「草稿不发」+ 跨桶发布
     ============================================================ */
  const ccw = JSON.parse(wD.eval('JSON.stringify(createCw({ title:"图的最短路径", courseId:"ds", courseName:"数据结构与算法", body:"Dijkstra 处理非负权。\\n\\nBellman-Ford 能处理负权边。", source:"write" }))'));
  ck(ccw.ok === true, "createCw 建课件成功");
  const ccid = ccw.cw.id;
  ck(wD.eval('cwSections(cwOf("' + ccid + '")).length') === 2, "🔴 cwSections 按空行切成 2 段");
  ck(wD.eval('cwTextFromHtml("<script>alert(1)</script><p>正文</p>").indexOf("alert")') < 0,
    "🔴 cwTextFromHtml 剥掉 script（上传是不可信输入）");

  const cpub0 = JSON.parse(wD.eval('JSON.stringify(publishCw("' + ccid + '", []))'));
  ck(cpub0.ok === false, "空名单拒绝发布");
  const cpub = JSON.parse(wD.eval('JSON.stringify(publishCw("' + ccid + '", ["student:lisi"]))'));
  ck(cpub.ok === true && cpub.added === 1, "发布给 lisi");
  const cpub2 = JSON.parse(wD.eval('JSON.stringify(publishCw("' + ccid + '", ["student:lisi"]))'));
  ck(cpub2.added === 0 && cpub2.updated === 1, "重复发布同一人只更新时间（不堆重复记录）");
  ck(wD.eval('cwsForStudent("student:lisi").some(function(c){return c.id==="' + ccid + '";})') === true,
    "🔴 学生读到老师发的课件");
  ck(wD.eval('cwsForStudent("student:wangwu").some(function(c){return c.id==="' + ccid + '";})') === false,
    "没发给的人读不到");

  // 草稿不发学生
  wD.eval('createCw({ title:"草稿课件", body:"x" })');
  ck(wD.eval('CWS.some(function(c){return c.title==="草稿课件" && c.status==="draft";})') === true,
    "新建的是草稿（status=draft）");
  ck(wD.eval('cwsForStudent("student:lisi").some(function(c){return c.title==="草稿课件";})') === false,
    "🔴 草稿不给学生读");

  // notesOfCw：老记录（无 cwId）算当前这份，别人的排除
  ck(wD.eval('notesOfCw([{kind:"note",label:"老",seg:1,courseId:"ds",at:1,cwId:""},{kind:"note",label:"别",seg:2,courseId:"ds",at:2,cwId:"other"}],"cw-a","ds").length') === 1,
    "🔴 notesOfCw：无 cwId 的老记录算当前这份，别人的排除");

  /* ============================================================
     一-G、第 47 轮：老师发课件 → 学生端跨桶收到（页面级）
     ============================================================ */
  const cwRec = {
    id: "cw-cross-1", title: "跨桶课件", courseId: "ds", courseName: "数据结构与算法",
    chapters: [{ id: "ds-c7", title: "第 7 章 · 排序" }],
    body: "第一段正文。\n\n第二段正文。",
    source: "write", status: "published", createdBy: "teacher:teacher",
    publishedTo: [{ who: "student:student", at: Date.now() }],
  };
  const domR = openPage("reader.html", "student", "student:student", {
    st_accounts: JSON.stringify([
      { role: "teacher", user: "teacher", pass: "x", name: "老师" },
      { role: "student", user: "student", pass: "x", name: "学生" },
    ]),
    // 🔴 课件存在**老师的桶**里，学生自己的桶里没有 —— 必须跨桶才读得到（老档双重编码）
    "st_courseware:teacher:teacher": JSON.stringify(JSON.stringify([cwRec])),
  });
  await settle(domR, 300);
  const wR = domR.window, dR = wR.document;
  ck(dR.querySelectorAll("#cwSwitch button").length === 0,
    "🔴 只有 1 份课件时不显示课件切换条（#cwSwitch 隐藏）");
  ck(/跨桶课件/.test(dR.getElementById("paperTitle").textContent),
    "🔴 学生端跨桶读到了老师发的课件（记录在老师的桶里，且是老师发的不是预置示例）");
  ck(/老师发布/.test(dR.getElementById("paperMeta").textContent),
    "🔴 标出「老师发布」（预置示例已按用户要求彻底移除）");
  ck(!/预置示例/.test(dR.getElementById("paperMeta").textContent),
    "🔴 不再出现「预置示例」标记");
  ck(dR.querySelectorAll("#paperBody .annot").length === 2, "段落按 cwSections 渲染（2 段）");
  ck(wR.eval('cwsForStudent("student:student").length') === 1, "数据层同一条路径读得到 1 份（无预置种子）");
  ck(wR.eval('cwsForStudent("student:student","ds").length') === 1, "🔴 按课程过滤读得到（courseId=ds）");
  ck(wR.eval('cwsForStudent("student:student","xx").length') === 0, "🔴 按别的课程过滤读不到");
  domR.window.close();

  /* ============================================================
     一-H、实训学生侧：跨桶读 → 发起 → 直接开启 → 老师也能看到
     ------------------------------------------------------------
     实训的 open/done 活动是**公开可参与**（不像卷子按下发名单），
     「老师没发布（draft）」学生读不到；「学生发起的」**直接 open**，不等老师确认。
     这里走一遍：学生跨桶读到老师发的 → 自己发起（直接 open）→ 同步给老师 → 老师也能看到。
     ============================================================ */
  const tAct = {
    id: "act-t1", title: "勾股定理怎么发现的", goal: "勾股定理是怎么被发现的", courseId: "ds",
    origin: "teacher", createdBy: "", status: "open", openEnded: true,
    skeleton: { source: "path", pathId: "pythagoras", pathTitle: "勾股定理", era: "", goal: "勾股定理", stages: [
      { id: "s1", title: "先量", prompt: "往哪想", clue: "线索", tryIt: "动手" },
      { id: "s2", title: "再拼", prompt: "往哪想2", clue: "线索2", tryIt: "动手2" },
    ] },
    participants: [], findings: [], createdAt: 1, updatedAt: 1,
  };
  const domSt = openPage("training-student.html", "student", "student:student", {
    st_accounts: JSON.stringify([
      { role: "teacher", user: "teacher", pass: "x", name: "李老师" },
      { role: "student", user: "student", pass: "x", name: "李同学" },
    ]),
    // 老师发的活动在老师桶里（老档双重编码）
    "st_activities:teacher:teacher": JSON.stringify(JSON.stringify([tAct])),
  });
  await settle(domSt, 300);
  const wS = domSt.window;

  ck(wS.eval('activitiesForStudent("student:student").some(function(a){return a.id==="act-t1";})') === true,
    "实训：学生跨桶读到老师发布的 open 活动（记录在老师桶）");
  // 老师桶里塞一条未发布的 draft —— 学生不该读到（直接在 Node 侧写 jsdom 的 localStorage，避免 eval 拼串）
  wS.localStorage.setItem("st_activities:teacher:teacher", JSON.stringify(JSON.stringify([
    tAct,
    { id: "act-d1", title: "未发布", origin: "teacher", status: "draft", openEnded: true,
      skeleton: { source: "generic", stages: [{ title: "t", prompt: "p", tryIt: "x" }] },
      participants: [], findings: [], createdAt: 1, updatedAt: 2 },
  ])));
  ck(wS.eval('activitiesForStudent("student:student").some(function(a){return a.id==="act-d1";})') === false,
    "实训：老师的草稿学生读不到（没发布就不见）");

  // 学生发起 → 直接 open → 落学生桶 + 同步教师桶
  const csa = JSON.parse(wS.eval('JSON.stringify(createStudentActivity({ goal: "排序算法为什么有这么多", courseId: "ds" }))'));
  ck(csa.ok === true && csa.activity.origin === "student" && csa.activity.status === "open",
    "实训：学生发起直接开启（origin=student、status=open，不等老师确认）");
  ck(csa.activity.createdBy === "student:student", "实训：发起人记成自己");
  ck(wS.eval('(localStorage.getItem("st_activities:student:student") || "").indexOf("排序算法")') >= 0,
    "实训：学生发起的落学生自己的桶");
  ck(wS.eval('(localStorage.getItem("st_activities:teacher:teacher") || "").indexOf("排序算法")') >= 0,
    "实训：学生发起的同步到本机教师桶");

  // 进度 / 路线 / 新发现
  ck(wS.eval('markStageDone("act-t1", "s1", false).ok') === true, "实训：学生能推进进度");
  ck(wS.eval('myProgressOf("act-t1").currentStage') === "s1", "实训：进度读得回");
  ck(wS.eval('addRouteNote("act-t1", "我把它拼成了长方形").ok') === true, "实训：能记路线笔记");
  const tF = JSON.parse(wS.eval('JSON.stringify(addMyFinding("act-t1", "我试了割补法", "李同学"))'));
  ck(tF.ok === true, "实训：能标记新发现");
  ck(wS.eval('(localStorage.getItem("st_activities:teacher:teacher") || "").indexOf("割补法")') >= 0,
    "实训：新发现写回了老师桶（老师看得到）");

  // 老师登录本机 → 也能看到学生发起的活动（已经是进行中，无需确认）
  const domT2 = openPage("training.html", "teacher", "teacher:teacher", {
    st_accounts: JSON.stringify([
      { role: "teacher", user: "teacher", pass: "x", name: "李老师" },
      { role: "student", user: "student", pass: "x", name: "李同学" },
    ]),
    "st_activities:teacher:teacher": wS.eval('localStorage.getItem("st_activities:teacher:teacher")'),
  });
  await settle(domT2, 300);
  const wT2 = domT2.window;
  ck(wT2.eval('ACTIVITIES.some(function(a){return a.origin==="student" && a.status==="open" && /排序算法/.test(a.title);})') === true,
    "实训：老师登录本机也能看到学生发起的活动（直接开启，无需确认）");
  ck(wT2.eval('pendingStudentActivities()') === 0, "实训：不再有待确认的学生发起活动（恒 0）");

  // 学生重新打开 → 自己发起的直接就是「进行中」
  const domS2 = openPage("training-student.html", "student", "student:student", {
    st_accounts: JSON.stringify([
      { role: "teacher", user: "teacher", pass: "x", name: "李老师" },
      { role: "student", user: "student", pass: "x", name: "李同学" },
    ]),
    "st_activities:teacher:teacher": wT2.eval('localStorage.getItem("st_activities:teacher:teacher")'),
  });
  await settle(domS2, 300);
  ck(domS2.window.eval('activitiesForStudent("student:student").some(function(a){return a.origin==="student" && a.createdBy==="student:student" && a.status==="open";})') === true,
    "实训：学生发起的直接就是「进行中」（无需老师确认）");
  domS2.window.close();
  domSt.window.close();

  /* ============================================================
     二、教师端页面：生成入口 / 列表 / 打开（同源沙箱）/ 下发
     ============================================================ */
  const domT = openWorkbench("teacher", "teacher:teacher");
  const wT = domT.window, dT = wT.document;
  await settle(domT, 300);

  ck(!!dT.querySelector("#appGrid"), "教师端渲染出工作台列表");
  ck(!!dT.querySelector("#appMake"), "教师端有生成入口");
  ck(!!dT.getElementById("appAsk"), "有需求输入框");
  ck(!dT.getElementById("tabDesk") && !dT.getElementById("tabTools"),
    "🔴 只剩 AI 工作台（事务台 / 教学模拟的视图已移除）");

  const gridT = dT.querySelector("#appGrid");
  const cardsT = gridT.querySelectorAll(".sm-card");
  ck(cardsT.length >= 1, "演示账号有种子工作台（" + cardsT.length + " 张）");
  ck(!!gridT.querySelector('[data-a="app-open"]'), "卡片上有「打开」");
  ck(!!gridT.querySelector('[data-a="app-send"]'), "卡片上有「下发给学生」");
  ck(!!gridT.querySelector('[data-a="app-del"]'), "卡片上有「删除」");

  // 演示模式点生成 → 如实说，不假装
  dT.getElementById("appAsk").value = "做个工作台：跟踪全班作业提交情况";
  dT.querySelector("#appMake").click();
  await settle(domT);
  const prog = dT.querySelector("#appProgress");
  ck(prog && prog.hidden === false, "点生成后进度区出现（不让人对着空白）");
  ck(/不会真去写代码|演示模式|设置/.test(prog.textContent), "如实说明不会真生成");
  ck(gridT.querySelectorAll(".sm-card").length === cardsT.length, "🔴 生成失败不往列表塞假卡片");

  /* --- 打开：沙箱 iframe，工作台给同源（要存数据） --- */
  gridT.querySelector('[data-a="app-open"]').click();
  await settle(domT);
  const frame = dT.querySelector("iframe.sm-frame");
  ck(!!frame, "打开后弹窗里有 iframe");
  ck(frame.getAttribute("sandbox") === "allow-scripts allow-same-origin",
    "🔴 工作台沙箱给同源（要 localStorage 存数据），实际=" + frame.getAttribute("sandbox"));
  ck((frame.getAttribute("srcdoc") || "").indexOf("<!DOCTYPE") === 0, "iframe 载入的是生成内容");
  ck(!!dT.querySelector('.modal [data-app-act="send"]'), "弹窗里有「下发给学生」");
  dT.querySelector('.modal [data-app-act="close"]').click();
  await settle(domT);

  /* --- 下发名单：没有在课学生时如实说 --- */
  gridT.querySelector('[data-a="app-send"]').click();
  await settle(domT);
  const sendHost = dT.getElementById("modalHost");
  ck(sendHost && sendHost.hidden === false, "点「下发给学生」开出名单弹窗");
  ck(/还没有学生加入|发给谁/.test(sendHost ? sendHost.textContent : ""),
    "名单弹窗要么给选人、要么如实说没学生（不假装）");
  const sClose = sendHost.querySelector('[data-mc="no"]') || sendHost.querySelector('[data-mc="ok"]');
  if (sClose) { sClose.click(); await settle(domT); }

  /* ============================================================
     三、学生端页面：也能自己造 + 看「老师发来的」
     ============================================================ */
  const domS = openWorkbench("student", "student:student");
  await settle(domS, 300);
  const dS = domS.window.document;
  ck(!!dS.querySelector("#appGrid"), "学生端渲染出工作台列表");
  ck(!!dS.getElementById("appMake"), "🔴 学生端也能自己造工作台（生成入口对两端开放）");
  ck(/老师发来的/.test(dS.querySelector("#appGrid").textContent), "学生端分区显示「老师发来的」");

  const gridS = dS.querySelector("#appGrid");
  const cardsS = gridS.querySelectorAll(".sm-card");
  ck(cardsS.length >= 1, "学生端看到「老师发来的工作台」（种子已转发），实际=" + cardsS.length);
  ck(!gridS.querySelector('[data-a="app-send"]'), "🔴 学生端没有「下发给学生」（那是教师的动作）");
  ck(!gridS.querySelector('[data-a="app-del"]'), "🔴 学生端没有「删除」（不是他的东西）");

  // 打开老师发来的那份：记录不在学生桶里 → 必须走跨桶取数
  gridS.querySelector('[data-a="app-open"]').click();
  await settle(domS);
  const frS = dS.querySelector("iframe.sm-frame");
  ck(!!frS, "学生端能打开老师发来的工作台（跨桶取数没挡住）");
  ck(!!frS && frS.getAttribute("sandbox").indexOf("allow-same-origin") >= 0,
    "🔴 学生端打开的工作台同样是同源沙箱（它要存自己的数据）");
  ck(!dS.querySelector('.modal [data-app-act="send"]'), "🔴 学生端的工作台弹窗里也没有下发按钮");
  const cS = dS.querySelector('.modal [data-app-act="close"]');
  if (cS) { cS.click(); await settle(domS); }

  console.log("\n=== 工作台闭环：" + ok.length + " 通过 / " + bad.length + " 失败 ===");
  if (bad.length) { console.log("\n失败项："); bad.forEach(function (t) { console.log("  ✗ " + t); }); }
  process.exit(bad.length ? 1 : 0);
}

main().catch(function (e) { console.error("脚本异常：", e); process.exit(1); });
