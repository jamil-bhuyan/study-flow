
"use strict";

/* STUDYFLOW — browser-only student planner.
   Planner records use IndexedDB, with localStorage as a fallback.
   The assistant below uses local rules, not a connected Gemini model. */

const $ = (id) => document.getElementById(id);
const DB_NAME = "StudyFlowDB";
const DB_VERSION = 1;
const STORE_NAME = "planner";
const FALLBACK_KEY = "studyflow_backup_v1";

const defaultState = () => ({
  tasks: [],
  exams: [],
  routine: {
    wake: "07:00", sleep: "23:00",
    collegeStart: "09:00", collegeEnd: "14:00",
    session: 45, break: 10
  },
  settings: { name: "Student", theme: "dark" },
  chat: []
});

let state = defaultState();
let currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDate = dateKey(new Date());
let toastTimer;

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayKey() {
  return dateKey(new Date());
}

function parseDate(value) {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const d = parseDate(value);
  return d ? d.toLocaleDateString(undefined, {
    day: "numeric", month: "short", year: "numeric"
  }) : "No date";
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function isOverdue(task) {
  return !task.completed && task.deadline < todayKey();
}

function pendingTasks() {
  return state.tasks.filter(t => !t.completed);
}

function remainingMinutes() {
  return pendingTasks().reduce((sum, task) => sum + Number(task.minutes || 0), 0);
}

function priorityScore(task) {
  const priority = { High: 30, Medium: 15, Low: 0 }[task.priority] || 0;
  const difficulty = { Hard: 8, Medium: 4, Easy: 0 }[task.difficulty] || 0;
  const days = Math.ceil((parseDate(task.deadline) - parseDate(todayKey())) / 86400000);
  const urgency = days < 0 ? 100 : days === 0 ? 60 : Math.max(0, 30 - days * 3);
  return priority + difficulty + urgency;
}

/* ---------- IndexedDB storage ---------- */

function openDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSavedState() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME).get("main");

      request.onsuccess = () => resolve(request.result?.data || null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    try {
      return JSON.parse(localStorage.getItem(FALLBACK_KEY) || "null");
    } catch {
      return null;
    }
  }
}

async function persist() {
  const snapshot = JSON.parse(JSON.stringify(state));

  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ id: "main", data: snapshot });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Save aborted"));
    });
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot));
  } catch (error) {
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot));
    } catch {
      toast("Could not save data. Export a backup and free browser storage.");
      console.error(error);
      return;
    }
  }

  const status = document.querySelector(".local-status");
  if (status) status.innerHTML = "<span></span> Saved locally";
}

async function commit(message) {
  await persist();
  renderAll();
  if (message) toast(message);
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

/* ---------- Navigation ---------- */

function goTo(view) {
  if (!$(`${view}`)) return;

  document.querySelectorAll(".view").forEach(section => {
    section.classList.toggle("active", section.id === view);
  });

  document.querySelectorAll(".nav-item[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  const activeButton = document.querySelector(`.nav-item[data-view="${view}"] span`);
  $("pageTitle").textContent = activeButton?.textContent || "Dashboard";
  $("sidebar").classList.remove("open");

  if (view === "calendar") renderCalendar();
  if (view === "routine") renderRoutine();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$("navigation").addEventListener("click", event => {
  const button = event.target.closest("[data-view]");
  if (button) goTo(button.dataset.view);
});

document.querySelectorAll("[data-go]").forEach(button => {
  button.addEventListener("click", () => goTo(button.dataset.go));
});

$("menuToggle").addEventListener("click", () => {
  $("sidebar").classList.toggle("open");
});

$("profileButton").addEventListener("click", () => goTo("settings"));

document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => $(button.dataset.close).close());
});

/* ---------- Homework CRUD ---------- */

function openTaskDialog(task = null) {
  $("taskForm").reset();
  $("taskId").value = task?.id || "";
  $("taskDialogTitle").textContent = task ? "Edit assignment" : "New assignment";
  $("taskTitle").value = task?.title || "";
  $("taskSubject").value = task?.subject || "";
  $("taskDeadline").value = task?.deadline || todayKey();
  $("taskMinutes").value = task?.minutes || 60;
  $("taskDifficulty").value = task?.difficulty || "Medium";
  $("taskPriority").value = task?.priority || "Medium";
  $("taskDescription").value = task?.description || "";
  $("taskDialog").showModal();
}

$("quickAdd").addEventListener("click", () => openTaskDialog());
$("addHomework").addEventListener("click", () => openTaskDialog());

$("taskForm").addEventListener("submit", async event => {
  event.preventDefault();

  const id = $("taskId").value;
  const existing = state.tasks.find(t => t.id === id);

  const task = {
    id: id || uid(),
    title: $("taskTitle").value.trim(),
    subject: $("taskSubject").value.trim(),
    deadline: $("taskDeadline").value,
    minutes: Number($("taskMinutes").value),
    difficulty: $("taskDifficulty").value,
    priority: $("taskPriority").value,
    description: $("taskDescription").value.trim(),
    completed: existing?.completed || false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    completedAt: existing?.completedAt || null
  };

  if (!task.title || !task.subject || !task.deadline ||
      !Number.isFinite(task.minutes) || task.minutes < 5) {
    toast("Please check the assignment details.");
    return;
  }

  if (existing) {
    state.tasks = state.tasks.map(t => t.id === id ? task : t);
  } else {
    state.tasks.push(task);
  }

  $("taskDialog").close();
  await commit(existing ? "Assignment updated." : "Assignment added.");
});

async function toggleTask(id, checked) {
  state.tasks = state.tasks.map(task => task.id === id
    ? { ...task, completed: checked, completedAt: checked ? new Date().toISOString() : null }
    : task);
  await commit(checked ? "Task completed!" : "Task marked as pending.");
}

async function deleteTask(id) {
  if (!confirm("Delete this assignment permanently?")) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  await commit("Assignment deleted.");
}

function taskHTML(task, actions = true) {
  const overdue = isOverdue(task);
  const statusTag = task.completed
    ? '<span class="tag completed">Completed</span>'
    : overdue
      ? '<span class="tag overdue">Overdue</span>'
      : `<span class="tag ${task.priority.toLowerCase()}">${escapeHTML(task.priority)}</span>`;

  return `
    <div class="task-row ${task.completed ? "task-done" : ""}">
      <input class="task-check" type="checkbox" aria-label="Mark ${escapeHTML(task.title)} complete"
        data-action="toggle-task" data-id="${escapeHTML(task.id)}"
        ${task.completed ? "checked" : ""}>
      <div class="task-info">
        <div class="task-title">${escapeHTML(task.title)}</div>
        <div class="task-subtitle">${escapeHTML(task.subject)} · ${formatDate(task.deadline)} · ${Math.ceil(task.minutes / 60 * 10) / 10}h</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:7px">
          ${statusTag}
          <span class="tag">${escapeHTML(task.difficulty)}</span>
        </div>
      </div>
      ${actions ? `<div class="task-actions">
        <button class="icon-btn" data-action="edit-task" data-id="${escapeHTML(task.id)}" aria-label="Edit task">✎</button>
        <button class="icon-btn" data-action="delete-task" data-id="${escapeHTML(task.id)}" aria-label="Delete task">×</button>
      </div>` : ""}
    </div>`;
}

function renderTaskList(element, tasks, emptyText = "Nothing here yet.") {
  element.innerHTML = tasks.length
    ? tasks.map(task => taskHTML(task)).join("")
    : `<div class="empty-state">${escapeHTML(emptyText)}</div>`;
}

document.addEventListener("change", async event => {
  const checkbox = event.target.closest('[data-action="toggle-task"]');
  if (checkbox) await toggleTask(checkbox.dataset.id, checkbox.checked);

  const chapter = event.target.closest("[data-chapter-check]");
  if (chapter) {
    const exam = state.exams.find(e => e.id === chapter.dataset.exam);
    if (exam && exam.chapters[Number(chapter.dataset.chapter)]) {
      exam.chapters[Number(chapter.dataset.chapter)].done = chapter.checked;
      await commit("Chapter progress saved.");
    }
  }
});

document.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const { action, id } = button.dataset;

  if (action === "edit-task") {
    const task = state.tasks.find(t => t.id === id);
    if (task) openTaskDialog(task);
  }
  if (action === "delete-task") deleteTask(id);
  if (action === "edit-exam") {
    const exam = state.exams.find(e => e.id === id);
    if (exam) openExamDialog(exam);
  }
  if (action === "delete-exam") deleteExam(id);
});

$("taskSearch").addEventListener("input", renderHomework);
$("taskFilter").addEventListener("change", renderHomework);

function renderHomework() {
  const search = $("taskSearch").value.trim().toLowerCase();
  const filter = $("taskFilter").value;

  let tasks = state.tasks.filter(t =>
    `${t.title} ${t.subject} ${t.description}`.toLowerCase().includes(search)
  );

  if (filter === "pending") tasks = tasks.filter(t => !t.completed && !isOverdue(t));
  if (filter === "completed") tasks = tasks.filter(t => t.completed);
  if (filter === "overdue") tasks = tasks.filter(isOverdue);

  tasks.sort((a, b) => {
    if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
    return a.deadline.localeCompare(b.deadline);
  });

  renderTaskList($("homeworkList"), tasks, "No assignments match your search.");
}

/* ---------- Dashboard and progress ---------- */

function renderDashboard() {
  const today = todayKey();
  const pending = pendingTasks();
  const completed = state.tasks.filter(t => t.completed);
  const overdue = pending.filter(isOverdue);
  const totalMinutes = remainingMinutes();
  const rate = state.tasks.length ? Math.round(completed.length / state.tasks.length * 100) : 0;

  $("todayDate").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });

  $("pendingCount").textContent = pending.length;
  $("completedCount").textContent = completed.length;
  $("overdueCount").textContent = overdue.length;
  $("remainingHours").textContent = `${Math.round(totalMinutes / 60 * 10) / 10}h`;
  $("progressPercent").textContent = `${rate}%`;
  $("progressRing").style.setProperty("--progress", `${rate}%`);
  $("progressDone").textContent = completed.length;
  $("progressLeft").textContent = pending.length;

  const todayTasks = pending
    .filter(t => t.deadline <= today)
    .sort((a, b) => priorityScore(b) - priorityScore(a));

  renderTaskList($("todayTasks"), todayTasks.slice(0, 5),
    pending.length ? "No assignments due today. Check your upcoming deadlines below." : "You're all caught up! Add an assignment to get started.");

  const upcoming = pending.filter(t => t.deadline >= today)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .slice(0, 5);

  renderTaskList($("upcomingTasks"), upcoming, "No upcoming deadlines. Enjoy the breathing room.");
}

function renderProgress() {
  const completed = state.tasks.filter(t => t.completed);
  const today = todayKey();
  const completedToday = completed.filter(t =>
    t.completedAt && dateKey(new Date(t.completedAt)) === today
  ).length;

  $("totalStat").textContent = state.tasks.length;
  $("rateStat").textContent = `${state.tasks.length ? Math.round(completed.length / state.tasks.length * 100) : 0}%`;
  $("hoursStat").textContent = `${Math.round(remainingMinutes() / 60 * 10) / 10}h`;
  $("examsStat").textContent = state.exams.length;

  const subjects = {};
  state.tasks.forEach(t => {
    const subject = t.subject || "Other";
    subjects[subject] ||= { total: 0, done: 0, minutes: 0 };
    subjects[subject].total++;
    if (t.completed) subjects[subject].done++;
    else subjects[subject].minutes += Number(t.minutes || 0);
  });

  const entries = Object.entries(subjects);
  $("subjectProgress").innerHTML = entries.length ? entries.map(([name, data]) => {
    const percent = Math.round(data.done / data.total * 100);
    return `<div>
      <div style="display:flex;justify-content:space-between;gap:10px">
        <strong>${escapeHTML(name)}</strong><span class="muted">${data.done}/${data.total} · ${percent}%</span>
      </div>
      <div class="large-progress"><div style="width:${percent}%"></div></div>
      <p class="muted">${Math.round(data.minutes / 60 * 10) / 10} hours of unfinished work</p>
    </div>`;
  }).join("") : '<div class="empty-state">Add homework to see subject statistics.</div>';

  const dailyPercent = state.tasks.length
    ? Math.round(completedToday / state.tasks.length * 100) : 0;
  $("dailyProgressBar").style.width = `${Math.min(100, dailyPercent)}%`;
  $("dailyProgressText").textContent = `${completedToday} assignment(s) completed today.`;
}

/* ---------- Routine generator ---------- */

function readRoutineForm() {
  return {
    wake: $("wakeTime").value,
    sleep: $("sleepTime").value,
    collegeStart: $("collegeStart").value,
    collegeEnd: $("collegeEnd").value,
    session: Number($("sessionLength").value),
    break: Number($("breakLength").value)
  };
}

function timeToMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

$("routineForm").addEventListener("submit", async event => {
  event.preventDefault();
  const routine = readRoutineForm();

  if (routine.wake === routine.sleep ||
      routine.collegeStart === routine.collegeEnd ||
      routine.session < 15 || routine.break < 5) {
    toast("Check your times and session lengths.");
    return;
  }

  state.routine = routine;
  await commit("Routine saved.");
  renderRoutine();
});

$("generateRoutine").addEventListener("click", generateRoutine);

function renderRoutine() {
  const r = state.routine;
  $("wakeTime").value = r.wake;
  $("sleepTime").value = r.sleep;
  $("collegeStart").value = r.collegeStart;
  $("collegeEnd").value = r.collegeEnd;
  $("sessionLength").value = r.session;
  $("breakLength").value = r.break;
}

function generateRoutine() {
  const r = state.routine;
  const start = timeToMinutes(r.wake);
  const end = timeToMinutes(r.sleep);
  const collegeStart = timeToMinutes(r.collegeStart);
  const collegeEnd = timeToMinutes(r.collegeEnd);

  if (end <= start || collegeEnd <= collegeStart ||
      r.session < 15 || r.break < 5) {
    toast("Your routine times need to be checked.");
    return;
  }

  const fixed = [
    { start, end: start + 30, title: "Morning routine" },
    { start: collegeStart, end: collegeEnd, title: "College / classes" },
    { start: Math.max(start, end - 45), end, title: "Prepare for sleep" }
  ].filter(x => x.end > start && x.start < end)
   .sort((a, b) => a.start - b.start);

  const blocks = [];
  for (const block of fixed) {
    const last = blocks[blocks.length - 1];
    if (last && block.start < last.end) {
      last.end = Math.max(last.end, block.end);
      if (!last.title.includes(block.title)) last.title += " / " + block.title;
    } else blocks.push({ ...block });
  }

  let cursor = start;
  const gaps = [];
  for (const block of blocks) {
    if (block.start > cursor) gaps.push([cursor, block.start]);
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < end) gaps.push([cursor, end]);

  let tasks = pendingTasks().sort((a, b) => priorityScore(b) - priorityScore(a));
  const plan = [];

  for (const [gapStart, gapEnd] of gaps) {
    let cursorTime = gapStart;
    let taskIndex = 0;

    while (cursorTime + 15 <= gapEnd && taskIndex < tasks.length) {
      const task = tasks[taskIndex];
      const remaining = Number(task.minutes || 0);
      const duration = Math.min(r.session, remaining, gapEnd - cursorTime);

      if (duration < 15) break;

      plan.push({
        start: cursorTime, end: cursorTime + duration,
        title: task.title, subject: task.subject, duration
      });

      task.minutes -= duration;
      cursorTime += duration;

      if (task.minutes <= 0) {
        task.minutes = 0;
        taskIndex++;
      } else if (gapEnd - cursorTime < 15) {
        break;
      } else {
        cursorTime += r.break;
      }
    }
  }

  // Use copies above; never modify saved task durations.
  const actualTasks = pendingTasks().sort((a, b) => priorityScore(b) - priorityScore(a));
  const restoredPlan = [];
  const freeSlots = gaps.map(([a, b]) => [a, b]);

  for (const [gapStart, gapEnd] of freeSlots) {
    let t = gapStart;
    let idx = 0;
    while (idx < actualTasks.length && t + 15 <= gapEnd) {
      const task = actualTasks[idx];
      const remaining = Number(task.minutes || 0);
      const duration = Math.min(r.session, remaining, gapEnd - t);
      if (duration < 15) break;

      restoredPlan.push({ start: t, end: t + duration, title: task.title, subject: task.subject });
      t += duration;
      task.minutes -= duration;
      if (task.minutes <= 0) idx++;
      else t += r.break;
    }
  }

  // Reset any temporary values on the real state.
  renderRoutine();

  const html = [
    ...blocks.map(b => `<div class="task-row"><div class="task-info"><div class="task-title">${escapeHTML(b.title)}</div><div class="task-subtitle">${minutesToTime(b.start)} – ${minutesToTime(b.end)} · Fixed routine</div></div></div>`),
    ...restoredPlan.map(p => `<div class="task-row"><div class="task-info"><div class="task-title">${escapeHTML(p.title)}</div><div class="task-subtitle">${escapeHTML(p.subject)} · ${minutesToTime(p.start)} – ${minutesToTime(p.end)}</div></div></div>`)
  ];

  const scheduled = restoredPlan.reduce((sum, p) => sum + (p.end - p.start), 0);
  const available = gaps.reduce((sum, g) => sum + g[1] - g[0], 0);

  $("routinePlan").innerHTML = html.length
    ? html.join("") + `<div class="empty-state">Scheduled ${Math.round(scheduled)} minutes of study. ${scheduled < available ? "Some free time remains for meals, rest and other activities." : "Your free time is nearly full."} This is a suggested plan; it is not saved as separate calendar events.</div>`
    : '<div class="empty-state">No study sessions could be fitted into the available time. Adjust your routine or session length.</div>';

  if (pendingTasks().length && scheduled < remainingMinutes()) {
    $("routinePlan").insertAdjacentHTML("beforeend",
      '<div class="empty-state">Not all unfinished work fits into this day. Prioritize urgent tasks and plan the remaining work for another day.</div>');
  }
}

/* ---------- Semester exams ---------- */

function openExamDialog(exam = null) {
  $("examForm").reset();
  $("examId").value = exam?.id || "";
  $("examDialogTitle").textContent = exam ? "Edit exam" : "Add exam";
  $("examName").value = exam?.name || "";
  $("examSubject").value = exam?.subject || "";
  $("examDate").value = exam?.date || todayKey();
  $("examChapters").value = exam?.chapters.map(c => c.name).join("\n") || "";
  $("examDialog").showModal();
}

$("addExam").addEventListener("click", () => openExamDialog());

$("examForm").addEventListener("submit", async event => {
  event.preventDefault();

  const id = $("examId").value;
  const existing = state.exams.find(e => e.id === id);
  const chapters = $("examChapters").value.split("\n")
    .map(s => s.trim()).filter(Boolean);

  if (!chapters.length) {
    toast("Add at least one chapter or topic.");
    return;
  }

  const exam = {
    id: id || uid(),
    name: $("examName").value.trim(),
    subject: $("examSubject").value.trim(),
    date: $("examDate").value,
    chapters: chapters.map(name => ({
      name,
      done: existing?.chapters.find(c => c.name === name)?.done || false
    }))
  };

  if (existing) state.exams = state.exams.map(e => e.id === id ? exam : e);
  else state.exams.push(exam);

  $("examDialog").close();
  await commit(existing ? "Exam updated." : "Exam added.");
});

async function deleteExam(id) {
  if (!confirm("Delete this exam and its chapter checklist?")) return;
  state.exams = state.exams.filter(e => e.id !== id);
  await commit("Exam deleted.");
}

function renderExams() {
  $("examList").innerHTML = state.exams.length ? state.exams
    .slice().sort((a, b) => a.date.localeCompare(b.date))
    .map(exam => {
      const done = exam.chapters.filter(c => c.done).length;
      const percent = Math.round(done / exam.chapters.length * 100);
      const days = Math.ceil((parseDate(exam.date) - parseDate(todayKey())) / 86400000);
      const countdown = days < 0 ? `${Math.abs(days)} day(s) ago` : days === 0 ? "Today" : `${days} day(s) left`;

      return `<article class="exam-card">
        <div class="panel-heading">
          <div><h2>${escapeHTML(exam.name)}</h2><p class="muted">${escapeHTML(exam.subject)} · ${formatDate(exam.date)}</p></div>
          <span class="tag ${days < 0 ? "overdue" : "medium"}">${countdown}</span>
        </div>
        <div class="large-progress"><div style="width:${percent}%"></div></div>
        <p class="muted">${done}/${exam.chapters.length} chapters completed · ${percent}%</p>
        <div class="chapter-list">${exam.chapters.map((chapter, index) => `
          <label class="chapter-item">
            <input type="checkbox" data-chapter-check data-exam="${escapeHTML(exam.id)}" data-chapter="${index}" ${chapter.done ? "checked" : ""}>
            <span>${escapeHTML(chapter.name)}</span>
          </label>`).join("")}</div>
        <div class="button-row">
          <button class="secondary-btn" data-action="edit-exam" data-id="${escapeHTML(exam.id)}">Edit exam</button>
          <button class="icon-btn" data-action="delete-exam" data-id="${escapeHTML(exam.id)}">Delete</button>
        </div>
      </article>`;
    }).join("") : '<div class="empty-state">No exams added. Start by adding an exam and its chapters.</div>';

  const topics = state.exams.flatMap(exam => exam.chapters.map(chapter => ({
    subject: exam.subject, exam: exam.name, ...chapter
  })));

  $("syllabusOverview").innerHTML = topics.length ? topics.map(t =>
    `<div class="task-row"><div class="task-info"><div class="task-title">${escapeHTML(t.name)}</div><div class="task-subtitle">${escapeHTML(t.subject)} · ${escapeHTML(t.exam)}</div></div><span class="tag ${t.done ? "completed" : "medium"}">${t.done ? "Done" : "To study"}</span></div>`
  ).join("") : '<div class="empty-state">Your syllabus overview will appear here.</div>';
}

/* ---------- Calendar ---------- */

$("prevMonth").addEventListener("click", () => {
  currentMonth.setMonth(currentMonth.getMonth() - 1);
  renderCalendar();
});

$("nextMonth").addEventListener("click", () => {
  currentMonth.setMonth(currentMonth.getMonth() + 1);
  renderCalendar();
});

function renderCalendar() {
  $("monthTitle").textContent = currentMonth.toLocaleDateString(undefined, {
    month: "long", year: "numeric"
  });

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  let html = weekdays.map(day => `<div class="calendar-cell weekday">${day}</div>`).join("");
  for (let i = 0; i < firstDay; i++) html += '<div class="calendar-cell" style="visibility:hidden"></div>';

  for (let day = 1; day <= days; day++) {
    const key = dateKey(new Date(year, month, day));
    const taskCount = state.tasks.filter(t => t.deadline === key && !t.completed).length;
    const examCount = state.exams.filter(e => e.date === key).length;
    const count = taskCount + examCount;

    html += `<button class="calendar-cell ${key === todayKey() ? "today" : ""} ${key === selectedDate ? "selected" : ""}"
      data-calendar-date="${key}" aria-label="${key}, ${count} item(s)">
      <span class="day-number">${day}</span>
      <span class="day-dots">${count ? "● " + count : ""}</span>
    </button>`;
  }

  $("calendarGrid").innerHTML = html;
  renderSelectedDate();
}

$("calendarGrid").addEventListener("click", event => {
  const cell = event.target.closest("[data-calendar-date]");
  if (!cell) return;
  selectedDate = cell.dataset.calendarDate;
  renderCalendar();
});

function renderSelectedDate() {
  $("selectedDateTitle").textContent = formatDate(selectedDate);
  const tasks = state.tasks.filter(t => t.deadline === selectedDate);
  const exams = state.exams.filter(e => e.date === selectedDate);

  const items = [
    ...tasks.map(t => taskHTML(t)),
    ...exams.map(e => `<div class="task-row"><div class="task-info"><div class="task-title">${escapeHTML(e.name)}</div><div class="task-subtitle">Exam · ${escapeHTML(e.subject)}</div></div><span class="tag medium">Exam</span></div>`)
  ];

  $("selectedDateTasks").innerHTML = items.length
    ? items.join("")
    : '<div class="empty-state">No deadlines or exams on this date.</div>';
}

/* ---------- Local study assistant ---------- */

function localAssistantReply(input) {
  const text = input.toLowerCase();
  const pending = pendingTasks().sort((a, b) => priorityScore(b) - priorityScore(a));

  if (text.includes("pending") || text.includes("homework") || text.includes("assignment")) {
    if (!pending.length) return "You have no unfinished assignments right now. Add homework whenever you receive it.";
    return "Here is your unfinished homework, prioritized by urgency and priority:\n\n" +
      pending.slice(0, 8).map((t, i) =>
        `${i + 1}. ${t.title} (${t.subject})\n   Deadline: ${formatDate(t.deadline)} · ${t.minutes} minutes${isOverdue(t) ? " · OVERDUE" : ""}`
      ).join("\n\n") +
      "\n\nThis list is based on your saved planner data.";
  }

  if (text.includes("first") || text.includes("priority") || text.includes("urgent")) {
    if (!pending.length) return "Nothing is pending. Add a task or review your semester syllabus.";
    const t = pending[0];
    return `Start with "${t.title}" for ${t.subject}.\n\nDeadline: ${formatDate(t.deadline)}\nEstimated time: ${t.minutes} minutes\nPriority: ${t.priority}\n\nTry one ${Math.min(state.routine.session, t.minutes)}-minute focus session, then take a short break. This is a local rule-based suggestion.`;
  }

  if (text.includes("exam") || text.includes("chapter") || text.includes("syllabus")) {
    if (!state.exams.length) return "You haven't added an exam yet. Open Semester Planner, add your exam date and list each chapter on a separate line.";
    return "Your upcoming exams:\n\n" + state.exams
      .slice().sort((a, b) => a.date.localeCompare(b.date))
      .map(e => {
        const done = e.chapters.filter(c => c.done).length;
        return `${e.name} — ${e.subject}\nDate: ${formatDate(e.date)}\nSyllabus: ${done}/${e.chapters.length} chapters completed`;
      }).join("\n\n") + "\n\nComplete the unfinished chapters and leave time for revision.";
  }

  if (text.includes("plan") || text.includes("schedule") || text.includes("tomorrow") || text.includes("today")) {
    if (!pending.length) return "You're all caught up! Add your next assignment or exam to create a study plan.";
    const tasks = pending.slice(0, 6);
    return "Here is a suggested study order based on your deadlines and priorities:\n\n" +
      tasks.map((t, i) => `${i + 1}. ${t.title} — ${t.minutes} min\n   ${t.subject} · Due ${formatDate(t.deadline)}`).join("\n\n") +
      `\n\nYour unfinished work totals ${Math.round(remainingMinutes() / 60 * 10) / 10} hours. Open Daily Routine to fit sessions into your available time. This is a local suggestion, not an AI-generated schedule.`;
  }

  if (text.includes("hello") || text.includes("hi") || text.includes("hey")) {
    return `Hey, ${state.settings.name || "student"}! I can help you review pending homework, identify urgent tasks, look at your exams, and suggest a study order. What would you like to work on?`;
  }

  return "I can help organize your saved planner data. Try asking:\n\n• Plan my study schedule for today\n• What should I study first?\n• Show my pending homework\n• Help me prepare for my exam\n\nThis version uses local rules only. It is not connected to Google Gemini.";
}

function addChatMessage(role, message) {
  const row = document.createElement("div");
  row.className = `chat-message ${role}`;
  row.textContent = message;
  $("chatMessages").appendChild(row);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  state.chat.push({ role, message });
}

function renderChat() {
  $("chatMessages").innerHTML = "";
  if (!state.chat.length) {
    const welcome = `Hi ${state.settings.name || "there"}! I'm your local StudyFlow assistant. I can help organize homework and study plans. What would you like to do today?`;
    const message = document.createElement("div");
    message.className = "chat-message assistant";
    message.textContent = welcome;
    $("chatMessages").appendChild(message);
  } else {
    state.chat.forEach(m => {
      const message = document.createElement("div");
      message.className = `chat-message ${m.role}`;
      message.textContent = m.message;
      $("chatMessages").appendChild(message);
    });
  }
}

$("chatForm").addEventListener("submit", async event => {
  event.preventDefault();
  const input = $("chatInput").value.trim();
  if (!input) return;

  addChatMessage("user", input);
  $("chatInput").value = "";

  const reply = localAssistantReply(input);
  addChatMessage("assistant", reply);
  await persist();
});

document.querySelectorAll("[data-prompt]").forEach(button => {
  button.addEventListener("click", () => {
    $("chatInput").value = button.dataset.prompt;
    $("chatForm").requestSubmit();
  });
});

$("clearChat").addEventListener("click", async () => {
  state.chat = [];
  await persist();
  renderChat();
  toast("Conversation cleared.");
});

/* ---------- Settings and data backup ---------- */

$("settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  state.settings.name = $("studentName").value.trim() || "Student";
  state.settings.theme = $("themeSelect").value;
  applyTheme();
  await commit("Settings saved.");
});

function applyTheme() {
  document.body.classList.toggle("light", state.settings.theme === "light");
}

$("exportData").addEventListener("click", () => {
  const data = {
    app: "StudyFlow",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: state
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `studyflow-backup-${todayKey()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  toast("Backup exported.");
});

$("importButton").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    if (file.size > 5 * 1024 * 1024) throw new Error("Backup must be smaller than 5 MB.");

    const parsed = JSON.parse(await file.text());
    const imported = parsed?.data || parsed;

    if (!imported || !Array.isArray(imported.tasks) || !Array.isArray(imported.exams)) {
      throw new Error("This file is not a valid StudyFlow backup.");
    }

    if (!confirm("Importing replaces the current planner data. Export your current data first if you need it. Continue?")) return;

    state = {
      ...defaultState(),
      ...imported,
      tasks: imported.tasks.map(t => ({
        id: String(t.id || uid()),
        title: String(t.title || "Untitled").slice(0, 120),
        subject: String(t.subject || "Other").slice(0, 60),
        description: String(t.description || "").slice(0, 1000),
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(t.deadline) ? t.deadline : todayKey(),
        minutes: Math.max(5, Math.min(10000, Number(t.minutes) || 60)),
        difficulty: ["Easy", "Medium", "Hard"].includes(t.difficulty) ? t.difficulty : "Medium",
        priority: ["Low", "Medium", "High"].includes(t.priority) ? t.priority : "Medium",
        completed: Boolean(t.completed),
        createdAt: t.createdAt || new Date().toISOString(),
        completedAt: t.completedAt || null
      })),
      exams: imported.exams.map(e => ({
        id: String(e.id || uid()),
        name: String(e.name || "Exam").slice(0, 100),
        subject: String(e.subject || "Other").slice(0, 60),
        date: /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : todayKey(),
        chapters: Array.isArray(e.chapters) ? e.chapters.map(c => ({
          name: String(c.name || "Chapter").slice(0, 200),
          done: Boolean(c.done)
        })).slice(0, 500) : []
      })),
      chat: Array.isArray(imported.chat) ? imported.chat.slice(-100).map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        message: String(m.message || "").slice(0, 5000)
      })) : []
    };

    await persist();
    applyTheme();
    renderAll();
    toast("Backup imported.");
  } catch (error) {
    alert(`Import failed: ${error.message}`);
  } finally {
    event.target.value = "";
  }
});

$("clearData").addEventListener("click", async () => {
  if (!confirm("Delete ALL homework, exams, routines, and settings? Export a backup first if needed.")) return;
  if (!confirm("This cannot be undone. Are you absolutely sure?")) return;

  state = defaultState();
  await persist();
  applyTheme();
  renderAll();
  goTo("dashboard");
  toast("Planner data cleared.");
});

/* ---------- App initialization ---------- */

function renderAll() {
  renderDashboard();
  renderHomework();
  renderExams();
  renderProgress();
  renderCalendar();
  renderRoutine();
  renderChat();

  $("studentName").value = state.settings.name || "Student";
  $("themeSelect").value = state.settings.theme || "dark";
  $("profileButton").textContent = (state.settings.name || "S").trim().charAt(0).toUpperCase() || "S";
  $("year").textContent = new Date().getFullYear();
}

async function initialize() {
  const saved = await readSavedState();
  if (saved && typeof saved === "object") {
    state = {
      ...defaultState(),
      ...saved,
      routine: { ...defaultState().routine, ...(saved.routine || {}) },
      settings: { ...defaultState().settings, ...(saved.settings || {}) },
      tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
      exams: Array.isArray(saved.exams) ? saved.exams : [],
      chat: Array.isArray(saved.chat) ? saved.chat : []
    };
  }

  applyTheme();
  renderAll();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./service-worker.js").catch(error => {
      console.warn("Offline support could not be enabled:", error);
    });
  }
}

initialize();
