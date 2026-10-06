#!/usr/bin/env python3
"""Card editor: make a new deck / add, edit and delete cards in cards.json.

    ./learnmax edit

Runs a tiny server on 127.0.0.1 (this Mac only) and opens it in your browser.
The page previews cards with the same renderer and KaTeX the study apps use.
Every save rewrites cards.json atomically. Ctrl-C to quit, or just close the page: it exits a minute later.
"""

import json
import os
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS = os.path.join(HERE, "cards.json")
WEB = os.path.join(HERE, "webapp")
PAGE = os.path.join(HERE, "editor", "index.html")
PORT = int(os.environ.get("RL_EDIT_PORT", "8765"))
LOCK = threading.Lock()

TYPES = {".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
         ".woff": "font/woff", ".ttf": "font/ttf", ".html": "text/html"}


def load():
    try:
        with open(CARDS) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return []


def save(cards):
    tmp = CARDS + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(cards, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, CARDS)


def check(card, cards, old_id=None):
    """Return an error string, or None if `card` can be stored."""
    for f in ("id", "front", "back", "cat"):
        if not str(card.get(f, "")).strip():
            return f"{f} is required"
    if any(c["id"] == card["id"] and c["id"] != old_id for c in cards):
        return f"id {card['id']!r} already exists"
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            return self.send(200, open(PAGE, "rb").read(), "text/html")
        if path == "/api/ping":
            LAST_PING[0] = time.time()
            return self.send(200, {})
        if path == "/api/cards":
            return self.send(200, load())
        if path.startswith("/web/"):
            full = os.path.realpath(os.path.join(WEB, path[5:]))
            if full.startswith(WEB + os.sep) and os.path.isfile(full):
                ext = os.path.splitext(full)[1]
                return self.send(200, open(full, "rb").read(),
                                 TYPES.get(ext, "application/octet-stream"))
        self.send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.send(400, {"error": "bad json"})
        with LOCK:
            cards = load()
            if self.path == "/api/save":      # add or replace; old_id for edits
                card, old = body.get("card", {}), body.get("old_id")
                card = {k: card[k] for k in ("id", "front", "back", "cat", "batch")
                        if card.get(k)}
                err = check(card, cards, old)
                if err:
                    return self.send(400, {"error": err})
                for i, c in enumerate(cards):
                    if c["id"] == (old or card["id"]):
                        cards[i] = card
                        break
                else:
                    cards.append(card)
            elif self.path == "/api/delete":
                cards = [c for c in cards if c["id"] != body.get("id")]
            else:
                return self.send(404, {"error": "not found"})
            save(cards)
        self.send(200, cards)


LAST_PING = [None]


def watchdog(srv):
    """Quit once the page has been closed (no heartbeat for a minute).

    Only starts counting after the first heartbeat, so a slow-opening
    browser does not kill it. Started from the app, nobody sees a terminal to
    Ctrl-C, so it must stop on its own.
    """
    while True:
        time.sleep(5)
        if LAST_PING[0] and time.time() - LAST_PING[0] > 60:
            srv.shutdown()
            return


def main():
    if not os.path.isfile(PAGE):
        sys.exit(f"missing {PAGE}")
    url = f"http://127.0.0.1:{PORT}/"
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:                       # already running: just show it
        webbrowser.open(url)
        return
    threading.Thread(target=watchdog, args=(srv,), daemon=True).start()
    print(f"Card editor on {url}  (Ctrl-C to quit)")
    threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
