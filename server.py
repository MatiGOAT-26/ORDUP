#!/usr/bin/env python3
"""Local ORDUP server. Serves the app and forwards ManageBac reads."""

import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

import mb_browser

HOST = "127.0.0.1"
PORT = 8777
GOOGLE_REDIRECT = f"http://{HOST}:{PORT}/google/callback"
GOOGLE_DONE = f"http://{HOST}:{PORT}/google/done"
GOOGLE_CHOOSER = "https://accounts.google.com/v3/signin/accountchooser?" + urlencode({
    "continue": "https://accounts.google.com/ServiceLogin?" + urlencode({
        "continue": "https://myaccount.google.com/personal-info",
        "hl": "en",
        "flowName": "GlifWebSignIn",
        "flowEntry": "ServiceLogin",
    }),
    "hl": "en",
    "flowName": "GlifWebSignIn",
    "flowEntry": "AccountChooser",
})
GOOGLE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "google.local.json")
_oauth_lock = threading.Lock()
_oauth_states = {}
ALLOWED_HOSTS = {
    "api.managebac.com",
    "api.managebac.us",
    "api.us.managebac.com",
    "api.managebac.cn",
}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/google/callback":
            self._google_callback(parse_qs(parsed.query))
            return
        if parsed.path == "/google/done":
            self._google_done(parse_qs(parsed.query))
            return
        if parsed.path == "/google/start":
            self._google_start()
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in {"/api/managebac", "/api/managebac/login", "/api/managebac/status", "/api/managebac/tasks", "/api/google/login", "/api/google/status", "/api/google/oauth/start", "/api/ai/status", "/api/ai/setup", "/api/chat"}:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        limit = 120000 if path == "/api/chat" else 20000
        if length > limit:
            self._json(413, {"error": "That request is too large."})
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "Invalid request."})
            return
        if path == "/api/google/login":
            status, payload = google_login()
        elif path == "/api/google/oauth/start":
            status, payload = google_oauth_start()
        elif path == "/api/google/status":
            status, payload = google_account_status()
        elif path == "/api/managebac/login":
            status, payload = student_login(body)
        elif path == "/api/managebac/status":
            status, payload = student_status(body)
        elif path == "/api/managebac/tasks":
            status, payload = student_tasks(body)
        elif path == "/api/ai/status":
            status, payload = ai_status()
        elif path == "/api/ai/setup":
            status, payload = ai_setup(body)
        elif path == "/api/chat":
            status, payload = ai_chat(body)
        else:
            status, payload = forward(body)
        self._json(status, payload)

    def _json(self, status, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _google_callback(self, query):
        status, page = google_oauth_callback(query)
        self._html(status, page)

    def _google_done(self, query):
        self._html(200, google_done_page(query))

    def _google_start(self):
        status, payload = google_oauth_start()
        url = payload.get("url") if status == 200 and payload.get("url") else GOOGLE_CHOOSER
        self._html(200, google_start_page(url))

    def _html(self, status, page):
        raw = page.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def google_oauth_config():
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    if os.path.exists(GOOGLE_FILE):
        try:
            with open(GOOGLE_FILE, encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError):
            data = {}
        client_id = str(data.get("clientId") or client_id).strip()
        client_secret = str(data.get("clientSecret") or client_secret).strip()
    if not client_id:
        return None
    return {"clientId": client_id, "clientSecret": client_secret}


def google_oauth_start():
    config = google_oauth_config()
    if not config:
        return 400, {"error": "ORDUP doesn’t have its own Google sign-in app yet, so the account page can’t say ORDUP."}
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    state = secrets.token_urlsafe(32)
    now = time.time()
    with _oauth_lock:
        expired = [key for key, item in _oauth_states.items() if now - item["at"] > 600]
        for key in expired:
            _oauth_states.pop(key, None)
        _oauth_states[state] = {"verifier": verifier, "at": now}
    query = urlencode({
        "client_id": config["clientId"],
        "redirect_uri": GOOGLE_REDIRECT,
        "response_type": "code",
        "scope": "openid email profile",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "prompt": "select_account",
        "access_type": "online",
    })
    return 200, {"url": f"https://accounts.google.com/o/oauth2/v2/auth?{query}"}


def google_oauth_callback(query):
    error = (query.get("error") or [""])[0]
    if error:
        return 400, google_result_page("", "", "Google didn’t finish sign-in.")
    code = (query.get("code") or [""])[0]
    state = (query.get("state") or [""])[0]
    with _oauth_lock:
        pending = _oauth_states.pop(state, None)
    if not code or not pending:
        return 400, google_result_page("", "", "That Google sign-in didn’t match this ORDUP window.")
    config = google_oauth_config()
    if not config:
        return 400, google_result_page("", "", "ORDUP’s Google sign-in app is missing.")
    form = {
        "code": code,
        "client_id": config["clientId"],
        "redirect_uri": GOOGLE_REDIRECT,
        "grant_type": "authorization_code",
        "code_verifier": pending["verifier"],
    }
    if config["clientSecret"]:
        form["client_secret"] = config["clientSecret"]
    request = Request(
        "https://oauth2.googleapis.com/token",
        data=urlencode(form).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            token = json.loads(response.read().decode("utf-8"))
    except Exception as failure:
        return 502, google_result_page("", "", safe_error(failure) or "Google didn’t confirm that sign-in.")
    payload = jwt_payload(token.get("id_token") or "")
    name = str(payload.get("name") or "").strip()
    if not name:
        name = " ".join(part for part in [payload.get("given_name"), payload.get("family_name")] if part).strip()
    email = str(payload.get("email") or "").strip()
    if not name:
        return 400, google_result_page("", "", "Google didn’t send the name on that account.")
    return 200, google_result_page(name, email, "")


def jwt_payload(token):
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part.encode("ascii")))
    except Exception:
        return {}


def google_result_page(name, email, error):
    account = json.dumps({"name": name, "email": email, "error": error}).replace("<", "\\u003c")
    message = error or "Signed in. Returning to ORDUP…"
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>ORDUP</title></head>
<body style="font-family: sans-serif; padding: 32px;">
<p>{message.replace("<", "")}</p>
<script id="ordup-account" type="application/json">{account}</script>
<script>
const account = JSON.parse(document.getElementById("ordup-account").textContent);
if (!account.error) localStorage.setItem("ordup.google.pending", JSON.stringify(account));
if (window.opener) window.opener.focus();
window.close();
setTimeout(() => location.replace("/"), 300);
</script>
</body></html>"""


def google_start_page(url):
    target = json.dumps(url).replace("<", "\\u003c")
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
<script id="ordup-url" type="application/json">{target}</script>
<script>
const url = JSON.parse(document.getElementById("ordup-url").textContent);
try {{
  if (window.opener) window.opener.postMessage({{ type: "ordup-google-tab" }}, location.origin);
}} catch (e) {{}}
setTimeout(() => location.replace(url), 0);
</script>
</body></html>"""


def google_done_page(query):
    name = (query.get("name") or [""])[0].strip()
    email = (query.get("email") or [""])[0].strip()
    account = json.dumps({"name": name, "email": email, "error": ""}).replace("<", "\\u003c")
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>ORDUP</title></head>
<body style="font-family: sans-serif; padding: 32px;">
<p>Signed in. Returning to ORDUP…</p>
<script id="ordup-account" type="application/json">{account}</script>
<script>
const account = JSON.parse(document.getElementById("ordup-account").textContent);
if (account.name) localStorage.setItem("ordup.google.pending", JSON.stringify(account));
else localStorage.setItem("ordup.google.back", "1");
if (window.opener) window.opener.focus();
window.close();
setTimeout(() => location.replace("/"), 300);
</script>
</body></html>"""


def google_login():
    try:
        result = mb_browser.start_google_login()
    except Exception as error:
        return 502, {"error": str(error)[:240]}
    if result.get("error"):
        return 400, result
    return 200, result


def google_account_status():
    try:
        return 200, mb_browser.google_status()
    except Exception:
        return 200, {"state": "waiting"}


def student_login(body):
    try:
        result = mb_browser.start_login(body.get("schoolHost"))
    except Exception as error:
        return 502, {"error": str(error)[:240]}
    if result.get("error"):
        return 400, result
    return 200, result


def student_status(body):
    try:
        return 200, mb_browser.login_status(body.get("schoolHost"))
    except Exception:
        return 200, {"state": "waiting"}


def student_tasks(body):
    try:
        result = mb_browser.fetch_tasks(body.get("schoolHost"))
    except Exception as error:
        return 502, {"error": str(error)[:240]}
    if result.get("loggedOut"):
        return 401, result
    if result.get("error"):
        return 502, result
    return 200, result


def forward(body):
    host = str(body.get("apiHost") or "")
    if host not in ALLOWED_HOSTS:
        return 400, {"error": "That ManageBac server isn’t supported."}
    action = body.get("action") or "get"
    if action == "token":
        return token(host, body)
    if action != "get":
        return 400, {"error": "ORDUP only reads ManageBac."}
    path = str(body.get("path") or "")
    if not allowed_get(path):
        return 400, {"error": "That ManageBac request isn’t used for task sync."}
    query = body.get("query") if isinstance(body.get("query"), dict) else {}
    safe_query = {str(key): value for key, value in query.items() if value is not None and value != ""}
    url = f"https://{host}{path}"
    if safe_query:
        url = f"{url}?{urlencode(safe_query)}"
    headers = {"Accept": "application/json"}
    token_value = str(body.get("authToken") or "")
    bearer = str(body.get("bearer") or "")
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    elif token_value:
        headers["auth-token"] = token_value
    else:
        return 400, {"error": "Add a ManageBac API token."}
    return call(url, headers)


def token(host, body):
    client_id = str(body.get("clientId") or "")
    client_secret = str(body.get("clientSecret") or "")
    if not client_id or not client_secret:
        return 400, {"error": "Add the ManageBac OAuth client id and secret."}
    payload = json.dumps({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }).encode("utf-8")
    url = f"https://{host}/oauth/token"
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    return call(url, headers, payload)


def allowed_get(path):
    if not path.startswith("/v2/") or ".." in path:
        return False
    parts = [part for part in path.split("/") if part]
    if any(not part.replace("_", "").replace("-", "").isalnum() for part in parts):
        return False
    if parts[:2] == ["v2", "students"]:
        return len(parts) == 2
    if parts[:2] == ["v2", "memberships"]:
        return len(parts) == 2
    if parts[:2] == ["v2", "classes"] and len(parts) == 3:
        return True
    if len(parts) == 4 and parts[:2] == ["v2", "classes"] and parts[3] == "tasks":
        return True
    return False


def call(url, headers, data=None):
    request = Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urlopen(request, timeout=25) as response:
            raw = response.read(2_000_000)
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return 502, {"error": "ManageBac sent a response ORDUP couldn’t read."}
            return response.status, parsed
    except HTTPError as error:
        detail = error.read(4000).decode("utf-8", "replace")
        message = "ManageBac refused the request."
        try:
            parsed = json.loads(detail)
            candidate = parsed.get("error_description") or parsed.get("error") or parsed.get("message")
            if isinstance(candidate, str) and candidate.strip():
                message = candidate.strip()
        except json.JSONDecodeError:
            pass
        if error.code == 401:
            message = "ManageBac refused that token."
        return error.code, {"error": message[:240]}
    except URLError:
        return 502, {"error": "Couldn’t reach ManageBac."}
    except TimeoutError:
        return 504, {"error": "ManageBac took too long to answer."}


AI_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai.local.json")
AI_MODELS = {
    "gemini": "gemini-2.5-flash",
    "grok": "grok-4",
    "claude": "claude-sonnet-4-5",
    "openai": "gpt-4.1-mini",
}


def load_ai():
    try:
        with open(AI_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    provider = data.get("provider")
    key = str(data.get("key") or "").strip()
    if provider not in AI_MODELS or len(key) < 10:
        return None
    return {"provider": provider, "key": key, "model": data.get("model") or AI_MODELS[provider]}


def ai_status():
    config = load_ai()
    if not config:
        return 200, {"ready": False, "provider": ""}
    return 200, {"ready": True, "provider": config["provider"]}


def ai_setup(body):
    provider = str(body.get("provider") or "")
    key = str(body.get("key") or "").strip()
    if provider not in AI_MODELS or len(key) < 10:
        return 400, {"error": "Choose Gemini, Grok, Claude, or ChatGPT and paste its key."}
    payload = {"provider": provider, "key": key, "model": AI_MODELS[provider]}
    with open(AI_FILE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.chmod(AI_FILE, 0o600)
    return 200, {"ready": True, "provider": provider}


def ai_chat(body):
    config = load_ai()
    if not config:
        return 503, {"error": "no-model"}
    messages = clean_messages(body.get("messages"))
    if not messages:
        return 400, {"error": "Nothing to send."}
    try:
        text = complete(config, messages)
    except Exception as error:
        return 502, {"error": safe_error(error)}
    return 200, {"text": text}


def clean_messages(value):
    if not isinstance(value, list):
        return []
    cleaned = []
    for item in value[-16:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = str(item.get("content") or "").strip()
        if role not in {"system", "user", "assistant"} or not content:
            continue
        cleaned.append({"role": role, "content": content[:8000]})
    return cleaned


def complete(config, messages):
    provider = config["provider"]
    if provider == "gemini":
        return complete_gemini(config, messages)
    if provider == "claude":
        return complete_claude(config, messages)
    url = "https://api.x.ai/v1/chat/completions" if provider == "grok" else "https://api.openai.com/v1/chat/completions"
    result = post_json(url, {
        "model": config["model"],
        "messages": messages,
        "temperature": 0.4,
    }, {"Authorization": f"Bearer {config['key']}"})
    return result["choices"][0]["message"]["content"]


def complete_gemini(config, messages):
    system = "\n".join(item["content"] for item in messages if item["role"] == "system")
    contents = []
    for item in messages:
        if item["role"] == "system":
            continue
        role = "model" if item["role"] == "assistant" else "user"
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"][0]["text"] += "\n" + item["content"]
        else:
            contents.append({"role": role, "parts": [{"text": item["content"]}]})
    if not contents:
        contents = [{"role": "user", "parts": [{"text": "Hello"}]}]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{config['model']}:generateContent?key={config['key']}"
    result = post_json(url, {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
    }, {})
    return result["candidates"][0]["content"]["parts"][0]["text"]


def complete_claude(config, messages):
    system = "\n".join(item["content"] for item in messages if item["role"] == "system")
    dialog = []
    for item in messages:
        if item["role"] == "system":
            continue
        role = "assistant" if item["role"] == "assistant" else "user"
        if dialog and dialog[-1]["role"] == role:
            dialog[-1]["content"] += "\n" + item["content"]
        else:
            dialog.append({"role": role, "content": item["content"]})
    if not dialog or dialog[0]["role"] != "user":
        dialog.insert(0, {"role": "user", "content": "Hello"})
    result = post_json("https://api.anthropic.com/v1/messages", {
        "model": config["model"],
        "max_tokens": 1200,
        "system": system,
        "messages": dialog,
    }, {"x-api-key": config["key"], "anthropic-version": "2023-06-01"})
    return "".join(part.get("text", "") for part in result.get("content") or [])


def post_json(url, payload, headers):
    raw = json.dumps(payload).encode("utf-8")
    request = Request(url, data=raw, method="POST", headers={"Content-Type": "application/json", **headers})
    with urlopen(request, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def safe_error(error):
    text = str(error)
    if isinstance(error, HTTPError):
        try:
            text = error.read().decode("utf-8", "replace")
        except Exception:
            text = str(error)
    text = re.sub(r"key=[^&\s\"']+", "key=hidden", text)
    text = re.sub(r"sk-[A-Za-z0-9_-]+", "hidden", text)
    return text[:180] or "The assistant didn’t answer."


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"ORDUP at http://{HOST}:{PORT}")
    server.serve_forever()
