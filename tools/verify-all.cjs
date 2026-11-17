/**
 * 站点验收总入口
 * ------------------------------------------------------------
 * 依次跑：
 *   1. verify-site.cjs  —— 桩化 DOM，验「逻辑正确性」（快，无依赖）
 *   2. dom-smoke.cjs    —— jsdom 真解析真执行，验「真实渲染结构」
 *   3. sim-smoke.cjs    —— jsdom，验「工作台闭环」（跨身份的数据流）
 *   4. e2e-journey.cjs  —— **模拟一个人的操作路径**：登录 → 逐页点下去 → 跨身份流转
 *                          （它是唯一能发现「单页都正常、连起来却走不通」那类问题的关卡）
 *   5. review-smoke.cjs —— jsdom + 打桩 fetch，验「接上模型才会走的那条路」
 *                          （它坏掉时页面不报错，只是悄悄退回半张卡 —— 最容易假绿灯）
 *   6. training-audit.cjs —— 实训模块**逐环节**审计：教师发布 → 学生参与 → 回看，
 *                          外加跨账号 id 唯一性 / 学生自发的实训不外泄
 *                          （这类问题单页全绿也照样存在：同 id 会把别人的记录写串、连带删掉）
 *   7. workbench-audit.cjs —— AI 工作台**逐环节**审计：一句话 → 假模型真生成 → 打开 → 下发 → 学生收到；
 *                          产出物单独跑起来验「能加能勾能删、刷新不丢」
 *                          （它把「真调模型」那条路也走了一遍，未接模型时则验如实拒绝）
 *
 * 用法：
 *   node tools/verify-all.cjs
 * 退出码：0 全通过 / 1 有失败
 * ------------------------------------------------------------
 */
const { spawnSync } = require("child_process");
const path = require("path");

const node = process.execPath;
const tools = __dirname;

const steps = [
  { name: "逻辑验证（桩化 DOM）", file: "verify-site.cjs", required: true },
  { name: "渲染验证（真实 DOM）", file: "dom-smoke.cjs", required: false },
  // 工作台闭环单开一步：它的关键风险是**跨身份的数据流**
  // （老师的桶 vs 学生的桶、发给了谁、谁收到了），与逐页结构检查不是一类
  { name: "闭环验证（跨身份数据流：下发 / 出卷 / 课件）", file: "sim-smoke.cjs", required: false },
  // 端到端旅程单开一步：前面三步是「按功能点验」，这一步是「按人的操作路径验」——
  // 很多问题（设置页存的 Key 读不回来、交接的提示词半路丢了）只有在**连起来走**时才暴露
  { name: "用户旅程（端到端：登录 → 逐页操作 → 跨身份流转）", file: "e2e-journey.cjs", required: false },
  // 模型链路单开一步：它坏掉时页面**不报错**，只是悄悄退回"只有规则检查"的半张卡 ——
  // 桩化 DOM 和人工看都发现不了，必须拿一个假模型返回真跑一遍
  { name: "模型链路（打桩 fetch：评分表真的由模型返回驱动）", file: "review-smoke.cjs", required: false },
  // 实训单开一步：它是唯一按环节走完整个模块的关卡 —— 跨账号 id 唯一性、
  // 学生自发的实训不外泄、"我的进度"只算我自己的，这些都只有走完整条路径才验得到
  { name: "实训全环节审计（教师发布 → 学生参与 → 回看）", file: "training-audit.cjs", required: false },
  // 工作台也单开一步：它验的是「一句话 → 真生成 → 打开就能用 → 下发到学生」整条路径，
  // 且生成物要能自己跑起来（能加能勾能删、刷新不丢）—— 这些都不是逐页结构检查能覆盖的
  { name: "工作台全环节审计（一句话 → 生成 → 打开 → 下发）", file: "workbench-audit.cjs", required: false },
];

let failed = 0;
const results = [];

for (const s of steps) {
  console.log("\n" + "#".repeat(62));
  console.log("# " + s.name + "  →  " + s.file);
  console.log("#".repeat(62));

  const r = spawnSync(node, [path.join(tools, s.file)], { stdio: "inherit" });
  const code = r.status === null ? 1 : r.status;

  if (code === 0) {
    results.push(`[通过] ${s.name}`);
  } else {
    results.push(`[失败] ${s.name}（退出码 ${code}）`);
    if (s.required) failed++;
    else {
      // 非必需步骤（如缺 jsdom）跳过不算失败
      console.log("\n（该步骤失败，检查上方输出）");
      failed++;
    }
  }
}

console.log("\n" + "=".repeat(62));
console.log("总览");
console.log("=".repeat(62));
results.forEach((r) => console.log("  " + r));
console.log("=".repeat(62));
console.log(failed === 0 ? "全部验收通过 ✓" : failed + " 个步骤失败 ✗");
console.log("=".repeat(62));

process.exit(failed === 0 ? 0 : 1);
