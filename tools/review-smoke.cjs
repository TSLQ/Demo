/**
 * 模型链路冒烟（jsdom + 打桩 fetch）
 * ------------------------------------------------------------
 * 验的是**只有接上模型才会走的那条路**：技能 → aiRunner → llmChat → 归一化 → 结果卡。
 *
 * 为什么单开一步：
 *   这条路坏掉时，页面**不会报错** —— 它只是悄悄退回「只有规则检查」的那半张卡，
 *   看起来一切正常。靠人眼看、靠桩化 DOM 都发现不了，必须拿一个假的模型返回跑一遍。
 *
 * 不发真请求：fetch 被替换成返回固定 JSON 的假实现，所以不需要网络、不需要真 Key。
 *
 * 用法：node tools/review-smoke.cjs
 * 退出码：0 全通过 / 1 有失败（缺 jsdom 时跳过，退出码 0）
 * ------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const JSDOM_PATH = path.join(__dirname, ".deps", "node_modules", "jsdom");
let JSDOM;
try {
  ({ JSDOM } = require(JSDOM_PATH));
} catch (e) {
  console.log("跳过：未安装 jsdom。安装方法：");
  console.log("  cd tools/.deps && npm install jsdom");
  process.exit(0);
}

const SITE = path.resolve(__dirname, "..", "docs");

let fail = 0, ok = 0;
const P = (m) => { ok++; console.log("  v " + m); };
const F = (m) => { fail++; console.log("  x " + m); };

function inlineAssets(root, file) {
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

/* 一份结构完整的教案（六个小节都在，时长加总也对），给评分当输入 */
const LESSON_MD = [
  "# 7.2 快速排序",
  "课程：数据结构与算法　课时长度：45 分钟",
  "",
  "## 教学目标",
  "能独立写出快排的划分过程，并说明平均复杂度为什么是 O(n log n)",
  "",
  "## 教学重点", "- 划分过程的指针移动", "",
  "## 教学难点", "为什么最坏会退化成 O(n^2)", "",
  "## 课堂流程",
  "- 导入（5 分钟）：给一组乱序数，问学生「你会怎么排」",
  "- 讲解（20 分钟）：先示范一次划分，再让学生跟上",
  "- 练习（15 分钟）：手写划分过程",
  "- 小结（5 分钟）：对比归并排序",
  "",
  "## 作业布置", "完成课后 3 题，并给出一次划分的完整过程", "",
  "## 学情提示", "上次递归部分错得多，这里要放慢",
].join("\n");

/* 假模型的返回：故意让两项不是满分，好验「合计」和「最该改」真的按分算 */
const CANNED = JSON.stringify({
  items: [
    { id: "G0", score: 2, why: "六节齐全，每节都有实质内容" },
    { id: "G1", score: 2, why: "目标是可观察的「写出划分过程」" },
    { id: "G2", score: 1, why: "20 分钟讲划分偏紧" },
    { id: "G3", score: 2, why: "有示范，也点了常见错误" },
    { id: "G4", score: 2, why: "练习给了判分要点" },
    { id: "G5", score: 1, why: "复杂度表述正确但没给推导" },
  ],
  top_fix: "把讲解压到 15 分钟，留 5 分钟给学生复述划分过程",
});

(async () => {
  const errors = [];
  const dom = new JSDOM(inlineAssets(SITE, "agent.html"), {
    url: "http://localhost/agent.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {
      win.addEventListener("error", (e) => errors.push(e.message));
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      if (win.Element && !win.Element.prototype.scrollIntoView) win.Element.prototype.scrollIntoView = function () {};
      win.document.cookie = "st_role=teacher; path=/";
      // 造出「已接模型」的前提：服务商 + Key 都在存档里（值本身是假的，请求被下面的 fetch 截住）
      win.localStorage.setItem("st_provider", "deepseek");
      win.localStorage.setItem("st_api_key", "sk-test-not-real");
      win.fetch = function () {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: CANNED } }] }),
          text: () => Promise.resolve(""),
        });
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => setTimeout(r, 400));

  w.llmReady() === true
    ? P("前提成立：存档里有服务商与 Key，模型路径会被走通")
    : F("llmReady() 不为 true —— 这条冒烟的前提没建立起来");

  const before = w.document.querySelector("#chatLog").textContent;
  // 模拟「结果卡上点 AI 评分」：直接以技能 + 正文强制路由（与页面按钮同一条路）
  w.handle("按量表给这份教案打个分", {
    skills: ["atom-lesson-check"], payload: { text: LESSON_MD }, back: null,
  });

  const deadline = Date.now() + 10000;
  let txt = "";
  while (Date.now() < deadline) {
    txt = w.document.querySelector("#chatLog").textContent;
    if (/质量评分|评分没跑起来/.test(txt)) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  const tail = txt.slice(before.length);

  /质量评分/.test(tail) ? P("模型返回被渲染成「质量评分」一节") : F("评分结果没上屏（可能静默退回了只有规则的那半张卡）");
  /6 个小节/.test(tail) ? P("规则检查与评分同时存在（不是二选一）") : F("规则段丢了");
  /维度[\s\S]*依据/.test(tail) ? P("评分渲染成表格（含维度 / 分 / 依据）") : F("评分表格没渲染");
  (tail.match(/[012]\/2/g) || []).length >= 6 ? P("六项分数全部上屏") : F("分数没上全");
  /10 \/ 12/.test(tail) ? P("合计按实际分算（10 / 12）") : F("合计算错");
  /可用/.test(tail) ? P("结论按分档给（可用）") : F("结论缺失");
  /把讲解压到 15 分钟/.test(tail) ? P("「最该改的一处」用的是模型给的那句") : F("最该改没取到");
  /同一个模型给自己打分/.test(tail) ? P("带上「同模型自评」的说明（不把分数当结论）") : F("自评口径说明缺失");

  /* 入口挂在哪张卡上：量表是给教案的，挂到题单上会得出没意义的分数 */
  const pad = "这是一段用于把卡片撑到入口阈值以上的说明文字，内容是真实的教案段落。";
  const cardOf = (lines, fromId) => w.resultCard(
    { secs: [{ title: "结果", lines: lines }], notes: [] }, null,
    { input: "测试", fromId: fromId, role: "teacher", courseId: "ds" }
  );
  // ⚠️ 入口有「正文够长（>200 字）」的门槛，所以这里要喂足够多的正文才测得到
  const lessonCard = cardOf(["## 教学目标", pad, pad, pad, pad, "## 课堂流程", "- 导入（5 分钟）：提问", pad, pad, pad, pad], "atom-lesson-draft");
  lessonCard.querySelector('[data-act="review"]')
    ? P("教案卡上挂「AI 评分」入口") : F("教案卡上没挂评分入口");
  const examCard = cardOf(["| 题号 | 考点 | 难度 |", "| --- | --- | --- |", "| 1 | 图的遍历 | 中 |", pad, pad], "atom-gen-quiz");
  !examCard.querySelector('[data-act="review"]')
    ? P("题单卡上不挂教案评分入口（不拿错量表评错东西）") : F("题单卡错挂了教案评分");

  w.document.querySelector("#sendBtn").disabled === false
    ? P("跑完发送按钮复位（不会把整页锁死）") : F("按钮没恢复");
  errors.length === 0 ? P("运行时错误 0 个") : F("运行时错误：" + errors.slice(0, 2).join(" / "));

  console.log("\n  评分冒烟：" + ok + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
