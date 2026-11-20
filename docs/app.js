"use strict";

// ============================================================
// Aufgaben-App (Modul 1 des Alltags-Systems)
// Reines JavaScript, kein Build-Schritt. Daten liegen in Supabase.
// ============================================================

const sb = window.supabase.createClient(window.APP_CONFIG.url, window.APP_CONFIG.key);

const PRIORITIES = [
  { value: 0, label: "Normal" },
  { value: 1, label: "Hoch" },
  { value: 2, label: "Dringend" },
];

// ---------- Kleine Helfer ----------

const root = document.getElementById("app");

// Baut ein Element. Texte werden immer als Text eingefügt (nie als HTML) -> kein Einschleusen von Code.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const CHECK_SVG = () => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M5 12.5l4.5 4.5L19 7.5");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "3");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
};

// Hinweis unten. Als "popover" liegt er in der obersten Ebene und bleibt auch über geöffneten Dialogen sichtbar.
let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "show" + (isError ? " error" : "");
  try { if (el.showPopover && !el.matches(":popover-open")) el.showPopover(); } catch { /* ältere Browser */ }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "";
    try { if (el.hidePopover && el.matches(":popover-open")) el.hidePopover(); } catch { /* ältere Browser */ }
  }, isError ? 5000 : 2200);
}

// ---------- Datum (nur Datum, ohne Uhrzeit; immer Ortszeit) ----------
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
// "Diese Woche" = der kommende Sonntag (Woche beginnt am Montag).
const endOfWeek = () => { const t = startOfToday(); return addDays(t, 6 - ((t.getDay() + 6) % 7)); };

function dueOptions() {
  const t = startOfToday();
  const opts = [
    { label: "Heute", value: iso(t) },
    { label: "Morgen", value: iso(addDays(t, 1)) },
  ];
  const ew = endOfWeek();
  if (ew > addDays(t, 1)) opts.push({ label: "Diese Woche", value: iso(ew) });
  return opts;
}

function dueLabel(str) {
  const d = parseISO(str);
  const diff = Math.round((d - startOfToday()) / 86400000);
  if (diff === 0) return "Heute";
  if (diff === 1) return "Morgen";
  if (diff === -1) return "Gestern";
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat("de-DE", { weekday: "long" }).format(d);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" }).format(d);
}

// ---------- Zustand ----------
let areas = [];
let openTasks = [];
let doneTasks = [];
let view = { type: "open", areaId: null }; // open | today | done | area
let appMounted = false;
let ui = {};          // Verweise auf Bereiche der Oberfläche
let addFields = null; // Eingabefelder des "Neue Aufgabe"-Formulars

const areaName = (id) => areas.find((a) => a.id === id)?.name ?? "?";
const openCount = (pred) => openTasks.filter(pred).length;

function compareOpen(a, b) {
  if (a.due_date !== b.due_date) {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.created_at < b.created_at ? 1 : -1;
}

function visibleTasks() {
  const today = iso(startOfToday());
  switch (view.type) {
    case "done": return [...doneTasks];
    case "today": return openTasks.filter((t) => t.due_date && t.due_date <= today).sort(compareOpen);
    case "area": return openTasks.filter((t) => t.area_id === view.areaId).sort(compareOpen);
    default: return [...openTasks].sort(compareOpen);
  }
}

// Ersetzt eine Aufgabe im lokalen Zustand (offen/erledigt je nach Status).
function applyTask(row) {
  openTasks = openTasks.filter((t) => t.id !== row.id);
  doneTasks = doneTasks.filter((t) => t.id !== row.id);
  if (row.status === "done") {
    doneTasks.push(row);
    doneTasks.sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1));
  } else {
    openTasks.push(row);
  }
}

// ---------- Daten laden und speichern ----------
async function load() {
  const [a, o, d] = await Promise.all([
    sb.from("areas").select("*").order("sort_order").order("name"),
    sb.from("tasks").select("*").eq("status", "open"),
    sb.from("tasks").select("*").eq("status", "done").order("completed_at", { ascending: false }).limit(100),
  ]);
  const err = a.error || o.error || d.error;
  if (err) {
    toast("Laden fehlgeschlagen: " + err.message, true);
    return;
  }
  areas = a.data;
  openTasks = o.data;
  doneTasks = d.data;
  if (view.type === "area" && !areas.some((x) => x.id === view.areaId)) view = { type: "open", areaId: null };
  render();
}

async function createTask(values) {
  const { data, error } = await sb.from("tasks").insert(values).select().single();
  if (error) throw error;
  applyTask(data);
  render();
}

async function updateTask(id, patch) {
  const { data, error } = await sb.from("tasks").update(patch).eq("id", id).select().single();
  if (error) throw error;
  applyTask(data);
  render();
}

async function deleteTask(id) {
  const { error } = await sb.from("tasks").delete().eq("id", id);
  if (error) throw error;
  openTasks = openTasks.filter((t) => t.id !== id);
  doneTasks = doneTasks.filter((t) => t.id !== id);
  render();
}

async function toggleDone(task) {
  const next = task.status === "done" ? "open" : "done";
  const before = { ...task };
  applyTask({ ...task, status: next, completed_at: next === "done" ? new Date().toISOString() : null });
  render();
  const { data, error } = await sb.from("tasks").update({ status: next }).eq("id", task.id).select().single();
  if (error) {
    applyTask(before);
    render();
    toast("Nicht gespeichert: " + error.message, true);
    return;
  }
  applyTask(data);
  render();
}

// ---------- Eingabefelder für Aufgaben (Formular und Bearbeiten-Dialog) ----------
function taskFields(init, { onChange, onSubmit }) {
  const s = {
    areaId: init.area_id ?? null,
    due: init.due_date ?? null,
    priority: init.priority ?? 0,
  };
  const input = h("input", {
    type: "text", class: "text-input", placeholder: "Neue Aufgabe …", value: init.title ?? "",
    maxlength: 500, enterkeyhint: "done", autocomplete: "off", "aria-label": "Aufgabentext",
    onInput: () => onChange?.(),
    onKeydown: (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); onSubmit?.(); } },
  });
  const areaBox = h("div", { class: "chips", role: "group", "aria-label": "Area" });
  const dueBox = h("div", { class: "chips", role: "group", "aria-label": "Fällig" });
  const prioBox = h("div", { class: "chips", role: "group", "aria-label": "Dringlichkeit" });

  // Wählt etwas aus und regelt den Fokus: Maus am Mac -> zurück ins Textfeld (dann genügt Enter),
  // Touch -> Tastatur bleibt zu, Tastaturbedienung -> Fokus bleibt auf dem gewählten Button.
  const choose = (apply, box, index) => (e) => {
    apply();
    paint();
    onChange?.();
    if (e.detail === 0) box.children[index]?.focus();
    else if (window.matchMedia("(pointer: fine)").matches) input.focus();
  };

  function paint() {
    if (s.areaId && !areas.some((a) => a.id === s.areaId)) s.areaId = null;

    areaBox.replaceChildren(...areas.map((a, i) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(s.areaId === a.id),
      onClick: choose(() => { s.areaId = a.id; }, areaBox, i),
    }, a.name)));

    const opts = dueOptions();
    const quick = opts.map((o, i) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(s.due === o.value),
      onClick: choose(() => { s.due = s.due === o.value ? null : o.value; }, dueBox, i),
    }, o.label));
    const custom = s.due && !opts.some((o) => o.value === s.due);
    const dateInput = h("input", {
      type: "date", value: s.due ?? "", "aria-label": "Datum wählen",
      onChange: (e) => { s.due = e.target.value || null; paint(); onChange?.(); },
    });
    quick.push(h("label", { class: "chip", "aria-pressed": String(!!custom) },
      custom ? dueLabel(s.due) : "Datum wählen …", dateInput));
    dueBox.replaceChildren(...quick);

    prioBox.replaceChildren(...PRIORITIES.map((p, i) => h("button", {
      type: "button", class: "chip prio-" + p.value, "aria-pressed": String(s.priority === p.value),
      onClick: choose(() => { s.priority = p.value; }, prioBox, i),
    }, p.label)));
  }
  paint();

  const el = h("div", {},
    input,
    h("span", { class: "label" }, "Area (Pflicht)"), areaBox,
    h("span", { class: "label" }, "Fällig"), dueBox,
    h("span", { class: "label" }, "Dringlichkeit"), prioBox);

  return {
    el, input, repaint: paint,
    isValid: () => input.value.trim() !== "" && !!s.areaId,
    values: () => ({ title: input.value.trim(), area_id: s.areaId, due_date: s.due, priority: s.priority }),
  };
}

// Button, der erst beim zweiten Klick wirklich auslöst (Schutz vor Versehen).
function confirmButton(label, armedLabel, action, extraClass = "") {
  let armed = false;
  let timer;
  const btn = h("button", {
    type: "button", class: "btn danger " + extraClass,
    onClick: async () => {
      if (!armed) {
        armed = true;
        btn.textContent = armedLabel;
        btn.classList.add("armed");
        timer = setTimeout(() => { armed = false; btn.textContent = label; btn.classList.remove("armed"); }, 3500);
        return;
      }
      clearTimeout(timer);
      await action();
    },
  }, label);
  return btn;
}

// ---------- Oberfläche ----------
function render() {
  if (!appMounted) return;
  const today = iso(startOfToday());

  // Filterleiste
  const chips = [
    { key: "open", label: "Offen", count: openTasks.length, active: view.type === "open", go: { type: "open" } },
    { key: "today", label: "Heute", count: openCount((t) => t.due_date && t.due_date <= today), active: view.type === "today", go: { type: "today" } },
    ...areas.map((a) => ({
      key: a.id, label: a.name, count: openCount((t) => t.area_id === a.id),
      active: view.type === "area" && view.areaId === a.id, go: { type: "area", areaId: a.id },
    })),
    { key: "done", label: "Erledigt", count: null, active: view.type === "done", go: { type: "done" } },
  ];
  ui.filters.replaceChildren(...chips.map((c) => h("button", {
    type: "button", class: "chip", "aria-pressed": String(c.active),
    onClick: () => { view = c.go; render(); },
  }, c.label, c.count ? h("span", { class: "count" }, String(c.count)) : null)));

  // Formular nur zeigen, wenn es Areas gibt
  const hasAreas = areas.length > 0;
  ui.addCard.hidden = !hasAreas;
  addFields.repaint();
  ui.updateSave();

  // Liste
  const tasks = visibleTasks();
  if (!hasAreas) {
    ui.list.replaceChildren(h("li", { class: "empty" },
      h("p", {}, "Lege zuerst deine erste Area an, zum Beispiel „Beruf“, „Gesundheit“ oder „Haushalt“."),
      h("button", { type: "button", class: "btn primary", onClick: openAreasDialog }, "Areas verwalten")));
    return;
  }
  if (!tasks.length) {
    ui.list.replaceChildren(h("li", { class: "empty" },
      view.type === "done" ? "Noch nichts erledigt." : "Keine offenen Aufgaben. 🎉"));
    return;
  }
  ui.list.replaceChildren(...tasks.map(taskRow));
}

function taskRow(task) {
  const overdue = task.status === "open" && task.due_date && task.due_date < iso(startOfToday());
  const meta = [h("span", { class: "badge" }, areaName(task.area_id))];
  if (task.due_date) meta.push(h("span", { class: "badge" + (overdue ? " overdue" : "") }, (overdue ? "Überfällig · " : "") + dueLabel(task.due_date)));
  if (task.priority > 0) meta.push(h("span", { class: "badge prio-" + task.priority }, PRIORITIES[task.priority].label));

  return h("li", { class: `task prio-${task.priority}` + (task.status === "done" ? " done" : "") },
    h("button", {
      type: "button", class: "check", "aria-pressed": String(task.status === "done"),
      "aria-label": task.status === "done" ? "Wieder öffnen" : "Erledigt",
      onClick: () => toggleDone(task),
    }, CHECK_SVG()),
    h("button", { type: "button", class: "body", onClick: () => openEditDialog(task) },
      h("span", { class: "title" }, task.title),
      h("span", { class: "meta" }, meta)));
}

// ---------- Dialog: Aufgabe bearbeiten ----------
function openEditDialog(task) {
  const dlg = h("dialog");
  const fields = taskFields(task, { onChange: updateSave, onSubmit: save });
  const saveBtn = h("button", { type: "submit", class: "btn primary" }, "Speichern");
  function updateSave() { saveBtn.disabled = !fields.isValid(); }

  async function save() {
    if (!fields.isValid()) return;
    saveBtn.disabled = true;
    try {
      await updateTask(task.id, fields.values());
      dlg.close();
    } catch (e) {
      toast("Nicht gespeichert: " + e.message, true);
      updateSave();
    }
  }

  const del = confirmButton("Löschen", "Wirklich löschen?", async () => {
    try { await deleteTask(task.id); dlg.close(); } catch (e) { toast("Nicht gelöscht: " + e.message, true); }
  });

  dlg.append(h("form", { class: "sheet", onSubmit: (e) => { e.preventDefault(); save(); } },
    h("h2", {}, "Aufgabe bearbeiten"),
    fields.el,
    h("div", { class: "row-actions" }, del,
      h("div", { class: "right" },
        h("button", { type: "button", class: "btn", onClick: () => dlg.close() }, "Abbrechen"), saveBtn))));
  showDialog(dlg);
  updateSave();
}

// ---------- Dialog: Areas verwalten ----------
function openAreasDialog() {
  const dlg = h("dialog");
  const body = h("div", { class: "sheet" });
  dlg.append(body);

  async function run(fn, failText) {
    try { await fn(); } catch (e) { toast(failText + e.message, true); await load(); }
    draw();
  }

  async function move(index, delta) {
    const order = [...areas];
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    await run(async () => {
      const changes = order.map((a, i) => ({ a, i })).filter(({ a, i }) => a.sort_order !== i);
      for (const { a, i } of changes) {
        const { error } = await sb.from("areas").update({ sort_order: i }).eq("id", a.id);
        if (error) throw error;
      }
      await load();
    }, "Reihenfolge nicht gespeichert: ");
  }

  async function rename(area, input) {
    const name = input.value.trim();
    if (!name || name === area.name) { input.value = area.name; return; }
    await run(async () => {
      const { error } = await sb.from("areas").update({ name }).eq("id", area.id);
      if (error) throw error;
      await load();
      toast("Umbenannt");
    }, "Nicht umbenannt: ");
  }

  async function remove(area) {
    const { error } = await sb.from("areas").delete().eq("id", area.id);
    if (error) {
      if (error.code === "23503") toast("Diese Area enthält noch Aufgaben (auch erledigte). Verschiebe oder lösche sie zuerst.", true);
      else toast("Nicht gelöscht: " + error.message, true);
      return;
    }
    await load();
    draw();
  }

  function draw() {
    const newName = h("input", { type: "text", class: "field", placeholder: "Neue Area, z. B. Haushalt", maxlength: 80, "aria-label": "Name der neuen Area", autocomplete: "off" });
    const addForm = h("form", {
      class: "area-row",
      onSubmit: (e) => {
        e.preventDefault();
        const name = newName.value.trim();
        if (!name) return;
        const sort_order = areas.reduce((m, a) => Math.max(m, a.sort_order), -1) + 1;
        run(async () => {
          const { error } = await sb.from("areas").insert({ name, sort_order });
          if (error) throw error;
          await load();
        }, "Nicht angelegt: ");
      },
    }, newName, h("button", { type: "submit", class: "btn primary" }, "Anlegen"));

    body.replaceChildren(
      h("h2", {}, "Areas verwalten"),
      ...areas.map((a, i) => {
        const input = h("input", {
          type: "text", class: "field", value: a.name, maxlength: 80, "aria-label": "Name der Area",
          onChange: () => rename(a, input),
        });
        return h("div", { class: "area-row" }, input,
          h("div", { class: "tools" },
            h("button", { type: "button", class: "btn small", "aria-label": "Nach oben", disabled: i === 0, onClick: () => move(i, -1) }, "↑"),
            h("button", { type: "button", class: "btn small", "aria-label": "Nach unten", disabled: i === areas.length - 1, onClick: () => move(i, 1) }, "↓"),
            confirmButton("Löschen", "Sicher?", () => remove(a), "small")));
      }),
      addForm,
      h("div", { class: "row-actions" }, h("span"),
        h("button", { type: "button", class: "btn", onClick: () => dlg.close() }, "Fertig")));
  }

  draw();
  showDialog(dlg, { focusDialog: true });
}

// focusDialog: Fokus auf den Dialog selbst statt auf das erste Textfeld (verhindert, dass am Handy sofort die Tastatur aufgeht).
function showDialog(dlg, { focusDialog = false } = {}) {
  document.body.append(dlg);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => dlg.remove());
  if (focusDialog) dlg.tabIndex = -1;
  dlg.showModal();
  if (focusDialog) dlg.focus();
}

// ---------- Hauptansicht ----------
function showApp() {
  appMounted = true;
  const form = h("form", { class: "card add", onSubmit: (e) => { e.preventDefault(); saveNew(); } });
  const saveBtn = h("button", { type: "submit", class: "btn primary" }, "Hinzufügen");

  addFields = taskFields({}, { onChange: updateSave, onSubmit: saveNew });
  function updateSave() { saveBtn.disabled = !addFields.isValid(); }

  async function saveNew() {
    if (!addFields.isValid()) return;
    saveBtn.disabled = true;
    try {
      await createTask(addFields.values());
      addFields = taskFields({}, { onChange: updateSave, onSubmit: saveNew });
      form.replaceChildren(addFields.el, h("div", { class: "actions" }, saveBtn));
      addFields.input.focus();
      toast("Gespeichert");
    } catch (e) {
      toast("Nicht gespeichert: " + e.message, true);
    }
    updateSave();
  }

  form.append(addFields.el, h("div", { class: "actions" }, saveBtn));

  ui = {
    filters: h("nav", { class: "filters", "aria-label": "Ansicht" }),
    list: h("ul", { class: "list" }),
    addCard: form,
    updateSave,
  };

  root.replaceChildren(h("div", { class: "wrap" },
    h("header", { class: "topbar" },
      h("h1", {}, "Aufgaben"),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn", onClick: openAreasDialog }, "Areas"),
        h("button", { type: "button", class: "btn", onClick: () => sb.auth.signOut() }, "Abmelden"))),
    form, ui.filters, ui.list));

  updateSave();
  load();
}

// ---------- Anmeldung ----------
function showLogin() {
  appMounted = false;
  areas = []; openTasks = []; doneTasks = [];
  const err = h("p", { class: "error", role: "alert" });
  const email = h("input", { type: "email", class: "field", required: true, autocomplete: "username", placeholder: "E-Mail", "aria-label": "E-Mail" });
  const pass = h("input", { type: "password", class: "field", required: true, autocomplete: "current-password", placeholder: "Passwort", "aria-label": "Passwort" });
  const btn = h("button", { type: "submit", class: "btn primary" }, "Anmelden");

  root.replaceChildren(h("div", { class: "wrap" }, h("div", { class: "login" },
    h("h1", {}, "Aufgaben"), h("p", {}, "Bitte anmelden."),
    h("form", {
      onSubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.textContent = "";
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        btn.disabled = false;
        if (error) { err.textContent = "E-Mail oder Passwort stimmt nicht."; return; }
        if (!appMounted) showApp();
      },
    }, email, pass, err, btn))));
}

// ---------- Start ----------
async function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  const { data } = await sb.auth.getSession();
  if (data.session) showApp(); else showLogin();

  // Hinweis: Hier keine Supabase-Aufrufe direkt ausführen (Verklemmungsgefahr), daher setTimeout.
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") setTimeout(showLogin, 0);
    else if (session && !appMounted) setTimeout(showApp, 0);
  });

  // Beim Zurückkehren in die App frisch laden, damit Mac und Handy synchron bleiben.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && appMounted) load(); });
  window.addEventListener("online", () => { if (appMounted) load(); });
}

start();
