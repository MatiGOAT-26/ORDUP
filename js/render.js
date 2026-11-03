import {
  agenda,
  biasNote,
  classInstances,
  nextUp,
  notifications,
  plannedSessions,
  subjectById,
  subjectColor,
  subjectName,
  taskById,
  taskStatus,
  choreOccurs,
  choreRepeatLabel,
  guessChoreMinutes,
  nextChoreDate,
} from "./engine.js";
import { isConnected } from "./managebac.js";
import { appearanceOf, GOOGLE_FONTS, isDarkNow } from "./theme.js";
import {
  WEEKDAYS,
  WEEKDAYS_SHORT,
  MONTHS,
  addDays,
  dayMonth,
  dueText,
  esc,
  formatDuration,
  formatRange,
  formatTime,
  greeting,
  longDate,
  nowParts,
  relativeDay,
  whenDay,
  startOfMonth,
  startOfWeek,
  toMin,
  weekday,
} from "./time.js";

const TYPES = ["homework", "assignment", "project", "reading", "revision", "test", "exam", "other"];
const LEVELS = ["easy", "medium", "hard"];
const STATUS_LABEL = {
  unplanned: "Unplanned",
  planned: "Planned",
  inprogress: "In progress",
  completed: "Completed",
  overdue: "Overdue",
};

export function render(state) {
  const clock = nowParts();
  const today = clock.date;
  const nowMin = clock.min;
  if (!state.user.onboarded) {
    return `<div class="onboard-screen">${onboard(state, today)}</div>`;
  }
  const title = { today: "Today", schedule: "Schedule", tasks: "Tasks", chores: "Chores", calendar: "Calendar" }[state.ui.tab] || "Today";
  const notes = notifications(state, today, nowMin);
  return `
    <div class="shell ${state.ui.sheet ? "sheet-open" : ""}">
      <aside class="sidebar">
        <div class="brand">
          <img class="app-logo" src="logo.png" alt="" />
          <div>
            <strong>ORDUP</strong>
            <p>Your school day, in order.</p>
          </div>
        </div>
        <nav class="side-nav" aria-label="Primary">
          ${navLinks(state, "side-link")}
        </nav>
        <button class="side-user" data-action="open-profile" type="button">
          <span class="avatar">${esc(initial(state.user.name))}</span>
          <span>
            <strong>${esc(state.user.name || "Student")}</strong>
            <small>${esc([state.user.grade, state.user.school].filter(Boolean).join(" · "))}</small>
          </span>
        </button>
      </aside>
      <div class="stage">
        <header class="topbar">
          <div class="top-title">
            <img class="app-logo" src="logo.png" alt="ORDUP" />
            <div>
              <p class="eyebrow">ORDUP</p>
              <h1>${title}</h1>
            </div>
          </div>
          <div class="top-actions">
            <span class="clock-chip" data-live="clock">${formatTime(nowMin)}</span>
            <button class="icon-btn" type="button" data-action="open-notes" aria-label="Notifications">
              ${icon("bell")}
              ${notes.length ? `<span class="badge">${notes.length}</span>` : ""}
            </button>
            <button class="icon-btn" type="button" data-action="open-settings" aria-label="Settings">
              ${icon("settings")}
            </button>
            <button class="avatar" type="button" data-action="open-profile" aria-label="Profile">${esc(initial(state.user.name))}</button>
          </div>
        </header>
        <main id="view">
          ${view(state, today, nowMin)}
        </main>
      </div>
      <nav class="tabbar" aria-label="Primary">
        ${navLinks(state, "tab")}
      </nav>
      ${state.ui.sheet?.type === "ai" ? "" : `<button class="fab" type="button" data-action="open-ai">ORDUP AI</button>`}
      ${sheet(state, today, nowMin)}
      ${toast(state)}
    </div>
  `;
}

function view(state, today, nowMin) {
  if (state.ui.tab === "schedule") return schedule(state, today, nowMin);
  if (state.ui.tab === "tasks") return tasks(state, today, nowMin);
  if (state.ui.tab === "chores") return chores(state, today);
  if (state.ui.tab === "calendar") return calendar(state, today, nowMin);
  return todayView(state, today, nowMin);
}

function todayView(state, today, nowMin) {
  const next = nextUp(state, today, nowMin);
  const plan = upcomingSessions(state, today, nowMin);
  const items = agenda(state, today).filter((item) => item.kind === "class" || item.kind === "event");
  return `
    <section class="today">
      <p class="hello">${greeting(nowMin)}, ${esc(state.user.name || "there")} <span aria-hidden="true">👋</span></p>
      <p class="date-line">${longDate(today)}</p>
      <p class="lead">Know what’s next. Get it done.</p>
      ${nextCard(next, today)}
      <div class="section-head">
        <h2>Today's homework plan</h2>
      </div>
      ${plan.length ? `<div class="plan-list">${plan.map((item) => planCard(state, item, today, true)).join("")}</div>` : `<div class="empty">Nothing is booked yet.</div>`}
      <div class="section-head"><h2>Today's events</h2></div>
      ${items.length ? `<ol class="day-list">${items.map((item) => dayRow(item, nowMin)).join("")}</ol>` : `<div class="empty">No classes or events today.</div>`}
    </section>
  `;
}

function nextCard(next, today) {
  if (!next) {
    return `<article class="next-card"><p class="kicker">Next up</p><h2>Nothing scheduled</h2><p>Add a class to build your week.</p></article>`;
  }
  const place = next.item.room || next.item.location || "";
  const when = next.date === today ? "" : `${relativeDay(next.date, today)} · `;
  const live = next.mode === "now"
    ? `Happening now · ends in ${next.endsIn} minute${next.endsIn === 1 ? "" : "s"}`
    : next.mode === "later"
      ? `${relativeDay(next.date, today)}`
      : `Starts in ${next.delta} minute${next.delta === 1 ? "" : "s"}`;
  return `
    <article class="next-card" style="--c:${esc(next.item.color)}">
      <p class="kicker">${next.mode === "now" ? "Happening now" : "Next up"}</p>
      <h2>${esc(next.item.title)}</h2>
      <p class="when">${when}${formatRange(next.item.start, next.item.end)}${place ? ` · ${esc(place)}` : ""}</p>
      <p class="countdown" data-live="countdown">${live}</p>
    </article>
  `;
}

function planCard(state, session, today, asTask) {
  const task = taskById(state, session.taskId);
  const subject = task ? subjectById(state, task.subjectId) : null;
  const open = asTask && task
    ? `data-action="open-task" data-id="${esc(task.id)}"`
    : `data-action="open-item" data-kind="session" data-id="${esc(session.id)}" data-date="${esc(session.date)}"`;
  return `
    <button class="plan-card" type="button" ${open} style="--c:${esc(subject?.color || "#6D4AFF")}">
      <span class="swatch">${esc((subject?.short || "Study").slice(0, 2))}</span>
      <span>
        <strong>${esc(task?.title || "Study")}</strong>
        <em>${relativeDay(session.date, today)} · ${formatRange(session.start, session.end)}</em>
        <small>Estimated: ${task?.estimated || toMin(session.end) - toMin(session.start)} min${session.label && session.label !== "ManageBac" ? ` · ${esc(session.label)}` : ""} · ${esc(dueText(task?.due))}</small>
      </span>
    </button>
  `;
}

function dayRow(item, nowMin) {
  const past = item.endMin <= nowMin;
  const live = item.startMin <= nowMin && item.endMin > nowMin;
  return `
    <li class="${past ? "past" : ""} ${live ? "live" : ""}">
      <time>${formatTime(item.startMin).replace(":00", "").replace(" ", " ")}</time>
      <button type="button" data-action="open-item" data-kind="${esc(item.kind)}" data-id="${esc(item.id)}" data-date="${esc(item.date)}" style="--c:${esc(item.color)}">
        <strong>${esc(item.title)}</strong>
        <span>${formatRange(item.start, item.end)}${item.subtitle ? ` · ${esc(item.subtitle)}` : ""}</span>
      </button>
    </li>
  `;
}

function schedule(state, today, nowMin) {
  const selected = state.ui.scheduleDate || today;
  const items = agenda(state, selected).filter((item) => {
    if (item.kind === "class" || item.kind === "event" || item.kind === "chore") return true;
    return item.kind === "session" && item.status === "planned";
  });
  const empty = selected === today ? "Nothing scheduled today." : "Nothing scheduled on this day.";
  return `
    <section>
      <div class="section-head">
        <h2>${longDate(selected)}</h2>
      </div>
      <div class="choice-row">
        <button class="btn soft" type="button" data-action="open-schedule-calendar">Pick a day</button>
        <button class="btn ghost" type="button" data-action="edit-class">Add class/events</button>
      </div>
      ${items.length ? `<div class="plan-list">${items.map((item) => item.kind === "session" ? planCard(state, item, today) : scheduleCard(item, today)).join("")}</div>` : `<div class="empty">${empty}</div>`}
    </section>
  `;
}

function scheduleCard(item, today) {
  const mark = (item.title || "Event").trim().slice(0, 2);
  return `
    <button class="plan-card" type="button" data-action="open-item" data-kind="${esc(item.kind)}" data-id="${esc(item.id)}" data-date="${esc(item.date)}" style="--c:${esc(item.color || "#6D4AFF")}">
      <span class="swatch">${esc(mark)}</span>
      <span>
        <strong>${esc(item.title)}</strong>
        <em>${relativeDay(item.date, today)} · ${formatRange(item.start, item.end)}</em>
        ${item.subtitle ? `<small>${esc(item.subtitle)}</small>` : ""}
      </span>
    </button>
  `;
}

function scheduleCalendar(state, today) {
  const selected = state.ui.scheduleDate || today;
  const month = state.ui.draft?.month || startOfMonth(selected);
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  const count = new Date(year, monthIndex, 0).getDate();
  const lead = (weekday(month) + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(`<span class="month-pad" aria-hidden="true"></span>`);
  for (let day = 1; day <= count; day += 1) {
    const date = `${month.slice(0, 8)}${String(day).padStart(2, "0")}`;
    cells.push(`<button class="month-cell ${date === today ? "is-today" : ""} ${date === selected ? "on" : ""}" type="button" data-action="pick-schedule-day" data-date="${date}"><span>${day}</span></button>`);
  }
  return `
    <div class="sheet-head">
      <div><p class="kicker">Schedule</p><h2>Pick a day</h2></div>
      <button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button>
    </div>
    <div class="sheet-body mini-cal">
      <div class="pager">
        <button class="icon-btn" type="button" data-action="shift-schedule-month" data-delta="-1" aria-label="Previous month">‹</button>
        <strong>${MONTHS[monthIndex - 1]} ${year}</strong>
        <button class="icon-btn" type="button" data-action="shift-schedule-month" data-delta="1" aria-label="Next month">›</button>
      </div>
      <div class="month-head">${WEEKDAYS_SHORT.slice(1).concat(WEEKDAYS_SHORT[0]).map((day) => `<span>${day}</span>`).join("")}</div>
      <div class="month-grid">${cells.join("")}</div>
    </div>
  `;
}

function tasks(state, today, nowMin) {
  const filter = state.ui.taskFilter || "open";
  const items = state.tasks.filter((task) => {
    const status = taskStatus(state, task, today, nowMin);
    if (filter === "open") return status !== "completed" && status !== "overdue";
    if (filter === "done") return status === "completed";
    if (filter === "overdue") return status === "overdue";
    return true;
  }).sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  return `
    <section>
      <div class="section-head">
        <h2>Homework and exams</h2>
        <div class="choice-row">
          ${isConnected(state) ? `<button class="btn ghost" type="button" data-action="sync-managebac" ${state.ui.syncing ? "disabled" : ""}>${state.ui.syncing ? "Syncing…" : "Sync ManageBac"}</button>` : hasGoogleAccount(state) ? "" : googleButton(Boolean(state.ui.syncing || state.ui.draft?.busy))}
          <button class="btn primary" type="button" data-action="add-task">Add homework</button>
        </div>
      </div>
      ${state.managebac?.lastError ? `<p class="error">${esc(state.managebac.lastError)}</p>` : ""}
      <div class="chip-row">
        ${["open", "overdue", "done", "all"].map((key) => `<button class="chip ${filter === key ? "on" : ""}" type="button" data-action="filter-tasks" data-filter="${key}">${cap(key === "open" ? "To do" : key)}</button>`).join("")}
      </div>
      ${items.length ? `<div class="stack">${items.map((task) => taskCard(state, task, today, nowMin)).join("")}</div>` : `<div class="empty">${!state.tasks.length && isConnected(state) ? "No tasks yet. New ManageBac tasks will show up here with a recommended time." : "Nothing in this list."}</div>`}
    </section>
  `;
}

function taskCard(state, task, today, nowMin) {
  const status = taskStatus(state, task, today, nowMin);
  const subject = subjectById(state, task.subjectId);
  const due = dueText(task.due);
  const next = state.sessions
    .filter((session) => session.taskId === task.id && session.status === "planned")
    .filter((session) => session.date > today || (session.date === today && toMin(session.end) > nowMin))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))[0];
  const when = next ? `Recommended ${whenDay(next.date, today)} · ${formatRange(next.start, next.end)} · ` : "";
  return `
    <button class="task-card" type="button" data-action="open-task" data-id="${esc(task.id)}" style="--c:${esc(subject?.color || "#6D4AFF")}">
      <span class="status ${status}">${STATUS_LABEL[status]}</span>
      <strong>${esc(task.title)}</strong>
      <span>${esc(subject?.name || "")} · ${esc(cap(task.type))} · ${due}</span>
      <small>${when}${task.estimated} min · ${esc(cap(task.difficulty))}</small>
    </button>
  `;
}

function chores(state, today) {
  const items = state.chores || [];
  const open = items.filter((item) => !item.done);
  const done = items.filter((item) => item.done);
  return `
    <section>
      <div class="section-head">
        <h2>Around the house</h2>
        <button class="btn primary" type="button" data-action="add-chore">Add chore</button>
      </div>
      ${items.length ? "" : `<div class="empty">No chores yet. Add one, like take out the trash.</div>`}
      ${open.length ? `<div class="stack">${open.map((item) => choreRow(item, today)).join("")}</div>` : ""}
      ${done.length ? `<div class="section-head"><h2>Done</h2></div><div class="stack">${done.map((item) => choreRow(item, today)).join("")}</div>` : ""}
    </section>
  `;
}

function choreRow(item, today) {
  const shown = nextChoreDate(item, today) || item.date;
  const when = item.start && shown ? `${relativeDay(shown, today)} · ${formatRange(item.start, item.end)}` : "Waiting for a free time";
  const estimate = item.estimated ? `Estimated: ${item.estimated} min` : "";
  const repeat = choreRepeatLabel(item);
  const detail = [repeat, when, estimate].filter(Boolean).join(" · ");
  return `
    <div class="chore-row">
      <button class="row-card chore-card ${item.done ? "done" : ""}" type="button" data-action="toggle-chore" data-id="${esc(item.id)}" data-date="${esc(shown || "")}">
        <span class="check ${item.done ? "on" : ""}" aria-hidden="true">${item.done ? "✓" : ""}</span>
        <span class="chore-copy">
          <strong>${esc(item.title)}</strong>
          ${item.done ? "" : `<span>${esc(detail)}</span>`}
        </span>
      </button>
      <button class="icon-btn" type="button" data-action="delete-chore" data-id="${esc(item.id)}" aria-label="Delete ${esc(item.title)}">×</button>
    </div>
  `;
}

function choreSheet(state) {
  const draft = state.ui.draft || { title: "" };
  return `
    <header class="sheet-head">
      <div><p class="kicker">Chores</p><h2>Add a chore</h2></div>
      <button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button>
    </header>
    <div class="sheet-body">
      <label class="field">Chore<input data-field="title" maxlength="80" value="${esc(draft.title || "")}" placeholder="Take out the trash" /></label>
      <p class="field-label">Repeat</p>
      <div class="chip-row">
        ${[
          ["once", "Once"],
          ["day", "Every day"],
          ["week", "Every week"],
          ["days", "Every … days"],
          ["weeks", "Every … weeks"],
        ].map(([value, label]) => `<button class="chip ${draft.repeat === value ? "on" : ""}" type="button" data-action="set-field" data-field="repeat" data-value="${value}">${label}</button>`).join("")}
      </div>
      ${draft.repeat === "days" || draft.repeat === "weeks" ? `<div class="repeat-count"><span>Every</span><input data-field="interval" type="number" min="1" max="99" value="${esc(draft.interval || 2)}" /><span>${draft.repeat === "days" ? "days" : "weeks"}</span></div>` : ""}
      <p class="muted">${choreRepeatSummary(draft)}</p>
      ${draft.error ? `<p class="error" role="alert">${esc(draft.error)}</p>` : ""}
      <button class="btn primary full" type="button" data-action="save-chore">Save chore</button>
    </div>
  `;
}

function calendar(state, today, nowMin) {
  const mode = state.ui.calendarMode || "week";
  const anchor = state.ui.calendarDate || today;
  return `
    <section>
      <div class="section-head">
        <h2>${mode === "month" ? `${MONTHS[Number(anchor.slice(5, 7)) - 1]}` : `Week of ${dayMonth(startOfWeek(anchor))}`}</h2>
        <div class="seg" role="tablist">
          ${["day", "week", "month"].map((key) => `<button class="${mode === key ? "on" : ""}" type="button" data-action="cal-mode" data-mode="${key}">${cap(key)}</button>`).join("")}
        </div>
      </div>
      <div class="pager">
        <button class="icon-btn" type="button" data-action="cal-shift" data-delta="-1" aria-label="Previous">‹</button>
        <button class="btn ghost" type="button" data-action="cal-today">Today</button>
        <button class="icon-btn" type="button" data-action="cal-shift" data-delta="1" aria-label="Next">›</button>
      </div>
      <div class="legend">
        <span><i style="background:#6D4AFF"></i>Classes</span>
        <span><i style="background:#1F9D8A"></i>Study</span>
        <span><i style="background:#D4537E"></i>Activities</span>
      </div>
      ${mode === "day" ? dayTimeline(state, anchor, today, nowMin) : mode === "month" ? monthGrid(state, anchor, today) : weekBoard(state, anchor, today)}
    </section>
  `;
}

function weekBoard(state, anchor, today) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  return `<div class="week-board">${days.map((date) => {
    const items = agenda(state, date).filter((item) => item.kind !== "routine");
    return `<section class="week-col ${date === today ? "is-today" : ""}">
      <button type="button" data-action="open-day" data-date="${date}"><strong>${WEEKDAYS_SHORT[weekday(date)]}</strong> ${Number(date.slice(8))}</button>
      ${items.map((item) => `<button class="mini" type="button" data-action="open-item" data-kind="${item.kind}" data-id="${esc(item.id)}" data-date="${date}" style="--c:${esc(item.color)}"><b>${formatTime(item.startMin)}</b> ${esc(item.title)}</button>`).join("") || `<p class="muted tiny">Clear</p>`}
    </section>`;
  }).join("")}</div>`;
}

function dayTimeline(state, date, today, nowMin) {
  const start = 7 * 60;
  const end = 22 * 60;
  const hour = 52;
  const height = ((end - start) / 60) * hour;
  const items = agenda(state, date).filter((item) => item.endMin > start && item.startMin < end);
  const hours = Array.from({ length: 16 }, (_, index) => start + index * 60);
  const nowTop = date === today ? ((nowMin - start) / 60) * hour : null;
  return `
    <div class="timeline" style="height:${height}px">
      ${hours.map((min) => `<div class="t-hour" style="top:${((min - start) / 60) * hour}px"><span>${formatTime(min)}</span></div>`).join("")}
      ${nowTop != null && nowTop >= 0 && nowTop <= height ? `<div class="t-now" style="top:${nowTop}px"></div>` : ""}
      ${items.map((item) => {
        const top = ((Math.max(item.startMin, start) - start) / 60) * hour;
        const block = (Math.max(20, item.endMin - item.startMin) / 60) * hour;
        return `<button class="t-block" type="button" data-action="open-item" data-kind="${item.kind}" data-id="${esc(item.id)}" data-date="${date}" style="top:${top}px;height:${Math.max(block - 4, 28)}px;--c:${esc(item.color)}"><strong>${esc(item.title)}</strong><span>${formatRange(item.start, item.end)}</span></button>`;
      }).join("")}
    </div>
  `;
}

function monthGrid(state, anchor, today) {
  const first = startOfMonth(anchor);
  const year = Number(first.slice(0, 4));
  const month = Number(first.slice(5, 7));
  const count = new Date(year, month, 0).getDate();
  const lead = (weekday(first) + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(`<span class="month-pad" aria-hidden="true"></span>`);
  for (let day = 1; day <= count; day += 1) {
    const date = `${first.slice(0, 8)}${String(day).padStart(2, "0")}`;
    const dots = agenda(state, date).filter((item) => item.kind !== "routine").slice(0, 3);
    cells.push(`<button class="month-cell ${date === today ? "is-today" : ""} ${date === (state.ui.calendarDate || today) ? "on" : ""}" type="button" data-action="open-day" data-date="${date}"><span>${day}</span>${dots.map((item) => `<i style="background:${esc(item.color)}"></i>`).join("")}</button>`);
  }
  const selected = state.ui.calendarDate || today;
  const selectedItems = agenda(state, selected).filter((item) => item.kind !== "routine");
  return `
    <div class="month-head">${WEEKDAYS_SHORT.slice(1).concat(WEEKDAYS_SHORT[0]).map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="month-grid">${cells.join("")}</div>
    <h3 class="month-label">${longDate(selected)}</h3>
    <div class="stack">${selectedItems.map((item) => `<button class="row-card" type="button" data-action="open-item" data-kind="${item.kind}" data-id="${esc(item.id)}" data-date="${selected}" style="--c:${esc(item.color)}"><strong>${esc(item.title)}</strong><span>${formatRange(item.start, item.end)}</span></button>`).join("") || `<div class="empty">Nothing on this day.</div>`}</div>
  `;
}

function sheet(state, today, nowMin) {
  const current = state.ui.sheet;
  if (!current) return "";
  const body = {
    ai: () => aiSheet(state),
    profile: () => profileSheet(state, today),
    settings: () => settingsSheet(state, nowMin),
    notes: () => notesSheet(state, today, nowMin),
    add: () => addSheet(state, today),
    task: () => taskSheet(state, today, nowMin),
    detail: () => detailSheet(state, today, nowMin),
    "test-confirm": () => testConfirm(state),
    "test-time": () => testTime(state),
    class: () => classSheet(state),
    chore: () => choreSheet(state),
    "schedule-calendar": () => scheduleCalendar(state, today),
    actual: () => actualSheet(state),
    move: () => moveSheet(state, today),
    onboard: () => onboard(state, today),
  }[current.type];
  if (!body) return "";
  const centered = current.type === "test-confirm" || current.type === "test-time";
  const wide = current.type === "ai" ? "ai" : "";
  return `
    <div class="scrim ${centered ? "center" : ""}" data-action="close-sheet">
      <section class="sheet ${wide} ${centered ? "center" : ""}" data-action="noop" role="dialog" aria-modal="true" aria-label="${centered ? "Mark as test" : "Panel"}">
        ${body()}
      </section>
    </div>
  `;
}

function aiSheet(state) {
  const messages = state.messages || [];
  return `
    <header class="sheet-head">
      <div><p class="kicker">ORDUP AI</p><h2>Your schedule assistant</h2></div>
      <button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button>
    </header>
    <div class="chat-log" aria-live="polite">
      ${messages.length ? "" : `<div class="bubble assistant"><p>Hi ${esc(state.user.name || "there")}. Ask me anything. I can also add, move, change, or remove things on your calendar.</p></div>`}
      ${messages.map((message) => messageHtml(state, message)).join("")}
    </div>
    <form class="composer" data-action="ai-send">
      <label class="sr" for="ai-input">Message</label>
      <input id="ai-input" data-field="aiInput" value="${esc(state.ui.aiInput || "")}" placeholder="Ask anything, or tell me what to change" autocomplete="off" />
      <button class="btn primary" type="submit">Send</button>
    </form>
  `;
}

function messageHtml(state, message) {
  const change = message.changeId ? state.changes.find((item) => item.id === message.changeId) : null;
  return `
    <div class="bubble ${message.role}">
      ${message.text.split("\n").map((line) => `<p>${esc(line)}</p>`).join("")}
      ${message.proposal && !message.applied && !message.dismissed ? proposalCard(message) : ""}
      ${message.choices && !message.resolved ? `<div class="choice-row">${message.choices.map((choice) => `<button type="button" data-action="ai-choice" data-id="${esc(message.id)}" data-choice="${esc(choice.id)}">${esc(choice.label)}</button>`).join("")}</div>` : ""}
      ${message.applied ? `<div class="done-line">${change?.undone ? "Undone" : "✓ Schedule updated"} ${change && !change.undone ? `<button type="button" data-action="undo" data-id="${esc(change.id)}">Undo</button>` : ""}</div>` : ""}
    </div>
  `;
}

function proposalCard(message) {
  const proposal = message.proposal;
  return `
    <div class="proposal">
      <p class="kicker">${esc(proposal.headline || "Proposed changes")}</p>
      ${proposal.groups.map((group) => `<p><strong>${esc(group.label)}</strong><span>${esc(group.from)} → ${esc(group.to)}</span></p>`).join("")}
      ${proposal.unchanged?.length ? `<p class="muted">Unchanged: ${esc(proposal.unchanged.join(", "))}</p>` : ""}
      <div class="choice-row">
        <button class="btn ghost" type="button" data-action="dismiss-proposal" data-id="${esc(message.id)}">${esc(proposal.secondary || "Cancel")}</button>
        <button class="btn primary" type="button" data-action="apply-proposal" data-id="${esc(message.id)}">${esc(proposal.primary || "Apply changes")}</button>
      </div>
    </div>
  `;
}

function addSheet(state, today) {
  const draft = state.ui.draft;
  if (!draft) return "";
  if (draft.step === 2) return estimateStep(state, draft);
  if (draft.step === 3) return planStep(state, draft, today);
  const thursday = upcomingThursday(today);
  const friday = addDays(thursday, 1);
  return `
    <header class="sheet-head">
      <div><p class="kicker">Add homework</p><h2>What do you need to do?</h2></div>
      <button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button>
    </header>
    <div class="sheet-body">
      <p class="field-label">Type</p>
      <div class="chip-row">${TYPES.map((type) => `<button class="chip ${draft.type === type ? "on" : ""}" type="button" data-action="set-field" data-field="type" data-value="${type}">${cap(type)}</button>`).join("")}</div>
      <p class="field-label">Subject</p>
      <div class="chip-row">${state.subjects.map((subject) => `<button class="chip ${draft.subjectId === subject.id ? "on" : ""}" type="button" data-action="set-field" data-field="subjectId" data-value="${subject.id}" style="--c:${esc(subject.color)}">${esc(subject.name)}</button>`).join("")}</div>
      <label class="field">Homework<input data-field="title" maxlength="80" value="${esc(draft.title)}" placeholder="Fractions worksheet, questions 1–20" /></label>
      <p class="field-label">Due</p>
      <div class="chip-row">
        <button class="chip ${draft.due === thursday ? "on" : ""}" type="button" data-action="set-field" data-field="due" data-value="${thursday}">Thursday</button>
        <button class="chip ${draft.due === friday ? "on" : ""}" type="button" data-action="set-field" data-field="due" data-value="${friday}">Friday</button>
      </div>
      <label class="field">Date<input data-field="due" type="date" value="${esc(draft.due)}" /></label>
      <p class="field-label">Difficulty</p>
      <div class="chip-row">${LEVELS.map((level) => `<button class="chip ${draft.difficulty === level ? "on" : ""}" type="button" data-action="set-field" data-field="difficulty" data-value="${level}">${cap(level)}</button>`).join("")}</div>
      ${draft.more ? `
        <label class="field">Details<textarea data-field="description" rows="3" placeholder="Teacher instructions">${esc(draft.description)}</textarea></label>
        <label class="field">Link<input data-field="link" value="${esc(draft.link)}" placeholder="https://" /></label>
        <label class="field">Notes<textarea data-field="notes" rows="2">${esc(draft.notes)}</textarea></label>
        <label class="field">Attachment<input data-field="attachment" type="file" accept="image/*,.pdf" />${draft.attachmentName ? `<small>${esc(draft.attachmentName)}</small>` : ""}</label>
      ` : `<button class="btn ghost" type="button" data-action="set-field" data-field="more" data-value="1">Add details, a link, or a file</button>`}
      ${draft.error ? `<p class="error" role="alert">${esc(draft.error)}</p>` : ""}
      <button class="btn primary full" type="button" data-action="add-next">Estimate and plan</button>
    </div>
  `;
}

function estimateStep(state, draft) {
  const note = biasNote(state, draft.subjectId);
  return `
    <header class="sheet-head">
      <div><p class="kicker">Estimate</p><h2>${esc(draft.title)}</h2></div>
      <button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button>
    </header>
    <div class="sheet-body">
      <p class="muted">${esc(subjectName(state, draft.subjectId))} · due ${esc(draft.due)} · ${esc(draft.difficulty)}</p>
      <div class="estimate-row">
        <button class="icon-btn" type="button" data-action="nudge-estimate" data-delta="-5" aria-label="Shorter">−</button>
        <div><strong>${draft.estimated}</strong><span>minutes</span></div>
        <button class="icon-btn" type="button" data-action="nudge-estimate" data-delta="5" aria-label="Longer">+</button>
      </div>
      <p>This is a starting point from the subject, the difficulty, and what you wrote. Change it if you know better.</p>
      ${note ? `<p class="note">${esc(note)}</p>` : `<p class="note">Press done during the planned time and ORDUP will learn how long it really takes.</p>`}
      <div class="choice-row">
        <button class="btn ghost" type="button" data-action="add-back">Back</button>
        <button class="btn primary" type="button" data-action="add-next">See times</button>
      </div>
    </div>
  `;
}

function planStep(state, draft, today) {
  if (!draft.slots?.length) {
    return `
      <header class="sheet-head"><div><p class="kicker">Plan</p><h2>Not enough available time</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
      <div class="sheet-body">
        <div class="notice"><strong>No free block fits</strong><p>${esc(draft.title)} needs about ${draft.estimated} minutes, and there isn’t a usable gap before ${esc(draft.due)} once school, activities, dinner, and sleep are protected.</p></div>
        <div class="choice-row">
          <button class="btn ghost" type="button" data-action="find-time">Find additional time</button>
          <button class="btn ghost" type="button" data-action="add-back">Adjust estimate</button>
          <button class="btn primary" type="button" data-action="save-unplanned">Save without a time</button>
        </div>
      </div>
    `;
  }
  return `
    <header class="sheet-head"><div><p class="kicker">When should you do it?</p><h2>${esc(draft.title)}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">
      <p class="muted">Estimated: ${draft.estimated} min. The block includes a few spare minutes.</p>
      <div class="stack">
        ${draft.slots.map((slot, index) => `
          <button class="slot ${index === 0 ? "best" : ""} ${draft.chosen === index ? "on" : ""}" type="button" data-action="choose-slot" data-index="${index}">
            <p class="kicker">${index === 0 ? "Best time" : "Alternative"}</p>
            <strong>${WEEKDAYS[weekday(slot.date)]}</strong>
            <em>${formatRange(slot.start, slot.end)}</em>
            <p>${relativeDay(slot.date, today)}</p>
            <p>${esc(slot.reason)}</p>
          </button>`).join("")}
      </div>
      <div class="choice-row">
        <button class="btn ghost" type="button" data-action="add-back">Back</button>
        <button class="btn primary" type="button" data-action="confirm-plan">Add to my plan</button>
      </div>
    </div>
  `;
}

function taskSheet(state, today, nowMin) {
  const task = taskById(state, state.ui.sheet.id);
  if (!task) return "";
  const status = taskStatus(state, task, today, nowMin);
  const sessions = plannedSessions(state, task.id);
  return `
    <header class="sheet-head"><div><p class="kicker">${esc(subjectName(state, task.subjectId))}</p><h2>${esc(task.title)}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">
      <p><span class="status ${status}">${STATUS_LABEL[status]}</span></p>
      <p>${esc(cap(task.type))} · ${esc(cap(task.difficulty))} · ${task.estimated} min${task.actual ? ` · took ${task.actual} min` : ""}</p>
      <p>Due ${task.due ? longDate(task.due) : "sometime"}</p>
      ${task.description ? `<p>${esc(task.description)}</p>` : ""}
      ${task.notes && !/^From ManageBac\b/.test(task.notes) ? `<p class="note">${esc(task.notes)}</p>` : ""}
      ${task.link ? `<p><a href="${esc(task.link)}" target="_blank" rel="noreferrer">${esc(task.link)}</a></p>` : ""}
      ${sessions.length ? `<h3>Study sessions</h3><div class="stack">${sessions.map((session) => `<button class="row-card" type="button" data-action="open-item" data-kind="session" data-id="${session.id}" data-date="${session.date}" style="--c:${subjectColor(state, task.subjectId)}"><strong>${session.label && session.label !== "ManageBac" ? esc(session.label) : esc(dueText(task.due))}</strong><span>${relativeDay(session.date, today)} · ${formatRange(session.start, session.end)}${session.autoDone ? " · Marks this homework done" : ""}</span></button>`).join("")}</div>` : `<p class="muted">No time booked yet.</p>`}
      <div class="choice-row">
        ${status !== "completed" ? `<button class="btn primary" type="button" data-action="ask-actual" data-id="${task.id}">Done</button>` : ""}
        ${biasNote(state, task.subjectId) ? `<p class="note">${esc(biasNote(state, task.subjectId))}</p>` : ""}
        ${status !== "completed" && !sessions.length ? `<button class="btn ghost" type="button" data-action="schedule-task" data-id="${task.id}">Find a time</button>` : ""}
        <button class="btn ghost danger" type="button" data-action="delete-task" data-id="${task.id}">Delete</button>
        ${status !== "completed" ? `<button class="btn ghost" type="button" data-action="mark-test" data-id="${task.id}">Mark as test</button>` : ""}
        ${status !== "completed" ? `<button class="btn ghost" type="button" data-action="add-session" data-id="${task.id}">Add another session</button>` : ""}
      </div>
    </div>
  `;
}

function testConfirm(state) {
  const task = taskById(state, state.ui.sheet.id);
  if (!task) return "";
  return `
    <div class="sheet-body confirm-copy">
      <h2>Mark as test</h2>
      <p>This will become an assessment date. If you press Yes, this is no longer homework and you cannot change it back.</p>
      <div class="choice-row">
        <button class="btn ghost" type="button" data-action="cancel-test" data-id="${esc(task.id)}">No</button>
        <button class="btn primary" type="button" data-action="confirm-test" data-id="${esc(task.id)}">Yes</button>
      </div>
    </div>
  `;
}

function testTime(state) {
  const event = state.events.find((item) => item.id === state.ui.sheet.id);
  const draft = state.ui.draft || {};
  if (!event) return "";
  return `
    <div class="sheet-body confirm-copy">
      <h2>What time is the test?</h2>
      <p>${esc(event.title)} is on ${esc(longDate(event.date))}.</p>
      <div class="split">
        <label class="field">Starts<input data-field="start" type="time" value="${esc(draft.start || event.start || "09:00")}" /></label>
        <label class="field">Ends<input data-field="end" type="time" value="${esc(draft.end || event.end || "10:00")}" /></label>
      </div>
      ${draft.error ? `<p class="error">${esc(draft.error)}</p>` : ""}
      <button class="btn primary full" type="button" data-action="save-test-time">Save test time</button>
    </div>
  `;
}

function detailSheet(state, today) {
  const { kind, id, date } = state.ui.sheet;
  if (kind === "session") {
    const session = state.sessions.find((item) => item.id === id);
    const task = session ? taskById(state, session.taskId) : null;
    if (!session || !task) return "";
    return `
      <header class="sheet-head"><div><p class="kicker">Study</p><h2>${esc(task.title)}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
      <div class="sheet-body">
        <p>${relativeDay(session.date, today)} · ${formatRange(session.start, session.end)}</p>
        <p>${esc(subjectName(state, task.subjectId))} · estimated ${task.estimated} min</p>
        <div class="choice-row">
          ${task.status !== "completed" ? `<button class="btn primary" type="button" data-action="ask-actual" data-id="${task.id}">Done</button>` : ""}
          <button class="btn ghost danger" type="button" data-action="delete-task" data-id="${task.id}">Delete</button>
          ${task.status !== "completed" ? `<button class="btn ghost" type="button" data-action="mark-test" data-id="${task.id}">Mark as test</button>` : ""}
          ${task.status !== "completed" ? `<button class="btn ghost" type="button" data-action="add-session" data-id="${task.id}">Add another session</button>` : ""}
          <button class="btn primary" type="button" data-action="open-task" data-id="${task.id}">Open homework</button>
          <button class="btn ghost" type="button" data-action="start-move" data-id="${session.id}">Move</button>
          <button class="btn ghost danger" type="button" data-action="remove-session" data-id="${session.id}">Remove</button>
        </div>
      </div>
    `;
  }
  if (kind === "class") {
    const item = classInstances(state, date).find((entry) => entry.id === id);
    if (!item) return "";
    return `
      <header class="sheet-head"><div><p class="kicker">Class</p><h2>${esc(item.title)}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
      <div class="sheet-body">
        <p>${longDate(date)}</p>
        <p>${formatRange(item.start, item.end)}</p>
        <p>${esc(item.room || "No room")} · ${esc(item.teacher || "No teacher")}</p>
        ${item.notes ? `<p>${esc(item.notes)}</p>` : ""}
        <div class="choice-row">
          ${item.override ? "" : `<button class="btn ghost" type="button" data-action="edit-class" data-id="${esc(item.id)}" data-date="${esc(date)}">Edit</button>`}
          ${item.override ? "" : `<button class="btn ghost" type="button" data-action="skip-class" data-id="${esc(item.id)}" data-date="${esc(date)}">Skip this date</button>`}
          <button class="btn ghost danger" type="button" data-action="delete-class" data-id="${esc(item.id)}" data-override="${item.override ? "1" : "0"}">Remove</button>
        </div>
      </div>
    `;
  }
  if (kind === "chore") {
    const chore = (state.chores || []).find((item) => item.id === id);
    if (!chore) return "";
    const shown = date && choreOccurs(chore, date) ? date : (nextChoreDate(chore, today) || chore.date);
    const when = chore.start && shown ? `${relativeDay(shown, today)} · ${formatRange(chore.start, chore.end)}` : "No free time yet";
    const repeat = choreRepeatLabel(chore);
    return `
      <header class="sheet-head"><div><p class="kicker">Chore</p><h2>${esc(chore.title)}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
      <div class="sheet-body">
        <p>${esc(when)}</p>
        ${repeat ? `<p>${esc(repeat)}</p>` : ""}
        <p>Estimated: ${chore.estimated || guessChoreMinutes(chore.title)} min</p>
        <div class="choice-row">
          <button class="btn primary" type="button" data-action="toggle-chore" data-id="${esc(chore.id)}" data-date="${esc(shown || "")}">Done</button>
          <button class="btn ghost danger" type="button" data-action="delete-chore" data-id="${esc(chore.id)}">Delete</button>
        </div>
      </div>
    `;
  }
  if (kind === "routine") {
    return `<header class="sheet-head"><div><p class="kicker">Routine</p><h2>Dinner</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header><div class="sheet-body"><p>${formatRange(state.user.routine.dinner, state.user.routine.dinnerEnd)} is kept free. Homework won’t be placed on top of it.</p><button class="btn ghost" type="button" data-action="open-profile">Edit routine</button></div>`;
  }
  const event = state.events.find((item) => item.id === id);
  if (!event) return "";
  const kicker = event.assessment ? "Test" : event.source === "google" ? "Google Calendar" : "Activity";
  return `
    <header class="sheet-head"><div><p class="kicker">${kicker}</p><h2>${esc(event.title)}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">
      <p>${longDate(event.date)} · ${formatRange(event.start, event.end)}</p>
      ${event.location ? `<p>${esc(event.location)}</p>` : ""}
      <p class="muted">${event.assessment ? "This is an assessment on the due date." : event.source === "google" ? "ORDUP treats this as busy time." : "This stays in your weekly life outside class."}</p>
    </div>
  `;
}

function classSheet(state) {
  const draft = state.ui.draft;
  if (!draft) return "";
  return `
    <header class="sheet-head"><div><p class="kicker">Timetable</p><h2>${draft.id ? "Edit class" : "Add class"}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">
      <label class="field">Class<input data-field="className" value="${esc(draft.className || "")}" placeholder="Type the class" /></label>
      <label class="field">Date<input data-field="startDate" type="date" value="${esc(draft.startDate || "")}" /></label>
      <p class="field-label">Repeat</p>
      <div class="chip-row">
        ${[
          ["day", "Every day"],
          ["week", "Every week"],
          ["days", "Every … days"],
          ["weeks", "Every … weeks"],
        ].map(([value, label]) => `<button class="chip ${draft.repeat === value ? "on" : ""}" type="button" data-action="set-field" data-field="repeat" data-value="${value}">${label}</button>`).join("")}
      </div>
      ${draft.repeat === "days" || draft.repeat === "weeks" ? `<div class="repeat-count"><span>Every</span><input data-field="interval" type="number" min="1" max="99" value="${esc(draft.interval || 2)}" /><span>${draft.repeat === "days" ? "days" : "weeks"}</span></div>` : ""}
      <div class="split">
        <label class="field">Start<input data-field="start" type="time" value="${esc(draft.start)}" /></label>
        <label class="field">End<input data-field="end" type="time" value="${esc(draft.end)}" /></label>
      </div>
      <label class="field">Room<input data-field="room" value="${esc(draft.room)}" placeholder="Room" /></label>
      <label class="field">Teacher<input data-field="teacher" value="${esc(draft.teacher)}" /></label>
      <label class="field">Notes<textarea data-field="notes" rows="2">${esc(draft.notes || "")}</textarea></label>
      <p class="muted">${repeatSummary(draft)}</p>
      ${draft.error ? `<p class="error" role="alert">${esc(draft.error)}</p>` : ""}
      <button class="btn primary full" type="button" data-action="save-class">Save class</button>
    </div>
  `;
}

function actualSheet(state) {
  const task = taskById(state, state.ui.sheet.taskId);
  const draft = state.ui.draft;
  if (!task || !draft) return "";
  return `
    <header class="sheet-head"><div><p class="kicker">Finished</p><h2>How long did this actually take?</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">
      <p>${esc(task.title)}</p>
      <p class="muted">Estimated: ${task.estimated} minutes</p>
      <label class="field">Actual minutes<input data-field="actual" type="number" min="1" max="600" value="${esc(draft.actual)}" /></label>
      <p class="note">This one was outside the planned time, so enter how long it took. ORDUP uses that for the next estimate.</p>
      <button class="btn primary full" type="button" data-action="save-actual">Mark complete</button>
    </div>
  `;
}

function moveSheet(state, today) {
  const draft = state.ui.draft;
  if (!draft) return "";
  return `
    <header class="sheet-head"><div><p class="kicker">Move</p><h2>${esc(draft.title || "Study")}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">
      ${draft.slots?.length ? `<div class="stack">${draft.slots.map((slot, index) => `<button class="slot ${draft.chosen === index ? "on" : ""}" type="button" data-action="choose-slot" data-index="${index}"><strong>${WEEKDAYS[weekday(slot.date)]}</strong><em>${formatRange(slot.start, slot.end)}</em><p>${esc(slot.reason)}</p></button>`).join("")}</div>
      <button class="btn primary full" type="button" data-action="confirm-move">Move it here</button>` : `<div class="notice"><strong>No other time</strong><p>There isn’t another block before the deadline.</p></div>`}
    </div>
  `;
}

function profileSheet(state) {
  const draft = state.ui.draft || {};
  return `
    <header class="sheet-head"><div><p class="kicker">Profile</p><h2>${esc(state.user.name || "Student")}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">
      <label class="field">Name<input data-field="name" value="${esc(draft.name || "")}" /></label>
      <label class="field">Year / grade<input data-field="grade" value="${esc(draft.grade || "")}" /></label>
      <label class="field">School<input data-field="school" value="${esc(draft.school || "")}" /></label>
      <p class="muted">Time zone: ${esc(state.user.timezone)}</p>
      <h3>Normal routine</h3>
      <div class="split">
        <label class="field">Wake<input data-field="wake" type="time" value="${esc(draft.wake)}" /></label>
        <label class="field">Bed<input data-field="bed" type="time" value="${esc(draft.bed)}" /></label>
      </div>
      <div class="split">
        <label class="field">School starts<input data-field="schoolStart" type="time" value="${esc(draft.schoolStart)}" /></label>
        <label class="field">School ends<input data-field="schoolEnd" type="time" value="${esc(draft.schoolEnd)}" /></label>
      </div>
      <div class="split">
        <label class="field">Dinner<input data-field="dinner" type="time" value="${esc(draft.dinner)}" /></label>
        <label class="field">Dinner ends<input data-field="dinnerEnd" type="time" value="${esc(draft.dinnerEnd)}" /></label>
      </div>
      <h3>Study preferences</h3>
      <div class="chip-row">
        <button class="chip ${draft.homeworkTiming === "yes" ? "on" : ""}" type="button" data-action="set-field" data-field="homeworkTiming" data-value="yes">Right after school</button>
        <button class="chip ${draft.homeworkTiming === "break" ? "on" : ""}" type="button" data-action="set-field" data-field="homeworkTiming" data-value="break">Break first</button>
        <button class="chip ${draft.homeworkTiming === "no" ? "on" : ""}" type="button" data-action="set-field" data-field="homeworkTiming" data-value="no">Not right away</button>
      </div>
      <label class="field">Break after school (minutes)<input data-field="breakMinutes" type="number" min="0" max="120" value="${esc(draft.breakMinutes)}" /></label>
      <div class="split">
        <label class="field">Preferred from<input data-field="preferredStart" type="time" value="${esc(draft.preferredStart)}" /></label>
        <label class="field">Preferred until<input data-field="preferredEnd" type="time" value="${esc(draft.preferredEnd)}" /></label>
      </div>
      <button class="chip ${draft.weekendStudy ? "on" : ""}" type="button" data-action="toggle-draft" data-field="weekendStudy">${draft.weekendStudy ? "Weekend study is ok" : "Keep weekends free"}</button>
      <h3>Notifications</h3>
      <div class="stack">
        ${[
          ["classes", "Upcoming class"],
          ["homework", "Planned homework"],
          ["deadlines", "Deadline risk"],
          ["conflicts", "Schedule conflicts"],
          ["exams", "Exams"],
        ].map(([key, label]) => `<button class="toggle ${draft[key] ? "on" : ""}" type="button" data-action="toggle-draft" data-field="${key}"><span>${label}</span><i></i></button>`).join("")}
      </div>
      <h3>Look</h3>
      <p class="muted">Color, dark mode, and font are saved for ${esc(state.user.name || "this account")}.</p>
      <button class="btn ghost" type="button" data-action="open-settings">Settings</button>
      <h3>Google and ManageBac</h3>
      <p class="muted">${draft.googleEmail ? `Signed in as ${esc(draft.googleEmail)}.` : "Login with the Google account your school uses."} Then add the ManageBac address so ORDUP can check it is the same school.</p>
      ${draft.googleEmail || state.user?.name ? "" : googleButton(Boolean(draft.busy || state.ui.syncing))}
      <label class="field">ManageBac address<input data-field="schoolHost" value="${esc(draft.schoolHost || "")}" placeholder="yourschool.managebac.com" /></label>
      <h3>Privacy</h3>
      <p class="muted">ORDUP stores this plan in this browser only. The assistant reads your timetable to answer and to propose changes. You can export or delete the plan.</p>
      <h3>Recent changes</h3>
      ${state.changes.length ? `<ul class="plain">${state.changes.slice(0, 6).map((change) => `<li>${esc(change.label)}${change.undone ? " · undone" : ""}</li>`).join("")}</ul>` : `<p class="muted">No changes yet.</p>`}
      <div class="choice-row">
        <button class="btn primary" type="button" data-action="save-profile">Save</button>
        <button class="btn ghost" type="button" data-action="export-data">Export</button>
        <button class="btn ghost danger" type="button" data-action="delete-account">Delete account</button>
      </div>
    </div>
  `;
}

function settingsSheet(state, nowMin) {
  const look = appearanceOf(state.user);
  const dark = isDarkNow(state.user, nowMin);
  const modes = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["auto", "Auto"],
  ];
  return `
    <header class="sheet-head"><div><p class="kicker">Settings</p><h2>${esc(state.user.name || "Your look")}</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">
      <p class="muted">These choices stay on this account.</p>
      <h3>Main color</h3>
      <div class="color-row">
        <input data-field="themeColor" type="color" value="${look.color}" aria-label="Main theme color" />
        <span>${esc(look.color)}</span>
      </div>
      <button class="btn ghost" type="button" data-action="reset-appearance">Reset to default</button>
      <h3>Mode</h3>
      <div class="seg" role="tablist">
        ${modes.map(([key, label]) => `<button class="${look.mode === key ? "on" : ""}" type="button" data-action="set-appearance-mode" data-mode="${key}">${label}</button>`).join("")}
      </div>
      <p class="muted">Auto is light while you are awake and dark from bedtime until you wake. Right now it is ${dark ? "dark" : "light"}.</p>
      <h3>Font</h3>
      <p class="using-font" style="font-family: &quot;${esc(look.font)}&quot;, sans-serif">Using ${esc(look.font)}</p>
      <p class="muted">Every Google font is written in that font. Search, tap a name, then use it for all text.</p>
      <label class="field">Search<input data-field="fontQuery" placeholder="Search ${GOOGLE_FONTS.length.toLocaleString()} fonts" /></label>
      <div class="font-list" data-field="fontPick" role="listbox" aria-label="Google fonts"></div>
      <button class="btn primary" type="button" data-action="use-font">Use this font</button>
    </div>
  `;
}

function notesSheet(state, today, nowMin) {
  const items = notifications(state, today, nowMin);
  return `
    <header class="sheet-head"><div><p class="kicker">Notifications</p><h2>Worth knowing</h2></div><button class="icon-btn" type="button" data-action="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">
      ${items.length ? items.map((item) => `<article class="note-card"><strong>${esc(item.title)}</strong><p>${esc(item.body)}</p><button class="btn ghost" type="button" data-action="dismiss-note" data-id="${esc(item.id)}">Dismiss</button></article>`).join("") : `<div class="empty">You’re clear. ORDUP pings when a class ends, and for upcoming classes, planned work, deadlines, conflicts, and exams.</div>`}
    </div>
  `;
}

function onboard(state, today) {
  const draft = state.ui.draft || { step: 0 };
  const step = draft.step || 0;
  if (step === 0) {
    return `
      <section class="welcome">
        <img class="app-logo" src="logo.png" alt="ORDUP" />
        <p class="kicker">ORDUP</p>
        <h1>Login with Google</h1>
        ${googleButton(Boolean(draft.busy))}
        ${draft.error ? `<p class="error">${esc(draft.error)}</p>` : ""}
      </section>
    `;
  }
  const fields = [
    googleButton(Boolean(draft.busy)),
    `<p>These protect sleep, school, and dinner when ORDUP looks for study time.</p>
     <div class="split"><label class="field">Wake<input data-field="wake" type="time" value="${esc(draft.wake || "07:00")}" /></label><label class="field">Bed<input data-field="bed" type="time" value="${esc(draft.bed || "22:00")}" /></label></div>
     <div class="split"><label class="field">School starts<input data-field="schoolStart" type="time" value="${esc(draft.schoolStart || "08:30")}" /></label><label class="field">School ends<input data-field="schoolEnd" type="time" value="${esc(draft.schoolEnd || "15:15")}" /></label></div>
     <label class="field">Dinner<input data-field="dinner" type="time" value="${esc(draft.dinner || "19:00")}" /></label>`,
    `<p>Do you like doing homework immediately after school?</p>
     <div class="stack">
       <button class="chip ${draft.homeworkTiming === "yes" ? "on" : ""}" type="button" data-action="set-field" data-field="homeworkTiming" data-value="yes">Yes</button>
       <button class="chip ${draft.homeworkTiming === "no" ? "on" : ""}" type="button" data-action="set-field" data-field="homeworkTiming" data-value="no">No</button>
       <button class="chip ${draft.homeworkTiming === "break" ? "on" : ""}" type="button" data-action="set-field" data-field="homeworkTiming" data-value="break">Give me a break first</button>
     </div>
     ${draft.homeworkTiming === "break" ? `<p class="field-label">How much break time?</p><div class="chip-row">${[15, 30, 45, 60].map((mins) => `<button class="chip ${Number(draft.breakMinutes) === mins ? "on" : ""}" type="button" data-action="set-field" data-field="breakMinutes" data-value="${mins}">${mins} minutes</button>`).join("")}</div>` : ""}
     <div class="split"><label class="field">Preferred study from<input data-field="preferredStart" type="time" value="${esc(draft.preferredStart || "16:00")}" /></label><label class="field">Until<input data-field="preferredEnd" type="time" value="${esc(draft.preferredEnd || "18:30")}" /></label></div>
     <button class="chip ${draft.weekendStudy !== false ? "on" : ""}" type="button" data-action="toggle-draft" data-field="weekendStudy">Weekend study is ok</button>`,
    `<p class="muted">Enter the ManageBac address for your school. ORDUP checks that it matches the Google account you just used, then loads the tasks already posted.</p>
     <label class="field">ManageBac address<input data-field="schoolHost" value="${esc(draft.schoolHost || "")}" placeholder="yourschool.managebac.com" /></label>
     ${draft.status ? `<p class="muted">${esc(draft.status)}</p>` : ""}`,
  ];
  const titles = ["", "Login with Google", "Your normal day", "How you like to study", "Your school’s ManageBac"];
  return `
    <section class="welcome">
      <p class="kicker">Step ${step} of 4</p>
      <h1>${titles[step] || ""}</h1>
      ${fields[step - 1] || ""}
      ${draft.error ? `<p class="error">${esc(draft.error)}</p>` : ""}
      ${step === 1 ? "" : `<div class="choice-row">
        <button class="btn ghost" type="button" data-action="onboard-go" data-step="${step - 1}" ${draft.busy ? "disabled" : ""}>Back</button>
        ${step === 4 ? `<button class="btn ghost" type="button" data-action="onboard-skip" ${draft.busy ? "disabled" : ""}>Skip for now</button>` : ""}
        <button class="btn primary" type="button" data-action="onboard-next" ${draft.busy ? "disabled" : ""}>${step === 4 && draft.busy ? "Loading tasks…" : "Continue"}</button>
      </div>`}
    </section>
  `;
}

function hasGoogleAccount(state) {
  return Boolean(state.managebac?.email || state.user?.name);
}

function googleButton(busy) {
  const label = busy ? "Waiting for Google…" : "Login with Google";
  const icon = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.7-6.6 7.1l6.3 5.3C37.4 38.4 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>`;
  return `<a class="google-btn" href="/google/start" target="_blank" rel="opener">${icon}<span>${label}</span></a>`;
}

function toast(state) {
  const current = state.ui.toast;
  if (!current) return "";
  return `
    <div class="toast" role="status">
      <span>${current.text === "Schedule updated" ? "✓ Schedule updated" : esc(current.text)}</span>
      ${current.changeId ? `<button type="button" data-action="undo" data-id="${esc(current.changeId)}">Undo</button>` : ""}
    </div>
  `;
}

function navLinks(state, className) {
  const items = [
    ["today", "Today", "today"],
    ["schedule", "Schedule", "schedule"],
    ["tasks", "Tasks", "tasks"],
    ["chores", "Chores", "chores"],
    ["calendar", "Calendar", "calendar"],
  ];
  return items.map(([id, label, glyph]) => `<button class="${className} ${state.ui.tab === id ? "on" : ""}" type="button" data-action="nav" data-tab="${id}">${icon(glyph)}<span>${label}</span></button>`).join("");
}

function upcomingSessions(state, today, nowMin) {
  return state.sessions
    .filter((session) => session.status === "planned" && session.date === today && toMin(session.end) > nowMin)
    .sort((a, b) => a.start.localeCompare(b.start));
}

function choreRepeatSummary(draft) {
  if (!draft.repeat || draft.repeat === "once") return "Happens once.";
  return repeatSummary(draft);
}

function repeatSummary(draft) {
  const every = Math.max(1, Math.round(Number(draft.interval) || 1));
  if (draft.repeat === "day") return "Repeats every day.";
  if (draft.repeat === "days") return `Repeats every ${every} day${every === 1 ? "" : "s"}.`;
  if (draft.repeat === "weeks") return `Repeats every ${every} week${every === 1 ? "" : "s"}.`;
  return "Repeats every week.";
}

function upcomingThursday(today) {
  const delta = (4 - weekday(today) + 7) % 7;
  return addDays(today, delta === 0 ? 7 : delta);
}

function initial(name) {
  return (name || "").trim().charAt(0).toUpperCase() || "?";
}

function cap(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function icon(name) {
  const paths = {
    today: '<rect x="4" y="5" width="16" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 3.5v3M16 3.5v3M4 9.5h16" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    schedule: '<path d="M5 7h14M7 4v3M17 4v3M6 11h4M6 15h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="4" y="5" width="16" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    tasks: '<path d="M8 7h9M8 12h9M8 17h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M5 7h.01M5 12h.01M5 17h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    chores: '<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-5v-5H10v5H5a1 1 0 0 1-1-1v-7.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 10h16M9 14h2M13 14h2M9 17h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    bell: '<path d="M6 16h12l-1.2-2.2a6 6 0 0 1-.8-3V10a4 4 0 0 0-8 0v.8a6 6 0 0 1-.8 3L6 16z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 16a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.7"/>',
    settings: '<path fill="currentColor" fill-rule="evenodd" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7.1 7.1 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.48-.41h-3.84a.5.5 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58c-.05.31-.07.63-.07.94s.02.63.07.94l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
}

export function liveCountdown(state) {
  const { date, min } = nowParts();
  const next = nextUp(state, date, min);
  if (!next) return { clock: formatTime(min), countdown: "", mode: "" };
  const countdown = next.mode === "now"
    ? `Happening now · ends in ${next.endsIn} minute${next.endsIn === 1 ? "" : "s"}`
    : next.mode === "later"
      ? relativeDay(next.date, date)
      : `Starts in ${next.delta} minute${next.delta === 1 ? "" : "s"}`;
  return { clock: formatTime(min), countdown, mode: `${next.mode}:${next.item?.id}` };
}
