"""Synthetic loopback-only login/TOTP/cart site for the opt-in KVM smoke."""
import base64
import hashlib
import hmac
import html
import json
import os
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

import pyotp

GENERATION = 1
LOGINS = 0
KEY = b"synthetic-browser-fixture-signing-key"


def token(items):
    payload = base64.urlsafe_b64encode(json.dumps({"generation": GENERATION, "items": items}).encode()).decode()
    return payload + "." + hmac.new(KEY, payload.encode(), hashlib.sha256).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, content, cookie=None):
        body = content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", "session=" + cookie + "; HttpOnly; SameSite=Lax; Path=/")
        self.end_headers()
        self.wfile.write(body)

    def session(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))["session"].value
            payload, signature = cookie.rsplit(".", 1)
            if not hmac.compare_digest(signature, hmac.new(KEY, payload.encode(), hashlib.sha256).hexdigest()):
                return None
            value = json.loads(base64.urlsafe_b64decode(payload))
            return value if value["generation"] == GENERATION else None
        except (KeyError, ValueError):
            return None

    def do_GET(self):
        global GENERATION
        if self.path == "/stats":
            self.send(json.dumps({"logins": LOGINS, "generation": GENERATION}))
            return
        if self.path == "/expire":
            GENERATION += 1
            self.send("expired")
            return
        session = self.session()
        if session:
            items = "".join("<li>" + html.escape(item) + "</li>" for item in session["items"])
            self.send('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Синтетический магазин</title>'
                      '<style>body{font:20px "Noto Sans",sans-serif;margin:48px;background:#f8f5ed;color:#242721}'
                      'button,input{font:inherit;padding:8px} main{max-width:650px}h1{font-size:36px}</style>'
                      '<main><h1>Корзина — тест Workspace</h1><p>Вход выполнен / Signed in</p><ul>' + items + '</ul>'
                      '<form method="post" action="/cart"><label>Товар <input name="item" value="Книга Python"></label>'
                      '<button>Добавить в корзину</button></form><p>Тестовый сайт: оплата отсутствует.</p></main></html>')
        else:
            self.send('<main><h1>Вход / Sign in</h1><form method="post" action="/login">'
                      '<label>Login <input name="login"></label><label>Password <input type="password" name="password"></label>'
                      '<button>Sign in</button></form></main>')

    def do_POST(self):
        global LOGINS
        size = int(self.headers.get("Content-Length", "0"))
        if size > 4096:
            self.send_error(413)
            return
        values = parse_qs(self.rfile.read(size).decode())
        get = lambda key: values.get(key, [""])[0]
        if self.path == "/login" and get("login") == os.environ["SHOP_LOGIN"] and get("password") == os.environ["SHOP_PASSWORD"]:
            self.send('<main><h1>Two-step verification</h1><form method="post" action="/totp">'
                      '<label>Verification code <input name="code"></label><button>Verify</button></form></main>')
        elif self.path == "/totp" and pyotp.TOTP(os.environ["SHOP_TOTP_SEED"]).verify(get("code"), valid_window=1):
            LOGINS += 1
            self.send('<main>Authenticated <a href="/">Continue</a></main>', token([]))
        elif self.path == "/cart" and self.session():
            items = self.session()["items"] + [get("item")[:100]]
            self.send('<main>Added <a href="/">Continue</a></main>', token(items))
        else:
            self.send_error(403)


HTTPServer(("127.0.0.1", 18765), Handler).serve_forever()
