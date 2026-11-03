import { blockLength, estimateMinutes, pickRecommendations, recommend, repackSchedule } from "./engine.js";
import { addDays, formatRange, nowParts, relativeDay, uid } from "./time.js";

const PALETTE = ["#6D4AFF", "#E36A45", "#1F9D8A", "#C8962E", "#3A7BD5", "#D4537E", "#7C6AD8"];

const GENERIC_EMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "live.com",
]);

export function normalizeSchool(value) {
  let host = String(value || "").trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
  if (!host) return "";
  if (!host.includes(".")) host = `${host}.managebac.com`;
  const allowed = host.endsWith(".managebac.com") || host.endsWith(".managebac.us") || host.endsWith(".managebac.cn");
  return allowed ? host : "";
}

export function profileFromGoogleName(raw) {
  const value = String(raw || "").replace(/\s+/g, " ").trim();
  const coded = value.match(/^Y0*(\d{1,2})[A-Za-z]?\s+(.+)$/);
  if (coded) return { name: coded[2].trim(), grade: `Year ${Number(coded[1])}` };
  return { name: value, grade: "" };
}

export function schoolMatchesEmail(email, schoolHost) {
  const host = normalizeSchool(schoolHost);
  const domain = String(email || "").trim().toLowerCase().split("@")[1] || "";
  if (!host || !domain || GENERIC_EMAIL.has(domain)) return false;
  const school = host.split(".")[0];
  const labels = domain.split(".").filter((label) => !["student", "students", "stu", "mail", "email"].includes(label));
  if (labels.includes(school)) return true;
  return labels.some((label) => school.length >= 3 && (label.startsWith(school) || school.startsWith(label)));
}

export function apiHostFor(schoolHost, chosen) {
  const pick = String(chosen || "");
  const known = ["api.managebac.com", "api.managebac.us", "api.us.managebac.com", "api.managebac.cn"];
  if (known.includes(pick)) return pick;
  if (String(schoolHost).endsWith(".managebac.us")) return "api.managebac.us";
  if (String(schoolHost).endsWith(".managebac.cn")) return "api.managebac.cn";
  return "api.managebac.com";
}

export function isConnected(state) {
  const link = state.managebac;
  return Boolean(link?.signedIn && link?.schoolHost);
}

export function classifyTask(task) {
  const name = `${task.name || ""} ${task.category?.name || ""} ${task.assessment_type?.name || ""} ${task.assessment_type?.kind || ""}`.toLowerCase();
  if (name.includes("exam")) return { type: "exam", difficulty: "hard" };
  if (name.includes("test") || name.includes("quiz")) return { type: "test", difficulty: "hard" };
  if (name.includes("project")) return { type: "project", difficulty: "hard" };
  if (name.includes("read")) return { type: "reading", difficulty: "easy" };
  if (name.includes("revision") || name.includes("review")) return { type: "revision", difficulty: "medium" };
  if (task.assessment_type?.kind === "summative") return { type: "assignment", difficulty: "hard" };
  return { type: "homework", difficulty: "medium" };
}

export function dueDate(value, today) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : addDays(today, 7);
}

export const GOOGLE_LOGIN_URL = "https://accounts.google.com/v3/signin/accountchooser?continue=" + encodeURIComponent("https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmyaccount.google.com%2Fpersonal-info&hl=en&flowName=GlifWebSignIn&flowEntry=ServiceLogin") + "&hl=en&flowName=GlifWebSignIn&flowEntry=AccountChooser";

export function accountFromText(text) {
  const source = String(text || "");
  let email = "";
  for (const found of source.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []) {
    const lowered = found.toLowerCase();
    if (lowered.endsWith("@google.com") || lowered.startsWith("noreply") || lowered.startsWith("no-reply")) continue;
    email = lowered;
    break;
  }
  const lines = source.split(/\n/).map((line) => line.trim()).filter(Boolean);
  let name = "";
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].toLowerCase() !== "name" || index + 1 >= lines.length) continue;
    const candidate = lines[index + 1].trim();
    if (candidate && !candidate.includes("@") && !["email", "profile picture"].includes(candidate.toLowerCase())) {
      name = candidate;
      break;
    }
  }
  return { name, email };
}

export function watchGoogleLogin(tab) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const started = Date.now();
    const stop = () => {
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
    };
    const onMessage = (event) => {
      if (settled || event.origin !== location.origin) return;
      const data = event.data || {};
      if (data.type !== "ordup-google") return;
      const name = String(data.name || "").trim();
      const email = String(data.email || "").trim();
      if (!name && !email) return;
      stop();
      resolve({ name, email });
    };
    let readable = false;
    window.addEventListener("message", onMessage);
    const timer = setInterval(() => {
      if (settled) return;
      const waited = Date.now() - started;
      if (!tab || tab.closed || (waited > 1500 && !readable)) {
        if (waited > 1500 && !readable) {
          stop();
          reject(new Error("unread"));
        }
        return;
      }
      if (waited > 4 * 60 * 1000) {
        stop();
        reject(new Error("Finish signing in on the Google tab, then press Login with Google again."));
        return;
      }
      let text = "";
      try {
        text = tab.document?.body?.innerText || "";
        readable = true;
      } catch {
        return;
      }
      const account = accountFromText(text);
      if (!account.name && !account.email) return;
      stop();
      resolve(account);
    }, 800);
  });
}

let running = null;

export function syncManageBac(state) {
  if (running) return running;
  running = runSync(state).finally(() => {
    running = null;
  });
  return running;
}

export async function beginGoogleSignIn() {
  const start = await portal("/api/google/login", {});
  if (start.error) throw new Error(start.error);
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    await wait(1500);
    const status = await portal("/api/google/status", {});
    if (status.state === "ready" && status.email) {
      return {
        email: String(status.email).trim().toLowerCase(),
        name: String(status.name || "").trim(),
      };
    }
    if (status.state === "error") throw new Error(status.error || "Google sign-in didn’t finish.");
  }
  throw new Error("Google sign-in is still waiting. Finish it on Google’s page, then try again.");
}

export async function beginSignIn(schoolHost) {
  const start = await portal("/api/managebac/login", { schoolHost });
  if (start.error) throw new Error(start.error);
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    await wait(1500);
    const status = await portal("/api/managebac/status", { schoolHost });
    if (status.state === "ready") return;
    if (status.state === "error") throw new Error(status.error || "Sign-in didn’t finish.");
  }
  throw new Error("Sign-in is still waiting. Use Google in the ManageBac window, then try again.");
}

async function runSync(state) {
  const link = state.managebac;
  if (!link?.schoolHost) throw new Error("Add your school’s ManageBac address.");
  const data = await portal("/api/managebac/tasks", { schoolHost: link.schoolHost });
  if (data.loggedOut) {
    link.signedIn = false;
    throw new Error(data.error || "Sign in to ManageBac with Google again.");
  }
  if (data.error) throw new Error(data.error);
  const { date } = nowParts();
  let added = 0;
  let scheduled = 0;
  let updated = 0;
  for (const remote of data.tasks || []) {
    if (!remote.id || !remote.title) continue;
    const subjectId = ensureSubject(state, subjectLabel(remote.course));
    const outcome = importTask(state, {
      id: remote.id,
      name: remote.title,
      notes: remote.course || "",
      due_date: remote.due || "",
      category: { name: remote.course || "" },
      assessment_type: {},
    }, {
      subjectId,
      schoolHost: link.schoolHost,
      today: date,
      href: remote.href || "",
      done: isDone(remote.status),
    });
    added += outcome.added;
    updated += outcome.updated;
    scheduled += outcome.scheduled;
  }
  if (added > 0) {
    const parts = nowParts();
    repackSchedule(state, parts.date, parts.min);
  }
  link.signedIn = true;
  link.lastSync = new Date().toISOString();
  link.lastError = "";
  return { added, updated, scheduled };
}

function isDone(status) {
  const value = String(status || "").toLowerCase();
  return value === "submitted" || value === "completed" || value === "complete" || value === "returned" || value === "excused";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function portal(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn’t reach the ORDUP server. Start it with python3 server.py.");
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 404) {
    throw new Error("Start ORDUP with python3 server.py so it can open ManageBac.");
  }
  return data;
}

function importTask(state, remote, context) {
  const kind = classifyTask(remote);
  const due = dueDate(remote.due_date, context.today);
  const id = `mb-${remote.id}`;
  const description = String(remote.notes || "").trim();
  const notes = "";
  const link = context.href || (context.schoolHost
    ? `https://${context.schoolHost}/student/tasks/${remote.id}`
    : "");
  let task = state.tasks.find((item) => item.id === id || item.managebacId === remote.id);
  if (task) {
    const changed = task.title !== remote.name || task.due !== due || task.description !== description || (context.done && task.status !== "completed");
    task.title = remote.name;
    task.description = description;
    task.due = due;
    task.subjectId = context.subjectId;
    task.link = link;
    task.managebacId = remote.id;
    if (context.done) markDone(state, task);
    if (changed) return { added: 0, updated: 1, scheduled: 0 };
    return { added: 0, updated: 0, scheduled: 0 };
  }
  const estimated = estimateMinutes(state, {
    subjectId: context.subjectId,
    type: kind.type,
    difficulty: kind.difficulty,
    title: remote.name,
    description,
  });
  task = {
    id,
    managebacId: remote.id,
    source: "managebac",
    subjectId: context.subjectId,
    type: kind.type,
    title: remote.name,
    description,
    assigned: context.today,
    due,
    difficulty: kind.difficulty,
    estimated,
    actual: null,
    priority: kind.type === "exam" || kind.type === "test" ? "high" : "medium",
    status: "unplanned",
    notes,
    link,
    attachmentName: "",
  };
  state.tasks.unshift(task);
  if (context.done) {
    markDone(state, task);
    return { added: 1, updated: 0, scheduled: 0 };
  }
  const slots = planTask(state, task, context.today);
  for (const slot of slots) {
    state.sessions.push({
      id: uid(),
      taskId: task.id,
      date: slot.date,
      start: slot.start,
      end: slot.end,
      status: "planned",
      label: slot.label || "",
    });
  }
  if (slots.length) task.status = "planned";
  noteNewTask(state, task, context.today);
  return { added: 1, updated: 0, scheduled: slots.length ? 1 : 0 };
}

function noteNewTask(state, task, today) {
  state.notices ||= [];
  const id = `mb-new-${task.id}`;
  if (state.notices.some((item) => item.id === id)) return;
  const subject = state.subjects.find((item) => item.id === task.subjectId);
  const session = state.sessions
    .filter((item) => item.taskId === task.id && item.status === "planned")
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))[0];
  const when = session
    ? `${relativeDay(session.date, today)} ${formatRange(session.start, session.end)}`
    : "no recommended time";
  state.notices.unshift({
    id,
    title: `Task for ${subject?.name || "class"}, ${task.title}, ${when}`,
    body: "Added to Tasks.",
  });
  state.notices = state.notices.slice(0, 30);
}

function markDone(state, task) {
  task.status = "completed";
  for (const session of state.sessions) {
    if (session.taskId === task.id && session.status === "planned") session.status = "removed";
  }
}

function planTask(state, task, today) {
  if (!task.due || task.due < today) return [];
  const { min } = nowParts();
  const minutes = Number(task.estimated) || 30;
  const slots = pickRecommendations(recommend(state, {
    duration: blockLength(minutes),
    due: task.due,
    today,
    nowMin: min,
  }));
  return slots[0] ? [slots[0]] : [];
}

function subjectLabel(course) {
  const text = String(course || "Class").trim();
  const match = text.match(/:\s*([^[]+?)(?:\s*\[|\s*\(|$)/);
  return (match ? match[1] : text).trim() || "Class";
}

function ensureSubject(state, label) {
  const name = String(label || "Class").trim();
  const hay = name.toLowerCase();
  const existing = state.subjects.find((subject) => {
    const full = subject.name.toLowerCase();
    if (hay === full || hay === subject.short.toLowerCase()) return true;
    return full.length >= 4 && (hay.includes(full) || full.includes(hay));
  });
  if (existing) return existing.id;
  const id = `mb-${hay.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "class"}`;
  const taken = state.subjects.find((subject) => subject.id === id);
  if (taken) return taken.id;
  state.subjects.push({
    id,
    name,
    short: name.split(/\s+/)[0].slice(0, 12),
    teacher: "",
    color: PALETTE[state.subjects.length % PALETTE.length],
  });
  return id;
}
