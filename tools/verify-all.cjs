/**
 * 站点验收总入口
 * ------------------------------------------------------------
 * 依次跑：
 *   1. verify-site.cjs  —— 桩化 DOM，验「逻辑正确性」（快，无依赖）
 *   2. dom-smoke.cjs    —— jsdom 真解析真执行，验「真实渲染结构」
 *   3. sim-smoke.cjs    —— jsdom，验「工作台闭环」（跨身份的数据流）
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
