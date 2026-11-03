export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function now() {
  return new Date();
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function isoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseISO(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function nowParts() {
  const date = now();
  return {
    date: isoDate(date),
    min: date.getHours() * 60 + date.getMinutes(),
  };
}

export function addDays(iso, days) {
  const date = parseISO(iso);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

export function daysBetween(from, to) {
  return Math.round((parseISO(to) - parseISO(from)) / 86400000);
}

export function weekday(iso) {
  return parseISO(iso).getDay();
}

export function isWeekend(iso) {
  const day = weekday(iso);
  return day === 0 || day === 6;
}

export function toMin(value) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

export function fromMin(mins) {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

export function formatTime(mins) {
  const h24 = Math.floor(mins / 60) % 24;
  const m = ((mins % 60) + 60) % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 || 12;
  return `${h}:${pad(m)} ${suffix}`;
}

export function formatRange(start, end) {
  const s = typeof start === "string" ? toMin(start) : start;
  const e = typeof end === "string" ? toMin(end) : end;
  const sSuffix = s >= 12 * 60 ? "PM" : "AM";
  const eSuffix = e >= 12 * 60 ? "PM" : "AM";
  const label = (mins) => {
    const h24 = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${h24 % 12 || 12}:${pad(m)}`;
  };
  if (sSuffix === eSuffix) return `${label(s)}–${label(e)} ${eSuffix}`;
  return `${label(s)} ${sSuffix}–${label(e)} ${eSuffix}`;
}

export function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} min`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
}

export function longDate(iso) {
  const date = parseISO(iso);
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function shortDate(iso) {
  const date = parseISO(iso);
  return `${WEEKDAYS_SHORT[date.getDay()]} ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
}

export function dayMonth(iso) {
  const date = parseISO(iso);
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
}

export function dueText(iso) {
  if (!iso) return "No due date";
  const date = parseISO(iso);
  const year = date.getFullYear() === now().getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `Due ${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

export function relativeDay(iso, today) {
  const delta = daysBetween(today, iso);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  return WEEKDAYS[weekday(iso)];
}

export function whenDay(iso, today) {
  const delta = daysBetween(today, iso);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  const date = parseISO(iso);
  const year = date.getFullYear() === now().getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

export function upcomingWeekday(from, target) {
  const delta = (target - weekday(from) + 7) % 7;
  return addDays(from, delta);
}

export function endOfWeek(iso) {
  const day = weekday(iso);
  return addDays(iso, day === 0 ? 0 : 7 - day);
}

export function startOfWeek(iso) {
  const day = weekday(iso);
  return addDays(iso, day === 0 ? -6 : 1 - day);
}

export function startOfMonth(iso) {
  const date = parseISO(iso);
  return isoDate(new Date(date.getFullYear(), date.getMonth(), 1));
}

export function addMonths(iso, count) {
  const date = parseISO(iso);
  return isoDate(new Date(date.getFullYear(), date.getMonth() + count, 1));
}

export function daysInMonth(iso) {
  const date = parseISO(iso);
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

export function greeting(min) {
  if (min < 12 * 60) return "Good morning";
  if (min < 17 * 60) return "Good afternoon";
  return "Good evening";
}

export function countdown(delta) {
  if (delta <= 0) return "Starting now";
  if (delta === 1) return "Starts in 1 minute";
  if (delta < 60) return `Starts in ${delta} minutes`;
  const hours = Math.floor(delta / 60);
  const mins = delta % 60;
  if (!mins) return `Starts in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `Starts in ${hours}h ${mins}m`;
}

export function uid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function cap(text) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}
