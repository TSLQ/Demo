// 临时截图脚本（用完即删）：Edge headless + CDP，等 iframe 真加载完再截图
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/157.0.4341.46/msedge.exe";
const ROOT = "E:/App/Document/VS Code/SchoolTeach";
const PROFILE = ROOT + "/tools/.shots/profile";
const PORT = 9334;

const jobs = [
  {
    out: "workbench-teacher.png",
    url: "http://127.0.0.1:8123/_shot.html?role=teacher&page=workbench.html",
    // 只隐藏「未接模型」这条系统状态提示（产品还没连 Key，不是界面的一部分）
    hide: ["还没有接入模型"],
  },
];

mkdirSync(PROFILE, { recursive: true });
const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

async function version() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch (_) { /* not ready */ }
    await sleep(250);
  }
  throw new Error("CDP 未就绪");
}

const v = await version();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}, sessionId) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  return new Promise((res) => pending.set(mid, res));
}

for (const job of jobs) {
  const t = await send("Target.createTarget", { url: "about:blank" });
  const targetId = t.result.targetId;
  const a = await send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = a.result.sessionId;
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: job.url }, sessionId);
  await sleep(1200);
  for (let i = 0; i < 60; i++) {
    const r = await send("Runtime.evaluate", {
      expression: `(() => {
        const f = document.querySelector('#contentFrame');
        if (!f || !f.contentDocument) return 'no-frame';
        const d = f.contentDocument;
        if (d.readyState !== 'complete') return 'loading-doc';
        const txt = (d.body ? d.body.innerText : '') || '';
        if (!txt.trim()) return 'empty';
        if (txt.indexOf('正在加载') >= 0) return 'loading-txt';
        return 'ready:' + location.hash;
      })()`,
      returnByValue: true,
    }, sessionId);
    const val = r.result?.result?.value;
    if (typeof val === "string" && val.startsWith("ready:")) { console.log(job.out, val); break; }
    if (i === 59) console.log(job.out, "timeout:", val);
    await sleep(300);
  }
  for (const text of job.hide || []) {
    const r = await send("Runtime.evaluate", {
      expression: `(() => {
        const d = document.querySelector('#contentFrame').contentDocument;
        let n = 0;
        d.querySelectorAll('span,div,p').forEach((el) => {
          if (el.children.length === 0 && (el.textContent || '').indexOf(${JSON.stringify(text)}) >= 0) {
            el.style.visibility = 'hidden';
            const row = el.parentElement;
            if (row && row.classList.contains('sm-make-row')) { /* keep row height */ }
            n++;
          }
        });
        return n;
      })()`,
      returnByValue: true,
    }, sessionId);
    console.log("hidden nodes:", r.result?.result?.value);
  }
  await sleep(400);
  const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(`${ROOT}/tools/.shots/${job.out}`, Buffer.from(shot.result.data, "base64"));
  await send("Target.closeTarget", { targetId });
}

ws.close();
edge.kill();
process.exit(0);
