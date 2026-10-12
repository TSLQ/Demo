# -*- coding: utf-8 -*-
"""
本地演示服务（禁用缓存）—— 纯静态站点的开发/演示用起法。

为什么不用 `python -m http.server`：
  它会给 assets/*.css、*.js 打上 Last-Modified / 304 协商缓存。改完代码刷新，
  浏览器**可能继续用旧文件** —— 本项目的实战症状是：
  修好了 CSS，用户刷新后仍看到旧样式，以为"没修好"（第 37 轮真机事故排查了一圈）。

用法：
  python tools/serve.py [端口]        # 默认 8123
  → http://127.0.0.1:8123/index.html

🔴 端口要固定：localStorage 按「协议+域名+端口」隔离，换端口 = 换了套存储，
   用户会以为"数据丢了"。演示一律用 8123。
"""
import io
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")


class NoCacheHandler(SimpleHTTPRequestHandler):
    """每次请求都要求浏览器重新取，不发 304；
    对 HTML 再把 assets/xxx 的引用改写成 assets/xxx?v=<指纹> —— 双保险。"""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只记非 200，避免刷屏
        code = args[1] if len(args) > 1 else ""
        if str(code) != "200":
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_head(self):
        """只拦 HTML：读出来 → 给 assets 引用打上内容指纹 → 直接回，不走 304。

        🔴 为什么要打指纹（第 37 轮真机事故）：
           `Cache-Control: no-store` 只对**之后**的请求生效。用户浏览器里若已存着
           旧的 `core.js`，而页面 HTML 本身也被缓存着，就仍会去取旧脚本 ——
           症状是「同一次交付，我这边新函数都在，用户那边报 renderLines is not defined」。
           把指纹写进 URL，**内容一变 URL 就变**，物理上不可能命中旧缓存。
           ⚠️ 只在服务端改写，**不动磁盘上的 HTML** —— 否则验证器里的资源引用断言会失配。
        """
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        if not path.lower().endswith((".html", ".htm")):
            return super().send_head()

        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError:
            return super().send_head()

        try:
            html = raw.decode("utf-8")
        except UnicodeDecodeError:
            return super().send_head()

        changed = False
        for m in set(re.findall(r'(?:href|src)="(assets/[^"?]+)"', html)):
            fp = os.path.join(os.path.dirname(path), m)
            if not os.path.isfile(fp):
                continue
            st = os.stat(fp)
            stamp = "%x-%x" % (int(st.st_mtime), st.st_size)
            html = html.replace('"%s"' % m, '"%s?v=%s"' % (m, stamp))
            changed = True

        if not changed:
            return super().send_head()

        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        return io.BytesIO(body)


def main():
    handler = partial(NoCacheHandler, directory=os.path.abspath(ROOT))
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    # 后台运行时 stdout 是全缓冲的 → 不加 flush，启动横幅与日志都看不到（排查时会被误判成"没起来"）
    print("智课助教 · 本地预览（已禁用缓存）", flush=True)
    print("  http://127.0.0.1:%d/index.html" % PORT, flush=True)
    print("  目录: %s" % os.path.abspath(ROOT), flush=True)
    print("  Ctrl+C 停止", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)


if __name__ == "__main__":
    main()
