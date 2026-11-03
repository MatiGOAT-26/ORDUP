import { clone, uid } from "./time.js";
import { blankManagebac, createEmptyState, freshUi } from "./model.js";

const KEY = "ordup.v1";
let state = null;
let listener = () => {};

export function getState() {
  return state;
}

export function subscribe(fn) {
  listener = fn;
}

export function commit() {
  persist();
  listener();
}

export function initState() {
  const params = new URLSearchParams(location.search);
  if (params.has("reset")) localStorage.removeItem(KEY);
  const saved = load();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  state = saved && saved.user?.routine && Array.isArray(saved.tasks) ? saved : createEmptyState(zone);
  state.ui = freshUi(state.ui || {});
  state.exceptions ||= [];
  state.overrides ||= [];
  state.changes ||= [];
  state.messages ||= [];
  state.dismissed ||= [];
  state.notices ||= [];
  state.history ||= [];
  state.chores ||= [];
  state.memory ||= [];
  state.managebac = { ...blankManagebac(), ...(state.managebac || {}) };
  if (!state.user.timezone || state.user.timezone === "local") {
    state.user.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  }
  const tab = location.hash.replace("#", "");
  if (["today", "schedule", "tasks", "chores", "calendar"].includes(tab)) state.ui.tab = tab;
  if (state.ui.tab === "schedule") state.ui.scheduleDate = "";
  return state;
}

export function replaceState(next) {
  state = next;
  state.ui = freshUi();
  commit();
}

export function loadEmpty() {
  const zone = state?.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  replaceState(createEmptyState(zone));
}

export function snapshot() {
  return clone({
    classes: state.classes,
    exceptions: state.exceptions,
    overrides: state.overrides,
    tasks: state.tasks,
    sessions: state.sessions,
    events: state.events,
    history: state.history,
    chores: state.chores || [],
    subjects: state.subjects,
  });
}

export function applyProposal(proposal) {
  const undo = snapshot();
  applyPatch(state, proposal.patch || {});
  const change = {
    id: uid(),
    at: new Date().toISOString(),
    label: proposal.log || "Schedule updated",
    undo,
    undone: false,
  };
  state.changes.unshift(change);
  state.changes = state.changes.slice(0, 20);
  state.ui.toast = { text: "Schedule updated", changeId: change.id };
  return change;
}

export function undoChange(id) {
  const change = state.changes.find((item) => item.id === id && !item.undone);
  if (!change) return false;
  Object.assign(state, clone(change.undo));
  change.undone = true;
  state.ui.toast = { text: "Change undone", changeId: null };
  return true;
}

function applyPatch(target, patch) {
  target.chores ||= [];
  target.subjects ||= [];
  for (const subject of patch.subjects || []) {
    if (!target.subjects.some((item) => item.id === subject.id)) target.subjects.push(subject);
  }
  for (const item of patch.events || []) {
    const event = target.events.find((entry) => entry.id === item.id);
    if (!event) {
      if (item.create) target.events.push({ ...pick(item, ["id", "title", "date", "start", "end", "location"]), removed: false });
      continue;
    }
    if (item.remove) event.removed = true;
    else Object.assign(event, pick(item, ["start", "end", "date", "location", "title"]));
  }
  for (const item of patch.sessions || []) {
    const session = target.sessions.find((entry) => entry.id === item.id);
    if (!session) {
      if (item.create) target.sessions.push(pick(item, ["id", "taskId", "date", "start", "end", "status", "label"]));
      continue;
    }
    if (item.remove) session.status = "removed";
    else Object.assign(session, pick(item, ["start", "end", "date", "status", "label"]));
  }
  for (const item of patch.tasks || []) {
    const task = target.tasks.find((entry) => entry.id === item.id);
    if (!task) {
      if (item.create) {
        target.tasks.unshift(pick(item, ["id", "subjectId", "type", "title", "description", "assigned", "due", "difficulty", "estimated", "actual", "priority", "status", "notes", "link", "attachmentName", "source"]));
      }
      continue;
    }
    Object.assign(task, pick(item, ["status", "due", "actual", "estimated", "title", "priority", "notes"]));
  }
  for (const item of patch.chores || []) {
    const chore = target.chores.find((entry) => entry.id === item.id);
    if (!chore) {
      if (item.create) target.chores.unshift(pick(item, ["id", "title", "done", "estimated", "date", "start", "end", "repeatEvery", "repeatUnit", "doneDates"]));
      continue;
    }
    Object.assign(chore, pick(item, ["title", "done", "estimated", "date", "start", "end", "repeatEvery", "repeatUnit", "doneDates"]));
  }
  for (const item of patch.classes || []) {
    const lesson = target.classes.find((entry) => entry.id === item.id);
    const fields = ["title", "subjectId", "start", "end", "room", "teacher", "notes", "startDate", "repeatEvery", "repeatUnit", "recurrence", "day", "date"];
    if (!lesson) {
      if (item.create) target.classes.push(pick(item, ["id", ...fields]));
      continue;
    }
    Object.assign(lesson, pick(item, fields));
  }
  if (patch.taskRemovals?.length) {
    const ids = new Set(patch.taskRemovals);
    target.tasks = target.tasks.filter((task) => !ids.has(task.id));
    for (const session of target.sessions) {
      if (ids.has(session.taskId)) session.status = "removed";
    }
  }
  if (patch.choreRemovals?.length) {
    const ids = new Set(patch.choreRemovals);
    target.chores = (target.chores || []).filter((chore) => !ids.has(chore.id));
  }
  if (patch.exceptions?.length) target.exceptions.push(...patch.exceptions);
  if (patch.overrides?.length) target.overrides.push(...patch.overrides);
  if (patch.overrideRemovals?.length) {
    const ids = new Set(patch.overrideRemovals);
    target.overrides = target.overrides.filter((item) => !ids.has(item.id));
  }
  if (patch.classRemovals?.length) {
    target.classes = target.classes.filter((lesson) => !patch.classRemovals.includes(lesson.id));
  }
  if (patch.history?.length) target.history.push(...patch.history);
}

function pick(source, keys) {
  const next = {};
  for (const key of keys) {
    if (source[key] !== undefined) next[key] = source[key];
  }
  return next;
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || raw.version !== 2) return null;
    return raw;
  } catch {
    return null;
  }
}

function persist() {
  try {
    const copy = clone(state);
    copy.ui = {
      tab: state.ui.tab,
      calendarMode: state.ui.calendarMode,
      calendarDate: state.ui.calendarDate,
      scheduleDate: state.ui.scheduleDate,
      taskFilter: state.ui.taskFilter,
    };
    localStorage.setItem(KEY, JSON.stringify(copy));
  } catch {
    state.ui.toast = { text: "Couldn’t save on this browser", changeId: null };
  }
}

export { uid };
