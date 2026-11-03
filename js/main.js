import { prepareModel, respond, respondChoice } from "./ai.js";
import { blockLength, choreRepeatLabel, choreStep, classEndNotices, estimateMinutes, guessChoreMinutes, nextChoreDate, observedWork, pickRecommendations, recommend, repackSchedule, retuneFuture, shiftStaleSessions, subjectById, taskById } from "./engine.js";
import { accountFromText, apiHostFor, beginSignIn, isConnected, normalizeSchool, profileFromGoogleName, schoolMatchesEmail, syncManageBac } from "./managebac.js";
import { blankManagebac } from "./model.js";
import { liveCountdown, render } from "./render.js";
import { appearanceOf, applyAppearance, DEFAULT_APPEARANCE, fillFontList, GOOGLE_FONTS } from "./theme.js";
import {
  addDays,
  addMonths,
  clone,
  formatRange,
  isWeekend,
  nowParts,
  whenDay,
  relativeDay,
  toMin,
  uid,
  upcomingWeekday,
  weekday,
} from "./time.js";
import {
  applyProposal,
  commit,
  getState,
  initState,
  loadEmpty,
  snapshot,
  subscribe,
  undoChange,
} from "./store.js";

const app = document.querySelector("#app");
initState();
{
  const saved = getState();
  if (!saved.user.onboarded && !saved.ui.draft) {
    saved.ui.draft = onboardDraft(saved);
    saved.ui.draft.step = 1;
  }
}
subscribe(paint);
paint();

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-action]");
  if (!el || !app.contains(el)) return;
  const name = el.dataset.action;
  if (name === "noop") return;
  const action = actions[name];
  if (!action) return;
  if (el.tagName === "BUTTON") event.preventDefault();
  action(el, event);
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-action]");
  if (!form) return;
  event.preventDefault();
  actions[form.dataset.action]?.(form, event);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && getState().ui.sheet) {
    getState().ui.sheet = null;
    getState().ui.draft = null;
    commit();
  }
});

let lastMode = "";
settlePlans();
setInterval(() => {
  settlePlans();
  const state = getState();
  const live = liveCountdown(state);
  const clock = document.querySelector("[data-live='clock']");
  const countdown = document.querySelector("[data-live='countdown']");
  if (clock) clock.textContent = live.clock;
  if (countdown && live.countdown) countdown.textContent = live.countdown;
  const { date, min } = nowParts();
  applyAppearance(state.user, min);
  const fresh = classEndNotices(state, date, min);
  if (fresh.length) {
    state.notices ||= [];
    state.notices.unshift(...fresh);
    state.notices = state.notices.slice(0, 30);
    const latest = fresh[0];
    state.ui.toast = { text: `${latest.title}. ${latest.body}`, changeId: null };
    rememberToast(state.ui.toast);
    lastMode = live.mode;
    commit();
    return;
  }
  const typing = document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (live.mode && live.mode !== lastMode && !typing && state.ui.tab === "today" && !state.ui.sheet) {
    lastMode = live.mode;
    paint();
  } else if (!lastMode) {
    lastMode = live.mode;
  }
}, 1000);

const actions = {
  noop() {},
  nav(el) {
    const state = getState();
    if (el.dataset.tab === "schedule" && state.ui.tab !== "schedule") state.ui.scheduleDate = "";
    state.ui.tab = el.dataset.tab;
    state.ui.sheet = null;
    const hash = `#${el.dataset.tab}`;
    if (location.hash !== hash) location.hash = hash;
    commit();
  },
  "open-ai"() {
    const state = getState();
    state.ui.sheet = { type: "ai" };
    commit();
  },
  "close-sheet"() {
    const state = getState();
    if (state.ui.sheet?.type === "test-confirm") {
      state.ui.sheet = { type: "task", id: state.ui.sheet.id };
      commit();
      return;
    }
    if (state.ui.sheet?.type === "test-time") {
      saveTestTime();
      return;
    }
    state.ui.sheet = null;
    state.ui.draft = null;
    commit();
  },
  "open-profile"() {
    const state = getState();
    state.ui.sheet = { type: "profile" };
    state.ui.draft = profileDraft(state);
    commit();
  },
  "open-settings"() {
    getState().ui.sheet = { type: "settings" };
    commit();
  },
  "set-appearance-mode"(el) {
    const mode = el.dataset.mode;
    if (mode !== "light" && mode !== "dark" && mode !== "auto") return;
    writeAppearance({ mode });
  },
  "reset-appearance"() {
    writeAppearance({ ...DEFAULT_APPEARANCE });
  },
  "use-font"() {
    const selected = document.querySelector("[data-field='fontPick']")?.dataset.selected || "";
    if (!GOOGLE_FONTS.includes(selected)) {
      const state = getState();
      state.ui.toast = { text: "Choose a Google font from the list.", changeId: null };
      rememberToast(state.ui.toast);
      commit();
      return;
    }
    writeAppearance({ font: selected });
  },
  "open-notes"() {
    getState().ui.sheet = { type: "notes" };
    commit();
  },
  "add-task"() {
    const state = getState();
    const { date } = nowParts();
    state.ui.tab = "tasks";
    state.ui.draft = {
      step: 1,
      type: "homework",
      subjectId: state.subjects[0]?.id || "math",
      title: "",
      description: "",
      due: upcomingWeekday(date, 4) === date ? addDays(date, 7) : upcomingWeekday(date, 4),
      difficulty: "medium",
      notes: "",
      link: "",
      attachmentName: "",
      estimated: null,
      manual: false,
      chosen: 0,
      error: "",
    };
    const math = state.subjects.find((subject) => subject.id === "math");
    if (math) state.ui.draft.subjectId = "math";
    state.ui.sheet = { type: "add" };
    commit();
  },
  "set-field"(el) {
    syncFields();
    const draft = getState().ui.draft;
    if (!draft) return;
    const field = el.dataset.field;
    if (field === "more") draft.more = true;
    else if (field === "repeat") setRepeat(draft, el.dataset.value);
    else draft[field] = el.dataset.value;
    if (field === "subjectId" && getState().ui.sheet?.type === "class") {
      const subject = subjectById(getState(), draft.subjectId);
      if (subject) draft.teacher = subject.teacher;
    }
    draft.error = "";
    commit();
  },
  "toggle-draft"(el) {
    const draft = getState().ui.draft;
    if (!draft) return;
    draft[el.dataset.field] = !draft[el.dataset.field];
    commit();
  },
  "nudge-estimate"(el) {
    const draft = getState().ui.draft;
    draft.estimated = Math.max(15, Math.min(240, Number(draft.estimated) + Number(el.dataset.delta)));
    draft.manual = true;
    commit();
  },
  "choose-slot"(el) {
    getState().ui.draft.chosen = Number(el.dataset.index);
    commit();
  },
  "add-back"() {
    const draft = getState().ui.draft;
    draft.step = Math.max(1, draft.step - 1);
    draft.error = "";
    commit();
  },
  "add-next"() {
    syncFields();
    const state = getState();
    const draft = state.ui.draft;
    if (draft.step === 1) {
      if (!draft.title.trim()) {
        draft.error = "Give the homework a name.";
        commit();
        return;
      }
      if (!draft.due) {
        draft.error = "Choose a due date.";
        commit();
        return;
      }
      const { date } = nowParts();
      if (draft.due < date) {
        draft.error = "That due date has already passed.";
        commit();
        return;
      }
      if (!draft.manual || !draft.estimated) draft.estimated = estimateMinutes(state, draft);
      draft.step = 2;
      draft.error = "";
      commit();
      return;
    }
    if (draft.step === 2) {
      fillPlan(state, draft);
      draft.step = 3;
      commit();
    }
  },
  "find-time"() {
    const state = getState();
    const draft = state.ui.draft;
    const relaxed = clone(state);
    relaxed.user.preferences = {
      ...relaxed.user.preferences,
      weekendStudy: true,
      homeworkTiming: "yes",
      breakMinutes: 0,
    };
    fillPlan(relaxed, draft);
    draft.relaxed = true;
    if (!draft.slots.length) {
      draft.error = "Even with shorter breaks, there still isn’t a fit.";
    }
    commit();
  },
  "confirm-plan"() {
    savePlan(false);
  },
  "save-unplanned"() {
    savePlan(true);
  },
  "open-task"(el) {
    getState().ui.sheet = { type: "task", id: el.dataset.id };
    commit();
  },
  "open-item"(el) {
    getState().ui.sheet = { type: "detail", kind: el.dataset.kind, id: el.dataset.id, date: el.dataset.date };
    commit();
  },
  "schedule-task"(el) {
    const state = getState();
    const task = taskById(state, el.dataset.id);
    if (!task) return;
    state.ui.draft = {
      step: 3,
      taskId: task.id,
      type: task.type,
      subjectId: task.subjectId,
      title: task.title,
      description: task.description,
      due: task.due,
      difficulty: task.difficulty,
      estimated: task.estimated,
      chosen: 0,
      manual: true,
    };
    fillPlan(state, state.ui.draft);
    state.ui.sheet = { type: "add" };
    commit();
  },
  "ask-actual"(el) {
    const state = getState();
    const task = taskById(state, el.dataset.id);
    if (!task) return;
    const { date, min } = nowParts();
    const observed = observedWork(state, task, date, min);
    if (observed) {
      finishTask(state, task, observed.actual);
      return;
    }
    state.ui.sheet = { type: "actual", taskId: task.id };
    state.ui.draft = { actual: String(task.estimated || 30) };
    commit();
  },
  "save-actual"() {
    syncFields();
    const state = getState();
    const task = taskById(state, state.ui.sheet.taskId);
    if (!task) return;
    const actual = Math.max(1, Number(state.ui.draft.actual) || task.estimated);
    finishTask(state, task, actual);
  },
  "delete-task"(el) {
    const state = getState();
    const undo = snapshot();
    const task = taskById(state, el.dataset.id);
    state.tasks = state.tasks.filter((item) => item.id !== el.dataset.id);
    state.sessions = state.sessions.filter((item) => item.taskId !== el.dataset.id);
    const change = pushChange(`Deleted ${task?.title || "homework"}`, undo);
    state.ui.sheet = null;
    state.ui.toast = { text: "Homework deleted", changeId: change.id };
    rememberToast(state.ui.toast);
    commit();
  },
  "mark-test"(el) {
    const state = getState();
    const task = taskById(state, el.dataset.id);
    if (!task || task.status === "completed") return;
    state.ui.sheet = { type: "test-confirm", id: task.id };
    commit();
  },
  "cancel-test"(el) {
    const state = getState();
    const id = el.dataset.id || state.ui.sheet?.id;
    state.ui.sheet = id ? { type: "task", id } : null;
    commit();
  },
  "confirm-test"(el) {
    const state = getState();
    const task = taskById(state, el.dataset.id || state.ui.sheet?.id);
    if (!task) return;
    const { date } = nowParts();
    const subject = state.subjects.find((item) => item.id === task.subjectId);
    const event = {
      id: uid(),
      title: task.title,
      date: task.due || date,
      start: "09:00",
      end: "10:00",
      location: "",
      removed: false,
      assessment: true,
      color: subject?.color || "#7C6AD8",
    };
    state.events.push(event);
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
    state.sessions = state.sessions.filter((item) => item.taskId !== task.id);
    state.ui.draft = { start: event.start, end: event.end, error: "" };
    state.ui.sheet = { type: "test-time", id: event.id };
    commit();
  },
  "save-test-time"() {
    saveTestTime();
  },
  "add-session"(el) {
    const state = getState();
    const task = taskById(state, el.dataset.id);
    if (!task || task.status === "completed") return;
    const { date, min } = nowParts();
    const current = state.sessions.find((session) => session.taskId === task.id && session.status === "planned" && session.start && session.end);
    const duration = current
      ? Math.max(15, toMin(current.end) - toMin(current.start))
      : blockLength(task.estimated || 30);
    const due = task.due && task.due >= date ? task.due : addDays(date, 7);
    const schoolStart = toMin(state.user.routine.schoolStart);
    const schoolEnd = toMin(state.user.routine.schoolEnd);
    const slot = recommend(state, { duration, due, today: date, nowMin: min }).find((item) => {
      if (isWeekend(item.date)) return true;
      return item.endMin <= schoolStart || item.startMin >= schoolEnd;
    });
    if (!slot || slot.date > due) {
      state.ui.toast = { text: "There isn’t a free time before the due date.", changeId: null };
      rememberToast(state.ui.toast);
      commit();
      return;
    }
    state.sessions.push({
      id: uid(),
      taskId: task.id,
      date: slot.date,
      start: slot.start,
      end: slot.end,
      status: "planned",
      label: current?.label || "",
      autoDone: true,
    });
    task.status = "planned";
    state.ui.sheet = { type: "task", id: task.id };
    state.ui.toast = {
      text: `Another session is ${whenDay(slot.date, date)} · ${formatRange(slot.start, slot.end)}. It marks this homework done then.`,
      changeId: null,
    };
    rememberToast(state.ui.toast);
    commit();
  },
  "start-move"(el) {
    const state = getState();
    const session = state.sessions.find((item) => item.id === el.dataset.id);
    const task = session ? taskById(state, session.taskId) : null;
    if (!session || !task) return;
    const { date, min } = nowParts();
    const duration = toMin(session.end) - toMin(session.start);
    const slots = pickRecommendations(recommend(state, {
      duration,
      due: task.due || addDays(date, 7),
      today: date,
      nowMin: min,
      ignoreSessionIds: [session.id],
    }));
    state.ui.draft = { sessionId: session.id, title: task.title, slots, chosen: 0 };
    state.ui.sheet = { type: "move" };
    commit();
  },
  "confirm-move"() {
    const state = getState();
    const draft = state.ui.draft;
    const slot = draft.slots[draft.chosen];
    const session = state.sessions.find((item) => item.id === draft.sessionId);
    if (!slot || !session) return;
    const undo = snapshot();
    session.date = slot.date;
    session.start = slot.start;
    session.end = slot.end;
    const change = pushChange("Moved a study session", undo);
    state.ui.sheet = null;
    state.ui.toast = { text: "Session moved", changeId: change.id };
    rememberToast(state.ui.toast);
    commit();
  },
  "remove-session"(el) {
    const state = getState();
    const undo = snapshot();
    const session = state.sessions.find((item) => item.id === el.dataset.id);
    if (session) session.status = "removed";
    const change = pushChange("Removed a study session", undo);
    state.ui.sheet = null;
    state.ui.toast = { text: "Session removed", changeId: change.id };
    rememberToast(state.ui.toast);
    commit();
  },
  "edit-class"(el) {
    const state = getState();
    const existing = el.dataset.id ? state.classes.find((item) => item.id === el.dataset.id) : null;
    const subject = subjectById(state, existing?.subjectId || "math");
    const startDate = el.dataset.date || state.ui.scheduleDate || nowParts().date;
    const repeat = repeatChoice(existing);
    state.ui.draft = existing ? {
      id: existing.id,
      className: existing.title || subject?.name || "",
      subjectId: existing.subjectId,
      startDate: existing.startDate || startDate,
      repeat: repeat.repeat,
      interval: repeat.interval,
      start: existing.start,
      end: existing.end,
      room: existing.room || "",
      teacher: existing.teacher || subject?.teacher || "",
      notes: existing.notes || "",
      error: "",
    } : {
      id: "",
      className: "",
      subjectId: "",
      startDate,
      repeat: "week",
      interval: 1,
      start: "09:00",
      end: "09:50",
      room: "",
      teacher: subjectById(state, "math")?.teacher || "",
      notes: "",
      error: "",
    };
    state.ui.sheet = { type: "class" };
    commit();
  },
  "save-class"() {
    syncFields();
    const state = getState();
    const draft = state.ui.draft;
    if (!draft.start || !draft.end || draft.end <= draft.start) {
      draft.error = "End time needs to be after the start.";
      commit();
      return;
    }
    const startDate = draft.startDate || nowParts().date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      draft.error = "Add the date of the first class.";
      commit();
      return;
    }
    const className = String(draft.className || "").trim();
    if (!className) {
      draft.error = "Type the class name.";
      commit();
      return;
    }
    const custom = draft.repeat === "days" || draft.repeat === "weeks";
    const repeatEvery = custom ? Math.max(1, Math.round(Number(draft.interval) || 2)) : 1;
    const repeatUnit = draft.repeat === "day" || draft.repeat === "days" ? "day" : "week";
    const subjectId = subjectForTypedClass(state, className);
    const subject = subjectById(state, subjectId);
    const lesson = {
      id: draft.id || uid(),
      title: className,
      subjectId,
      start: draft.start,
      end: draft.end,
      room: draft.room.trim(),
      teacher: draft.teacher.trim() || subject?.teacher || "",
      notes: draft.notes.trim(),
      startDate,
      repeatEvery,
      repeatUnit,
      recurrence: "repeat",
      day: weekday(startDate),
    };
    if (draft.id) {
      const index = state.classes.findIndex((item) => item.id === draft.id);
      if (index >= 0) state.classes[index] = lesson;
      else state.classes.push(lesson);
    } else state.classes.push(lesson);
    state.ui.sheet = null;
    state.ui.tab = "schedule";
    state.ui.toast = { text: draft.id ? "Class updated" : "Class added", changeId: null };
    rememberToast(state.ui.toast);
    commit();
  },
  "skip-class"(el) {
    const state = getState();
    const undo = snapshot();
    state.exceptions.push({ id: uid(), classId: el.dataset.id, date: el.dataset.date, type: "cancel" });
    const change = pushChange("Skipped one class", undo);
    state.ui.sheet = null;
    state.ui.toast = { text: "Skipped this date", changeId: change.id };
    rememberToast(state.ui.toast);
    commit();
  },
  "delete-class"(el) {
    const state = getState();
    const undo = snapshot();
    if (el.dataset.override === "1") state.overrides = state.overrides.filter((item) => item.id !== el.dataset.id);
    else state.classes = state.classes.filter((item) => item.id !== el.dataset.id);
    const change = pushChange("Removed a class", undo);
    state.ui.sheet = null;
    state.ui.toast = { text: "Class removed", changeId: change.id };
    rememberToast(state.ui.toast);
    commit();
  },
  "add-chore"() {
    const state = getState();
    state.ui.draft = { title: "", error: "", repeat: "once", interval: 1 };
    state.ui.sheet = { type: "chore" };
    commit();
  },
  "save-chore"() {
    syncFields();
    const state = getState();
    const title = String(state.ui.draft?.title || "").trim();
    if (!title) {
      state.ui.draft.error = "Type the chore.";
      commit();
      return;
    }
    state.chores ||= [];
    const choice = state.ui.draft.repeat || "once";
    const custom = choice === "days" || choice === "weeks";
    const repeating = choice !== "once";
    const chore = {
      id: uid(),
      title,
      done: false,
      estimated: guessChoreMinutes(title),
      date: "",
      start: "",
      end: "",
      repeatEvery: repeating ? (custom ? Math.max(1, Math.round(Number(state.ui.draft.interval) || 2)) : 1) : 0,
      repeatUnit: !repeating ? "" : (choice === "day" || choice === "days" ? "day" : "week"),
      doneDates: [],
    };
    state.chores.unshift(chore);
    const { date, min } = nowParts();
    const moved = repackSchedule(state, date, min);
    state.ui.sheet = null;
    state.ui.draft = null;
    state.ui.tab = "chores";
    if (location.hash !== "#chores") location.hash = "chores";
    const when = chore.start ? `${relativeDay(chore.date, date)} · ${formatRange(chore.start, chore.end)}` : "";
    const repeat = choreRepeatLabel(chore);
    state.ui.toast = {
      text: when
        ? `Added. ${chore.estimated} min${repeat ? `, ${repeat.toLowerCase()}` : ""}, recommended ${when}.${moved ? " The schedule moved to fit." : ""}`
        : "Chore added. No free time in the next few days.",
      changeId: null,
    };
    rememberToast(state.ui.toast);
    commit();
  },
  "toggle-chore"(el) {
    const state = getState();
    const chore = (state.chores || []).find((item) => item.id === el.dataset.id);
    if (!chore) return;
    const { date, min } = nowParts();
    if (choreStep(chore)) {
      const target = el.dataset.date || nextChoreDate(chore, date) || chore.date;
      chore.doneDates ||= [];
      chore.doneDates = chore.doneDates.includes(target)
        ? chore.doneDates.filter((item) => item !== target)
        : [...chore.doneDates, target];
    } else {
      chore.done = !chore.done;
      if (chore.done) {
        chore.date = "";
        chore.start = "";
        chore.end = "";
      }
    }
    repackSchedule(state, date, min);
    if (state.ui.sheet?.type === "detail" && state.ui.sheet.id === chore.id) state.ui.sheet = null;
    commit();
  },
  "delete-chore"(el) {
    const state = getState();
    state.chores = (state.chores || []).filter((item) => item.id !== el.dataset.id);
    const { date, min } = nowParts();
    repackSchedule(state, date, min);
    if (state.ui.sheet?.kind === "chore" && state.ui.sheet.id === el.dataset.id) state.ui.sheet = null;
    commit();
  },
  "filter-tasks"(el) {
    getState().ui.taskFilter = el.dataset.filter;
    commit();
  },
  "open-schedule-calendar"() {
    const state = getState();
    const { date } = nowParts();
    state.ui.draft = { month: startOfMonthSafe(state.ui.scheduleDate || date) };
    state.ui.sheet = { type: "schedule-calendar" };
    commit();
  },
  "shift-schedule-month"(el) {
    const state = getState();
    const { date } = nowParts();
    const month = state.ui.draft?.month || startOfMonthSafe(state.ui.scheduleDate || date);
    state.ui.draft = { month: addMonths(month, Number(el.dataset.delta)) };
    commit();
  },
  "pick-schedule-day"(el) {
    const state = getState();
    state.ui.scheduleDate = el.dataset.date;
    state.ui.sheet = null;
    state.ui.draft = null;
    commit();
  },
  "cal-mode"(el) {
    getState().ui.calendarMode = el.dataset.mode;
    commit();
  },
  "cal-today"() {
    const { date } = nowParts();
    getState().ui.calendarDate = date;
    commit();
  },
  "cal-shift"(el) {
    const state = getState();
    const { date } = nowParts();
    const anchor = state.ui.calendarDate || date;
    const delta = Number(el.dataset.delta);
    if (state.ui.calendarMode === "month") state.ui.calendarDate = addMonths(startOfMonthSafe(anchor), delta);
    else if (state.ui.calendarMode === "week") state.ui.calendarDate = addDays(anchor, delta * 7);
    else state.ui.calendarDate = addDays(anchor, delta);
    commit();
  },
  "open-day"(el) {
    const state = getState();
    state.ui.calendarDate = el.dataset.date;
    state.ui.calendarMode = "day";
    state.ui.tab = "calendar";
    commit();
  },
  "ai-send"() {
    sendAi(document.querySelector("#ai-input")?.value || getState().ui.aiInput || "");
  },
  "ai-chip"(el) {
    sendAi(el.dataset.text || "");
  },
  "ai-choice"(el) {
    const state = getState();
    const message = state.messages.find((item) => item.id === el.dataset.id);
    if (!message?.pending) return;
    const { date, min } = nowParts();
    const turn = respondChoice(message.pending, el.dataset.choice, state, date, min);
    message.resolved = true;
    pushTurn(turn);
    commit();
  },
  "apply-proposal"(el) {
    const state = getState();
    const message = state.messages.find((item) => item.id === el.dataset.id);
    if (!message?.proposal || message.applied) return;
    const change = applyProposal(message.proposal);
    message.applied = true;
    message.changeId = change.id;
    rememberToast(state.ui.toast);
    commit();
  },
  "dismiss-proposal"(el) {
    const message = getState().messages.find((item) => item.id === el.dataset.id);
    if (message) message.dismissed = true;
    getState().messages.push({ id: uid(), role: "assistant", text: "Kept the original plan." });
    commit();
  },
  undo(el) {
    if (undoChange(el.dataset.id)) rememberToast(getState().ui.toast);
    commit();
  },
  "dismiss-note"(el) {
    getState().dismissed.push(el.dataset.id);
    commit();
  },
  "save-profile"() {
    syncFields();
    const state = getState();
    const draft = state.ui.draft;
    state.user.name = draft.name.trim() || state.user.name;
    state.user.grade = draft.grade.trim();
    state.user.school = draft.school.trim();
    state.user.routine = {
      wake: draft.wake,
      schoolStart: draft.schoolStart,
      schoolEnd: draft.schoolEnd,
      dinner: draft.dinner,
      dinnerEnd: draft.dinnerEnd,
      bed: draft.bed,
    };
    state.user.preferences = {
      ...state.user.preferences,
      homeworkTiming: draft.homeworkTiming,
      breakMinutes: Number(draft.breakMinutes) || 0,
      preferred: [{ start: draft.preferredStart, end: draft.preferredEnd }],
      weekendStudy: Boolean(draft.weekendStudy),
    };
    state.user.notifications = {
      ...state.user.notifications,
      classes: Boolean(draft.classes),
      homework: Boolean(draft.homework),
      deadlines: Boolean(draft.deadlines),
      conflicts: Boolean(draft.conflicts),
      exams: Boolean(draft.exams),
    };
    if (validEmail(draft.googleEmail) && normalizeSchool(draft.schoolHost)) {
      applyManagebacDraft(state, draft);
    }
    state.ui.sheet = null;
    state.ui.toast = { text: "Profile saved", changeId: null };
    rememberToast(state.ui.toast);
    commit();
    runSync(false);
  },
  "export-data"() {
    const copy = clone(getState());
    delete copy.ui;
    if (copy.managebac) {
      copy.managebac = { ...copy.managebac, authToken: "", clientSecret: "" };
    }
    const blob = new Blob([JSON.stringify(copy, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "ordup.json";
    link.click();
    URL.revokeObjectURL(link.href);
  },
  "delete-account"() {
    if (!confirm("Delete this plan from this browser?")) return;
    loadEmpty();
  },
  "onboard-go"(el) {
    const state = getState();
    if (!state.ui.draft || el.dataset.step === "1") state.ui.draft = onboardDraft(state);
    state.ui.draft.step = Number(el.dataset.step);
    state.ui.draft.error = "";
    commit();
  },
  "sync-managebac"() {
    syncFields();
    const state = getState();
    if (state.ui.draft?.googleEmail != null && state.ui.sheet?.type === "profile") {
      const problem = applyManagebacDraft(state, state.ui.draft);
      if (problem) {
        state.managebac.lastError = problem;
        commit();
        return;
      }
    }
    if (!state.managebac?.signedIn) {
      signInThenSync(false);
      return;
    }
    runSync(true);
  },
  "google-login"() {},
  "onboard-next"() {
    syncFields();
    const state = getState();
    const draft = state.ui.draft || onboardDraft(state);
    state.ui.draft = draft;
    if (draft.busy) return;
    const step = draft.step || 1;
    if (step === 1 && !validEmail(draft.googleEmail)) {
      draft.error = "Login with Google first.";
      commit();
      return;
    }
    if (step < 4) {
      draft.step = step + 1;
      draft.error = "";
      commit();
      return;
    }
    const problem = applyManagebacDraft(state, draft);
    if (problem) {
      draft.error = problem;
      commit();
      return;
    }
    applyOnboardProfile(state, draft);
    const count = state.tasks.length;
    finishOnboard(count ? "Your tasks are ready." : "Setup is done.", count ? "tasks" : "today");
  },
  "onboard-skip"() {
    syncFields();
    const state = getState();
    const draft = state.ui.draft || onboardDraft(state);
    if (draft.busy) return;
    applyOnboardProfile(state, draft);
    if (validEmail(draft.googleEmail)) state.managebac.email = String(draft.googleEmail).trim().toLowerCase();
    finishOnboard("You can connect ManageBac later from your profile.");
  },
};

function adoptGoogleAccount(account) {
  const current = getState();
  const profile = profileFromGoogleName(account?.name || "");
  current.ui.syncing = false;
  if (!profile.name) {
    if (current.ui.draft) {
      current.ui.draft.busy = false;
      current.ui.draft.error = account?.error || "Google didn’t send the name on that account.";
    }
    commit();
    return;
  }
  current.user.name = profile.name;
  if (profile.grade) current.user.grade = profile.grade;
  if (account.email) current.managebac = { ...(current.managebac || {}), email: account.email };
  if (current.ui.draft) {
    current.ui.draft.name = profile.name;
    if (profile.grade) current.ui.draft.grade = profile.grade;
    if (account.email) current.ui.draft.googleEmail = account.email;
    current.ui.draft.busy = false;
    current.ui.draft.error = "";
    current.ui.draft.status = "";
    if (!current.user.onboarded) current.ui.draft.step = 2;
  }
  commit();
}

function takeGoogleAccount() {
  const raw = localStorage.getItem("ordup.google.pending");
  if (!raw) return;
  localStorage.removeItem("ordup.google.pending");
  try {
    adoptGoogleAccount(JSON.parse(raw));
  } catch {
    adoptGoogleAccount(null);
  }
}

function watchGoogleTab(tab) {
  if (!tab) return;
  const started = Date.now();
  const timer = setInterval(() => {
    if (tab.closed || Date.now() - started > 4 * 60 * 1000) {
      clearInterval(timer);
      return;
    }
    let text = "";
    try {
      text = tab.document?.body?.innerText || "";
    } catch {
      return;
    }
    const account = accountFromText(text);
    if (!account.name) return;
    clearInterval(timer);
    adoptGoogleAccount(account);
    try { tab.close(); } catch { /* the sign-in tab can stay open */ }
    window.focus();
  }, 700);
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  if (event.data?.type !== "ordup-google-tab") return;
  watchGoogleTab(event.source);
});

function paint() {
  const state = getState();
  applyAppearance(state.user, nowParts().min);
  app.innerHTML = render(state);
  document.body.classList.toggle("sheet-open", Boolean(state.ui.sheet) || !state.user.onboarded);
  app.querySelectorAll("[data-field]").forEach((input) => {
    const write = () => {
      if (input.dataset.field === "aiInput") {
        state.ui.aiInput = input.value;
        return;
      }
      if (state.ui.draft) state.ui.draft[input.dataset.field] = input.value;
    };
    input.addEventListener("input", write);
    input.addEventListener("change", write);
  });
  const file = app.querySelector("input[type='file'][data-field='attachment']");
  file?.addEventListener("change", () => {
    if (state.ui.draft) state.ui.draft.attachmentName = file.files?.[0]?.name || "";
    commit();
  });
  const log = app.querySelector(".chat-log");
  if (log) log.scrollTop = log.scrollHeight;
  if (state.ui.sheet?.type === "ai") app.querySelector("#ai-input")?.focus();
  const fontPick = app.querySelector("[data-field='fontPick']");
  if (fontPick) {
    const current = appearanceOf(state.user).font;
    fillFontList(fontPick, "", current);
    fontPick.addEventListener("click", (event) => {
      const button = event.target.closest("[data-font]");
      if (!button || !fontPick.contains(button)) return;
      fontPick.querySelectorAll(".font-choice.on").forEach((item) => item.classList.remove("on"));
      button.classList.add("on");
      fontPick.dataset.selected = button.dataset.font;
    });
    app.querySelector("[data-field='fontQuery']")?.addEventListener("input", (event) => {
      fillFontList(fontPick, event.target.value, fontPick.dataset.selected || current);
    });
  }
  const color = app.querySelector("[data-field='themeColor']");
  color?.addEventListener("input", () => {
    applyAppearance(state.user, nowParts().min, { color: color.value });
  });
  color?.addEventListener("change", () => {
    writeAppearance({ color: color.value });
  });
}

function writeAppearance(partial) {
  const state = getState();
  const current = appearanceOf(state.user);
  state.user.appearance = { ...current, ...partial };
  if (partial.color) state.user.appearance.color = String(partial.color).toLowerCase();
  applyAppearance(state.user, nowParts().min);
  commit();
}

function saveTestTime() {
  syncFields();
  const state = getState();
  const event = state.events.find((item) => item.id === state.ui.sheet?.id);
  if (!event) {
    state.ui.sheet = null;
    state.ui.draft = null;
    commit();
    return;
  }
  const draft = state.ui.draft || {};
  const start = draft.start || event.start;
  const end = draft.end || event.end;
  if (!start || !end || toMin(end) <= toMin(start)) {
    state.ui.draft = { ...draft, start, end, error: "The test needs a start time and a later end time." };
    commit();
    return;
  }
  event.start = start;
  event.end = end;
  state.ui.sheet = null;
  state.ui.draft = null;
  state.ui.toast = { text: "Marked as a test", changeId: null };
  rememberToast(state.ui.toast);
  commit();
}

function syncFields() {
  const state = getState();
  document.querySelectorAll("#app input[data-field], #app textarea[data-field], #app select[data-field]").forEach((input) => {
    if (input.type === "file") return;
    if (input.dataset.field === "aiInput") {
      state.ui.aiInput = input.value;
      return;
    }
    if (state.ui.draft) state.ui.draft[input.dataset.field] = input.value;
  });
}

async function sendAi(raw) {
  const text = raw.trim();
  if (!text) return;
  const state = getState();
  const { date, min } = nowParts();
  state.messages.push({ id: uid(), role: "user", text });
  const pendingId = uid();
  state.messages.push({ id: pendingId, role: "assistant", text: "Thinking…" });
  state.ui.aiInput = "";
  state.ui.sheet = { type: "ai" };
  commit();
  const report = (status) => {
    const bubble = getState().messages.find((item) => item.id === pendingId);
    if (!bubble || bubble.text === status) return;
    bubble.text = status;
    commit();
  };
  prepareModel(report);
  let turn;
  try {
    turn = await respond(text, getState(), date, min, report);
  } catch {
    turn = { text: "I couldn’t answer that. Try sending it again." };
  }
  const bubble = getState().messages.find((item) => item.id === pendingId);
  if (bubble) {
    bubble.text = turn.text;
    bubble.proposal = turn.proposal || null;
    bubble.choices = turn.choices || null;
    bubble.pending = turn.pending || null;
  } else pushTurn(turn);
  commit();
}

function pushTurn(turn) {
  getState().messages.push({
    id: uid(),
    role: "assistant",
    text: turn.text,
    proposal: turn.proposal || null,
    choices: turn.choices || null,
    pending: turn.pending || null,
  });
}

function fillPlan(state, draft) {
  const { date, min } = nowParts();
  const minutes = Number(draft.estimated) || 30;
  draft.plan = null;
  draft.slots = pickRecommendations(recommend(state, {
    duration: blockLength(minutes),
    due: draft.due,
    today: date,
    nowMin: min,
  }));
  draft.chosen = 0;
}

function savePlan(unplanned) {
  const state = getState();
  const draft = state.ui.draft;
  const { date } = nowParts();
  let task = draft.taskId ? taskById(state, draft.taskId) : null;
  if (!task) {
    task = {
      id: uid(),
      subjectId: draft.subjectId,
      type: draft.type,
      title: draft.title.trim(),
      description: (draft.description || "").trim(),
      assigned: date,
      due: draft.due,
      difficulty: draft.difficulty,
      estimated: Number(draft.estimated) || 30,
      actual: null,
      priority: draft.type === "exam" || draft.type === "test" ? "high" : "medium",
      status: "unplanned",
      notes: (draft.notes || "").trim(),
      link: (draft.link || "").trim(),
      attachmentName: draft.attachmentName || "",
    };
    state.tasks.unshift(task);
  }
  const created = [];
  if (!unplanned && draft.slots?.length) {
    created.push(sessionFrom(task.id, draft.slots[draft.chosen] || draft.slots[0]));
  }
  state.sessions.push(...created);
  if (created.length) task.status = "planned";
  const when = created[0];
  let moved = 0;
  if (created.length) {
    const parts = nowParts();
    moved = repackSchedule(state, parts.date, parts.min);
  }
  state.ui.sheet = null;
  state.ui.draft = null;
  state.ui.tab = "today";
  if (location.hash !== "#today") location.hash = "today";
  if (when) {
    state.ui.calendarDate = when.date;
    state.ui.calendarMode = "week";
  }
  state.ui.toast = {
    text: when ? (moved ? "Added to your plan. The schedule moved to fit." : "Added to your plan") : "Saved without a time",
    changeId: null,
  };
  rememberToast(state.ui.toast);
  commit();
}

function sessionFrom(taskId, slot) {
  return {
    id: uid(),
    taskId,
    date: slot.date,
    start: slot.start,
    end: slot.end,
    status: "planned",
    label: slot.label || "",
  };
}

function profileDraft(state) {
  const { user } = state;
  const preferred = user.preferences.preferred?.[0] || { start: "16:00", end: "18:30" };
  return {
    name: user.name,
    grade: user.grade,
    school: user.school || "",
    wake: user.routine.wake,
    bed: user.routine.bed,
    schoolStart: user.routine.schoolStart,
    schoolEnd: user.routine.schoolEnd,
    dinner: user.routine.dinner,
    dinnerEnd: user.routine.dinnerEnd,
    homeworkTiming: user.preferences.homeworkTiming,
    breakMinutes: user.preferences.breakMinutes,
    preferredStart: preferred.start,
    preferredEnd: preferred.end,
    weekendStudy: user.preferences.weekendStudy,
    classes: user.notifications.classes,
    homework: user.notifications.homework,
    deadlines: user.notifications.deadlines,
    conflicts: user.notifications.conflicts,
    exams: user.notifications.exams,
    googleEmail: state.managebac?.email || "",
    schoolHost: state.managebac?.schoolHost || "",
    apiHost: state.managebac?.apiHost || "api.managebac.com",
  };
}

function onboardDraft(state) {
  const base = profileDraft(state);
  return {
    ...base,
    step: 1,
    name: state.user.name || "",
    timezone: state.user.timezone,
    homeworkTiming: state.user.preferences.homeworkTiming || "break",
    breakMinutes: state.user.preferences.breakMinutes || 30,
    weekendStudy: true,
    googleEmail: state.managebac?.email || "",
    schoolHost: state.managebac?.schoolHost || "",
    apiHost: state.managebac?.apiHost || "api.managebac.com",
    busy: false,
    error: "",
  };
}

function subjectForTypedClass(state, label) {
  const name = String(label || "").trim();
  const hay = name.toLowerCase();
  const existing = state.subjects.find((subject) => subject.name.toLowerCase() === hay || subject.short.toLowerCase() === hay);
  if (existing) return existing.id;
  const id = `class-${hay.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "class"}`;
  const taken = state.subjects.find((subject) => subject.id === id);
  if (taken) return taken.id;
  const colors = ["#6D4AFF", "#E36A45", "#1F9D8A", "#C8962E", "#3A7BD5", "#D4537E", "#7C6AD8"];
  state.subjects.push({
    id,
    name,
    short: name.split(/\s+/)[0].slice(0, 12),
    teacher: "",
    color: colors[state.subjects.length % colors.length],
  });
  return id;
}

function applyOnboardProfile(state, draft) {
  state.user.name = draft.name.trim();
  state.user.grade = draft.grade.trim();
  state.user.school = draft.school.trim();
  state.user.timezone = draft.timezone || state.user.timezone;
  state.user.routine = {
    wake: draft.wake,
    schoolStart: draft.schoolStart,
    schoolEnd: draft.schoolEnd,
    dinner: draft.dinner,
    dinnerEnd: draft.dinnerEnd || shiftMinutes(draft.dinner, 30),
    bed: draft.bed,
  };
  state.user.preferences = {
    ...state.user.preferences,
    homeworkTiming: draft.homeworkTiming || "break",
    breakMinutes: Number(draft.breakMinutes) || 30,
    preferred: [{ start: draft.preferredStart || "16:00", end: draft.preferredEnd || "18:30" }],
    weekendStudy: draft.weekendStudy !== false,
  };
}

function applyManagebacDraft(state, draft) {
  const email = String(draft.googleEmail || "").trim().toLowerCase();
  if (!validEmail(email)) return "Add the Google email your school uses for ManageBac.";
  const schoolHost = normalizeSchool(draft.schoolHost);
  if (!schoolHost) return "Add your school’s ManageBac address, like yourschool.managebac.com.";
  if (!schoolMatchesEmail(email, schoolHost)) {
    const domain = email.split("@")[1] || "";
    if (domain === "gmail.com" || domain === "googlemail.com" || domain === "outlook.com" || domain === "hotmail.com" || domain === "yahoo.com" || domain === "icloud.com") {
      return "Login with the Google account your school gave you. A personal email can’t be matched to a ManageBac school.";
    }
    return `${schoolHost} doesn’t match ${email}. Use the ManageBac address for that same school.`;
  }
  const previous = state.managebac || blankManagebac();
  state.managebac = {
    ...blankManagebac(),
    ...previous,
    email,
    schoolHost,
    apiHost: apiHostFor(schoolHost, draft.apiHost || previous.apiHost),
    authToken: "",
    clientId: "",
    clientSecret: "",
    signedIn: previous.schoolHost === schoolHost ? Boolean(previous.signedIn) : false,
    lastError: "",
  };
  return "";
}

function signInThenSync(finish) {
  const state = getState();
  const host = state.managebac.schoolHost;
  state.ui.syncing = true;
  if (!finish) commit();
  const ready = state.managebac.signedIn ? Promise.resolve() : beginSignIn(host);
  ready.then(() => {
    if (finish) applyOnboardProfile(getState(), getState().ui.draft || {});
    return syncManageBac(getState());
  }).then((result) => {
    const current = getState();
    current.ui.syncing = false;
    const count = result?.added || 0;
    if (count) current.ui.taskFilter = "all";
    const text = count
      ? `Added ${count} ManageBac task${count === 1 ? "" : "s"}`
      : "Signed in. New ManageBac tasks will show up here.";
    if (finish) {
      finishOnboard(text, count ? "tasks" : "today");
      return;
    }
    current.ui.toast = { text, changeId: null };
    rememberToast(current.ui.toast);
    if (count) {
      current.ui.tab = "tasks";
      if (location.hash !== "#tasks") location.hash = "tasks";
    }
    commit();
  }).catch((error) => {
    const current = getState();
    current.ui.syncing = false;
    const message = error.message || "Couldn’t sign in to ManageBac.";
    current.managebac.lastError = message;
    if (current.ui.draft) {
      current.ui.draft.busy = false;
      current.ui.draft.status = "";
      current.ui.draft.error = message;
    }
    if (!finish) {
      current.ui.toast = { text: message, changeId: null };
      rememberToast(current.ui.toast);
    }
    commit();
  });
}

function finishOnboard(text, tab = "today") {
  const state = getState();
  state.user.onboarded = true;
  state.ui.draft = null;
  state.ui.sheet = null;
  state.ui.tab = tab;
  state.ui.toast = { text, changeId: null };
  rememberToast(state.ui.toast);
  const hash = `#${tab}`;
  if (location.hash !== hash) location.hash = hash;
  commit();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

let syncing = false;

function runSync(manual) {
  const state = getState();
  if (syncing || !isConnected(state)) return;
  if (!manual && (state.ui.sheet || !state.user.onboarded || state.ui.draft)) return;
  syncing = true;
  state.ui.syncing = true;
  if (manual) commit();
  syncManageBac(state).then((result) => {
    const current = getState();
    current.ui.syncing = false;
    const count = result.added;
    if (count || manual) {
      current.ui.toast = {
        text: count
          ? `Added ${count} ManageBac task${count === 1 ? "" : "s"}`
          : "ManageBac is up to date",
        changeId: null,
      };
      rememberToast(current.ui.toast);
    }
    commit();
  }).catch((error) => {
    const current = getState();
    current.ui.syncing = false;
    current.managebac.lastError = error.message || "Couldn’t reach ManageBac.";
    if (manual) {
      current.ui.toast = { text: current.managebac.lastError, changeId: null };
      rememberToast(current.ui.toast);
    }
    commit();
  }).finally(() => {
    syncing = false;
  });
}

function finishTask(state, task, actual) {
  const undo = snapshot();
  const { date, min } = nowParts();
  const sample = { subjectId: task.subjectId, type: task.type, difficulty: task.difficulty, title: "", description: "" };
  const before = estimateMinutes(state, sample);
  task.status = "completed";
  task.actual = actual;
  for (const session of state.sessions) {
    if (session.taskId !== task.id || session.status === "removed") continue;
    if (session.date > date || (session.date === date && toMin(session.start) >= min)) session.status = "removed";
  }
  state.history.push({
    id: uid(),
    subjectId: task.subjectId,
    type: task.type,
    difficulty: task.difficulty,
    estimated: task.estimated,
    actual,
    date,
    minute: min,
    onTime: !task.due || task.due >= date,
  });
  const after = estimateMinutes(state, sample);
  const tuned = retuneFuture(state, task.subjectId, task.difficulty, date, min);
  const name = subjectById(state, task.subjectId)?.name || "This subject";
  let text = `Done in ${actual} min.`;
  if (after !== before) text = `Done in ${actual} min. Next ${name} estimates are about ${after} min.`;
  else text = `Done in ${actual} min. That matches the ${name} estimate.`;
  if (tuned) text += ` ${tuned} later ${tuned === 1 ? "plan was" : "plans were"} updated.`;
  const change = pushChange(`Completed ${task.title}`, undo);
  state.ui.sheet = null;
  state.ui.draft = null;
  state.ui.toast = { text, changeId: change.id };
  rememberToast(state.ui.toast);
  commit();
}

function pushChange(label, undo) {
  const change = { id: uid(), at: new Date().toISOString(), label, undo, undone: false };
  getState().changes.unshift(change);
  getState().changes = getState().changes.slice(0, 20);
  return change;
}

function rememberToast(toast) {
  const token = `${toast.text}:${toast.changeId || ""}`;
  setTimeout(() => {
    const current = getState().ui.toast;
    if (current && `${current.text}:${current.changeId || ""}` === token) {
      getState().ui.toast = null;
      commit();
    }
  }, 8000);
}

function setRepeat(draft, value) {
  draft.repeat = value;
  if (value === "once" || value === "day" || value === "week") draft.interval = 1;
  else if (Number(draft.interval) < 2) draft.interval = 2;
}

function repeatChoice(existing) {
  const every = Number(existing?.repeatEvery) || 1;
  if (existing?.repeatUnit === "day") return { repeat: every > 1 ? "days" : "day", interval: every };
  if (existing?.repeatUnit === "week") return { repeat: every > 1 ? "weeks" : "week", interval: every };
  return { repeat: "week", interval: 1 };
}

function shiftMinutes(value, amount) {
  const [h, m] = (value || "19:00").split(":").map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + amount);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function finishAutoSessions() {
  const state = getState();
  const { date, min } = nowParts();
  const session = state.sessions.find((item) => {
    if (!item.autoDone || item.status !== "planned") return false;
    if (item.date > date) return false;
    if (item.date < date) return true;
    return toMin(item.end) <= min;
  });
  if (!session) return false;
  const task = taskById(state, session.taskId);
  session.autoDone = false;
  if (!task || task.status === "completed") {
    commit();
    return true;
  }
  finishTask(state, task, Math.max(1, toMin(session.end) - toMin(session.start)));
  return true;
}

function settlePlans() {
  const state = getState();
  const { date, min } = nowParts();
  const english = state.tasks.find((task) => task.id === "mb-49169320");
  let changed = false;
  if (english && english.due === "2026-11-02") {
    english.due = "2026-11-06";
    changed = true;
  }
  if (finishAutoSessions()) return;
  if (shiftStaleSessions(state, date, min)) changed = true;
  if (changed) commit();
}

function startOfMonthSafe(iso) {
  return `${iso.slice(0, 8)}01`;
}

window.addEventListener("storage", (event) => {
  if (event.key === "ordup.google.pending") takeGoogleAccount();
});
takeGoogleAccount();
setInterval(takeGoogleAccount, 800);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") runSync(false);
});
setTimeout(() => runSync(false), 1500);

window.addEventListener("hashchange", () => {
  const tab = location.hash.replace("#", "");
  const state = getState();
  if (["today", "schedule", "tasks", "chores", "calendar"].includes(tab) && tab !== state.ui.tab) {
    if (tab === "schedule") state.ui.scheduleDate = "";
    state.ui.tab = tab;
    state.ui.sheet = null;
    commit();
  }
});
