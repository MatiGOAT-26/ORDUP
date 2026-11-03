import {
  addDays,
  cap,
  daysBetween,
  dueText,
  endOfWeek,
  formatDuration,
  formatRange,
  formatTime,
  fromMin,
  relativeDay,
  isWeekend,
  toMin,
  weekday,
} from "./time.js";

export function subjectById(state, id) {
  return state.subjects.find((subject) => subject.id === id) || null;
}

export function subjectName(state, id) {
  return subjectById(state, id)?.name || "Subject";
}

export function subjectColor(state, id) {
  return subjectById(state, id)?.color || "#6D4AFF";
}

export function blockLength(estimate) {
  const spare = estimate < 50 ? 5 : 0;
  return Math.ceil((estimate + spare) / 5) * 5;
}

function paceRows(state, subjectId) {
  return state.history.filter((row) => row.subjectId === subjectId && row.estimated > 0 && row.actual > 0).slice(-5);
}

function paceFactor(rows) {
  if (!rows.length) return 1;
  const ratio = rows.reduce((sum, row) => sum + row.actual / row.estimated, 0) / rows.length;
  const strength = Math.min(1, 0.8 + 0.1 * (rows.length - 1));
  return Math.max(0.6, Math.min(1.6, 1 + (ratio - 1) * strength));
}

export function biasFor(state, subjectId) {
  return paceFactor(paceRows(state, subjectId));
}

export function biasNote(state, subjectId) {
  const rows = paceRows(state, subjectId);
  if (!rows.length) return "";
  const factor = paceFactor(rows);
  const name = subjectName(state, subjectId);
  if (factor <= 0.9) return `You finish ${name} faster than the first guess, so the next estimate is shorter.`;
  if (factor >= 1.1) return `You take longer on ${name} than the first guess, so the next estimate is longer.`;
  return `${name} estimates match how long you actually take.`;
}

export function observedWork(state, task, date, nowMin) {
  const sessions = state.sessions
    .filter((session) => session.taskId === task.id && session.status === "planned")
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  if (!sessions.length) return null;
  const active = [...sessions].reverse().find((session) => session.date === date && toMin(session.start) <= nowMin);
  if (!active) return null;
  const elapsed = nowMin - toMin(active.start);
  const block = Math.max(1, toMin(active.end) - toMin(active.start));
  const limit = Math.max(block * 2, (task.estimated || block) * 2, 150);
  if (elapsed < 5 || elapsed > limit) return null;
  const last = sessions[sessions.length - 1];
  if (sessions.length === 1 || active.id === last.id) {
    const earlier = sessions
      .filter((session) => session.id !== active.id && (session.date < date || (session.date === date && toMin(session.end) <= nowMin)))
      .reduce((sum, session) => sum + (toMin(session.end) - toMin(session.start)), 0);
    return { actual: earlier + elapsed, estimated: task.estimated };
  }
  return { actual: Math.max(5, Math.round((task.estimated || block) * (elapsed / block))), estimated: task.estimated };
}

export function retuneFuture(state, subjectId, difficulty, date, nowMin) {
  let changed = 0;
  for (const task of state.tasks) {
    if (task.subjectId !== subjectId || task.difficulty !== difficulty || task.status === "completed") continue;
    const sessions = state.sessions.filter((session) => session.taskId === task.id && session.status === "planned" && (session.date > date || (session.date === date && toMin(session.start) > nowMin)));
    if (sessions.length !== 1) continue;
    const next = estimateMinutes(state, {
      subjectId,
      type: task.type,
      difficulty: task.difficulty,
      title: task.title,
      description: task.description,
    });
    if (next === task.estimated) continue;
    const session = sessions[0];
    const start = toMin(session.start);
    const others = agenda(state, session.date)
      .filter((item) => !(item.kind === "session" && item.id === session.id) && item.startMin > start)
      .sort((a, b) => a.startMin - b.startMin);
    const limit = others.length ? others[0].startMin : 22 * 60;
    const end = Math.min(start + blockLength(next), limit);
    if (end - start < 15) continue;
    task.estimated = next;
    session.end = fromMin(end);
    changed += 1;
  }
  return changed;
}

export function estimateMinutes(state, input) {
  const difficulty = input.difficulty || "medium";
  const type = input.type || "homework";
  const base = { easy: 20, medium: 35, hard: 60 }[difficulty] || 35;
  const typeScale = {
    homework: 1,
    assignment: 1.05,
    project: 1.2,
    reading: 0.85,
    revision: 1,
    test: 1,
    exam: 1,
    other: 1,
  }[type] || 1;
  let minutes = base * typeScale;
  const text = `${input.title || ""} ${input.description || ""}`;
  const questions = text.match(/questions?\s*(\d+)\s*[-–—]\s*(\d+)/i);
  if (questions) {
    const count = Math.abs(Number(questions[2]) - Number(questions[1])) + 1;
    const each = difficulty === "easy" ? 1.2 : difficulty === "hard" ? 2.4 : 1.75;
    minutes = Math.max(minutes, count * each);
  }
  const pages = text.match(/(\d+)\s*pages?/i);
  if (pages) minutes = Math.max(minutes, Number(pages[1]) * (difficulty === "hard" ? 8 : 6));
  const biased = Math.round((minutes * biasFor(state, input.subjectId)) / 5) * 5;
  return Math.max(15, Math.min(240, biased));
}

export function classDays(item) {
  if (item?.repeatUnit === "week" && item.startDate) return [weekday(item.startDate)];
  if (item?.repeatUnit === "day" && Number(item.repeatEvery) <= 1) return [0, 1, 2, 3, 4, 5, 6];
  if (item?.repeatUnit === "day") return [];
  const days = Array.isArray(item?.days) && item.days.length ? item.days : [item?.day];
  return [...new Set(days.map(Number))].filter((day) => day >= 0 && day <= 6);
}

export function classOccurs(item, date) {
  if (item?.startDate && item.repeatEvery && item.repeatUnit) {
    if (date < item.startDate) return false;
    const step = item.repeatUnit === "week" ? Number(item.repeatEvery) * 7 : Number(item.repeatEvery);
    return step > 0 && daysBetween(item.startDate, date) % step === 0;
  }
  return classDays(item).includes(weekday(date));
}

export function choreStep(chore) {
  const every = Number(chore?.repeatEvery) || 0;
  if (!every || (chore.repeatUnit !== "day" && chore.repeatUnit !== "week")) return 0;
  return chore.repeatUnit === "week" ? every * 7 : every;
}

export function choreRepeatLabel(chore) {
  const every = Number(chore?.repeatEvery) || 0;
  if (!choreStep(chore)) return "";
  if (chore.repeatUnit === "week") return every === 1 ? "Every week" : `Every ${every} weeks`;
  return every === 1 ? "Every day" : `Every ${every} days`;
}

export function choreOccurs(chore, date) {
  if (!chore || chore.done || !chore.date || !chore.start || !chore.end || !date) return false;
  if ((chore.doneDates || []).includes(date)) return false;
  const step = choreStep(chore);
  if (!step) return chore.date === date;
  if (date < chore.date) return false;
  return daysBetween(chore.date, date) % step === 0;
}

export function nextChoreDate(chore, today) {
  if (!chore || chore.done || !chore.date) return "";
  const step = choreStep(chore);
  if (!step) return chore.date;
  let date = chore.date;
  if (today > date) {
    const jumps = Math.floor(daysBetween(date, today) / step);
    date = addDays(date, jumps * step);
  }
  for (let i = 0; i < 400; i += 1) {
    if (date >= today && !(chore.doneDates || []).includes(date)) return date;
    date = addDays(date, step);
  }
  return "";
}

export function classInstances(state, date) {
  const day = weekday(date);
  const hidden = new Set(
    (state.exceptions || [])
      .filter((item) => item.date === date && (item.type === "cancel" || item.type === "hide"))
      .map((item) => item.classId)
  );
  const regular = state.classes
    .filter((item) => item.recurrence !== "once" && classOccurs(item, date) && !hidden.has(item.id))
    .map((item) => classItem(state, item, date, false));
  const once = state.classes
    .filter((item) => item.recurrence === "once" && item.date === date)
    .map((item) => classItem(state, item, date, false));
  const overrides = (state.overrides || [])
    .filter((item) => item.date === date)
    .map((item) => ({
      kind: "class",
      id: item.id,
      override: true,
      subjectId: item.subjectId,
      title: item.title || subjectName(state, item.subjectId),
      start: item.start,
      end: item.end,
      startMin: toMin(item.start),
      endMin: toMin(item.end),
      room: item.room || "",
      teacher: item.teacher || subjectById(state, item.subjectId)?.teacher || "",
      color: item.color || subjectColor(state, item.subjectId),
      date,
      sourceClassId: item.sourceClassId || "",
    }));
  return [...regular, ...once, ...overrides].sort((a, b) => a.startMin - b.startMin);
}

function classItem(state, item, date, override) {
  return {
    kind: "class",
    id: item.id,
    override,
    subjectId: item.subjectId,
    title: item.title || subjectName(state, item.subjectId),
    start: item.start,
    end: item.end,
    startMin: toMin(item.start),
    endMin: toMin(item.end),
    room: item.room || "",
    teacher: item.teacher || subjectById(state, item.subjectId)?.teacher || "",
    color: subjectColor(state, item.subjectId),
    date,
    notes: item.notes || "",
  };
}

function visibleEvents(state, date) {
  return state.events.filter((event) => {
    if (event.date !== date || event.removed) return false;
    if (event.source === "google" && !state.googleConnected) return false;
    return true;
  });
}

function liveSessions(state, date) {
  return state.sessions.filter((session) => session.date === date && session.status !== "removed");
}

export function taskById(state, id) {
  return state.tasks.find((task) => task.id === id) || null;
}

export function taskStatus(state, task, today, nowMin) {
  if (task.status === "completed") return "completed";
  if (task.due && task.due < today) return "overdue";
  const sessions = state.sessions.filter((session) => session.taskId === task.id && session.status !== "removed");
  if (!sessions.length) return "unplanned";
  const active = sessions.some((session) => session.date === today && toMin(session.start) <= nowMin && toMin(session.end) > nowMin);
  if (active) return "inprogress";
  return "planned";
}

export function agenda(state, date) {
  const items = [];
  for (const item of classInstances(state, date)) {
    items.push({
      ...item,
      key: `class-${item.id}-${date}`,
      subtitle: [item.room, item.teacher].filter(Boolean).join(" · "),
      location: item.room,
    });
  }
  for (const event of visibleEvents(state, date)) {
    items.push({
      kind: "event",
      key: `event-${event.id}`,
      id: event.id,
      title: event.title,
      date,
      start: event.start,
      end: event.end,
      startMin: toMin(event.start),
      endMin: toMin(event.end),
      color: event.color || "#7C6AD8",
      location: event.location || "",
      subtitle: event.assessment ? "Test" : (event.location || (event.source === "google" ? "Google Calendar" : "Activity")),
      source: event.source,
      sport: !!event.sport,
    });
  }
  for (const chore of state.chores || []) {
    if (!choreOccurs(chore, date)) continue;
    const repeat = choreRepeatLabel(chore);
    items.push({
      kind: "chore",
      key: `chore-${chore.id}-${date}`,
      id: chore.id,
      title: chore.title,
      date,
      start: chore.start,
      end: chore.end,
      startMin: toMin(chore.start),
      endMin: toMin(chore.end),
      color: "#7C6AD8",
      subtitle: ["Chore", repeat, `Est. ${chore.estimated || guessChoreMinutes(chore.title)} min`].filter(Boolean).join(" · "),
    });
  }
  for (const session of liveSessions(state, date)) {
    const task = taskById(state, session.taskId);
    const subject = task ? subjectById(state, task.subjectId) : null;
    items.push({
      kind: "session",
      key: `session-${session.id}`,
      id: session.id,
      taskId: session.taskId,
      title: task?.title || "Study",
      date,
      start: session.start,
      end: session.end,
      startMin: toMin(session.start),
      endMin: toMin(session.end),
      color: subject?.color || "#6D4AFF",
      subjectId: task?.subjectId || "",
      subtitle: [subject?.short || subject?.name, session.label && session.label !== "ManageBac" ? session.label : "", dueText(task?.due), task ? `Est. ${task.estimated} min` : ""].filter(Boolean).join(" · "),
      label: session.label || "",
      status: session.status,
    });
  }
  const routine = state.user.routine;
  items.push({
    kind: "routine",
    key: `dinner-${date}`,
    id: "dinner",
    title: "Dinner",
    date,
    start: routine.dinner,
    end: routine.dinnerEnd,
    startMin: toMin(routine.dinner),
    endMin: toMin(routine.dinnerEnd),
    color: "#B7A7D6",
    subtitle: "Protected time",
    location: "Home",
  });
  return items.sort((a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title));
}

export function nextUp(state, today, nowMin) {
  const ranked = (date) => agenda(state, date).filter((item) => item.kind === "class" || item.kind === "event");
  const todayItems = ranked(today);
  const current = todayItems.find((item) => item.startMin <= nowMin && item.endMin > nowMin);
  if (current) {
    const following = todayItems.find((item) => item.startMin >= current.endMin);
    return { mode: "now", item: current, endsIn: current.endMin - nowMin, following, date: today };
  }
  const upcoming = todayItems.find((item) => item.startMin > nowMin);
  if (upcoming) return { mode: "next", item: upcoming, delta: upcoming.startMin - nowMin, date: today };
  for (let i = 1; i <= 7; i += 1) {
    const date = addDays(today, i);
    const first = ranked(date)[0];
    if (first) return { mode: "later", item: first, date, delta: null };
  }
  return null;
}

export function classEndNotices(state, today, nowMin) {
  if (state.user?.notifications?.classes === false) return [];
  const ended = agenda(state, today).filter((item) => item.kind === "class" && item.endMin <= nowMin && nowMin - item.endMin <= 2);
  const seen = new Set([...(state.notices || []).map((item) => item.id), ...(state.dismissed || [])]);
  const fresh = [];
  for (const item of ended) {
    const id = `ended-${today}-${item.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const next = followingItem(state, today, item.endMin, item.id);
    fresh.push({
      id,
      title: `${item.title} finished`,
      body: nextAfterText(next, today),
    });
  }
  return fresh;
}

function followingItem(state, today, endMin, skipId) {
  const sameDay = agenda(state, today).filter((item) => (item.kind === "class" || item.kind === "event") && item.id !== skipId && item.startMin >= endMin);
  if (sameDay.length) return { item: sameDay[0], date: today };
  for (let i = 1; i <= 7; i += 1) {
    const date = addDays(today, i);
    const first = agenda(state, date).find((item) => item.kind === "class" || item.kind === "event");
    if (first) return { item: first, date };
  }
  return null;
}

function nextAfterText(next, today) {
  if (!next) return "Nothing else is coming up.";
  const place = next.item.room || next.item.location;
  const when = next.date === today
    ? formatRange(next.item.start, next.item.end)
    : `${relativeDay(next.date, today)} ${formatRange(next.item.start, next.item.end)}`;
  return `Next is ${next.item.title}, ${when}${place ? `, ${place}` : ""}.`;
}

function mergeBusy(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const block of sorted) {
    const last = merged[merged.length - 1];
    if (!last || block.start > last.end) {
      merged.push({ ...block });
      continue;
    }
    if (block.end > last.end) {
      last.end = block.end;
      last.kind = block.kind;
      last.title = block.title;
      last.sport = block.sport;
      last.id = block.id;
    }
  }
  return merged;
}

function padAfter(block) {
  if (!block || block.kind === "school" || block.kind === "dinner" || block.kind === "sleep" || block.kind === "day-start") return 0;
  if (block.sport) return 20;
  return 15;
}

export function busyBlocks(state, date, options = {}) {
  const ignoreSessionIds = new Set(options.ignoreSessionIds || []);
  const ignoreEventIds = new Set(options.ignoreEventIds || []);
  const routine = state.user.routine;
  const blocks = [];
  const classes = classInstances(state, date);
  const weekdayClasses = classes.filter((item) => !item.override);
  if (weekdayClasses.length && !isWeekend(date)) {
    blocks.push({
      kind: "morning",
      title: "Morning",
      start: toMin(routine.wake),
      end: toMin(routine.schoolStart),
    });
    blocks.push({
      kind: "school",
      title: "School",
      start: toMin(routine.schoolStart),
      end: toMin(routine.schoolEnd),
    });
  }
  for (const item of classes) {
    blocks.push({ kind: "class", title: item.title, start: item.startMin, end: item.endMin, id: item.id });
  }
  for (const event of visibleEvents(state, date)) {
    if (ignoreEventIds.has(event.id)) continue;
    blocks.push({
      kind: "event",
      title: event.title,
      start: toMin(event.start),
      end: toMin(event.end),
      sport: !!event.sport,
      id: event.id,
    });
  }
  for (const session of liveSessions(state, date)) {
    if (ignoreSessionIds.has(session.id)) continue;
    const task = taskById(state, session.taskId);
    blocks.push({
      kind: "session",
      title: task?.title || "Study",
      start: toMin(session.start),
      end: toMin(session.end),
      id: session.id,
    });
  }
  for (const chore of state.chores || []) {
    if (!choreOccurs(chore, date)) continue;
    blocks.push({
      kind: "chore",
      title: chore.title,
      start: toMin(chore.start),
      end: toMin(chore.end),
      id: chore.id,
    });
  }
  blocks.push({
    kind: "dinner",
    title: "Dinner",
    start: toMin(routine.dinner),
    end: toMin(routine.dinnerEnd),
  });
  for (const block of state.user.preferences.unavailable || []) {
    if (block.day == null || block.day === weekday(date)) {
      blocks.push({ kind: "unavailable", title: "Unavailable", start: toMin(block.start), end: toMin(block.end) });
    }
  }
  for (const extra of options.extraBusy || []) {
    if (extra.date !== date) continue;
    blocks.push({
      kind: extra.kind || "session",
      title: extra.title || "Study",
      start: toMin(extra.start),
      end: toMin(extra.end),
      sport: !!extra.sport,
    });
  }
  return mergeBusy(blocks.filter((block) => block.end > block.start));
}

function phrase(block) {
  if (!block || block.kind === "day-start" || block.kind === "sleep") return null;
  if (block.kind === "school") return "school";
  if (block.kind === "dinner") return "dinner";
  if (block.kind === "unavailable") return "a blocked time";
  const title = block.title ? block.title.charAt(0).toLowerCase() + block.title.slice(1) : "";
  if (block.kind === "session") return `your ${title}`;
  return title;
}

function inPreferred(start, end, preferences) {
  return (preferences.preferred || []).some((window) => start >= toMin(window.start) && end <= toMin(window.end));
}

function schoolBreak(preferences) {
  if (preferences.homeworkTiming === "yes") return 0;
  if (preferences.homeworkTiming === "no") return Math.max(preferences.breakMinutes || 0, 60);
  return preferences.breakMinutes || 0;
}

export function describeSlot(slot, due) {
  const parts = [];
  if (slot.afterLabel === "school") parts.push("After school");
  else if (slot.afterLabel) parts.push(`After ${slot.afterLabel}`);
  if (slot.beforeLabel === "dinner") parts.push("before dinner");
  else if (slot.beforeLabel) parts.push(`before ${slot.beforeLabel}`);
  const days = daysBetween(slot.date, due);
  const words = ["", "one", "two", "three", "four", "five", "six", "seven"];
  const ahead = words[days] ? `${words[days]} day${days === 1 ? "" : "s"} before the deadline` : `${days} days before the deadline`;
  parts.push(days <= 0 ? "on the due date" : ahead);
  const last = parts.pop();
  const sentence = parts.length ? `${parts.join(", ")}, and ${last}` : last;
  return cap(sentence) + ".";
}

function scoreSlot(slot, state, due, today) {
  const dayOffset = daysBetween(today, slot.date);
  let score = 1000 - dayOffset * 90;
  if (slot.preferred) score += 70;
  if (slot.startMin >= 19 * 60) score -= 80;
  if (slot.date === due) score -= 100;
  const sessions = state.sessions.filter((session) => session.date === slot.date && session.status !== "removed").length;
  score -= sessions * 20;
  score += Math.max(0, 18 * 60 - slot.startMin) / 30;
  return score;
}

export function recommend(state, options) {
  const duration = options.duration;
  const due = options.due;
  const today = options.today;
  const nowMin = options.nowMin ?? 0;
  const fromDate = options.fromDate || today;
  const preferences = state.user.preferences;
  const routine = state.user.routine;
  const wake = toMin(routine.wake);
  const bed = toMin(routine.bed);
  const breakMinutes = schoolBreak(preferences);
  const candidates = [];
  let date = fromDate < today ? today : fromDate;
  while (date <= due) {
    if (!(isWeekend(date) && !preferences.weekendStudy)) {
      const blocks = busyBlocks(state, date, options).filter((block) => block.end > wake && block.start < bed);
      const gaps = [];
      let cursor = wake;
      let prev = { kind: "day-start", end: wake, title: "" };
      for (const block of blocks) {
        const start = Math.max(block.start, wake);
        const end = Math.min(block.end, bed);
        if (start > cursor) gaps.push({ start: cursor, end: start, prev, next: block });
        if (end > cursor) {
          cursor = end;
          prev = { ...block, end };
        }
      }
      if (cursor < bed) gaps.push({ start: cursor, end: bed, prev, next: { kind: "sleep", start: bed, title: "bedtime" } });

      for (const gap of gaps) {
        let start = gap.start;
        if (gap.prev?.kind === "school") start = Math.max(start, gap.prev.end + breakMinutes);
        else if (gap.prev && gap.prev.kind !== "day-start") start = Math.max(start, gap.prev.end + padAfter(gap.prev));
        let limit = gap.end - 15;
        if (date === today) start = Math.max(start, nowMin + 10);
        start = Math.ceil(start / 5) * 5;
        if (limit - start < duration) continue;
        const end = start + duration;
        const slot = {
          date,
          startMin: start,
          endMin: end,
          start: fromMin(start),
          end: fromMin(end),
          afterLabel: phrase(gap.prev),
          beforeLabel: phrase(gap.next),
          preferred: inPreferred(start, end, preferences),
        };
        slot.score = scoreSlot(slot, state, due, today);
        slot.reason = describeSlot(slot, due);
        candidates.push(slot);
      }
    }
    date = addDays(date, 1);
  }
  return candidates.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date) || a.startMin - b.startMin);
}

export function pickRecommendations(candidates) {
  if (!candidates.length) return [];
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.startMin - b.startMin);
  const best = sorted[0];
  const otherDays = sorted.filter((slot) => slot.date !== best.date);
  if (!otherDays.length) return sorted.slice(0, 3);
  const day = otherDays[0].date;
  const alternatives = otherDays.filter((slot) => slot.date === day).slice(0, 2);
  return [best, ...alternatives];
}

export function freeWindows(state, date, today, nowMin, minimum = 30) {
  return recommend(state, {
    duration: minimum,
    due: date,
    today,
    nowMin,
    fromDate: date,
  }).filter((slot) => slot.date === date);
}

export function buildPlan(state, options) {
  const maxContinuous = options.maxContinuous || state.user.preferences.maxContinuous || 60;
  const phases = options.type === "exam" || options.type === "test"
    ? ["Review", "Practice questions", "Final review"]
    : ["Research", "Outline", "Writing", "Review"];
  let left = options.minutes;
  const chunks = [];
  const extraBusy = [];
  let guard = 0;
  while (left > 0 && guard < 8) {
    guard += 1;
    const size = Math.min(maxContinuous, left);
    const duration = size >= 50 ? Math.ceil(size / 5) * 5 : blockLength(size);
    const slots = recommend(state, { ...options, duration, extraBusy });
    const slot = slots[0];
    if (!slot) break;
    chunks.push({
      ...slot,
      label: phases[Math.min(chunks.length, phases.length - 1)],
      work: size,
    });
    extraBusy.push({ date: slot.date, start: slot.start, end: slot.end, title: "Study", kind: "session" });
    left -= size;
  }
  return { chunks, remaining: left };
}

export function guessChoreMinutes(title) {
  const text = String(title || "").toLowerCase();
  const rules = [
    [/trash|rubbish|garbage|bin|recycling/, 10],
    [/dish|wash up|kitchen/, 20],
    [/laundry|clothes|washing/, 30],
    [/vacuum|tidy|clean|room|bed|mop/, 25],
    [/dog|pet|walk/, 20],
    [/homework|study/, 30],
  ];
  for (const [pattern, minutes] of rules) {
    if (pattern.test(text)) return minutes;
  }
  return 15;
}

function intervalFree(state, date, start, end, options = {}) {
  const blocks = busyBlocks(state, date, options);
  const open = toMin(start);
  const close = toMin(end);
  return !blocks.some((block) => overlaps(open, close, block.start, block.end));
}

function choreDue(chore, today) {
  const step = choreStep(chore);
  return addDays(today, step || 2);
}

function chooseSlot(candidates, previous) {
  if (!candidates.length) return null;
  if (!previous?.date || !previous.start) return candidates[0];
  const target = toMin(previous.start);
  const sameDay = candidates.filter((slot) => slot.date === previous.date);
  const pool = sameDay.length ? sameDay : candidates;
  return [...pool].sort((a, b) => Math.abs(a.startMin - target) - Math.abs(b.startMin - target) || b.score - a.score)[0];
}

function slotIsFuture(date, start, today, nowMin) {
  if (!date || !start) return true;
  if (date > today) return true;
  if (date < today) return false;
  return toMin(start) > nowMin;
}

export function repackSchedule(state, today, nowMin) {
  state.chores ||= [];
  const sessions = state.sessions.filter((session) => session.status === "planned" && slotIsFuture(session.date, session.start, today, nowMin));
  const chores = state.chores.filter((chore) => !chore.done && slotIsFuture(chore.date, chore.start, today, nowMin));
  const savedSessions = new Map(sessions.map((session) => [session.id, { date: session.date, start: session.start, end: session.end, status: "planned" }]));
  const savedChores = new Map(chores.map((chore) => [chore.id, { date: chore.date || "", start: chore.start || "", end: chore.end || "", estimated: chore.estimated }]));
  for (const session of sessions) session.status = "removed";
  for (const chore of chores) {
    chore.date = "";
    chore.start = "";
    chore.end = "";
  }
  let moved = 0;
  const keep = (date, start, end) => date && start && end && slotIsFuture(date, start, today, nowMin) && intervalFree(state, date, start, end);
  try {
    const homework = sessions
      .map((session) => ({ session, task: taskById(state, session.taskId), previous: savedSessions.get(session.id) }))
      .sort((a, b) => {
        const due = (a.task?.due || "9999-99-99").localeCompare(b.task?.due || "9999-99-99");
        if (due) return due;
        if (!!a.previous.date !== !!b.previous.date) return a.previous.date ? -1 : 1;
        return (a.previous.start || "").localeCompare(b.previous.start || "");
      });
    for (const item of homework) {
      const previous = item.previous;
      if (keep(previous.date, previous.start, previous.end)) {
        item.session.date = previous.date;
        item.session.start = previous.start;
        item.session.end = previous.end;
        item.session.status = "planned";
        continue;
      }
      const duration = previous.start && previous.end
        ? Math.max(15, toMin(previous.end) - toMin(previous.start))
        : blockLength(item.task?.estimated || 30);
      const due = item.task?.due && item.task.due >= today ? item.task.due : addDays(today, 14);
      const slot = chooseSlot(recommend(state, { duration, due, today, nowMin }), previous);
      if (!slot) continue;
      if (previous.date && (previous.date !== slot.date || previous.start !== slot.start || previous.end !== slot.end)) moved += 1;
      item.session.date = slot.date;
      item.session.start = slot.start;
      item.session.end = slot.end;
      item.session.status = "planned";
    }
    const ordered = [...chores].sort((a, b) => {
      const left = savedChores.get(a.id);
      const right = savedChores.get(b.id);
      if (!!left.date !== !!right.date) return left.date ? -1 : 1;
      return (left.start || "99:99").localeCompare(right.start || "99:99") || a.title.localeCompare(b.title);
    });
    for (const chore of ordered) {
      const previous = savedChores.get(chore.id);
      if (!chore.estimated) chore.estimated = guessChoreMinutes(chore.title);
      if (keep(previous.date, previous.start, previous.end)) {
        chore.date = previous.date;
        chore.start = previous.start;
        chore.end = previous.end;
        continue;
      }
      let duration = blockLength(chore.estimated);
      const due = choreDue(chore, today);
      let slot = chooseSlot(recommend(state, { duration, due, today, nowMin }), previous);
      if (!slot && chore.estimated > 10) {
        chore.estimated = 10;
        duration = blockLength(10);
        slot = chooseSlot(recommend(state, { duration, due, today, nowMin }), previous);
      }
      if (!slot) continue;
      if (previous.date && (previous.date !== slot.date || previous.start !== slot.start || previous.end !== slot.end)) moved += 1;
      chore.date = slot.date;
      chore.start = slot.start;
      chore.end = slot.end;
    }
    for (const session of state.sessions) {
      if (session.status !== "planned" || !slotIsFuture(session.date, session.start, today, nowMin)) continue;
      const blocks = busyBlocks(state, session.date, { ignoreSessionIds: [session.id] });
      const open = toMin(session.start);
      const close = toMin(session.end);
      if (!blocks.some((block) => block.kind === "chore" && overlaps(open, close, block.start, block.end))) continue;
      const previous = { date: session.date, start: session.start, end: session.end };
      session.status = "removed";
      const duration = Math.max(15, close - open);
      const task = taskById(state, session.taskId);
      const due = task?.due && task.due >= today ? task.due : addDays(today, 14);
      const slot = chooseSlot(recommend(state, { duration, due, today, nowMin }), previous);
      if (!slot) {
        session.date = previous.date;
        session.start = previous.start;
        session.end = previous.end;
        session.status = "planned";
        continue;
      }
      if (previous.date !== slot.date || previous.start !== slot.start || previous.end !== slot.end) moved += 1;
      session.date = slot.date;
      session.start = slot.start;
      session.end = slot.end;
      session.status = "planned";
    }
  } finally {
    for (const session of sessions) {
      if (session.status !== "removed") continue;
      Object.assign(session, savedSessions.get(session.id));
    }
    for (const chore of chores) {
      if (chore.start) continue;
      const previous = savedChores.get(chore.id);
      chore.date = previous.date;
      chore.start = previous.start;
      chore.end = previous.end;
      if (previous.estimated) chore.estimated = previous.estimated;
    }
  }
  return moved;
}

export function shiftStaleSessions(state, today, nowMin) {
  const planned = state.sessions.filter((session) => session.status === "planned");
  const ordered = planned
    .map((session) => ({ session, task: taskById(state, session.taskId) }))
    .filter((item) => item.task && item.task.status !== "completed")
    .sort((a, b) => (a.task.due || "9999-99-99").localeCompare(b.task.due || "9999-99-99"));
  let moved = 0;
  for (const item of ordered) {
    const session = item.session;
    const task = item.task;
    const past = !slotIsFuture(session.date, session.start, today, nowMin);
    const afterDue = Boolean(task.due && session.date > task.due);
    if (!past && !afterDue) continue;
    const duration = session.start && session.end
      ? Math.max(15, toMin(session.end) - toMin(session.start))
      : blockLength(task.estimated || 30);
    session.status = "removed";
    if (!task.due || task.due < today) {
      moved += 1;
      continue;
    }
    const slot = recommend(state, { duration, due: task.due, today, nowMin })[0];
    if (!slot || slot.date > task.due) {
      moved += 1;
      continue;
    }
    session.date = slot.date;
    session.start = slot.start;
    session.end = slot.end;
    session.status = "planned";
    task.status = "planned";
    moved += 1;
  }
  return moved;
}

export function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

export function sessionConflicts(state, session, options = {}) {
  const blocks = busyBlocks(state, session.date, {
    ignoreSessionIds: [session.id, ...(options.ignoreSessionIds || [])],
    ignoreEventIds: options.ignoreEventIds || [],
  });
  const start = toMin(session.start);
  const end = toMin(session.end);
  return blocks.filter((block) => block.kind !== "school" && overlaps(start, end, block.start, block.end));
}

export function findConflicts(state) {
  const found = [];
  for (const session of state.sessions) {
    if (session.status === "removed") continue;
    const hits = sessionConflicts(state, session).filter((block) => block.kind === "event" || block.kind === "class");
    if (!hits.length) continue;
    const task = taskById(state, session.taskId);
    found.push({ session, task, with: hits[0] });
  }
  return found;
}

export function remainingMinutes(state, task) {
  if (task.status === "completed") return 0;
  const done = state.sessions
    .filter((session) => session.taskId === task.id && session.status === "completed")
    .reduce((sum, session) => sum + (toMin(session.end) - toMin(session.start)), 0);
  return Math.max(0, (task.estimated || 0) - done);
}

export function progressStats(state, today) {
  const from = addDays(today, -7);
  const recent = state.history.filter((row) => row.date >= from && row.date < today);
  const focused = recent.reduce((sum, row) => sum + (row.actual || 0), 0);
  const onTime = recent.filter((row) => row.onTime).length;
  return {
    completed: recent.length,
    focused,
    focusedLabel: formatDuration(focused),
    onTime: recent.length ? Math.round((onTime / recent.length) * 100) : 0,
    window: productiveWindow(recent),
  };
}

function productiveWindow(rows) {
  if (!rows.length) return "Not enough yet";
  let best = { count: -1, start: 16 * 60 + 30 };
  for (let start = 15 * 60; start <= 20 * 60; start += 15) {
    const count = rows.filter((row) => row.minute >= start && row.minute < start + 90).length;
    if (count > best.count) best = { count, start };
  }
  return formatRange(best.start, best.start + 90);
}

export function openTasks(state) {
  return state.tasks.filter((task) => task.status !== "completed");
}

export function dueThisWeek(state, today) {
  const end = endOfWeek(today);
  return openTasks(state)
    .filter((task) => task.due && task.due <= end)
    .sort((a, b) => a.due.localeCompare(b.due));
}

export function notifications(state, today, nowMin) {
  const items = [];
  for (const notice of state.notices || []) {
    items.push({
      id: notice.id,
      kind: "homework",
      title: notice.title,
      body: notice.body || "Added to Tasks.",
    });
  }
  const settings = state.user.notifications;
  const next = nextUp(state, today, nowMin);
  if (settings.classes && next?.mode === "next" && next.date === today && next.delta <= 30) {
    items.push({
      id: `class-${next.item.id}-${today}`,
      kind: "class",
      title: `${next.item.title} starts in ${next.delta} minute${next.delta === 1 ? "" : "s"}`,
      body: next.item.room || next.item.location || "Upcoming class",
    });
  }
  if (settings.homework) {
    for (const item of agenda(state, today)) {
      if (item.kind !== "session") continue;
      const delta = item.startMin - nowMin;
      if (delta > 0 && delta <= 180) {
        const task = taskById(state, item.taskId);
        items.push({
          id: `session-${item.id}`,
          kind: "homework",
          title: `${item.title} starts at ${formatTime(item.startMin)}`,
          body: task ? `Estimated time: ${task.estimated} minutes.` : "Planned study",
        });
      }
    }
  }
  if (settings.deadlines) {
    for (const task of openTasks(state)) {
      const days = daysBetween(today, task.due);
      const left = remainingMinutes(state, task);
      const scheduled = state.sessions
        .filter((session) => session.taskId === task.id && session.status === "planned")
        .reduce((sum, session) => sum + (toMin(session.end) - toMin(session.start)), 0);
      if (days >= 0 && days <= 3 && left > scheduled + 20) {
        items.push({
          id: `risk-${task.id}`,
          kind: "deadline",
          title: `${task.title} is due ${days === 0 ? "today" : days === 1 ? "tomorrow" : task.due}`,
          body: `You still need approximately ${formatDuration(left - scheduled)}.`,
        });
      }
    }
  }
  if (settings.conflicts) {
    for (const conflict of findConflicts(state)) {
      items.push({
        id: `conflict-${conflict.session.id}-${conflict.with.id || conflict.with.title}`,
        kind: "conflict",
        title: "Your afternoon changed",
        body: `${conflict.task?.title || "A study session"} now conflicts with ${conflict.with.title}.`,
      });
    }
  }
  if (settings.exams) {
    for (const task of openTasks(state).filter((item) => item.type === "exam" || item.type === "test")) {
      const days = daysBetween(today, task.due);
      if (days >= 0 && days <= 14) {
        const nextSession = state.sessions
          .filter((session) => session.taskId === task.id && session.status !== "removed" && (session.date > today || (session.date === today && toMin(session.end) > nowMin)))
          .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))[0];
        items.push({
          id: `exam-${task.id}`,
          kind: "exam",
          title: days === 0 ? `${task.title} is today` : `${task.title} in ${days} day${days === 1 ? "" : "s"}`,
          body: nextSession ? `Your next revision is ${nextSession.date === addDays(today, 1) ? "tomorrow" : nextSession.date}.` : "No revision is booked yet.",
        });
      }
    }
  }
  return items.filter((item) => !(state.dismissed || []).includes(item.id));
}

export function plannedSessions(state, taskId) {
  return state.sessions
    .filter((session) => session.taskId === taskId && session.status !== "removed")
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}
