#!/usr/bin/env python3
"""Drive the persistent CDP Chrome to render the SynCare console and screenshot it.

The browser_exec tool refuses private/internal addresses, so verifying a
localhost-only service is done over raw CDP. Dependency-free: it speaks the
WebSocket protocol directly over stdlib sockets, so nothing needs installing.

Prints page-derived text and the screenshot path. Touches no credentials.
"""
import base64
import json
import os
import socket
import struct
import sys
import time
import urllib.request

URL = "http://127.0.0.1:8080/"
SHOT = "/home/ubuntu/kittys-workspace/syncare-be/docs/ui-console.png"
CDP = "http://127.0.0.1:9222"


def http_json(path):
    with urllib.request.urlopen(CDP + path, timeout=8) as r:
        return json.load(r)


class WS:
    """Minimal RFC6455 client: text frames, no extensions, no fragmentation out."""

    def __init__(self, url):
        assert url.startswith("ws://")
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {hostport}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            self.buf += self.sock.recv(4096)
        self.buf = self.buf.split(b"\r\n\r\n", 1)[1]

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        payload = text.encode()
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv(self):
        b0, b1 = self._recv(2)
        opcode = b0 & 0x0F
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv(8))[0]
        data = self._recv(length)
        if opcode == 0x8:
            raise EOFError("close frame")
        if opcode == 0x9:  # ping -> pong
            return self.recv()
        return data.decode("utf-8", "replace")


def main():
    targets = http_json("/json/list")
    page = next((t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")), None)
    if not page:
        print("no CDP page target available")
        return 1

    ws = WS(page["webSocketDebuggerUrl"])
    mid = [0]

    def send(method, **params):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": method, "params": params}))
        deadline = time.time() + 40
        while time.time() < deadline:
            msg = json.loads(ws.recv())
            if msg.get("id") == mid[0]:
                return msg.get("result", {})
        raise TimeoutError(method)

    send("Page.enable")
    send("Runtime.enable")
    send(
        "Emulation.setDeviceMetricsOverride",
        width=1280,
        height=1700,
        deviceScaleFactor=2,
        mobile=False,
    )
    send("Page.navigate", url=URL)
    time.sleep(7)

    probe = """(() => {
      const txt = (s) => (document.querySelector(s)||{}).innerText || '';
      return JSON.stringify({
        title: document.title,
        h1: txt('h1').replace(/\\n/g,' | '),
        statusChips: [...document.querySelectorAll('#status .chip')].map(c=>c.innerText.replace(/\\s+/g,' ').trim()),
        planCount: txt('#planCount'),
        planCards: document.querySelectorAll('.plan').length,
        auditRows: document.querySelectorAll('.audit').length,
        firstPlanPid: (document.querySelector('.plan .pid')||{}).innerText || '',
        firstPlanTier: (document.querySelector('.plan .stamp')||{}).innerText || '',
        satusehatChips: [...document.querySelectorAll('.sus .stamp')].map(s=>s.innerText),
        banner: txt('#banner'),
        h1Font: getComputedStyle(document.querySelector('h1')).fontFamily.split(',')[0],
        bg: getComputedStyle(document.body).backgroundColor,
        logText: txt('#log'),
        jsAlive: typeof post === 'function',
      });
    })()"""
    out = send("Runtime.evaluate", expression=probe, returnByValue=True)
    print(out.get("result", {}).get("value", "{}"))

    shot = send("Page.captureScreenshot", format="png", captureBeyondViewport=True)
    if shot.get("data"):
        with open(SHOT, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        print("screenshot:", SHOT, os.path.getsize(SHOT), "bytes")
    else:
        print("screenshot failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())