import {
  agenda,
  blockLength,
  busyBlocks,
  classOccurs,
  estimateMinutes,
  freeWindows,
  guessChoreMinutes,
  nextUp,
  overlaps,
  recommend,
  repackSchedule,
  subjectById,
} from "./engine.js";
import {
  addDays,
  clone,
  endOfWeek,
  formatRange,
  formatTime,
  fromMin,
  longDate,
  relativeDay,
  toMin,
  uid,
  WEEKDAYS,
  weekday,
} from "./time.js";

const ASSISTANT = `You are ORDUP, a normal assistant, the same kind of assistant as Gemini, Grok, or Claude. Answer the question the student actually asked, in plain language.

You can also change their calendar. Reply with one JSON object and nothing else:
{"say":"your reply","actions":[]}

Put actions only when they want something added, changed, moved, or removed. Otherwise actions is an empty array.
Do not list their tasks unless they asked what is due, what homework they have, or what is on a day.

Actions use a "do" field:
- add-task: title, subject, due (YYYY-MM-DD), minutes, date (optional), start (optional, 24-hour HH:MM)
- add-event: title, date, start, end, location
- add-class: title, date, start, end, repeatEvery (number), repeatUnit ("day" or "week")
- add-chore: title, repeatEvery (0 means once), repeatUnit ("day" or "week")
- move: what (name already on the calendar), date, start, end. toDate moves one class to another day. series true changes the repeating time.
- complete: what
- cancel: what, date
- delete: what
Use names from the calendar when changing something that already exists. Do not invent homework or classes.`;

const SYSTEM = ASSISTANT;

const COLORS = ["#6D4AFF", "#E36A45", "#1F9D8A", "#C8962E", "#3A7BD5", "#D4537E", "#7C6AD8"];
const DOS = {
  "add-task": "add-task",
  add_task: "add-task",
  "add task": "add-task",
  "create-task": "add-task",
  move: "move",
  reschedule: "move",
  "add-event": "add-event",
  add_event: "add-event",
  "add-class": "add-class",
  add_class: "add-class",
  "add-chore": "add-chore",
  add_chore: "add-chore",
  complete: "complete",
  finish: "complete",
  done: "complete",
  cancel: "cancel",
  skip: "cancel",
  delete: "delete",
  remove: "delete",
  rename: "rename",
  change: "rename",
  remember: "remember",
  note: "remember",
};

let model = null;
let creating = null;
let modelProblem = null;
let tail = Promise.resolve();

export function prepareModel(onStatus) {
  if (model || creating || typeof LanguageModel === "undefined") return creating;
  modelProblem = null;
  creating = createModel(onStatus).then((session) => {
    model = session;
    return session;
  }).catch((error) => {
    creating = null;
    model = null;
    modelProblem = error;
    return null;
  });
  return creating;
}

async function ensureModel(onStatus) {
  if (model) return model;
  if (typeof LanguageModel === "undefined") throw new Error("unavailable");
  if (!creating) prepareModel(onStatus);
  const session = creating ? await creating : model;
  if (session) return session;
  throw modelProblem || new Error("unavailable");
}

export function respond(text, state, today, nowMin, onStatus) {
  const run = tail.then(() => answer(text, state, today, nowMin, onStatus));
  tail = run.then(() => {}, () => {});
  return run;
}

export function respondChoice(pending, choice, state, today, nowMin) {
  if (!pending || pending.type !== "pick") return { text: "That choice has expired. Ask me again." };
  const [kind, id] = String(choice).split(":");
  return planFromActions([{ ...pending.action, resolved: { kind, id } }], state, today, nowMin, pending.say);
}

export function planFromActions(actions, state, today, nowMin, say = "") {
  const working = clone(state);
  working.tasks ||= [];
  working.sessions ||= [];
  working.events ||= [];
  working.classes ||= [];
  working.chores ||= [];
  working.subjects ||= [];
  working.exceptions ||= [];
  working.overrides ||= [];
  const notes = [];
  const adds = [];
  const rest = [];
  for (const action of actions || []) {
    if (String(action.do || "").startsWith("add")) adds.push(action);
    else rest.push(action);
  }
  let scheduleNew = false;
  for (const action of adds) {
    const result = runAction(action, working, today, nowMin, notes);
    if (result?.choices) return choiceTurn(result, action, say);
    if (result?.added) scheduleNew = true;
  }
  if (scheduleNew) repackSchedule(working, today, nowMin);
  for (const action of rest) {
    const result = runAction(action, working, today, nowMin, notes);
    if (result?.choices) return choiceTurn(result, action, say);
  }
  const planned = describeChanges(state, working, today);
  const text = [say, ...notes].filter(Boolean).join(" ");
  if (!planned.groups.length) {
    return { text: text || "Tell me what to add, move, or change." };
  }
  return {
    text: text || "Here’s what I’d change.",
    proposal: {
      headline: "Proposed changes",
      groups: planned.groups,
      patch: planned.patch,
      log: planned.groups.map((group) => group.label).slice(0, 3).join(", "),
      primary: planned.primary,
      secondary: "Cancel",
    },
  };
}

async function answer(text, state, today, nowMin, onStatus) {
  const clean = String(text || "").trim();
  if (!clean) return { text: "Ask me anything, or tell me what to add, move, change, or remove." };
  const linked = linkChat(clean, state, today);
  const spoken = speak(linked, state, today, nowMin);
  if (spoken) return spoken;
  try {
    const raw = await askDevice(state, today, nowMin, linked, onStatus);
    if (raw && !/on-device model is not available/i.test(String(raw))) {
      const parsed = parseReply(raw) || { say: String(raw).trim(), actions: [] };
      return applyParsed(parsed, state, today, nowMin);
    }
  } catch {
    // The built-in model isn't available here. Answer from ORDUP instead.
  }
  return { text: "I can answer questions about your day, and I can add, move, change, or remove things on your calendar." };
}

function applyParsed(parsed, state, today, nowMin) {
  const remembered = [];
  const actions = [];
  for (const rawAction of (parsed.actions || []).slice(0, 8)) {
    const action = normalizeAction(rawAction);
    if (!action) continue;
    if (action.do === "remember") {
      if (action.text) remembered.push(action.text);
      continue;
    }
    actions.push(action);
  }
  if (remembered.length) {
    state.memory ||= [];
    for (const note of remembered) {
      state.memory.push({ kind: "note", text: note, at: new Date().toISOString() });
    }
    state.memory = state.memory.slice(-40);
  }
  const planned = planFromActions(actions, state, today, nowMin, parsed.say);
  if (!actions.length && remembered.length && !parsed.say) planned.text = "I’ll remember that.";
  return planned;
}

export function speak(text, state, today, nowMin) {
  const linked = linkChat(text, state, today);
  const command = commandFrom(linked, today) || commandFrom(expandFromMemory(linked, state), today);
  if (command?.actions?.length) return planFromActions(command.actions, state, today, nowMin, command.say || "");
  if (command?.say) return { text: command.say };
  const lower = linked.trim().toLowerCase();
  const name = state.user?.name?.split(" ")[0] || "";
  if (/^(hi|hello|hey|thanks|thank you)\b/.test(lower)) {
    return { text: `Hi${name ? ` ${name}` : ""}. Ask me anything about your day, or tell me what to add, move, change, or remove.` };
  }
  if (/^how are you\b/.test(lower)) return { text: "I’m here. What do you want to know, or what should I change on your calendar?" };
  const math = mathAnswer(linked);
  if (math) return { text: math };
  if (isQuestion(linked) || /^(what|when|where|who|why|how)\b/i.test(linked)) {
    const say = answerQuestion(linked, state, today, nowMin);
    if (say) return { text: say };
  }
  return null;
}

let deviceStub = false;

async function askDevice(state, today, nowMin, text, onStatus) {
  if (deviceStub || typeof LanguageModel === "undefined") {
    deviceStub = true;
    throw new Error("no-model");
  }
  const session = await ensureModel(onStatus);
  const prompt = chatMessages(state, today, nowMin, text).filter((item) => item.role !== "system").map((item) => item.content).join("\n\n");
  const raw = await Promise.race([
    session.prompt(prompt),
    new Promise((_, reject) => setTimeout(() => reject(new Error("no-model")), 4000)),
  ]);
  if (/on-device model is not available/i.test(String(raw))) {
    deviceStub = true;
    throw new Error("no-model");
  }
  return raw;
}

function chatMessages(state, today, nowMin, text) {
  const prior = (state.messages || []).slice(0, -2).slice(-8).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: String(message.text || "").slice(0, 2000),
  })).filter((message) => message.content);
  return [
    { role: "system", content: ASSISTANT },
    ...prior,
    { role: "user", content: `Today is ${longDate(today)}. The time is ${formatTime(nowMin)}.\n${calendarBrief(state, today)}\n\n${text}` },
  ];
}

function choiceTurn(result, action, say) {
  return {
    text: say ? `${say} Which one?` : "Which one do you mean?",
    choices: result.choices.map((hit) => ({ id: `${hit.kind}:${hit.id}`, label: `${hit.title} · ${hit.kind}` })),
    pending: { type: "pick", action, say },
  };
}

function runAction(action, working, today, nowMin, notes) {
  if (action.do === "add-task") return addTask(working, action, today, nowMin, notes);
  if (action.do === "add-event") return addEvent(working, action, today, nowMin, notes);
  if (action.do === "add-class") return addClass(working, action, today, notes);
  if (action.do === "add-chore") return addChore(working, action, today, notes);
  if (action.do === "move") return moveItem(working, action, today, notes);
  if (action.do === "complete") return completeItem(working, action, notes);
  if (action.do === "cancel") return cancelItem(working, action, today, notes);
  if (action.do === "delete") return deleteItem(working, action, notes);
  if (action.do === "rename") return renameItem(working, action, notes);
  notes.push("I can add, move, finish, or remove tasks, classes, events, and chores.");
  return null;
}

function addTask(working, action, today, nowMin, notes) {
  const title = cleanTitle(action.title || action.what);
  if (!title || blocked(title)) {
    notes.push("Tell me the name of the task.");
    return null;
  }
  const subject = action.subject
    ? ensureSubject(working, action.subject)
    : matchSubject(working, title) || ensureSubject(working, "General");
  const due = dateValue(action.due, today) || addDays(today, 7);
  const minutes = clampMinutes(action.minutes) || estimateMinutes(working, { title, subjectId: subject.id, type: "homework" });
  const task = {
    id: uid(),
    subjectId: subject.id,
    type: "homework",
    title,
    description: "",
    assigned: today,
    due,
    difficulty: "medium",
    estimated: minutes,
    actual: null,
    priority: "medium",
    status: "unplanned",
    notes: "",
    link: "",
    attachmentName: "",
    source: "ai",
  };
  working.tasks.unshift(task);
  placeTask(working, task, action, today, nowMin, notes, minutes);
  return { added: true };
}

function placeTask(working, task, action, today, nowMin, notes, minutes) {
  const explicitDate = dateValue(action.date, today);
  const explicitStart = clock(action.start);
  if (explicitDate && explicitStart) {
    const end = clock(action.end) || fromMin(toMin(explicitStart) + blockLength(minutes));
    if (toMin(end) > toMin(explicitStart) && intervalOpen(working, explicitDate, explicitStart, end)) {
      working.sessions.push({ id: uid(), taskId: task.id, date: explicitDate, start: explicitStart, end, status: "planned", label: "" });
      task.status = "planned";
      return;
    }
    notes.push(`${task.title} doesn’t fit at that time, so I looked for another opening.`);
  }
  if (task.due < today) {
    notes.push(`${task.title} is already due, so I didn’t pick a time.`);
    return;
  }
  const slot = recommend(working, { duration: blockLength(minutes), due: task.due, today, nowMin })[0];
  if (!slot) {
    notes.push(`I can add ${task.title}, but there isn’t a free time before it’s due.`);
    return;
  }
  working.sessions.push({ id: uid(), taskId: task.id, date: slot.date, start: slot.start, end: slot.end, status: "planned", label: "" });
  task.status = "planned";
}

function addEvent(working, action, today, nowMin, notes) {
  const title = cleanTitle(action.title || action.what);
  const date = dateValue(action.date, today);
  const start = clock(action.start);
  const end = clock(action.end) || (start ? fromMin(toMin(start) + 60) : "");
  if (!title || blocked(title) || !date || !start || !end || toMin(end) <= toMin(start)) {
    notes.push("I need a name, a day, and a start time to add an event.");
    return null;
  }
  const id = uid();
  working.events.push({ id, title, date, start, end, location: String(action.location || "").trim(), removed: false });
  slideOverlaps(working, date, start, end, today, nowMin);
  const clash = clashTitle(working, date, start, end, { ignoreEventIds: [id] });
  if (clash) notes.push(`${title} overlaps ${clash}.`);
  return null;
}

function slideOverlaps(working, date, start, end, today, nowMin) {
  const open = toMin(start);
  const close = toMin(end);
  for (const session of [...working.sessions]) {
    if (session.status !== "planned" || session.date !== date) continue;
    if (!overlaps(open, close, toMin(session.start), toMin(session.end))) continue;
    const duration = Math.max(15, toMin(session.end) - toMin(session.start));
    const previous = { date: session.date, start: session.start, end: session.end, status: "planned" };
    session.status = "removed";
    const task = working.tasks.find((item) => item.id === session.taskId);
    const due = task?.due && task.due >= today ? task.due : addDays(today, 14);
    const slot = recommend(working, {
      duration,
      due,
      today,
      nowMin,
      ignoreSessionIds: [session.id],
      fromDate: date,
    }).find((item) => item.date > date || item.startMin >= close);
    if (!slot) {
      Object.assign(session, previous);
      continue;
    }
    session.date = slot.date;
    session.start = slot.start;
    session.end = slot.end;
    session.status = "planned";
  }
}

function addClass(working, action, today, notes) {
  const title = cleanTitle(action.title || action.what);
  const date = dateValue(action.date, today) || today;
  const start = clock(action.start);
  const end = clock(action.end) || (start ? fromMin(toMin(start) + 50) : "");
  if (!title || blocked(title) || !start || !end || toMin(end) <= toMin(start)) {
    notes.push("I need a class name, a start time, and an end time.");
    return null;
  }
  const subject = ensureSubject(working, action.subject || title);
  const every = Math.max(1, Math.round(Number(action.repeatEvery) || 1));
  const unit = action.repeatUnit === "day" ? "day" : "week";
  working.classes.push({
    id: uid(),
    title,
    subjectId: subject.id,
    start,
    end,
    room: "",
    teacher: "",
    notes: "",
    startDate: date,
    repeatEvery: every,
    repeatUnit: unit,
    recurrence: "repeat",
    day: weekday(date),
  });
  return null;
}

function addChore(working, action, today, notes) {
  const title = cleanTitle(action.title || action.what);
  if (!title || blocked(title)) {
    notes.push("Tell me the chore.");
    return null;
  }
  const every = Math.round(Number(action.repeatEvery) || 0);
  const repeating = every > 0;
  const date = dateValue(action.date, today) || "";
  const start = clock(action.start);
  const minutes = guessChoreMinutes(title);
  const end = start ? (clock(action.end) || fromMin(toMin(start) + blockLength(minutes))) : "";
  working.chores.unshift({
    id: uid(),
    title,
    done: false,
    estimated: minutes,
    date: date && start ? date : "",
    start: date && start ? start : "",
    end: date && start ? end : "",
    repeatEvery: repeating ? every : 0,
    repeatUnit: repeating ? (action.repeatUnit === "week" ? "week" : "day") : "",
    doneDates: [],
  });
  return { added: true };
}

function moveItem(working, action, today, notes) {
  const found = resolve(working, action);
  if (found?.choices) return found;
  if (found?.error) {
    notes.push(found.error);
    return null;
  }
  const date = dateValue(action.date, today);
  const start = clock(action.start);
  if (!start && !date) {
    notes.push(`What time should I move ${found.hit.title} to?`);
    return null;
  }
  if (found.hit.kind === "task") return moveTask(working, found.hit, action, today, notes, date, start);
  if (found.hit.kind === "event") return moveEvent(working, found.hit, notes, date, start, clock(action.end));
  if (found.hit.kind === "chore") return moveChore(working, found.hit, notes, date, start, clock(action.end));
  if (found.hit.kind === "class") return moveClass(working, found.hit, action, today, notes, date, start, clock(action.end));
  notes.push(`I can’t move ${found.hit.title}.`);
  return null;
}

function moveTask(working, hit, action, today, notes, date, start) {
  const task = working.tasks.find((item) => item.id === hit.id);
  const session = working.sessions.find((item) => item.taskId === task.id && item.status !== "removed");
  const duration = session ? Math.max(15, toMin(session.end) - toMin(session.start)) : blockLength(task.estimated || 30);
  const destDate = date || session?.date || today;
  const destStart = start || session?.start || "";
  if (!destStart) {
    notes.push(`What time should I move ${task.title} to?`);
    return null;
  }
  const destEnd = clock(action.end) || fromMin(toMin(destStart) + duration);
  if (toMin(destEnd) <= toMin(destStart)) {
    notes.push("The end time needs to be after the start.");
    return null;
  }
  let sessionId = session?.id;
  if (session) {
    session.date = destDate;
    session.start = destStart;
    session.end = destEnd;
  } else {
    sessionId = uid();
    working.sessions.push({ id: sessionId, taskId: task.id, date: destDate, start: destStart, end: destEnd, status: "planned", label: "" });
    task.status = "planned";
  }
  const clash = clashTitle(working, destDate, destStart, destEnd, { ignoreSessionIds: [sessionId] });
  if (clash) notes.push(`That overlaps ${clash}.`);
  return null;
}

function moveEvent(working, hit, notes, date, start, end) {
  const event = working.events.find((item) => item.id === hit.id);
  const duration = Math.max(15, toMin(event.end) - toMin(event.start));
  const destDate = date || event.date;
  const destStart = start || event.start;
  const destEnd = end || fromMin(toMin(destStart) + duration);
  if (toMin(destEnd) <= toMin(destStart)) {
    notes.push("The end time needs to be after the start.");
    return null;
  }
  event.date = destDate;
  event.start = destStart;
  event.end = destEnd;
  const clash = clashTitle(working, destDate, destStart, destEnd, { ignoreEventIds: [event.id] });
  if (clash) notes.push(`That overlaps ${clash}.`);
  return null;
}

function moveChore(working, hit, notes, date, start, end) {
  const chore = working.chores.find((item) => item.id === hit.id);
  const duration = blockLength(chore.estimated || guessChoreMinutes(chore.title));
  const destDate = date || chore.date || "";
  const destStart = start || chore.start || "";
  if (!destDate || !destStart) {
    notes.push(`What time should I move ${chore.title} to?`);
    return null;
  }
  const destEnd = end || fromMin(toMin(destStart) + duration);
  chore.date = destDate;
  chore.start = destStart;
  chore.end = destEnd;
  return null;
}

function moveClass(working, hit, action, today, notes, date, start, end) {
  const lesson = working.classes.find((item) => item.id === hit.id);
  const destStart = start || lesson.start;
  const destEnd = end || lesson.end;
  if (toMin(destEnd) <= toMin(destStart)) {
    notes.push("The end time needs to be after the start.");
    return null;
  }
  if (action.series) {
    lesson.start = destStart;
    lesson.end = destEnd;
    return null;
  }
  const source = nextClassDate(lesson, today, date);
  if (!source) {
    notes.push(`I can’t find ${lesson.title} on that day.`);
    return null;
  }
  const destDate = dateValue(action.toDate, today) || source;
  working.exceptions.push({ id: uid(), classId: lesson.id, date: source, type: "cancel" });
  working.overrides.push({
    id: uid(),
    subjectId: lesson.subjectId,
    title: lesson.title,
    date: destDate,
    start: destStart,
    end: destEnd,
    room: lesson.room || "",
    teacher: lesson.teacher || "",
    color: subjectById(working, lesson.subjectId)?.color || "#3A7BD5",
    sourceClassId: lesson.id,
  });
  return null;
}

function completeItem(working, action, notes) {
  const found = resolve(working, action);
  if (found?.choices) return found;
  if (found?.error) {
    notes.push(found.error);
    return null;
  }
  if (found.hit.kind === "chore") {
    const chore = working.chores.find((item) => item.id === found.hit.id);
    chore.done = true;
    return null;
  }
  if (found.hit.kind !== "task") {
    notes.push(`I can mark homework or a chore done. ${found.hit.title} stays as it is.`);
    return null;
  }
  const task = working.tasks.find((item) => item.id === found.hit.id);
  task.status = "completed";
  for (const session of working.sessions) {
    if (session.taskId === task.id && session.status === "planned") session.status = "removed";
  }
  return null;
}

function cancelItem(working, action, today, notes) {
  const found = resolve(working, action);
  if (found?.choices) return found;
  if (found?.error) {
    notes.push(found.error);
    return null;
  }
  if (found.hit.kind === "event") {
    const event = working.events.find((item) => item.id === found.hit.id);
    event.removed = true;
    return null;
  }
  if (found.hit.kind === "class") {
    const lesson = working.classes.find((item) => item.id === found.hit.id);
    const date = nextClassDate(lesson, today, dateValue(action.date, today));
    if (!date) {
      notes.push(`I can’t find ${lesson.title} on that day.`);
      return null;
    }
    working.exceptions.push({ id: uid(), classId: lesson.id, date, type: "cancel" });
    return null;
  }
  if (found.hit.kind === "task") {
    for (const session of working.sessions) {
      if (session.taskId === found.hit.id && session.status === "planned") session.status = "removed";
    }
    const task = working.tasks.find((item) => item.id === found.hit.id);
    if (task?.status === "planned") task.status = "unplanned";
    return null;
  }
  if (found.hit.kind === "chore") {
    const chore = working.chores.find((item) => item.id === found.hit.id);
    const date = dateValue(action.date, today) || chore.date;
    if (chore.repeatEvery) {
      chore.doneDates ||= [];
      if (date && !chore.doneDates.includes(date)) chore.doneDates.push(date);
    } else chore.done = true;
    return null;
  }
  return null;
}

function renameItem(working, action, notes) {
  const found = resolve(working, action);
  if (found?.choices) return found;
  if (found?.error) {
    notes.push(found.error);
    return null;
  }
  const title = cleanTitle(action.title);
  if (!title) {
    notes.push("What should I change it to?");
    return null;
  }
  if (found.hit.kind === "task") working.tasks.find((item) => item.id === found.hit.id).title = title;
  else if (found.hit.kind === "event") working.events.find((item) => item.id === found.hit.id).title = title;
  else if (found.hit.kind === "class") working.classes.find((item) => item.id === found.hit.id).title = title;
  else if (found.hit.kind === "chore") working.chores.find((item) => item.id === found.hit.id).title = title;
  return null;
}

function deleteItem(working, action, notes) {
  const found = resolve(working, action);
  if (found?.choices) return found;
  if (found?.error) {
    notes.push(found.error);
    return null;
  }
  if (found.hit.kind === "task") {
    working.tasks = working.tasks.filter((item) => item.id !== found.hit.id);
    working.sessions = working.sessions.filter((item) => item.taskId !== found.hit.id);
    return null;
  }
  if (found.hit.kind === "event") {
    const event = working.events.find((item) => item.id === found.hit.id);
    event.removed = true;
    return null;
  }
  if (found.hit.kind === "class") {
    working.classes = working.classes.filter((item) => item.id !== found.hit.id);
    return null;
  }
  if (found.hit.kind === "chore") {
    working.chores = working.chores.filter((item) => item.id !== found.hit.id);
    return null;
  }
  notes.push(`I can’t remove ${found.hit.title}.`);
  return null;
}

function resolve(working, action, only = null) {
  if (action.resolved?.id) {
    const hit = hitById(working, action.resolved.kind, action.resolved.id);
    return hit ? { hit } : { error: "That choice is no longer on the calendar." };
  }
  const what = action.what || action.title;
  if (!what || blocked(what)) return { error: "Tell me the name of the one thing to change." };
  let hits = candidates(working, what);
  if (only) hits = hits.filter((hit) => only.includes(hit.kind));
  if (!hits.length) return { error: `I can’t find “${cleanTitle(what)}” on your calendar.` };
  const best = hits[0].score;
  const top = hits.filter((hit) => hit.score === best);
  if (top.length > 1) return { choices: top.slice(0, 4) };
  return { hit: top[0] };
}

function candidates(working, what) {
  const hits = [];
  for (const task of working.tasks) {
    if (task.status === "completed") continue;
    const score = scoreName(what, task.title);
    if (score) hits.push({ kind: "task", id: task.id, title: task.title, score });
  }
  for (const event of working.events) {
    if (event.removed) continue;
    const score = scoreName(what, event.title);
    if (score) hits.push({ kind: "event", id: event.id, title: event.title, score });
  }
  for (const lesson of working.classes) {
    const score = scoreName(what, lesson.title);
    if (score) hits.push({ kind: "class", id: lesson.id, title: lesson.title, score });
  }
  for (const chore of working.chores || []) {
    if (chore.done) continue;
    const score = scoreName(what, chore.title);
    if (score) hits.push({ kind: "chore", id: chore.id, title: chore.title, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

function hitById(working, kind, id) {
  if (kind === "task") {
    const task = working.tasks.find((item) => item.id === id && item.status !== "completed");
    return task ? { kind, id, title: task.title, score: 100 } : null;
  }
  if (kind === "event") {
    const event = working.events.find((item) => item.id === id && !item.removed);
    return event ? { kind, id, title: event.title, score: 100 } : null;
  }
  if (kind === "class") {
    const lesson = working.classes.find((item) => item.id === id);
    return lesson ? { kind, id, title: lesson.title, score: 100 } : null;
  }
  if (kind === "chore") {
    const chore = (working.chores || []).find((item) => item.id === id && !item.done);
    return chore ? { kind, id, title: chore.title, score: 100 } : null;
  }
  return null;
}

function describeChanges(before, after, today) {
  const patch = {
    tasks: [],
    sessions: [],
    events: [],
    chores: [],
    classes: [],
    exceptions: [],
    overrides: [],
    subjects: [],
    taskRemovals: [],
    choreRemovals: [],
    classRemovals: [],
  };
  const groups = [];
  const beforeTasks = before.tasks || [];
  const beforeSessions = before.sessions || [];
  const removedTasks = new Set();
  const completed = new Set();

  for (const subject of after.subjects || []) {
    if (!(before.subjects || []).some((item) => item.id === subject.id)) patch.subjects.push(subject);
  }
  for (const task of after.tasks) {
    const prev = beforeTasks.find((item) => item.id === task.id);
    if (!prev) {
      patch.tasks.push({ ...task, create: true });
      const session = after.sessions.find((item) => item.taskId === task.id && item.status !== "removed");
      groups.push({
        label: task.title,
        from: "Not on the calendar",
        to: session ? stamp(session.date, session.start, session.end, today) : "Saved without a time",
      });
      continue;
    }
    if (prev.status !== "completed" && task.status === "completed") completed.add(task.id);
    const changed = {};
    for (const key of ["status", "due", "title", "estimated", "priority", "notes"]) {
      if (task[key] !== prev[key]) changed[key] = task[key];
    }
    if (Object.keys(changed).length) patch.tasks.push({ id: task.id, ...changed });
    if (changed.status === "completed") groups.push({ label: task.title, from: "To do", to: "Done" });
    else if (changed.title) groups.push({ label: task.title, from: prev.title, to: task.title });
    else if (changed.due && !changed.status) groups.push({ label: task.title, from: prev.due || "No due date", to: task.due });
  }
  for (const task of beforeTasks) {
    if (!after.tasks.some((item) => item.id === task.id)) {
      removedTasks.add(task.id);
      patch.taskRemovals.push(task.id);
      groups.push({ label: task.title, from: "On the calendar", to: "Removed" });
    }
  }
  for (const session of after.sessions) {
    if (removedTasks.has(session.taskId)) continue;
    const prev = beforeSessions.find((item) => item.id === session.id);
    const task = after.tasks.find((item) => item.id === session.taskId);
    const label = task?.title || "Homework";
    if (!prev) {
      if (session.status === "removed") continue;
      patch.sessions.push({ ...session, create: true });
      if (!patch.tasks.some((item) => item.id === session.taskId && item.create)) {
        groups.push({ label, from: "Not scheduled", to: stamp(session.date, session.start, session.end, today) });
      }
      continue;
    }
    const same = prev.date === session.date && prev.start === session.start && prev.end === session.end && prev.status === session.status;
    if (same) continue;
    patch.sessions.push({ id: session.id, date: session.date, start: session.start, end: session.end, status: session.status });
    if (completed.has(session.taskId)) continue;
    groups.push({
      label,
      from: stamp(prev.date, prev.start, prev.end, today),
      to: session.status === "removed" ? "Taken off the plan" : stamp(session.date, session.start, session.end, today),
    });
  }
  for (const event of after.events || []) {
    const prev = (before.events || []).find((item) => item.id === event.id);
    if (!prev) {
      patch.events.push({ ...event, create: true });
      groups.push({ label: event.title, from: "Not on the calendar", to: stamp(event.date, event.start, event.end, today) });
    } else if (event.removed && !prev.removed) {
      patch.events.push({ id: event.id, remove: true });
      groups.push({ label: event.title, from: stamp(prev.date, prev.start, prev.end, today), to: "Removed" });
    } else if (!event.removed && (prev.date !== event.date || prev.start !== event.start || prev.end !== event.end || prev.title !== event.title)) {
      patch.events.push({ id: event.id, date: event.date, start: event.start, end: event.end, title: event.title, location: event.location });
      const sameTime = prev.date === event.date && prev.start === event.start && prev.end === event.end;
      groups.push({
        label: event.title,
        from: sameTime ? prev.title : stamp(prev.date, prev.start, prev.end, today),
        to: sameTime ? event.title : stamp(event.date, event.start, event.end, today),
      });
    }
  }
  for (const chore of after.chores || []) {
    const prev = (before.chores || []).find((item) => item.id === chore.id);
    if (!prev) {
      patch.chores.push({ ...chore, create: true });
      groups.push({
        label: chore.title,
        from: "Not on the calendar",
        to: chore.start ? stamp(chore.date, chore.start, chore.end, today) : "Saved, no free time",
      });
    } else if (prev.title !== chore.title || prev.date !== chore.date || prev.start !== chore.start || prev.end !== chore.end || prev.done !== chore.done || JSON.stringify(prev.doneDates || []) !== JSON.stringify(chore.doneDates || [])) {
      patch.chores.push({ id: chore.id, title: chore.title, date: chore.date, start: chore.start, end: chore.end, done: chore.done, estimated: chore.estimated, doneDates: chore.doneDates });
      groups.push({
        label: chore.title,
        from: prev.title !== chore.title ? prev.title : (prev.start ? stamp(prev.date, prev.start, prev.end, today) : "Chore"),
        to: prev.title !== chore.title && prev.start === chore.start ? chore.title : (chore.done ? "Done" : stamp(chore.date, chore.start, chore.end, today)),
      });
    }
  }
  for (const chore of before.chores || []) {
    if (!(after.chores || []).some((item) => item.id === chore.id)) {
      patch.choreRemovals.push(chore.id);
      groups.push({ label: chore.title, from: "Chore", to: "Removed" });
    }
  }
  for (const lesson of after.classes || []) {
    const prev = (before.classes || []).find((item) => item.id === lesson.id);
    if (!prev) {
      patch.classes.push({ ...lesson, create: true });
      groups.push({ label: lesson.title, from: "Not on the calendar", to: `${stamp(lesson.startDate, lesson.start, lesson.end, today)} · repeats` });
    } else if (prev.start !== lesson.start || prev.end !== lesson.end || prev.title !== lesson.title) {
      patch.classes.push({ id: lesson.id, title: lesson.title, start: lesson.start, end: lesson.end });
      groups.push({ label: lesson.title, from: formatRange(prev.start, prev.end), to: `${formatRange(lesson.start, lesson.end)} every time` });
    }
  }
  for (const lesson of before.classes || []) {
    if (!(after.classes || []).some((item) => item.id === lesson.id)) {
      patch.classRemovals.push(lesson.id);
      groups.push({ label: lesson.title, from: "Repeating class", to: "Removed" });
    }
  }
  const newOverrides = (after.overrides || []).filter((item) => !(before.overrides || []).some((prev) => prev.id === item.id));
  for (const exception of after.exceptions || []) {
    if ((before.exceptions || []).some((item) => item.id === exception.id)) continue;
    patch.exceptions.push(exception);
    const moved = newOverrides.find((item) => item.sourceClassId === exception.classId);
    if (moved) continue;
    const lesson = (before.classes || []).find((item) => item.id === exception.classId);
    groups.push({ label: lesson?.title || "Class", from: relativeDay(exception.date, today), to: "Cancelled once" });
  }
  for (const override of newOverrides) {
    patch.overrides.push(override);
    groups.push({ label: override.title || "Class", from: "That class", to: stamp(override.date, override.start, override.end, today) });
  }

  const used = {};
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value) && value.length) used[key] = value;
  }
  const primary = groups.every((group) => group.from === "Not on the calendar")
    ? "Add it"
    : groups.every((group) => group.to === "Removed" || group.to === "Cancelled once")
      ? "Remove"
      : "Apply";
  return { groups, patch: used, primary };
}

function userPrompt(state, today, nowMin, text) {
  const prior = (state.messages || []).slice(-7, -1).map((message) => `${message.role === "user" ? "Student" : "ORDUP"}: ${message.text}`).join("\n");
  return `Today is ${longDate(today)}. The time is ${formatTime(nowMin)}.
${calendarBrief(state, today)}
${prior ? `Recent chat:\n${prior}\n` : ""}
Student: ${text}`;
}

function calendarBrief(state, today) {
  const routine = state.user?.routine || {};
  const lines = [`Wake ${routine.wake || "?"}, school ${routine.schoolStart || "?"}-${routine.schoolEnd || "?"}, dinner ${routine.dinner || "?"}-${routine.dinnerEnd || "?"}, bed ${routine.bed || "?"}.`];
  const classes = state.classes || [];
  lines.push(classes.length ? "Classes:" : "Classes: none.");
  for (const lesson of classes.slice(0, 20)) {
    lines.push(`- ${lesson.title}, ${lesson.start}-${lesson.end}, every ${lesson.repeatEvery || 1} ${lesson.repeatUnit || "week"} from ${lesson.startDate}`);
  }
  const events = (state.events || []).filter((event) => !event.removed && event.date >= today && event.date <= addDays(today, 21));
  lines.push(events.length ? "Events:" : "Events: none.");
  for (const event of events.slice(0, 12)) lines.push(`- ${event.title}, ${event.date} ${event.start}-${event.end}`);
  const chores = (state.chores || []).filter((chore) => !chore.done);
  lines.push(chores.length ? "Chores:" : "Chores: none.");
  for (const chore of chores.slice(0, 12)) lines.push(`- ${chore.title}${chore.start ? `, ${chore.date} ${chore.start}-${chore.end}` : ""}`);
  const tasks = (state.tasks || []).filter((task) => task.status !== "completed").sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  lines.push(tasks.length ? "Homework still to do:" : "Homework still to do: none.");
  for (const task of tasks.slice(0, 24)) {
    const session = (state.sessions || []).find((item) => item.taskId === task.id && item.status !== "removed");
    const subject = subjectById(state, task.subjectId)?.name || "";
    const when = session ? `${session.date} ${session.start}-${session.end}` : "not scheduled";
    lines.push(`- ${task.title}${subject ? ` (${subject})` : ""}, due ${task.due || "unknown"}, ${when}`);
  }
  if (tasks.length > 24) lines.push(`- and ${tasks.length - 24} more`);
  const notes = (state.memory || []).slice(-8).map((item) => item.text || (item.name ? `Saved schedule ${item.name}` : "")).filter(Boolean);
  if (notes.length) lines.push(`Notes: ${notes.join(" | ").slice(0, 500)}`);
  return lines.join("\n");
}

async function createModel(onStatus) {
  const options = {
    initialPrompts: [{ role: "system", content: SYSTEM }],
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        const loaded = Number(event.loaded);
        if (!Number.isFinite(loaded) || loaded <= 0) return;
        const pct = loaded <= 1 ? Math.round(loaded * 100) : Math.round(loaded);
        onStatus?.(`Getting the assistant ready… ${Math.min(99, pct)}%`);
      });
    },
  };
  try {
    return await LanguageModel.create(options);
  } catch (error) {
    if (!/expected/i.test(String(error?.message || error))) throw error;
    delete options.expectedInputs;
    delete options.expectedOutputs;
    return LanguageModel.create(options);
  }
}

export function understand(text, state, today, nowMin) {
  const command = commandFrom(text, today) || commandFrom(expandFromMemory(text, state), today);
  if (command?.actions?.length) return command;
  if (isQuestion(text)) {
    return { say: answerQuestion(text, state, today, nowMin), actions: [] };
  }
  return command;
}

function linkChat(text, state, today) {
  const expanded = expandChatWords(text).trim();
  if (!isFollowUp(expanded)) return expanded;
  const root = rootQuestion(state);
  if (!root) return expanded;
  const focus = expanded
    .replace(/^(what|how) about\s+/i, "")
    .replace(/^(and|then)\s+/i, "")
    .replace(/^same(?:\s+for)?\s+/i, "")
    .replace(/[?!.]+$/g, "")
    .trim();
  const day = isDayish(focus) ? focus : isDayish(expanded) ? expanded.replace(/[?!.]+$/g, "") : "";
  if (day) {
    const reusable = isQuestion(root) || /\b(free|busy|available|homework|due|schedule|dinner|school|wake|bed|next|class|event|chore)\b/i.test(root);
    return reusable ? swapDay(root, day) : day;
  }
  return `${root} ${focus}`.replace(/\s+/g, " ").trim();
}

function rootQuestion(state) {
  const users = priorMessages(state).filter((message) => message.role === "user");
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const text = expandChatWords(users[index].text || "");
    if (!isFollowUp(text)) return text;
  }
  return expandChatWords(users[users.length - 1]?.text || "");
}

function priorMessages(state) {
  const messages = (state.messages || []).filter((message) => message.text && message.text !== "Thinking…");
  if (messages.length && messages[messages.length - 1].role === "user") messages.pop();
  return messages;
}

function expandChatWords(text) {
  return String(text || "")
    .replace(/\b(tmrw|tmr|tmoz|2moro|2mrw|tomo)\b/gi, "tomorrow")
    .replace(/\btdy\b/gi, "today")
    .replace(/\b2nite\b/gi, "tonight")
    .replace(/\bwhat abt\b/gi, "what about")
    .replace(/\bhow abt\b/gi, "how about");
}

function isFollowUp(text) {
  const lower = String(text || "").trim().toLowerCase().replace(/[?!.]+$/g, "");
  if (/^(what|how) about\b/.test(lower)) {
    const rest = lower.replace(/^(what|how) about\s+/, "");
    return isDayish(rest) || rest.split(/\s+/).filter(Boolean).length <= 3;
  }
  if (/^(and|then)\s+/.test(lower) && lower.split(/\s+/).length <= 5) return true;
  if (/^same\b/.test(lower) && lower.split(/\s+/).length <= 5) return true;
  return isDayish(lower);
}

function isDayish(text) {
  const lower = String(text || "").trim().toLowerCase().replace(/[?!.]+$/g, "");
  return /^(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening|night))?$/.test(lower);
}

function swapDay(previous, day) {
  const rest = String(previous || "")
    .replace(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${rest} ${day}`.replace(/\s+/g, " ").trim();
}

function expandFromMemory(text, state) {
  if (findClock(text) || findDate(text, "2000-01-01")) return text;
  const skip = new Set(["have", "this", "that", "with", "from", "your", "schedule", "move", "task", "homework", "please"]);
  const words = norm(text).split(" ").filter((word) => word.length > 3 && !skip.has(word));
  const note = [...(state.memory || [])].reverse().find((item) => {
    const hay = norm(item.text || "");
    return words.some((word) => hay.includes(word));
  });
  return note?.text ? `${text}. ${note.text}` : text;
}

function commandFrom(text, today) {
  const cleaned = text.replace(/^(please\s+)?(can you\s+|could you\s+)?/i, "").trim();
  const lower = cleaned.toLowerCase();
  if (/^remember\b/.test(lower)) {
    return { say: "", actions: [{ do: "remember", text: tidy(cleaned.replace(/^remember\s+(that\s+)?/i, "")) }] };
  }
  if (/^(change|update|edit|rename)\b/.test(lower)) {
    const parts = cleaned.match(/^(?:change|update|edit|rename)\s+(.+?)\s+to\s+(.+)$/i);
    if (!parts) return null;
    if (findClock(parts[2]) || findDate(parts[2], today)) {
      return {
        say: "",
        actions: [{ do: "move", what: tidy(parts[1]), date: findDate(parts[2], today) || findDate(cleaned, today), start: findClock(parts[2]) }],
      };
    }
    return { say: "", actions: [{ do: "rename", what: tidy(parts[1]), title: tidy(parts[2]) }] };
  }
  if (/^(move|reschedule|shift)\b/.test(lower)) {
    const parts = cleaned.match(/^(?:move|reschedule|shift)\s+(.+?)\s+(?:to|at)\s+(.+)$/i);
    if (!parts) return null;
    return {
      say: "",
      actions: [{ do: "move", what: tidy(parts[1]), date: findDate(parts[2], today) || findDate(cleaned, today), start: findClock(parts[2]) }],
    };
  }
  if (/^(delete|remove)\b/.test(lower)) {
    return { say: "", actions: [{ do: "delete", what: tidy(cleaned.replace(/^(delete|remove)\s+(the\s+|my\s+)?/i, "")) }] };
  }
  if (/^cancel\b/.test(lower)) {
    return { say: "", actions: [{ do: "cancel", what: tidy(cleaned.replace(/^cancel\s+(the\s+|my\s+)?/i, "")) }] };
  }
  if (/^(finish|finished|complete|completed)\b/.test(lower) || /^mark\b/.test(lower)) {
    const what = tidy(cleaned.replace(/^(mark\s+)?/i, "").replace(/\b(as\s+)?(done|finished|complete|completed)\b/gi, ""));
    if (!what) return null;
    return { say: "", actions: [{ do: "complete", what }] };
  }
  if (!/^(add|create|schedule|put|new|i have)\b/.test(lower)) return null;
  const kind = /\bchore\b/i.test(cleaned)
    ? "add-chore"
    : /\bclass\b/i.test(cleaned)
      ? "add-class"
      : /\b(event|appointment|practice)\b/i.test(cleaned) || /^i have\b/i.test(cleaned)
        ? "add-event"
        : "add-task";
  const title = titleFrom(cleaned);
  if (!title) return { say: "What’s it called?", actions: [] };
  const action = {
    do: kind,
    title,
    what: title,
    date: findDate(cleaned, today),
    start: findClock(cleaned),
    due: dueFrom(cleaned, today),
    subject: "",
  };
  if (/\bevery day\b/i.test(cleaned)) {
    action.repeatEvery = 1;
    action.repeatUnit = "day";
  } else if (/\bevery week\b/i.test(cleaned) || kind === "add-class") {
    action.repeatEvery = 1;
    action.repeatUnit = "week";
  }
  return { say: "", actions: [action] };
}

function titleFrom(text) {
  const called = text.match(/\b(?:called|named)\s+(.+?)(?=\s+\b(?:due|on|at|tomorrow|today|tonight|every|from|to)\b|$)/i);
  if (called) return tidy(called[1]);
  let rest = text.replace(/^(please\s+)?(can you\s+|could you\s+)?/i, "");
  rest = rest.replace(/^(add|create|schedule|put|make|new|i have)\s+/i, "");
  rest = rest.replace(/^(a|an|the|my)\s+/i, "");
  rest = rest.replace(/^(task|homework|assignment|event|class|chore|appointment)\s+(called\s+|named\s+)?/i, "");
  rest = rest.replace(/\b(due|on|at|tomorrow|today|tonight|every|from|to|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[\s\S]*$/i, "");
  rest = rest.replace(/\b\d{1,2}(?::\d{2})?\s*(am|pm)?\b[\s\S]*$/i, "");
  return tidy(rest);
}

function answerQuestion(text, state, today, nowMin) {
  const lower = text.toLowerCase();
  const routine = state.user?.routine || {};
  if (/\b(what day|what date|what's the date|whats the date|what is the date|what is today|what's today|whats today)\b/.test(lower)) {
    return `Today is ${longDate(today)}.`;
  }
  if (/\b(what time is it|what's the time|whats the time|what time)\b/.test(lower) && !/\b(dinner|school|bed|wake|homework|class)\b/.test(lower)) {
    return `It’s ${formatTime(nowMin)}.`;
  }
  if (/\bwho am i\b/.test(lower)) {
    const who = state.user?.name || "You";
    return state.user?.grade ? `${who}, ${state.user.grade}.` : `${who}.`;
  }
  if (/\bdinner\b/.test(lower) && routine.dinner) return `Dinner is ${formatRange(routine.dinner, routine.dinnerEnd || routine.dinner)}.`;
  if (/\bwake\b/.test(lower) && routine.wake) return `You wake at ${formatTime(toMin(routine.wake))}.`;
  if (/\bbed\b/.test(lower) && routine.bed) return `Bedtime is ${formatTime(toMin(routine.bed))}.`;
  if (/\bschool\b/.test(lower) && routine.schoolStart && !/\bhomework\b/.test(lower)) {
    return `School is ${formatRange(routine.schoolStart, routine.schoolEnd)}.`;
  }
  if (/\bfree\b/.test(lower) || /\b(busy|available)\b/.test(lower)) {
    const day = findDate(text, today) || today;
    const windows = freeWindows(state, day, today, day === today ? nowMin : 0, 30);
    const when = relativeDay(day, today);
    const label = when === "Today" || when === "Tomorrow" || when === "Yesterday" ? when.toLowerCase() : when;
    if (!windows.length) return `You don’t have a free half hour ${label}.`;
    return `You’re free ${windows.slice(0, 3).map((slot) => formatRange(slot.start, slot.end)).join(", ")} ${label}.`;
  }
  if (/\bnext\b/.test(lower) && !/\b(homework|task|assignment)\b/.test(lower)) {
    const next = nextUp(state, today, nowMin);
    if (!next?.item) return "Nothing else is coming up.";
    return `Next is ${next.item.title}, ${relativeDay(next.date, today)} · ${formatRange(next.item.start, next.item.end)}.`;
  }
  const named = namedAnswer(text, state, today);
  if (named) return named;
  const aboutTasks = /\b(homework|due|tasks?|assignments?|to do)\b/.test(lower);
  if (aboutTasks) return taskList(state, today, lower);
  if (/\b(today|tomorrow|tonight|schedule|coming up|what do i have|what's on|whats on)\b/.test(lower)) {
    return dayPlan(state, /\btomorrow\b/.test(lower) ? addDays(today, 1) : today, today);
  }
  return "";
}

function taskList(state, today, lower) {
  let tasks = (state.tasks || []).filter((task) => task.status !== "completed");
  if (/this week/.test(lower)) {
    const end = endOfWeek(today);
    tasks = tasks.filter((task) => task.due && task.due >= today && task.due <= end);
  }
  tasks.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  if (!tasks.length) return /this week/.test(lower) ? "Nothing is due for the rest of this week." : "Nothing is still to do.";
  const lines = tasks.slice(0, 8).map((task) => `${task.title}, due ${task.due ? relativeDay(task.due, today) : "no date"}`);
  return `${lines.join("\n")}${tasks.length > 8 ? `\nAnd ${tasks.length - 8} more.` : ""}`;
}

function dayPlan(state, day, today) {
  const items = agenda(state, day).filter((item) => item.start && item.end);
  if (!items.length) return `${relativeDay(day, today)} is clear.`;
  return items.slice(0, 8).map((item) => `${formatRange(item.start, item.end)} ${item.title}`).join("\n");
}

function namedAnswer(text, state, today) {
  const subject = text
    .replace(/^(what|when|where|whats|what's|how|do i|is there|am i)\b/i, "")
    .replace(/\b(is|are|was|the|my|a|an|due|homework|tasks?|assignments?|still|to|do|on|at|for|this|week|today|tomorrow|tonight)\b/gi, " ")
    .replace(/[?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (subject.length < 3) return "";
  const hits = candidates(state, subject).filter((hit) => hit.score >= 60);
  if (!hits.length) return "";
  const best = hits[0].score;
  const top = hits.filter((hit) => hit.score === best).slice(0, 3);
  if (top.length > 1) return top.map((hit) => describeHit(state, hit, today)).join("\n");
  return describeHit(state, top[0], today);
}

function describeHit(state, hit, today) {
  if (hit.kind === "task") {
    const task = state.tasks.find((item) => item.id === hit.id);
    const session = (state.sessions || []).find((item) => item.taskId === task?.id && item.status !== "removed");
    const due = task?.due ? `due ${relativeDay(task.due, today)}` : "no due date";
    const when = session ? `, planned ${stamp(session.date, session.start, session.end, today)}` : "";
    return `${task.title} is ${due}${when}.`;
  }
  if (hit.kind === "event") {
    const event = state.events.find((item) => item.id === hit.id);
    return `${event.title} is ${stamp(event.date, event.start, event.end, today)}.`;
  }
  if (hit.kind === "class") {
    const lesson = state.classes.find((item) => item.id === hit.id);
    return `${lesson.title} is ${formatRange(lesson.start, lesson.end)} every ${lesson.repeatUnit || "week"}.`;
  }
  const chore = (state.chores || []).find((item) => item.id === hit.id);
  return chore?.start ? `${chore.title} is ${stamp(chore.date, chore.start, chore.end, today)}.` : `${chore?.title || hit.title} doesn’t have a time yet.`;
}

function mathAnswer(text) {
  const source = text.replace(/\btimes\b/ig, "*").replace(/\bdivided by\b/ig, "/").replace(/\bplus\b/ig, "+").replace(/\bminus\b/ig, "-");
  const match = source.match(/(-?\d+(?:\.\d+)?)\s*([+\-*/x×÷])\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return "";
  const left = Number(match[1]);
  const right = Number(match[3]);
  const op = match[2];
  const value = op === "+" ? left + right
    : op === "-" ? left - right
      : op === "*" || op === "x" || op === "×" ? left * right
        : right === 0 ? null
          : left / right;
  if (value === null || !Number.isFinite(value)) return "";
  const shown = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  return shown;
}

function isQuestion(text) {
  return /^(what|when|whats|what's|how|do i|is there|am i)\b|\?\s*$/i.test(text.trim());
}

function findClock(text) {
  const match = String(text).match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i)
    || String(text).match(/\b(?:at|to)\s+(\d{1,2}:\d{2})\b/i)
    || String(text).match(/\b(?:at|to)\s+(\d{1,2})\b/i);
  if (!match) return "";
  return clock(match[1] || match[0]);
}

function findDate(text, today) {
  const lower = String(text).toLowerCase();
  if (/\btomorrow\b/.test(lower)) return addDays(today, 1);
  if (/\b(today|tonight)\b/.test(lower)) return today;
  for (const day of WEEKDAYS) {
    if (new RegExp(`\\b${day}\\b`, "i").test(text)) return dateValue(day, today);
  }
  const iso = String(text).match(/\b\d{4}-\d{2}-\d{2}\b/);
  return iso ? iso[0] : "";
}

function dueFrom(text, today) {
  const match = String(text).match(/\bdue\s+(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})/i);
  return match ? dateValue(match[1], today) : "";
}

function tidy(value) {
  return cleanTitle(String(value || "").replace(/^(the|my|a|an)\s+/i, "").replace(/[?.!]+$/g, "").trim());
}

function parseReply(raw) {
  const text = String(raw || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(text.slice(start, end + 1));
      const say = String(json.say || json.reply || json.text || "").trim();
      const actions = Array.isArray(json.actions) ? json.actions : [];
      return { say, actions };
    } catch {
      return null;
    }
  }
  if (text && !text.includes("{")) return { say: text, actions: [] };
  return null;
}

function normalizeAction(raw) {
  if (!raw || typeof raw !== "object") return null;
  const doName = DOS[String(raw.do || raw.action || raw.op || "").trim().toLowerCase()];
  if (!doName) return null;
  return {
    do: doName,
    title: raw.title || raw.name || "",
    what: raw.what || raw.match || raw.title || raw.name || "",
    subject: raw.subject || "",
    due: raw.due || "",
    minutes: raw.minutes || raw.estimated || 0,
    date: raw.date || "",
    toDate: raw.toDate || raw.to || "",
    start: raw.start || "",
    end: raw.end || "",
    location: raw.location || "",
    repeatEvery: raw.repeatEvery,
    repeatUnit: raw.repeatUnit || "",
    series: Boolean(raw.series),
    text: String(raw.text || raw.note || "").trim().slice(0, 240),
  };
}

function modelError(error) {
  const message = String(error?.message || error);
  if (/unavailable/i.test(message)) return "This browser can’t run the assistant on the device.";
  if (/notallowed|gesture|activation/i.test(message)) return "Tap Send once more so this browser can finish setting up the assistant.";
  return "The assistant didn’t answer. Try sending that again.";
}

function ensureSubject(state, label) {
  const name = cleanTitle(label);
  if (!name) return state.subjects[0] || { id: "general", name: "General", short: "General", color: COLORS[0] };
  const found = matchSubject(state, name);
  if (found) return found;
  const id = `class-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "class"}`;
  const subject = {
    id: state.subjects.some((item) => item.id === id) ? `${id}-2` : id,
    name,
    short: name.split(/\s+/)[0].slice(0, 12),
    teacher: "",
    color: COLORS[state.subjects.length % COLORS.length],
  };
  state.subjects.push(subject);
  return subject;
}

function matchSubject(state, label) {
  const hay = String(label || "").toLowerCase();
  return (state.subjects || []).find((subject) => {
    const full = subject.name.toLowerCase();
    const short = subject.short.toLowerCase();
    return full === hay || short === hay || hay.includes(full) || hay.includes(short) || full.includes(hay);
  }) || null;
}

function nextClassDate(lesson, today, requested) {
  if (requested && classOccurs(lesson, requested)) return requested;
  if (requested) return "";
  for (let i = 0; i < 21; i += 1) {
    const date = addDays(today, i);
    if (classOccurs(lesson, date)) return date;
  }
  return "";
}

function intervalOpen(state, date, start, end, ignore = {}) {
  const open = toMin(start);
  const close = toMin(end);
  return !busyBlocks(state, date, ignore).some((block) => overlaps(open, close, block.start, block.end));
}

function clashTitle(state, date, start, end, ignore = {}) {
  const open = toMin(start);
  const close = toMin(end);
  const blocks = busyBlocks(state, date, ignore);
  const hit = blocks.find((block) => block.kind !== "school" && overlaps(open, close, block.start, block.end));
  return hit?.title || "";
}

function scoreName(query, title) {
  const left = norm(query);
  const right = norm(title);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (right.includes(left)) return 80;
  const words = left.split(" ").filter((word) => word.length > 2);
  if (words.length && words.every((word) => right.includes(word))) return 60;
  return 0;
}

function dateValue(value, today) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (!today) return "";
  if (text === "today" || text === "tonight") return today;
  if (text === "tomorrow") return addDays(today, 1);
  const index = WEEKDAYS.findIndex((day) => day.toLowerCase() === text);
  if (index < 0) return "";
  const delta = (index - weekday(today) + 7) % 7;
  return addDays(today, delta);
}

function clock(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (match[3] === "pm" && hour < 12) hour += 12;
  if (match[3] === "am" && hour === 12) hour = 0;
  if (!match[3] && match[2] === undefined && hour >= 1 && hour <= 7) hour += 12;
  if (hour > 23 || minute > 59) return "";
  return fromMin(hour * 60 + minute);
}

function clampMinutes(value) {
  const minutes = Math.round(Number(value) || 0);
  if (!minutes) return 0;
  return Math.max(10, Math.min(240, minutes));
}

function cleanTitle(value) {
  return String(value || "").trim().slice(0, 120);
}

function blocked(value) {
  return /^(all|everything|every thing|all tasks|all classes|all events|all chores)$/.test(norm(value));
}

function norm(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stamp(date, start, end, today) {
  if (!date || !start) return "No time";
  return `${relativeDay(date, today)} · ${formatRange(start, end || start)}`;
}
