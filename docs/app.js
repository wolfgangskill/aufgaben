"use strict";

// ============================================================
// Aufgaben-App (Modul 1 des Alltags-Systems)
// Reines JavaScript, kein Build-Schritt. Daten liegen in Supabase.
// ============================================================

const sb = window.supabase.createClient(window.APP_CONFIG.url, window.APP_CONFIG.key);

// Nur diese Spalten laden (die Suchspalte "search" wird nicht mit übertragen).
const TASK_COLS = "id, area_id, title, status, due_date, priority, completed_at, created_at, updated_at";
const NOTE_COLS = "id, area_id, body, pinned_at, created_at, updated_at";
// Mit eingebetteten Tag-Verknüpfungen (ein Aufruf liefert Eintrag und seine Tags).
const TASK_SEL = TASK_COLS + ", task_tags(tag_id)";
const NOTE_SEL = NOTE_COLS + ", note_tags(tag_id)";
// Aus der Antwort der Datenbank wird ein Eintrag mit einfacher Liste tag_ids.
const normTask = ({ task_tags, ...r }) => ({ ...r, tag_ids: (task_tags ?? []).map((x) => x.tag_id) });
const normNote = ({ note_tags, ...r }) => ({ ...r, tag_ids: (note_tags ?? []).map((x) => x.tag_id) });

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

// Notizen
let notes = [];
let notesError = null;            // Meldung, falls die Tabelle "notes" nicht erreichbar ist
let page = "tasks";               // tasks | notes
let noteView = { areaId: null };  // null = alle Areas

// Tags
let tags = [];                    // [{ id, name }], nach Name sortiert
let tagsError = null;
const sortTags = () => tags.sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
const tagLabel = (id) => "#" + (tags.find((t) => t.id === id)?.name ?? "?");

// Suche
let searchQuery = "";
let searchResults = [];
let searchPending = false;
let searchSeq = 0;
let searchTimer;
const isSearching = () => searchQuery.length >= 2;
try { if (localStorage.getItem("page") === "notes") page = "notes"; } catch { /* ohne Speicher weiter */ }

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
  const [a, o, d, nt, tg] = await Promise.all([
    sb.from("areas").select("*").order("sort_order").order("name"),
    sb.from("tasks").select(TASK_SEL).eq("status", "open"),
    sb.from("tasks").select(TASK_SEL).eq("status", "done").order("completed_at", { ascending: false }).limit(100),
    sb.from("notes").select(NOTE_SEL).order("updated_at", { ascending: false }).limit(500),
    sb.from("tags").select("id, name"),
  ]);
  const err = a.error || o.error || d.error;
  if (err) {
    toast("Laden fehlgeschlagen: " + err.message, true);
    return;
  }
  areas = a.data;
  openTasks = o.data.map(normTask);
  doneTasks = d.data.map(normTask);
  // Notizen und Tags getrennt behandeln: Fehlen die Tabellen, sollen die Aufgaben trotzdem funktionieren.
  notesError = nt.error ? nt.error.message : null;
  notes = nt.error ? [] : nt.data.map(normNote).sort(compareNotes);
  tagsError = tg.error ? tg.error.message : null;
  tags = tg.error ? [] : tg.data;
  sortTags();
  if (view.type === "area" && !areas.some((x) => x.id === view.areaId)) view = { type: "open", areaId: null };
  render();
}

// ---------- Tags: anlegen, auflösen, mit Einträgen verknüpfen ----------
// Liefert den Tag mit diesem Namen (ohne Unterschied zwischen Groß und Klein); legt ihn an, falls er fehlt.
async function ensureTag(name) {
  const find = () => tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
  let t = find();
  if (t) return t;
  const { data, error } = await sb.from("tags").insert({ name }).select("id, name").single();
  if (error) {
    if (error.code === "23505") { // gibt es schon (z. B. auf einem anderen Gerät angelegt)
      const r = await sb.from("tags").select("id, name");
      if (!r.error) { tags = r.data; sortTags(); t = find(); if (t) return t; }
    }
    throw error;
  }
  tags.push(data);
  sortTags();
  return data;
}

// Auswahl aus dem Tag-Feld (bestehende ids plus neue Namen) in eine Liste von ids umwandeln.
async function resolveTags(sel) {
  const ids = new Set(sel.ids);
  for (const name of sel.fresh) ids.add((await ensureTag(name)).id);
  return [...ids];
}

// Gleicht die Verknüpfungen eines Eintrags mit der neuen Auswahl ab (nur Unterschiede werden geschrieben).
async function syncTags(kind, itemId, newIds, oldIds) {
  const table = kind === "task" ? "task_tags" : "note_tags";
  const col = kind === "task" ? "task_id" : "note_id";
  const add = newIds.filter((x) => !oldIds.includes(x));
  const del = oldIds.filter((x) => !newIds.includes(x));
  if (add.length) {
    const { error } = await sb.from(table).insert(add.map((tag_id) => ({ [col]: itemId, tag_id })));
    if (error) throw error;
  }
  if (del.length) {
    const { error } = await sb.from(table).delete().eq(col, itemId).in("tag_id", del);
    if (error) throw error;
  }
}

async function createTask(values, tagSel) {
  const { data, error } = await sb.from("tasks").insert(values).select(TASK_COLS).single();
  if (error) throw error;
  let ids = [];
  try {
    ids = await resolveTags(tagSel);
    await syncTags("task", data.id, ids, []);
  } catch (e) {
    applyTask({ ...data, tag_ids: [] }); render();
    throw new Error("Aufgabe gespeichert, aber Tags nicht: " + e.message);
  }
  applyTask({ ...data, tag_ids: ids });
  render();
}

async function updateTask(id, patch, tagSel) {
  const old = [...openTasks, ...doneTasks].find((t) => t.id === id);
  const { data, error } = await sb.from("tasks").update(patch).eq("id", id).select(TASK_COLS).single();
  if (error) throw error;
  let ids = old?.tag_ids ?? [];
  if (tagSel) {
    try {
      const wanted = await resolveTags(tagSel);
      await syncTags("task", id, wanted, ids);
      ids = wanted;
    } catch (e) {
      applyTask({ ...data, tag_ids: ids }); render();
      throw new Error("Änderung gespeichert, aber Tags nicht: " + e.message);
    }
  }
  applyTask({ ...data, tag_ids: ids });
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
  const { data, error } = await sb.from("tasks").update({ status: next }).eq("id", task.id).select(TASK_COLS).single();
  if (error) {
    applyTask(before);
    render();
    toast("Nicht gespeichert: " + error.message, true);
    return;
  }
  applyTask({ ...data, tag_ids: task.tag_ids ?? [] });
  render();
}

// ---------- Tag-Auswahl (für Aufgaben und Notizen) ----------
// Bestehende Tags antippen = ein/aus. Neuer Tag: Namen tippen, Enter oder Komma. Neue Tags werden erst beim Speichern angelegt.
function tagPicker(initIds, onChange) {
  const sel = new Set(initIds ?? []);
  const fresh = [];
  const box = h("div", { class: "chips", role: "group", "aria-label": "Tags" });
  const input = h("input", {
    type: "text", class: "tag-input", placeholder: "Neuer Tag …", maxlength: 40, autocomplete: "off",
    "aria-label": "Neuen Tag hinzufügen", enterkeyhint: "done",
    onKeydown: (e) => {
      if ((e.key === "Enter" || e.key === ",") && !e.isComposing) { e.preventDefault(); e.stopPropagation(); addFresh(); }
    },
  });

  function addFresh() {
    const name = input.value.replace(/,/g, "").trim().replace(/^#+/, "");
    input.value = "";
    if (!name) return;
    const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) sel.add(existing.id);
    else if (!fresh.some((f) => f.toLowerCase() === name.toLowerCase())) fresh.push(name);
    paint();
    onChange?.();
  }

  function paint() {
    for (const id of [...sel]) if (!tags.some((t) => t.id === id)) sel.delete(id);
    box.replaceChildren(
      ...tags.map((t) => h("button", {
        type: "button", class: "chip tagchip", "aria-pressed": String(sel.has(t.id)),
        onClick: () => { if (sel.has(t.id)) sel.delete(t.id); else sel.add(t.id); paint(); onChange?.(); },
      }, "#" + t.name)),
      ...fresh.map((n, i) => h("button", {
        type: "button", class: "chip tagchip", "aria-pressed": "true", title: "Neuer Tag, wird beim Speichern angelegt",
        onClick: () => { fresh.splice(i, 1); paint(); onChange?.(); },
      }, "#" + n + " (neu)")),
      input);
  }
  paint();

  return {
    el: box, repaint: paint,
    // Auswahl für das Speichern; ein noch nicht mit Enter bestätigter Text im Feld zählt mit.
    selection: () => {
      addFresh();
      return { ids: [...sel], fresh: [...fresh] };
    },
  };
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
    picker?.repaint();
  }
  const picker = tagPicker(init.tag_ids, onChange);
  paint();

  const el = h("div", {},
    input,
    h("span", { class: "label" }, "Area (Pflicht)"), areaBox,
    h("span", { class: "label" }, "Fällig"), dueBox,
    h("span", { class: "label" }, "Dringlichkeit"), prioBox,
    h("span", { class: "label" }, "Tags"), picker.el);

  return {
    el, input, repaint: paint,
    isValid: () => input.value.trim() !== "" && !!s.areaId,
    values: () => ({ title: input.value.trim(), area_id: s.areaId, due_date: s.due, priority: s.priority }),
    tagSel: () => picker.selection(),
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
  renderTabs();
  renderTasks();
  renderNotes();
  if (isSearching()) runSearch(); // Trefferliste nach Änderungen auffrischen
}

function renderTasks() {
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

// Tag-Etikett in Listen: Antippen sucht nach allem mit diesem Tag. Es ist ein span (kein button), weil es in einem button steht.
function tagBadge(label) {
  const go = (e) => { e.stopPropagation(); e.preventDefault(); searchByTag(label.replace(/^#/, "")); };
  return h("span", {
    class: "badge tag", role: "button", tabindex: "0", title: "Alles mit diesem Tag zeigen",
    onClick: go, onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") go(e); },
  }, label);
}

function searchByTag(name) {
  ui.search.input.value = "#" + name;
  runSearch();
  window.scrollTo({ top: 0 });
}

function taskRow(task) {
  const overdue = task.status === "open" && task.due_date && task.due_date < iso(startOfToday());
  const meta = [h("span", { class: "badge" }, areaName(task.area_id))];
  if (task.due_date) meta.push(h("span", { class: "badge" + (overdue ? " overdue" : "") }, (overdue ? "Überfällig · " : "") + dueLabel(task.due_date)));
  if (task.priority > 0) meta.push(h("span", { class: "badge prio-" + task.priority }, PRIORITIES[task.priority].label));
  for (const id of task.tag_ids ?? []) meta.push(tagBadge(tagLabel(id)));

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
      await updateTask(task.id, fields.values(), fields.tagSel());
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

// ---------- Dialog: Tags verwalten (umbenennen, löschen) ----------
function openTagsDialog() {
  const dlg = h("dialog");
  const body = h("div", { class: "sheet" });
  dlg.append(body);
  // Anzahl der Einträge je Tag (nur geladene Einträge; sehr alte erledigte Aufgaben können fehlen)
  const uses = (id) => [...openTasks, ...doneTasks, ...notes].filter((x) => (x.tag_ids ?? []).includes(id)).length;

  async function rename(tag, input) {
    const name = input.value.trim().replace(/^#+/, "");
    if (!name || name === tag.name) { input.value = tag.name; return; }
    const { error } = await sb.from("tags").update({ name }).eq("id", tag.id);
    if (error) {
      toast(error.code === "23505" ? "Diesen Tag gibt es schon." : "Nicht umbenannt: " + error.message, true);
      input.value = tag.name;
      return;
    }
    tag.name = name;
    sortTags();
    toast("Umbenannt");
    render();
    draw();
  }

  async function remove(tag) {
    const { error } = await sb.from("tags").delete().eq("id", tag.id); // Verknüpfungen verschwinden mit
    if (error) { toast("Nicht gelöscht: " + error.message, true); return; }
    tags = tags.filter((t) => t.id !== tag.id);
    for (const x of [...openTasks, ...doneTasks, ...notes]) x.tag_ids = (x.tag_ids ?? []).filter((id) => id !== tag.id);
    render();
    draw();
  }

  function draw() {
    body.replaceChildren(...[
      h("h2", {}, "Tags verwalten"),
      tagsError ? h("p", { class: "hint" }, "Tags sind noch nicht eingerichtet: " + tagsError) : null,
      !tags.length && !tagsError ? h("p", { class: "hint" }, "Noch keine Tags. Du legst sie beim Schreiben einer Aufgabe oder Notiz an.") : null,
      ...tags.map((t) => {
        const input = h("input", {
          type: "text", class: "field", value: t.name, maxlength: 40, "aria-label": "Name des Tags",
          onChange: () => rename(t, input),
        });
        return h("div", { class: "area-row" }, input,
          h("div", { class: "tools" },
            h("span", { class: "hint uses", title: "Verwendet in so vielen Einträgen" }, uses(t.id) + "×"),
            confirmButton("Löschen", "Sicher?", () => remove(t), "small")));
      }),
      h("p", { class: "hint" }, "Löschen entfernt den Tag nur von den Einträgen, die Einträge selbst bleiben."),
      h("div", { class: "row-actions" }, h("span"),
        h("button", { type: "button", class: "btn", onClick: () => dlg.close() }, "Fertig")),
    ].filter(Boolean));
  }

  draw();
  showDialog(dlg, { focusDialog: true });
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
      if (error.code === "23503") toast("Diese Area enthält noch Aufgaben oder Notizen (auch erledigte Aufgaben). Verschiebe oder lösche sie zuerst.", true);
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

// ---------- Notizen ----------

// Ersetzt eine Notiz im lokalen Zustand, zuletzt bearbeitete zuerst.
// Reihenfolge: angeheftete zuerst (zuletzt angeheftete oben), danach nach letzter Bearbeitung.
function compareNotes(a, b) {
  if (!!a.pinned_at !== !!b.pinned_at) return a.pinned_at ? -1 : 1;
  if (a.pinned_at) return a.pinned_at < b.pinned_at ? 1 : -1;
  return a.updated_at < b.updated_at ? 1 : -1;
}

function applyNote(row) {
  notes = notes.filter((n) => n.id !== row.id);
  notes.push(row);
  notes.sort(compareNotes);
}

const PIN_PATH = "M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z";
function pinIcon(filled) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", PIN_PATH);
  p.setAttribute("fill", filled ? "currentColor" : "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "2");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
}

// Anheften / Lösen. Zählt nicht als Bearbeiten (updated_at bleibt, dafür sorgt die Datenbank).
async function togglePin(note) {
  const cur = notes.find((n) => n.id === note.id) ?? note;
  const before = { ...cur };
  const next = cur.pinned_at ? null : new Date().toISOString();
  applyNote({ ...cur, pinned_at: next });
  render();
  const { data, error } = await sb.from("notes").update({ pinned_at: next }).eq("id", cur.id).select(NOTE_COLS).single();
  if (error) {
    applyNote(before);
    render();
    toast("Nicht gespeichert: " + error.message, true);
    return;
  }
  applyNote({ ...data, tag_ids: cur.tag_ids ?? [] });
  render();
}

async function createNote(values, tagSel) {
  const { data, error } = await sb.from("notes").insert(values).select(NOTE_COLS).single();
  if (error) throw error;
  let ids = [];
  try {
    ids = await resolveTags(tagSel);
    await syncTags("note", data.id, ids, []);
  } catch (e) {
    applyNote({ ...data, tag_ids: [] }); render();
    throw new Error("Notiz gespeichert, aber Tags nicht: " + e.message);
  }
  applyNote({ ...data, tag_ids: ids });
  render();
}

async function updateNote(id, patch, tagSel) {
  const old = notes.find((n) => n.id === id);
  const { data, error } = await sb.from("notes").update(patch).eq("id", id).select(NOTE_COLS).single();
  if (error) throw error;
  let ids = old?.tag_ids ?? [];
  if (tagSel) {
    try {
      const wanted = await resolveTags(tagSel);
      await syncTags("note", id, wanted, ids);
      ids = wanted;
    } catch (e) {
      applyNote({ ...data, tag_ids: ids }); render();
      throw new Error("Änderung gespeichert, aber Tags nicht: " + e.message);
    }
  }
  applyNote({ ...data, tag_ids: ids });
  render();
}

async function deleteNote(id) {
  const { error } = await sb.from("notes").delete().eq("id", id);
  if (error) throw error;
  notes = notes.filter((n) => n.id !== id);
  render();
}

// Liste: erste Zeile = Überschrift, Rest = Auszug. Markdown-Zeichen werden dafür entfernt.
const plainLine = (l) => l.replace(/^\s*(#{1,3}\s+|[-*]\s+|\d+\.\s+)/, "").replace(/\*\*|\*/g, "").trim();
function noteTexts(body) {
  const lines = body.split("\n").map(plainLine).filter(Boolean);
  return { title: (lines[0] ?? "").slice(0, 120), excerpt: lines.slice(1).join(" · ").slice(0, 160) };
}

function shortWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(d);
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" }).format(d);
}

// --- Formatierung: eigener, sicherer Anzeiger für das kleine Markdown (kein HTML aus dem Text) ---
function inlineNodes(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(h("strong", {}, m[1]));
    } else if (m[2] !== undefined) {
      out.push(h("em", {}, m[2]));
    } else {
      const trail = (m[3].match(/[.,;:!?)\]]+$/) || [""])[0];
      const url = m[3].slice(0, m[3].length - trail.length);
      out.push(h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
      if (trail) out.push(trail);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(text) {
  const box = h("div", { class: "md" });
  let list = null; // { kind, el }
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = h("p", {});
    para.forEach((line, i) => {
      if (i) p.append(h("br"));
      p.append(...inlineNodes(line));
    });
    box.append(p);
    para = [];
  };
  const addItem = (kind, content) => {
    flushPara();
    if (!list || list.kind !== kind) {
      list = { kind, el: h(kind) };
      box.append(list.el);
    }
    list.el.append(h("li", {}, ...inlineNodes(content)));
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    let m;
    if (!line.trim()) { flushPara(); list = null; continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara(); list = null;
      box.append(h("h" + (m[1].length + 2), {}, ...inlineNodes(m[2])));
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      addItem("ul", m[1]);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      addItem("ol", m[1]);
    } else {
      list = null;
      para.push(line);
    }
  }
  flushPara();
  return box;
}

// --- Schreibhilfen für das Textfeld ---
function wrapSelection(ta, mark) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e) || "Text";
  ta.value = value.slice(0, s) + mark + sel + mark + value.slice(e);
  ta.selectionStart = s + mark.length;
  ta.selectionEnd = s + mark.length + sel.length;
  ta.focus();
  ta.dispatchEvent(new Event("input"));
}

function formatLines(ta, kind) {
  const spec = {
    bullet: { re: /^[-*]\s+/, make: () => "- " },
    number: { re: /^\d+\.\s+/, make: (i) => `${i + 1}. ` },
    heading: { re: /^#{1,3}\s+/, make: () => "# " },
  }[kind];
  const strip = (l) => l.replace(/^([-*]\s+|\d+\.\s+|#{1,3}\s+)/, "");
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const from = value.lastIndexOf("\n", s - 1) + 1;
  let to = value.indexOf("\n", e);
  if (to === -1) to = value.length;
  const lines = value.slice(from, to).split("\n");
  const allHave = lines.every((l) => spec.re.test(l));
  const out = lines.map((l, i) => (allHave ? strip(l) : spec.make(i) + strip(l))).join("\n");
  ta.value = value.slice(0, from) + out + value.slice(to);
  if (s === e) {
    // Nichts markiert: Cursor ans Ende der Zeile, damit man direkt weiterschreiben kann.
    ta.selectionStart = ta.selectionEnd = from + out.length;
  } else {
    ta.selectionStart = from;
    ta.selectionEnd = from + out.length;
  }
  ta.focus();
  ta.dispatchEvent(new Event("input"));
}

// Enter in einer Liste: nächster Punkt; Enter in leerem Punkt beendet die Liste.
function continueList(e, ta) {
  if (e.key !== "Enter" || e.isComposing || e.shiftKey || e.metaKey || e.ctrlKey) return;
  const { selectionStart: s, selectionEnd: en, value } = ta;
  if (s !== en) return;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const m = value.slice(lineStart, s).match(/^(\s*)([-*]|(\d+)\.)\s+(.*)$/);
  if (!m) return;
  e.preventDefault();
  if (!m[4].trim()) {
    ta.value = value.slice(0, lineStart) + value.slice(s);
    ta.selectionStart = ta.selectionEnd = lineStart;
  } else {
    const ins = "\n" + m[1] + (m[3] ? `${Number(m[3]) + 1}. ` : `${m[2]} `);
    ta.value = value.slice(0, s) + ins + value.slice(s);
    ta.selectionStart = ta.selectionEnd = s + ins.length;
  }
  ta.dispatchEvent(new Event("input"));
}

const autosize = (ta, max = 420) => {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight + 2, max) + "px";
};

function noteToolbar(ta) {
  const btn = (label, aria, fn, cls = "") => h("button", {
    type: "button", class: "btn small tool " + cls, "aria-label": aria, title: aria,
    onMousedown: (e) => e.preventDefault(), // Auswahl im Textfeld bleibt erhalten
    onClick: fn,
  }, label);
  return h("div", { class: "toolbar", role: "toolbar", "aria-label": "Formatierung" },
    btn("B", "Fett", () => wrapSelection(ta, "**"), "bold"),
    btn("I", "Kursiv", () => wrapSelection(ta, "*"), "italic"),
    btn("H", "Überschrift", () => formatLines(ta, "heading")),
    btn("• Liste", "Aufzählung", () => formatLines(ta, "bullet")),
    btn("1. Liste", "Nummerierte Liste", () => formatLines(ta, "number")));
}

// Eingabefelder für eine Notiz: Werkzeugleiste, Textfeld, Area (Pflicht)
function noteFields(init, { onChange, onSubmit, rows = 4 }) {
  const s = { areaId: init.area_id ?? null };
  const ta = h("textarea", {
    class: "text-input note-input", rows, placeholder: "Notiz …", maxlength: 20000, "aria-label": "Notiztext",
    onInput: () => { autosize(ta); onChange?.(); },
    onKeydown: (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit?.(); return; }
      continueList(e, ta);
    },
  });
  ta.value = init.body ?? "";
  const toolbar = noteToolbar(ta);
  const areaBox = h("div", { class: "chips", role: "group", "aria-label": "Area" });

  function paint() {
    if (s.areaId && !areas.some((a) => a.id === s.areaId)) s.areaId = null;
    areaBox.replaceChildren(...areas.map((a, i) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(s.areaId === a.id),
      onClick: (e) => {
        s.areaId = a.id;
        paint();
        onChange?.();
        if (e.detail === 0) areaBox.children[i]?.focus();
        else if (window.matchMedia("(pointer: fine)").matches) ta.focus();
      },
    }, a.name)));
    picker?.repaint();
  }
  const picker = tagPicker(init.tag_ids, onChange);
  paint();
  requestAnimationFrame(() => autosize(ta));

  return {
    el: h("div", {}, toolbar, ta,
      h("span", { class: "label" }, "Area (Pflicht)"), areaBox,
      h("span", { class: "label" }, "Tags"), picker.el),
    toolbar, textarea: ta, repaint: paint,
    isValid: () => ta.value.trim() !== "" && !!s.areaId,
    values: () => ({ body: ta.value.trim(), area_id: s.areaId }),
    tagSel: () => picker.selection(),
  };
}

function noteRow(note) {
  const { title, excerpt } = noteTexts(note.body);
  const pinned = !!note.pinned_at;
  return h("li", { class: "note" + (pinned ? " pinned" : "") },
    h("button", { type: "button", class: "body", onClick: () => openNoteDialog(note) },
      h("span", { class: "title" }, title || "(leer)"),
      excerpt ? h("span", { class: "excerpt" }, excerpt) : null,
      h("span", { class: "meta" },
        h("span", { class: "badge" }, areaName(note.area_id)),
        h("span", { class: "badge when" }, shortWhen(note.updated_at)),
        ...(note.tag_ids ?? []).map((id) => tagBadge(tagLabel(id))))),
    h("button", {
      type: "button", class: "pin", "aria-pressed": String(pinned),
      "aria-label": pinned ? "Lösen" : "Anheften", title: pinned ? "Lösen" : "Anheften",
      onClick: () => togglePin(note),
    }, pinIcon(pinned)));
}

function openNoteDialog(note) {
  const dlg = h("dialog");
  const fields = noteFields(note, { onChange: updateSave, onSubmit: save, rows: 10 });
  const preview = h("div", { class: "card preview", hidden: true });
  const saveBtn = h("button", { type: "submit", class: "btn primary" }, "Speichern");
  let mode = "write";
  const seg = h("div", { class: "seg", role: "tablist" });
  // Anheften wirkt sofort, unabhängig von "Speichern".
  const pinBtn = h("button", { type: "button", class: "btn small", onClick: async () => { await togglePin(note); paintPin(); } });
  function paintPin() {
    const on = !!notes.find((n) => n.id === note.id)?.pinned_at;
    pinBtn.setAttribute("aria-pressed", String(on));
    pinBtn.replaceChildren(pinIcon(on), on ? " Angeheftet" : " Anheften");
  }
  paintPin();

  function updateSave() { saveBtn.disabled = !fields.isValid(); }
  function paintMode() {
    seg.replaceChildren(...[["write", "Schreiben"], ["preview", "Vorschau"]].map(([key, label]) => h("button", {
      type: "button", role: "tab", class: "seg-btn", "aria-selected": String(mode === key),
      onClick: () => {
        mode = key;
        if (key === "preview") preview.replaceChildren(renderMarkdown(fields.textarea.value));
        fields.textarea.hidden = fields.toolbar.hidden = key === "preview";
        preview.hidden = key !== "preview";
        paintMode();
      },
    }, label)));
  }
  async function save() {
    if (!fields.isValid()) return;
    saveBtn.disabled = true;
    try {
      await updateNote(note.id, fields.values(), fields.tagSel());
      dlg.close();
    } catch (e) {
      toast("Nicht gespeichert: " + e.message, true);
      updateSave();
    }
  }
  const del = confirmButton("Löschen", "Wirklich löschen?", async () => {
    try { await deleteNote(note.id); dlg.close(); } catch (e) { toast("Nicht gelöscht: " + e.message, true); }
  });

  paintMode();
  // Die Vorschau steht zwischen Werkzeugleiste/Textfeld und den Area-Buttons.
  fields.el.insertBefore(preview, fields.el.querySelector(".label"));
  dlg.append(h("form", { class: "sheet", onSubmit: (e) => { e.preventDefault(); save(); } },
    h("div", { class: "dlg-head" }, h("h2", {}, "Notiz"), pinBtn), seg, fields.el,
    h("div", { class: "row-actions" }, del,
      h("div", { class: "right" },
        h("button", { type: "button", class: "btn", onClick: () => dlg.close() }, "Abbrechen"), saveBtn))));
  showDialog(dlg, { focusDialog: true });
  updateSave();
  autosize(fields.textarea);
}

// Seite "Notizen": Formular, Filter nach Area, Liste
function buildNotesPage() {
  const form = h("form", { class: "card add", onSubmit: (e) => { e.preventDefault(); saveNew(); } });
  const holder = h("div");
  const saveBtn = h("button", { type: "submit", class: "btn primary" }, "Notiz speichern");
  let fields = noteFields({}, { onChange: updateSave, onSubmit: saveNew });

  function updateSave() { saveBtn.disabled = !fields.isValid(); }
  async function saveNew() {
    if (!fields.isValid()) return;
    saveBtn.disabled = true;
    try {
      await createNote(fields.values(), fields.tagSel());
      fields = noteFields({}, { onChange: updateSave, onSubmit: saveNew });
      holder.replaceChildren(fields.el);
      fields.textarea.focus();
      toast("Gespeichert");
    } catch (e) {
      toast("Nicht gespeichert: " + e.message, true);
    }
    updateSave();
  }

  holder.append(fields.el);
  form.append(holder, h("div", { class: "actions" }, h("span", { class: "hint" }, "Strg/⌘ + Enter speichert"), saveBtn));

  const filters = h("nav", { class: "filters", "aria-label": "Notizen nach Area" });
  const list = h("ul", { class: "list" });
  updateSave();
  return { el: h("section", {}, form, filters, list), form, filters, list, repaint: () => fields.repaint(), updateSave };
}

function renderNotes() {
  const n = ui.notes;
  if (!n) return;
  const hasAreas = areas.length > 0;
  n.form.hidden = !hasAreas || !!notesError;
  n.repaint();
  n.updateSave();

  if (notesError) {
    n.filters.replaceChildren();
    n.list.replaceChildren(h("li", { class: "empty" }, "Notizen sind noch nicht eingerichtet: " + notesError));
    return;
  }
  if (!hasAreas) {
    n.filters.replaceChildren();
    n.list.replaceChildren(h("li", { class: "empty" },
      h("p", {}, "Lege zuerst deine erste Area an."),
      h("button", { type: "button", class: "btn primary", onClick: openAreasDialog }, "Areas verwalten")));
    return;
  }
  if (noteView.areaId && !areas.some((a) => a.id === noteView.areaId)) noteView.areaId = null;

  const chips = [
    { id: null, label: "Alle", count: notes.length },
    ...areas.map((a) => ({ id: a.id, label: a.name, count: notes.filter((x) => x.area_id === a.id).length })),
  ];
  n.filters.replaceChildren(...chips.map((c) => h("button", {
    type: "button", class: "chip", "aria-pressed": String(noteView.areaId === c.id),
    onClick: () => { noteView.areaId = c.id; renderNotes(); },
  }, c.label, c.count ? h("span", { class: "count" }, String(c.count)) : null)));

  const shown = notes.filter((x) => !noteView.areaId || x.area_id === noteView.areaId);
  n.list.replaceChildren(...(shown.length ? shown.map(noteRow) : [h("li", { class: "empty" }, "Noch keine Notizen.")]));
}

// ---------- Suche (Aufgaben und Notizen, Wortstamm plus Wortteil) ----------
// Die Datenbank-Funktion search_all liefert Treffer; Fundstellen sind mit «…» markiert.
function buildSearch() {
  const input = h("input", {
    type: "search", class: "text-input", placeholder: "Suchen in Aufgaben und Notizen …",
    "aria-label": "Suchen", autocomplete: "off", enterkeyhint: "search",
    onInput: () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); },
    onKeydown: (e) => { if (e.key === "Escape") { input.value = ""; runSearch(); } },
  });
  const info = h("p", { class: "hint search-info" });
  const list = h("ul", { class: "list" });
  return { input, info, list, page: h("section", { hidden: true }, info, list), bar: h("div", { class: "searchbar" }, input) };
}

async function runSearch() {
  const q = ui.search.input.value.trim();
  searchQuery = q;
  if (q.length < 2) {
    searchSeq++;
    searchResults = [];
    searchPending = false;
    renderTabs();
    return;
  }
  const seq = ++searchSeq;
  searchPending = true;
  renderTabs();
  const { data, error } = await sb.rpc("search_all", { q });
  if (seq !== searchSeq) return; // inzwischen wurde etwas Neues gesucht
  searchPending = false;
  if (error) {
    toast("Suche fehlgeschlagen: " + error.message, true);
    searchResults = [];
  } else {
    searchResults = data;
  }
  renderTabs();
}

function clearSearch() {
  searchSeq++;
  searchQuery = "";
  searchResults = [];
  searchPending = false;
  if (ui.search) ui.search.input.value = "";
}

// Text mit «Markierung» in Elemente umwandeln; ohne Markierung (reine Wortteil-Treffer) wird der Suchbegriff selbst markiert.
function snippetNodes(raw, q) {
  const text = raw.replace(/^\s*(#{1,3}|[-*]|\d+\.)\s+/gm, "").replace(/\*\*|\*/g, "").replace(/\s+/g, " ").trim();
  if (text.includes("«")) {
    const parts = text.split("«");
    const out = [parts[0]];
    for (const p of parts.slice(1)) {
      const i = p.indexOf("»");
      if (i < 0) out.push(p);
      else out.push(h("mark", {}, p.slice(0, i)), p.slice(i + 1));
    }
    return out;
  }
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? [text] : [text.slice(0, i), h("mark", {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

function resultRow(r) {
  const isTask = r.kind === "task";
  const meta = [
    h("span", { class: "badge kind" }, isTask ? "Aufgabe" : "Notiz"),
    h("span", { class: "badge" }, areaName(r.area_id)),
  ];
  if (isTask && r.status === "done") meta.push(h("span", { class: "badge" }, "Erledigt"));
  if (isTask && r.status === "open" && r.due_date) meta.push(h("span", { class: "badge" }, dueLabel(r.due_date)));
  for (const name of r.tags ?? []) meta.push(tagBadge("#" + name));
  const snippet = snippetNodes(r.snippet, searchQuery);
  return h("li", { class: "note" },
    h("button", { type: "button", class: "body", onClick: () => openResult(r) },
      isTask ? h("span", { class: "title" }, ...snippet) : h("span", { class: "title" }, noteTexts(r.head).title || "(leer)"),
      isTask ? null : h("span", { class: "excerpt" }, ...snippet),
      h("span", { class: "meta" }, meta)));
}

async function openResult(r) {
  if (r.kind === "task") {
    let t = [...openTasks, ...doneTasks].find((x) => x.id === r.id);
    if (!t) {
      const { data } = await sb.from("tasks").select(TASK_SEL).eq("id", r.id).single();
      if (data) t = normTask(data);
    }
    if (t) openEditDialog(t);
  } else {
    let n = notes.find((x) => x.id === r.id);
    if (!n) {
      const { data } = await sb.from("notes").select(NOTE_SEL).eq("id", r.id).single();
      if (data) n = normNote(data);
    }
    if (n) openNoteDialog(n);
  }
}

function renderSearch() {
  const s = ui.search;
  if (!s) return;
  s.page.hidden = !isSearching();
  if (!isSearching()) return;
  s.info.textContent = searchPending && !searchResults.length ? "Suche …"
    : searchResults.length ? `${searchResults.length} Treffer` : "Keine Treffer.";
  s.list.replaceChildren(...searchResults.map(resultRow));
}

// ---------- Umschalter Aufgaben / Notizen ----------
function renderTabs() {
  if (!ui.tabs) return;
  ui.tabs.replaceChildren(...[["tasks", "Aufgaben"], ["notes", "Notizen"]].map(([key, label]) => h("button", {
    type: "button", role: "tab", class: "seg-btn", "aria-selected": String(page === key),
    onClick: () => setPage(key),
  }, label)));
  ui.title.textContent = page === "tasks" ? "Aufgaben" : "Notizen";
  ui.tasksPage.hidden = isSearching() || page !== "tasks";
  ui.notesPage.hidden = isSearching() || page !== "notes";
  renderSearch();
}

function setPage(p) {
  page = p;
  clearSearch();
  try { localStorage.setItem("page", p); } catch { /* ohne Speicher weiter */ }
  renderTabs();
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
      await createTask(addFields.values(), addFields.tagSel());
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
    title: h("h1", {}, "Aufgaben"),
    tabs: h("div", { class: "seg", role: "tablist", "aria-label": "Bereich" }),
    notes: buildNotesPage(),
    search: buildSearch(),
  };
  ui.tasksPage = h("section", {}, form, ui.filters, ui.list);
  ui.notesPage = ui.notes.el;

  root.replaceChildren(h("div", { class: "wrap" },
    h("header", { class: "topbar" },
      ui.title,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn", onClick: openAreasDialog }, "Areas"),
        h("button", { type: "button", class: "btn", onClick: openTagsDialog }, "Tags"),
        h("button", { type: "button", class: "btn", onClick: () => sb.auth.signOut() }, "Abmelden"))),
    ui.tabs, ui.search.bar, ui.tasksPage, ui.notesPage, ui.search.page));
  renderTabs();

  updateSave();
  load();
}

// ---------- Anmeldung ----------
function showLogin() {
  appMounted = false;
  areas = []; openTasks = []; doneTasks = []; notes = []; tags = [];
  clearSearch();
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
