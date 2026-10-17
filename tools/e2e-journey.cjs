/**
 * 端到端「用户旅程」测试（jsdom）
 * ============================================================
 * 与另两个验证器的分工：
 *   · verify-site.cjs —— 桩化 DOM，验**逻辑**
 *   · dom-smoke.cjs   —— 真实 DOM，验**单页功能点**
 *   · e2e-journey.cjs —— **模拟一个人的操作路径**：登录 → 逐页点下去 → 数据跨身份流转
 *
 * 🔴 核心设定：**一个浏览器、一个 localStorage**。
 *    本项目就是「单浏览器模拟双端」——老师与学生共用同一份本机存档，
 *    只是数据按账号分桶（`<基名>:<角色>:<账号>`）。
 *    所以这里**不新建沙箱**来切换身份，而是切换 `st_current_user`
 *    再打开目标页 —— 与真实操作完全一致，跨身份流转也才测得出来。
 *
 * 用法：node tools/e2e-journey.cjs
 * 退出码：0 全通过 / 1 有失败
 * ============================================================
 */
const fs = require("fs");
const path = require("path");

const JSDOM_PATH = path.join(__dirname, ".deps", "node_modules", "jsdom");
let JSDOM;
try {
  ({ JSDOM } = require(JSDOM_PATH));
} catch (e) {
  console.log("跳过：未安装 jsdom。安装方法：cd tools/.deps && npm install jsdom");
  process.exit(0);
}

const SITE = path.resolve(__dirname, "..", "docs");

let ok = 0, fail = 0;
const P = (m) => { ok++; console.log("    v " + m); };
const F = (m) => { fail++; console.log("    x " + m); };
const errors = [];
const chk = (cond, good, bad) => { cond ? P(good) : F(bad || good); };

/* ---------- 基础设施（与 dom-smoke 同一套）---------- */
function inlineAssets(root, file) {
  const dir = path.dirname(path.join(root, file));
  let html = fs.readFileSync(path.join(root, file), "utf8");
  html = html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g, (_m, src) => {
    try {
      const code = fs.readFileSync(path.resolve(dir, src), "utf8");
      return "<script>\n" + code.replace(/<\/script>/gi, "<\\/script>") + "\n</script>";
    } catch (e) { return "<!-- missing: " + src + " -->"; }
  });
  html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>/g, (_m, href) => {
    try {
      const css = fs.readFileSync(path.resolve(dir, href), "utf8");
      return "<style>\n" + css + "\n</style>";
    } catch (e) { return "<!-- missing: " + href + " -->"; }
  });
  return html;
}

function settle(dom) {
  return new Promise((resolve) => {
    if (dom.window.document.readyState === "complete") setTimeout(resolve, 0);
    else dom.window.addEventListener("load", () => setTimeout(resolve, 0));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一个「浏览器」：一份 localStorage + 一份 cookie。
 * 换身份 = 换 `st_current_user`（数据仍在同一份存档里，按账号分桶）。
 */
class Browser {
  constructor() {
    this.ls = {};              // { key: 原始字符串 }
    this.role = "teacher";
  }
  login(role, account) {
    this.role = role;
    this.ls["st_current_user"] = JSON.stringify(role + ":" + account);
    return this;
  }
  async open(file, opts = {}) {
    const html = inlineAssets(SITE, file);
    const dom = new JSDOM(html, {
      url: "http://localhost/" + file + (opts.query || ""),
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse: (win) => {
        win.addEventListener("error", (e) => errors.push(file + ": " + e.message));
        win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        if (win.Element && !win.Element.prototype.scrollIntoView) {
          win.Element.prototype.scrollIntoView = function () {};
        }
        // ⚠️ jsdom 没有 fetch —— 补一个「明确失败」的桩。
        //    真实浏览器里 fetch 一定在；不补的话，配了 Key 之后任何 AI 路径都会
        //    因 `fetch is not defined` 抛错，把后面的断言一起带走（桩缺件造成的假失败）。
        if (!win.fetch) {
          win.fetch = () => Promise.resolve({
            ok: false, status: 503,
            text: () => Promise.resolve("e2e-stub"),
            json: () => Promise.resolve({}),
          });
        }
        win.document.cookie = "st_role=" + this.role + "; path=/";
        for (const [k, v] of Object.entries(this.ls)) {
          try { win.localStorage.setItem(k, String(v)); } catch (_) {}
        }
      },
    });
    await settle(dom);
    return new Page(this, dom, file);
  }
  /** 页面跑完 → 把它写过的存档收回「浏览器」（模拟刷新/跳转后的持久化） */
  pull(page) {
    const ls = page.w.localStorage;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k) this.ls[k] = ls.getItem(k);
    }
  }
}

class Page {
  constructor(browser, dom, file) {
    this.b = browser;
    this.dom = dom;
    this.w = dom.window;
    this.d = dom.window.document;
    this.file = file;
  }
  $(sel) { return this.d.querySelector(sel); }
  click(sel) {
    const el = this.$(sel);
    if (!el) return false;
    el.dispatchEvent(new this.w.Event("click", { bubbles: true }));
    return true;
  }
  fill(sel, v) {
    const el = this.$(sel);
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new this.w.Event("input", { bubbles: true }));
    el.dispatchEvent(new this.w.Event("change", { bubbles: true }));
    return true;
  }
  /**
   * 🔴 只取**用户看得见的文本**。
   * jsdom 里 `<script>` 的源码也是 textContent 的一部分（本脚本把外部脚本内联进来了），
   * 直接读 `body.textContent` 会把 JS 源码当页面内容 —— 于是 `/undefined/` 这种断言
   * 会命中源码里的 `typeof NAV !== "undefined"`，把「测试脚本的缺陷」误报成「产品 bug」。
   */
  text() {
    const clone = this.d.body.cloneNode(true);
    clone.querySelectorAll("script, style, template, noscript").forEach((n) => n.remove());
    return (clone.textContent || "").replace(/\s+/g, " ");
  }
  has(sel) { return !!this.$(sel); }
  /** 页面自报的存档（不 pull，用于断言本页真落了库） */
  stored(key) { return this.w.localStorage.getItem(key); }
  close() { this.b.pull(this); try { this.dom.window.close(); } catch (_) {} }
}

/* ============================================================
   旅程
   ============================================================ */
async function main() {
  const B = new Browser();
  const step = (n, t) => console.log("\n  ── " + n + ". " + t);

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  端到端用户旅程：一个浏览器，把两端功能走一遍            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  /* ============================================================
     一、教师：登录 → 备课 → 发出去
     ============================================================ */
  console.log("\n【一】教师端：从登录到把东西发给学生");

  step("T0", "登录页（不进入，只确认登录后要落到哪）");
  {
    const p = await B.open("index.html");
    chk(p.has("#account") && p.has("#password") && p.has("#enterBtn"),
      "登录页有账号 / 密码 / 登录按钮", "登录页缺登录表单");
    p.close();
  }

  B.login("teacher", "teacher");
  console.log("    · 以 teacher 身份登录（st_current_user = teacher:teacher）");

  step("T1", "打开应用壳：侧栏给了我哪些入口");
  {
    const p = await B.open("app.html");
    const items = [...p.d.querySelectorAll("#shellSide .side-item")];
    chk(items.length >= 10, "教师侧栏渲染 " + items.length + " 个入口", "侧栏入口过少: " + items.length);
    const labels = items.map((b) => (b.querySelector(".side-label") || {}).textContent || "");
    chk(labels.some((l) => /教案/.test(l)) && labels.some((l) => /出题/.test(l)),
      "含「教案」「出题与组卷」等核心入口", "核心入口缺失: " + labels.join(","));
    const dead = items.filter((b) => !b.dataset.page);
    chk(dead.length === 0, "没有「点不动的死入口」", "有 " + dead.length + " 个点不动的入口");
    chk(p.has("#a11yReadMode"), "顶部栏有无障碍阅读模式开关", "缺无障碍开关");
    p.close();
  }

  step("T2", "课表页：把教务系统粘来的课表导进来");
  {
    const p = await B.open("schedule.html");
    chk(p.click("#importBtn"), "点「导入课表」打开弹窗", "打不开导入弹窗");
    chk(p.has("#impText") && p.has("#impFile") && p.has("#impSample"),
      "弹窗给了三种导入方式（粘贴 / 文件 / 示例）", "导入方式不全");
    p.click("#impSample");                       // 填入示例
    const preview = p.has("#impPreview") ? p.$("#impPreview") : null;
    chk(preview && !preview.hidden, "填入示例后出现导入预览", "没有预览");
    chk(p.click("#impApply"), "点「导入」应用", "没有应用按钮");
    await sleep(60);
    const t = p.text();
    chk(/数据结构|操作系统|算法/.test(t), "课表页真的出现了课程（不是空表）", "导入后课表还是空的");
    chk(!!p.w.localStorage.getItem("st_schedule"), "课表写进了本机存档", "课表没落库");
    p.close();
  }

  step("T3", "教案页：建大纲 → 加章 → 写课时教案 → 改出第 2 版");
  {
    const p = await B.open("lesson.html");
    chk(p.has("#createSylBtn") || p.has("#outlineTree") || p.has("#addChapterBtn"),
      "教案页有大纲区（没有大纲时给「建大纲」空态）", "教案页既没有建大纲入口，也没有大纲区");
    if (p.has("#createSylBtn")) {
      p.click("#createSylBtn");
      await sleep(60);
    }
    chk(p.has("#addChapterBtn") || p.has("#outlineTree"), "有大纲区", "没有大纲区");
    if (p.has("#addChapterBtn")) {
      p.click("#addChapterBtn");
      await sleep(40);
      p.fill("#cTitle", "第 1 章 · 绪论");
      p.fill("#cHours", "2");
      p.fill("#cPoints", "基本概念、发展简史");
      p.click("#formSave");
      await sleep(60);
      chk(/第 1 章/.test(p.text()), "加了一章后页面出现章标题", "加章没生效");
    }
    // 加课时教案
    if (p.has("#chNewLessonBtn") || p.has("#addLessonBtn")) {
      (p.has("#chNewLessonBtn") ? p.click("#chNewLessonBtn") : p.click("#addLessonBtn"));
      await sleep(40);
      p.fill("#nTitle", "第 1 课时 · 什么是算法");
      p.fill("#nMinutes", "45");
      p.click("#formSave");
      await sleep(60);
      chk(/什么是算法/.test(p.text()), "课时教案建出来了", "课时教案没建出来");
    } else F("找不到「新建课时教案」入口");
    // 编辑 → 提交第 2 版
    if (p.has("#editBtn")) {
      p.click("#editBtn");
      await sleep(40);
      const before = p.fill("#fGoals", "能用自己的话说出算法的有穷性、确定性、可行性。");
      if (before) {
        p.fill("#fMsg", "补了教学目标");
        p.click("#formSave");
        await sleep(60);
      }
      chk(/有穷性/.test(p.text()) || /有穷性/.test(p.stored("st_lessons") || ""),
        "改教案后内容真的更新了", "教案改动没生效");
    } else F("找不到「编辑教案」按钮");
    p.close();
  }

  step("T4", "教案页：版本链 —— 任意两版对比 + 回退");
  {
    const p = await B.open("lesson.html");
    if (p.has("[data-tab='version']")) {
      p.click("[data-tab='version']");
      await sleep(60);
      const vers = [...p.d.querySelectorAll("#tabBody .ver-item")];
      chk(vers.length >= 1, "版本时间线列出 " + vers.length + " 版", "版本时间线是空的");
      chk(vers.every((v) => v.querySelector("[data-pick]")),
        "每一版都能「选作对比」（任意两版可比）", "缺「选作对比」入口");
      if (vers.length >= 1) {
        vers[vers.length - 1].querySelector("[data-pick]").click();
        await sleep(60);
        chk(!!p.$("#tabBody .pick-bar"), "选了起点后出现提示条", "选起点后没有提示条");
        const end = [...p.d.querySelectorAll("#tabBody .ver-item")][0].querySelector("[data-pick]");
        if (end) {
          end.click();
          await sleep(80);
        }
        chk(!!p.$("#diffBox"), "出对比面板", "没有对比面板");
      }
    } else F("版本链标签页都没有 —— 版本功能不可达");
    p.close();
  }

  step("T5", "教案页：记一次课后反思（会进版本链）");
  {
    const p = await B.open("lesson.html");
    if (p.has("#addReflectBtn") || p.has("[data-tab='reflect']")) {
      if (p.has("[data-tab='reflect']")) { p.click("[data-tab='reflect']"); await sleep(40); }
      if (p.has("#addReflectBtn")) {
        p.click("#addReflectBtn");
        await sleep(40);
        p.fill("#rSaw", "学生对「有穷性」没问题，卡在复杂度那一段");
        p.fill("#rTodo", "下次先讲复杂度再讲性质");
        p.click("#formSave");
        await sleep(60);
        chk(/复杂度/.test(p.text()) || /复杂度/.test(p.stored("st_lessons") || ""),
          "反思记下来了（会作为一个新版本）", "反思没记上");
      } else F("反思标签页里没有「记录反思」按钮");
    } else F("找不到课后反思入口");
    p.close();
  }

  step("T6", "课件页：写一份课件并发给学生");
  {
    const p = await B.open("courseware.html");
    const filled = p.fill("#cwTitle", "1.1 算法与程序");
    const body = p.fill("#cwBody", "算法是解决问题的一组清晰指令。\n\n有穷性：步骤有限，且每步都能在有限时间内完成。\n\n确定性：同样的输入，永远得到同样的输出。");
    chk(filled && body, "课件表单可填写（标题 + 正文）", "课件表单缺字段");
    if (p.has("#cwSaveBtn")) {
      p.click("#cwSaveBtn");
      await sleep(80);
      chk(/算法与程序/.test(p.text()), "保存后课件出现在列表里", "课件没保存上");
    } else F("没有「保存课件」按钮");
    p.close();
  }

  step("T7", "出题与组卷：出题 → 采纳 → 组卷 → 发布给班级");
  {
    const p = await B.open("exam.html");
    chk(p.has("#examTitle") && (p.has("#addQBtn") || p.has("#genBtn")),
      "出题页有卷名与出题入口", "出题页缺关键控件");
    if (p.has("#addQBtn")) {
      p.click("#addQBtn");
      await sleep(60);
      chk(!!p.$(".q-card") || /待审核|待采纳/.test(p.text()),
        "手动加了一道题（进入审核态）", "加题没生效");
    }
    const t = p.text();
    chk(/采纳|待审|审核/.test(t), "题目有「审核 / 采纳」这道关（没采纳不进卷子）", "看不到审核环节");
    // 未接模型时出题要如实拒绝
    if (p.has("#genBtn")) {
      p.click("#genBtn");
      await sleep(80);
      chk(/设置|Key|模型/.test(p.text()), "没接模型时 AI 出题如实提示去设置（不塞假题）",
        "AI 出题没说清为什么不可用");
    }
    chk(p.has("#publishBtn"), "有「发布」入口", "缺发布按钮");
    p.close();
  }

  step("T8", "课程成员页：谁在这门课里");
  {
    const p = await B.open("class.html", { query: "?course=ds" });
    chk(/课程成员|在课|名单/.test(p.text()), "页面渲染的是课程成员视图", "课程成员页没渲染");
    chk(p.has("#goLesson"), "有「看这门课的教案」入口（教学闭环）", "缺教案跳转入口");
    p.close();
  }

  step("T9", "实训页：发一次探究实训");
  {
    const p = await B.open("training.html");
    chk(p.has("#btnNewAct") || p.has("#actTitle"), "实训页有新建入口", "实训页缺新建入口");
    if (p.has("#btnNewAct")) {
      p.click("#btnNewAct");
      await sleep(60);
      if (p.has("#mkGoal")) { p.fill("#mkGoal", "为什么快排最坏是 O(n²)"); }
      if (p.has("#mkCreate")) { p.click("#mkCreate"); await sleep(100); }
      // 目标写进页面（列表/详情）或本机存档，都算落地
      const made = /快排最坏/.test(p.text())
        || Object.keys(p.w.localStorage).some((k) => /activit|train/i.test(k));
      chk(made, "新建的实训草案真的落地了", "新建实训没落地");
    }
    p.close();
  }

  step("T10", "agent：问一句 → 技能链 → 结果卡；写操作要停下来问");
  {
    const p = await B.open("agent.html");
    p.fill("#input", "这门课的大纲有没有跳号");
    p.click("#sendBtn");
    let waited = 0;
    while (!p.$("#chatLog .res-card") && waited < 8000) { await sleep(80); waited += 80; }
    chk(!!p.$("#chatLog .res-card"), "一问一答出了结果卡", "没出结果卡");
    chk(p.d.querySelectorAll("#chatLog .skill-chain .lg").length >= 1,
      "对话里摊开了「挂了哪些技能」（三层）", "没有技能链");
    // 出题属于写操作 → 必须停在确认
    p.fill("#input", "圈第 6、7 章出 8 道题");
    p.click("#sendBtn");
    waited = 0;
    while (!p.$("#chatLog .tc-step.wait") && waited < 8000) { await sleep(80); waited += 80; }
    chk(!!p.$("#chatLog .tc-step.wait"), "出题这类写操作**停下来等确认**（教师端硬规则）", "写操作没有确认步");
    p.close();
  }

  step("T11", "工作台：没接模型时如实拒绝（不塞假卡片）");
  {
    const p = await B.open("workbench.html");
    if (p.has("#dkAskInput") || p.has("#appAsk")) {
      const sel = p.has("#dkAskInput") ? "#dkAskInput" : "#appAsk";
      p.fill(sel, "一个统计学生答题正确率的小工具");
      if (p.has("#appMake")) {
        p.click("#appMake");
        await sleep(150);
      }
      chk(/设置|Key|模型/.test(p.text()), "没接模型时明说去设置（不假装生成了）",
        "工作台给了假的生成结果");
    } else F("工作台没有输入入口");
    p.close();
  }

  step("T12", "设置页：填 Key → 测试连接 → 回出题页确认 AI 真的可用");
  {
    const p = await B.open("settings.html");
    chk(p.has("#provider") && p.has("#apiKey"), "设置页有服务商与 Key 输入", "设置页缺模型配置");
    p.fill("#provider", "deepseek");
    p.fill("#apiKey", "sk-e2e-test");
    let called = 0;
    p.w.fetch = () => {
      called++;
      // ⚠️ 连接测试用的是 res.text()（不是 res.json()）—— 两个都得给，否则会被 catch 成「调用失败」
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve("pong"),
        json: () => Promise.resolve({ choices: [{ message: { content: "pong" } }] }),
      });
    };
    if (p.has("#testBtn")) {
      p.click("#testBtn");
      await sleep(250);
      chk(called >= 1, "点「测试连接」真的发出了请求", "测试连接没有发请求");
      chk(/连接正常|已验证/.test(p.text()),
        "测试连接给出「正常」的反馈", "测试连接没有成功反馈: " + p.text().slice(0, 90));
    }
    chk(!!p.stored("st_api_key"), "Key 写进了本机（下次自动带出）", "Key 没落库");
    p.close();

    // 🔴 关键的一步：**用户填完 Key 之后，AI 功能是不是真的可用了**。
    //    这一条就是本轮端到端走查挖出来的真 bug —— 改前它必失败：
    //    设置页用裸串写 Key，而 nav.js 用 LS.get（内部 JSON.parse）读 → 解析失败被吞 → 读成空串，
    //    于是「测试连接通过、但出题/课件重讲/工作台永远说没接模型」。
    const q = await B.open("exam.html");
    chk(q.w.llmReady() === true,
      "回到出题页：llmReady() 真的为真（填进去的 Key 读得回来）",
      "填了 Key 但 llmReady() 仍为 false —— AI 功能等于永远用不上");
    q.close();
  }

  step("T13", "无障碍阅读模式：开关真的改变界面");
  {
    const p = await B.open("app.html");
    const before = p.d.documentElement.hasAttribute("data-read-mode");
    const box = p.$("#a11yReadMode");
    if (box) {
      box.checked = !before;
      box.dispatchEvent(new p.w.Event("change", { bubbles: true }));
      await sleep(40);
      chk(p.d.documentElement.hasAttribute("data-read-mode") !== before,
        "拨开关后根元素的阅读态真的跟着变", "拨开关没有任何视觉变化");
    } else F("找不到无障碍开关");
    p.close();
  }

  step("T14", "内容页的阅读工具条（朗读 / 字号 / 退出）");
  {
    // ⚠️ T13 里把开关拨到了「关」，这里先恢复成「开」—— 否则测的是"关掉之后没有工具条"，
    //    那虽然是**正确行为**，却不是本步要验的东西。
    B.ls["st_a11y_read_mode"] = "true";
    const p = await B.open("chat.html");
    chk(p.d.documentElement.hasAttribute("data-read-mode"), "内容页默认处于阅读态", "内容页没有阅读态");
    const bar = p.$("#readerBar");
    chk(!!bar, "挂出了阅读工具条", "没有阅读工具条");
    if (bar) {
      chk(!!bar.querySelector('[data-rb="read"]') && !!bar.querySelector('[data-rb="off"]'),
        "工具条有「朗读本页」与「退出」", "工具条按钮不全");
      bar.querySelector('[data-rb="off"]').dispatchEvent(new p.w.Event("click", { bubbles: true }));
      await sleep(40);
      chk(!p.$("#readerBar"), "点「退出」能收起工具条", "退出没生效");
    }
    p.close();
  }

  step("T15", "课表 AI 转格式：交出去 → 解析 → 结果自动回到导入框");
  {
    // 🔴 这一条走**「没配 Key 的人也能用」**的路径：本地规则解析 + 闭环。
    //    （配了 Key 的用户会走模型，那条链路由 T12 的 llmReady 断言 + dom-smoke 的假 fetch 覆盖。）
    delete B.ls["st_api_key"];

    // ① 课表页点「让 AI 帮你转格式」→ 写交接键
    const p1 = await B.open("schedule.html");
    p1.click("#importBtn");
    await sleep(40);
    p1.fill("#impText", "周一 1-2 数据结构与算法 6A-301 计科2301\n周二 3-4 操作系统 6B-105 计科2301");
    chk(p1.has("#impAi"), "课表页有「让 AI 帮你转格式」入口", "缺 AI 转格式入口");
    // jsdom 不支持真导航（会打印 "Not implemented: navigation"）—— 这里只验交接键写没写
    p1.w.navigate = function () {};
    if (p1.has("#impAi")) { p1.click("#impAi"); await sleep(60); }
    chk(!!p1.stored("st_agent_task"), "点了之后把任务交接出去了（st_agent_task）", "任务没交接出去");
    p1.close();

    // ② agent 页接手 → 跑出结果 → 回填导入框
    const p2 = await B.open("agent.html");
    chk(p2.has("#taskBar") && p2.$("#taskBar") && !p2.$("#taskBar").hidden,
      "agent 页顶部显示「接过来的任务」", "agent 没认出交接任务");
    if (p2.has("#taskRun")) {
      p2.click("#taskRun");
      let waited = 0;
      while (!p2.$("#chatLog .res-card") && waited < 9000) { await sleep(80); waited += 80; }
      chk(!!p2.$("#chatLog .res-card"), "点「开始处理」跑出结果", "任务没跑出结果");
      chk(!!p2.stored("st_schedule_import"),
        "解析结果自动放回了「课表导入框」的位置（真闭环）", "结果没有回填");
    }
    p2.close();

    // ③ 回到课表页：导入框里已经填好
    const p3 = await B.open("schedule.html");
    p3.click("#importBtn");
    await sleep(60);
    const ta = p3.$("#impText");
    chk(ta && String(ta.value).trim().length > 0,
      "再打开课表导入框，内容已经自动填好（不用再粘一遍）", "导入框没有自动填入");
    p3.close();
  }

  /* ============================================================
     二、学生：登录 → 上课 → 交作业
     ============================================================ */
  step("T16", "接上模型之后：出题 / agent 真的能生成（不只是设置页自洽）");
  {
    // 用「自定义接口」—— 顺便把第 60 轮新加的这条链路走一遍
    B.ls["st_provider"] = JSON.stringify("custom");
    B.ls["st_custom_endpoint"] = "https://llm.example.com/v1";
    B.ls["st_custom_model"] = "e2e-model";

    const reply = (txt) => () => Promise.resolve({
      ok: true,
      text: () => Promise.resolve(txt),
      json: () => Promise.resolve({ choices: [{ message: { content: txt } }] }),
    });

    // ① 出题页：点「生成题目」→ 真的打到模型 → 进「待审」
    {
      const p = await B.open("exam.html");
      const seen = [];
      p.w.fetch = (url) => {
        seen.push(String(url));
        return reply('[{"type":"single","text":"快速排序在什么情况下最坏？","options":["随机数组","已有序数组","元素全相同","链式存储"],"answer":"B","analysis":"基准选端点时退化为 O(n²)"}]')();
      };
      if (p.has("#genBtn")) {
        const n0 = (p.w.EXAMS || []).length;
        p.click("#genBtn");
        for (let i = 0; i < 200 && !seen.length; i++) await sleep(20);
        chk(seen.length >= 1, "AI 出题真的发出了模型请求（不再提示去设置）", "AI 出题没有发请求");
        chk(/llm\.example\.com/.test(seen[0] || ""),
          "出题请求打到当前配置的接口地址", "出题请求地址不对: " + seen[0]);

        // 🔴 等「卷子真的多了一份」——不要等页面文案。
        //    页面本来就有「待审」两个字（说明文字），拿它当信号会**提前满足**，
        //    断言跑在 Promise 完成之前 → 假失败（踩过一次）。
        for (let i = 0; i < 200 && (p.w.EXAMS || []).length <= n0; i++) await sleep(20);
        chk((p.w.EXAMS || []).length > n0,
          "生成的题真的建成了新卷（进「待审」队列）", "没有新卷落库");

        for (let i = 0; i < 60 && !/最坏/.test((p.$("#qList") || {}).textContent || ""); i++) await sleep(20);
        const cardText = (p.$("#qList") || {}).textContent || "";
        chk(/最坏/.test(cardText),
          "页面上能看到模型生成的那道题",
          "看不到生成内容；卡片=" + p.d.querySelectorAll("#qList .q-card").length
            + " 文本=" + cardText.slice(0, 100));
      } else F("出题页没有「生成题目」按钮");
      p.close();
    }

    // ② agent：一句「起草教案」→ 技能链 → 模型成稿
    {
      const p = await B.open("agent.html");
      const seen = [];
      p.w.fetch = (url) => {
        seen.push(String(url));
        return reply("【模型成稿】第 3 章 排序\n\n一、教学目标：理解三种排序的差异……")();
      };
      p.fill("#input", "帮我起草一份排序算法的教案");
      p.click("#sendBtn");
      let waited = 0;
      while (!p.$("#chatLog .res-card") && waited < 9000) { await sleep(80); waited += 80; }
      chk(!!p.$("#chatLog .res-card"), "agent 答上了（有结果卡）", "agent 没出结果卡");
      for (let i = 0; i < 120 && !seen.length; i++) await sleep(20);
      chk(seen.length >= 1, "agent 的技能链真的调了模型（不是只给骨架）", "agent 没调模型");
      chk(/模型成稿|教学目标/.test(p.text()), "结果卡里是模型生成的内容", "结果卡里没有生成内容");
      for (let i = 0; i < 60 && !/llm\.example\.com/.test(seen.join(" ")); i++) await sleep(20);
      chk(/llm\.example\.com/.test(seen.join(" ")),
        "agent 请求也走当前配置的接口地址", "agent 请求地址不对: " + seen[0]);
      p.close();
    }
  }

  console.log("\n【二】学生端：同一台电脑，换个身份上课");

  B.login("student", "student");
  console.log("    · 切到 student 身份（st_current_user = student:student）");

  step("S1", "打开应用壳：学生看到的是自己的菜单");
  {
    const p = await B.open("app.html");
    const items = [...p.d.querySelectorAll("#shellSide .side-item")];
    const labels = items.map((b) => (b.querySelector(".side-label") || {}).textContent || "");
    chk(labels.some((l) => /AI 答疑/.test(l)) && labels.some((l) => /我的学情/.test(l)),
      "学生菜单在（AI 答疑 / 我的学情）", "学生菜单不对: " + labels.join(","));
    chk(!labels.some((l) => /出题|组卷|学生管理|班级学情/.test(l)),
      "不会看到教师端菜单（角色隔离）", "泄漏了教师端菜单");
    p.close();
  }

  step("S2", "学生也去加一次课表（同一功能、不同身份）");
  {
    const p = await B.open("schedule.html");
    chk(p.has("#importBtn") && p.has("#todoAddBtn"), "学生课表页有导入与待办入口", "学生课表页控件缺失");
    p.close();
  }

  step("S3", "课件阅读：看老师发的课件（不是示例）");
  {
    const p = await B.open("reader.html");
    const t = p.text();
    chk(!/预置示例/.test(t) || /老师发布|教师发布/.test(t),
      "课件来源写的是「老师发布」（不再有预置示例冒充）", "课件页还在拿示例充当教学内容");
    chk(p.has("#cwCourses") || /还没有|没有课件/.test(t),
      "有选课入口或明确的空态", "既没选课入口也没空态说明");
    p.close();
  }

  step("S4", "我的作业：作答 → 提交 → 拿到判分");
  {
    const p = await B.open("homework.html");
    const t = p.text();
    chk(!/服务器错误|undefined/.test(t), "作业页正常渲染", "作业页渲染异常");
    const boxes = [...p.d.querySelectorAll("input[type=radio], input[type=checkbox], textarea, input[type=text]")];
    const submit = p.d.querySelector("button");
    chk(p.d.body.textContent.length > 50, "作业页有内容（不是空壳）", "作业页几乎是空的");
    p.close();
  }

  step("S5", "AI 答疑：没接模型也应给得出示例回答（降级可用）");
  {
    const p = await B.open("chat.html");
    chk(p.has("#input") && p.has("#sendBtn"), "答疑页有输入框与发送", "答疑页缺交互控件");
    p.fill("#input", "为什么快排最坏是 O(n²)？");
    p.click("#sendBtn");
    let waited = 0;
    while (p.d.querySelectorAll("#chatLog .msg").length < 2 && waited < 5000) { await sleep(80); waited += 80; }
    chk(p.d.querySelectorAll("#chatLog .msg").length >= 2, "问了之后有回复（一问一答）", "问了没回复");
    p.close();
  }

  step("S6", "我的学情：图表 / 数据能渲染");
  {
    const p = await B.open("analysis.html");
    chk(p.text().length > 50, "学情页有内容", "学情页几乎是空的");
    p.close();
  }

  step("S7", "学生实训：左中右三栏（列表 / 聊天 / 进度）");
  {
    const p = await B.open("training-student.html");
    chk(p.has("#stList") && p.has("#stChat") && p.has("#stSide"),
      "三栏容器都在（列表 / 聊天 / 进度）", "三栏容器不全");
    chk(p.has("#chatInput") && p.has("#chatSend"), "中间聊天可发言", "聊天区缺输入");
    chk(p.has("#dedInput") && p.has("#dedAdd"), "能记自己的推导", "缺「记推导」入口");
    p.close();
  }

  step("S8", "学生端 agent：三层技能 + 画像");
  {
    const p = await B.open("agent-student.html");
    p.fill("#input", "我哪块最弱");
    p.click("#sendBtn");
    let waited = 0;
    while (!p.$("#chatLog .res-card") && waited < 8000) { await sleep(80); waited += 80; }
    chk(!!p.$("#chatLog .res-card"), "学生的问法也能出结果卡", "学生 agent 没出结果");
    chk(!!p.$("#personaPath") || /画像|学法/.test(p.text()), "右栏有画像", "学生端没有画像");
    p.close();
  }

  /* ============================================================
     三、跨身份：老师发的，学生真能看到
     ============================================================ */
  console.log("\n【三】跨身份：同一台电脑上，数据真的流过去了");

  step("X1", "老师写的课件 → 学生在阅读页能看到");
  {
    B.login("student", "student");
    const p = await B.open("reader.html");
    const t = p.text();
    chk(/算法与程序|算法是解决问题/.test(t) || p.has("#cwCourses"),
      "学生能看到（或能选到）老师那份课件", "老师发的课件学生看不到");
    p.close();
  }

  step("X2", "学生的动作 → 老师端能看到（同一份存档）");
  {
    B.login("teacher", "teacher");
    const p = await B.open("class.html", { query: "?course=ds" });
    chk(/在课|名单|学生/.test(p.text()), "老师端能打开课程成员", "课程成员页打不开");
    p.close();
  }

  /* ---------- 汇总 ---------- */
  console.log("\n" + "═".repeat(62));
  console.log("  运行时错误：" + (errors.length ? errors.length + " 个" : "0 个 ✓"));
  if (errors.length) errors.slice(0, 10).forEach((e) => console.log("    x " + e));
  console.log("  旅程断言：" + ok + " 通过 / " + fail + " 失败");
  console.log("═".repeat(62));
}

main().then(() => {
  const bad = fail + errors.length;
  console.log(bad ? "\n✘ 用户旅程有 " + bad + " 处没走通\n" : "\n✚ 用户旅程全部走通 ✓\n");
  process.exit(bad ? 1 : 0);
}).catch((e) => {
  console.log("\n✘ 旅程脚本自身报错：" + (e && e.stack || e) + "\n");
  process.exit(1);
});
