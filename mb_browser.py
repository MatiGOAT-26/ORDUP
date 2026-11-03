"""Open the student's ManageBac login and read their own tasks after they sign in."""

import json
import os
import re
import socket
import struct
import subprocess
import time
from base64 import b64encode
from datetime import datetime
from urllib.parse import urlparse
from urllib.request import urlopen

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9333
PROFILE = os.path.expanduser("~/Library/Application Support/Ordup/chrome")
MODE = os.path.expanduser("~/Library/Application Support/Ordup/chrome-mode")
MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}
STATUSES = {
    "pending", "submitted", "late", "missing", "overdue", "not submitted",
    "not assessed yet", "complete", "completed", "returned", "excused",
}
GOOGLE_LOGIN = (
    "https://accounts.google.com/ServiceLogin"
    "?continue=https%3A%2F%2Fmyaccount.google.com%2Fpersonal-info"
    "&hl=en&flowName=GlifWebSignIn&flowEntry=ServiceLogin"
)
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
_google_announced = False


def school_host(value):
    host = str(value or "").strip().lower()
    host = host.replace("https://", "").replace("http://", "").split("/")[0].strip(".")
    if host and "." not in host:
        host = f"{host}.managebac.com"
    if host.endswith(".managebac.com") or host.endswith(".managebac.us") or host.endswith(".managebac.cn"):
        return host
    return ""


def start_google_login():
    global _google_announced
    _google_announced = False
    if not os.path.exists(CHROME):
        return {"error": "Google Chrome is needed to sign in."}
    launch("accounts.google.com", visible=True, start_url=GOOGLE_LOGIN)
    if not google_page():
        open_page(GOOGLE_LOGIN)
    return {"state": "waiting"}


def google_status():
    global _google_announced
    if not debugger_up():
        return {"state": "waiting"}
    page = google_page()
    if not page:
        return {"state": "waiting"}
    parsed = urlparse(page.get("url") or "")
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    if host != "myaccount.google.com" or any(part in path for part in ("signin", "identifier", "challenge")):
        return {"state": "waiting"}
    email, name = read_google_profile(page)
    if not email:
        return {"state": "waiting"}
    if not _google_announced:
        _google_announced = True
        subprocess.Popen(
            ["osascript", "-e", 'tell application "Cursor" to activate'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    return {"state": "ready", "email": email, "name": name}


def google_page():
    try:
        found = pages()
    except Exception:
        return None
    account = None
    other = None
    for page in found:
        host = (urlparse(page.get("url") or "").hostname or "").lower()
        if host == "myaccount.google.com":
            account = page
        elif host == "accounts.google.com":
            other = page
    return account or other


def read_google_profile(page):
    try:
        result = call_page(page["webSocketDebuggerUrl"], "Runtime.evaluate", {
            "expression": "document.body ? document.body.innerText.slice(0, 8000) : ''",
            "returnByValue": True,
        })
    except Exception:
        return "", ""
    text = result.get("result", {}).get("value") or ""
    email = ""
    for found in EMAIL_RE.findall(text):
        lowered = found.lower()
        if lowered.endswith("@google.com") or lowered.startswith("noreply") or lowered.startswith("no-reply"):
            continue
        email = lowered
        break
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    name = ""
    for index, line in enumerate(lines):
        if line.lower() == "name" and index + 1 < len(lines):
            candidate = lines[index + 1].strip()
            if candidate and "@" not in candidate and candidate.lower() not in {"email", "profile picture"}:
                name = candidate
                break
    return email, name


def start_login(host):
    host = school_host(host)
    if not host:
        return {"error": "Add your school’s ManageBac address."}
    if not os.path.exists(CHROME):
        return {"error": "Google Chrome is needed for ManageBac sign-in."}
    launch(host, visible=True)
    if not page_on_host(host):
        open_page(f"https://{host}/login")
    return {"state": "waiting"}


def login_status(host):
    host = school_host(host)
    if not debugger_up():
        return {"state": "waiting"}
    page = page_on_host(host)
    if not page:
        return {"state": "waiting"}
    parsed = urlparse(page.get("url") or "")
    if (parsed.hostname or "").lower() != host:
        return {"state": "waiting"}
    path = parsed.path.lower()
    if path.startswith("/login") or path.startswith("/auth") or "/session" in path:
        return {"state": "waiting"}
    try:
        locked = call_page(page["webSocketDebuggerUrl"], "Runtime.evaluate", {
            "expression": "Boolean(document.querySelector('input[type=password]'))",
            "returnByValue": True,
        })
    except Exception:
        return {"state": "waiting"}
    if locked.get("result", {}).get("value"):
        return {"state": "waiting"}
    return {"state": "ready"}


def fetch_tasks(host):
    host = school_host(host)
    if not host:
        return {"error": "Add your school’s ManageBac address."}
    if not debugger_up():
        launch(host, visible=False)
    today = datetime.now()
    tasks = []
    seen = set()
    for view in ("upcoming", "past", "overdue"):
        snapshot = read_live_view(host, view)
        if snapshot.get("loggedOut"):
            return {"loggedOut": True, "error": "Sign in to ManageBac with Google again."}
        if snapshot.get("error"):
            return snapshot
        for task in parse_view(snapshot.get("lines") or [], snapshot.get("links") or [], view, today):
            if task["key"] in seen:
                continue
            seen.add(task["key"])
            tasks.append(task)
    return {"tasks": tasks}


def read_live_view(host, view):
    url = f"https://{host}/student/tasks_and_deadlines?view={view}"
    page = page_on_host(host)
    if not page:
        if debugger_up():
            open_page(url)
        page = wait_for_page(host)
    if not page:
        return {"loggedOut": True}
    if view not in (page.get("url") or ""):
        try:
            call_page(page["webSocketDebuggerUrl"], "Page.navigate", {"url": url})
        except Exception:
            open_page(url)
    expression = """(() => {
      const loggedOut = Boolean(document.querySelector("input[type=password]")) || location.pathname.indexOf("/login") === 0;
      const lines = (document.body && document.body.innerText ? document.body.innerText : "").split(/\\n/).map((line) => line.replace(/\\u00a0/g, " ").trim()).filter(Boolean);
      const links = [...document.querySelectorAll("a[href]")].map((node) => ({
        text: (node.innerText || "").replace(/\\s+/g, " ").trim(),
        href: node.href || ""
      }));
      const ready = loggedOut || lines.some((line) => /tasks\\s*&\\s*deadlines/i.test(line));
      return { loggedOut, lines, links, ready };
    })()"""
    for _ in range(40):
        time.sleep(0.25)
        page = page_on_host(host)
        if not page or view not in (page.get("url") or ""):
            continue
        try:
            result = call_page(page["webSocketDebuggerUrl"], "Runtime.evaluate", {
                "expression": expression,
                "returnByValue": True,
            })
        except Exception:
            continue
        value = result.get("result", {}).get("value")
        if isinstance(value, dict) and value.get("ready"):
            return value
    return {"error": "ManageBac didn’t finish loading your tasks."}


def parse_view(lines, links, category, today):
    cleaned = [str(line).strip() for line in lines if str(line).strip()]
    due_indexes = [index for index, line in enumerate(cleaned) if parse_due(line, category, today)]
    tasks = []
    for position, due_index in enumerate(due_indexes):
        title = cleaned[due_index - 1] if due_index else ""
        due = parse_due(cleaned[due_index], category, today)
        if not due or not likely_title(title):
            continue
        next_due = due_indexes[position + 1] if position + 1 < len(due_indexes) else len(cleaned)
        block = cleaned[due_index:next_due]
        course = block[1] if len(block) > 1 and block[1].lower() not in STATUSES else ""
        status = next((line for line in block if line.lower() in STATUSES), "")
        href = href_for(title, links)
        task_id = task_id_from(href) or f"{title}|{course}|{due['date']}"
        tasks.append({
            "id": task_id,
            "title": title,
            "course": course,
            "due": due["date"],
            "status": status,
            "href": href,
            "view": category,
            "key": f"{task_id}|{due['date']}",
        })
    return tasks


def parse_due(value, category, today):
    month = day = year = None
    clock = meridiem = None
    for token in str(value).replace(",", " ").split():
        piece = token.strip(".,")
        if not piece:
            continue
        if piece.lower() in MONTHS and month is None:
            month = MONTHS[piece.lower()]
            continue
        if clock is None and ":" in piece and piece.replace(":", "").isdigit():
            clock = piece
            continue
        if piece.upper() in {"AM", "PM"}:
            meridiem = piece.upper()
            continue
        if piece.isdigit():
            number = int(piece)
            if year is None and number > 2000:
                year = number
            elif day is None and 1 <= number <= 31:
                day = number
    if not (month and day and clock and meridiem):
        return None
    hour_text, minute_text = clock.split(":", 1)
    hour = int(hour_text)
    minute = int(minute_text)
    if meridiem == "PM" and hour < 12:
        hour += 12
    if meridiem == "AM" and hour == 12:
        hour = 0
    if year is None:
        year = today.year
        try:
            candidate = datetime(year, month, day)
        except ValueError:
            return None
        if category == "upcoming" and candidate.date() < today.date() and month < today.month:
            year += 1
        if category != "upcoming" and (candidate.date() - today.date()).days > 45:
            year -= 1
    try:
        datetime(year, month, day, hour, minute)
    except ValueError:
        return None
    return {"date": f"{year:04d}-{month:02d}-{day:02d}"}


def likely_title(value):
    if not value or len(value) < 3 or len(value) > 180:
        return False
    lowered = value.lower()
    if lowered in STATUSES or lowered in {"upcoming", "past", "overdue", "show more"}:
        return False
    return True


def href_for(title, links):
    wanted = " ".join(title.lower().split())
    for link in links:
        text = " ".join(str(link.get("text") or "").lower().split())
        href = str(link.get("href") or "")
        if text == wanted and ("core_tasks" in href or "/tasks/" in href):
            return href
    return ""


def task_id_from(href):
    for marker in ("/core_tasks/", "/tasks/"):
        if marker in href:
            tail = href.split(marker, 1)[1].split("?", 1)[0].strip("/")
            piece = tail.split("/")[0]
            if piece:
                return piece
    return ""


def launch(host, visible, start_url=""):
    mode = "visible" if visible else "hidden"
    if debugger_up():
        if visible and current_mode() != "visible":
            quit_chrome()
        else:
            return
    os.makedirs(PROFILE, exist_ok=True)
    os.makedirs(os.path.dirname(MODE), exist_ok=True)
    with open(MODE, "w", encoding="utf-8") as handle:
        handle.write(mode)
    args = [
        CHROME,
        f"--user-data-dir={PROFILE}",
        f"--remote-debugging-port={PORT}",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
    ]
    if visible:
        args.append(start_url or f"https://{host}/login")
    else:
        args.append("--headless=new")
        args.append("about:blank")
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if debugger_up():
            return
        time.sleep(0.25)
    raise RuntimeError("Chrome didn’t open.")


def current_mode():
    try:
        with open(MODE, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def quit_chrome():
    if not debugger_up():
        return
    try:
        version = json.loads(urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=2).read().decode("utf-8"))
        call_page(version["webSocketDebuggerUrl"], "Browser.close", {})
    except Exception:
        pass
    for _ in range(40):
        if not debugger_up():
            return
        time.sleep(0.25)


def debugger_up():
    try:
        with urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=0.5) as response:
            return response.status == 200
    except Exception:
        return False


def pages():
    with urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=2) as response:
        data = json.loads(response.read().decode("utf-8"))
    return [item for item in data if item.get("type") == "page" and item.get("webSocketDebuggerUrl")]


def page_on_host(host):
    try:
        found = pages()
    except Exception:
        return None
    for page in found:
        if urlparse(page.get("url") or "").hostname == host:
            return page
    return None


def wait_for_page(host):
    for _ in range(20):
        page = page_on_host(host)
        if page:
            return page
        time.sleep(0.25)
    return None


def open_page(url):
    version = json.loads(urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=2).read().decode("utf-8"))
    socket_url = version["webSocketDebuggerUrl"]
    call_page(socket_url, "Target.createTarget", {"url": url})


def call_page(ws_url, method, params):
    client = SocketClient(ws_url)
    try:
        return client.request(method, params)
    finally:
        client.close()


class SocketClient:
    def __init__(self, ws_url):
        parsed = urlparse(ws_url)
        self.socket = socket.create_connection((parsed.hostname, parsed.port or 80), timeout=20)
        key = b64encode(os.urandom(16)).decode()
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.socket.sendall(request.encode())
        buffered = b""
        while b"\r\n\r\n" not in buffered:
            chunk = self.socket.recv(4096)
            if not chunk:
                raise RuntimeError("Chrome closed the connection.")
            buffered += chunk
        if b" 101 " not in buffered.split(b"\r\n", 1)[0]:
            raise RuntimeError("Couldn’t connect to Chrome.")
        self.pending = buffered.split(b"\r\n\r\n", 1)[1]
        self.next_id = 1

    def request(self, method, params):
        message_id = self.next_id
        self.next_id += 1
        self.send({"id": message_id, "method": method, "params": params})
        while True:
            message = self.receive()
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(message["error"].get("message") or "Chrome rejected the request.")
                return message.get("result") or {}

    def send(self, payload):
        data = json.dumps(payload).encode()
        mask = os.urandom(4)
        header = bytearray([0x81])
        length = len(data)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
        self.socket.sendall(header + mask + masked)

    def receive(self):
        while True:
            opcode, payload = self.read_frame()
            if opcode == 8:
                raise RuntimeError("Chrome closed the connection.")
            if opcode == 9:
                self.pong(payload)
                continue
            if opcode == 1:
                return json.loads(payload.decode())

    def read_frame(self):
        header = self.read_bytes(2)
        opcode = header[0] & 0x0F
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self.read_bytes(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self.read_bytes(8))[0]
        if header[1] & 0x80:
            mask = self.read_bytes(4)
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(self.read_bytes(length)))
        else:
            payload = self.read_bytes(length)
        return opcode, payload

    def read_bytes(self, count):
        data = self.pending
        self.pending = b""
        while len(data) < count:
            chunk = self.socket.recv(max(4096, count - len(data)))
            if not chunk:
                raise RuntimeError("Chrome closed the connection.")
            data += chunk
        self.pending = data[count:]
        return data[:count]

    def pong(self, payload):
        header = bytearray([0x8A])
        mask = os.urandom(4)
        header.append(0x80 | len(payload))
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.socket.sendall(header + mask + masked)

    def close(self):
        try:
            self.socket.close()
        except Exception:
            pass
