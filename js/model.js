export const subjects = [
  { id: "math", name: "Mathematics", short: "Maths", teacher: "", color: "#6D4AFF" },
  { id: "english", name: "English", short: "English", teacher: "", color: "#E36A45" },
  { id: "science", name: "Science", short: "Science", teacher: "", color: "#1F9D8A" },
  { id: "history", name: "History", short: "History", teacher: "", color: "#C8962E" },
  { id: "cs", name: "Computer Science", short: "Computing", teacher: "", color: "#3A7BD5" },
  { id: "pe", name: "PE", short: "PE", teacher: "", color: "#D4537E" },
];

export function blankUser(detectedZone = "local") {
  return {
    id: "user",
    name: "",
    grade: "",
    school: "",
    timezone: detectedZone,
    onboarded: false,
    routine: {
      wake: "07:00",
      schoolStart: "08:30",
      schoolEnd: "15:15",
      dinner: "19:00",
      dinnerEnd: "19:30",
      bed: "22:00",
    },
    preferences: {
      homeworkTiming: "break",
      breakMinutes: 30,
      preferred: [{ start: "16:00", end: "18:30" }],
      unavailable: [],
      maxContinuous: 60,
      breakBetween: 15,
      weekendStudy: true,
    },
    notifications: {
      classes: true,
      homework: true,
      deadlines: true,
      conflicts: true,
      exams: true,
      device: false,
    },
    ai: { confirmSmall: true },
  };
}

export function blankManagebac() {
  return {
    email: "",
    schoolHost: "",
    apiHost: "api.managebac.com",
    authToken: "",
    clientId: "",
    clientSecret: "",
    studentId: null,
    studentName: "",
    signedIn: false,
    lastSync: "",
    lastError: "",
  };
}

export function createEmptyState(detectedZone = "local") {
  return {
    version: 2,
    user: blankUser(detectedZone),
    googleConnected: false,
    managebac: blankManagebac(),
    subjects,
    classes: [],
    exceptions: [],
    overrides: [],
    tasks: [],
    sessions: [],
    events: [],
    history: [],
    changes: [],
    messages: [],
    notices: [],
    dismissed: [],
    chores: [],
    memory: [],
    ui: freshUi(),
  };
}

export function freshUi(partial = {}) {
  return {
    tab: partial.tab || "today",
    sheet: null,
    toast: null,
    calendarMode: partial.calendarMode || "week",
    calendarDate: partial.calendarDate || "",
    scheduleDate: partial.scheduleDate || "",
    taskFilter: partial.taskFilter || "open",
    draft: null,
    aiInput: "",
  };
}
