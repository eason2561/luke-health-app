// Luke's health log: a daily evening log, heart-rate episodes and the standing test, saved as
// YAML files in the private repo. Strict CSP: no inline scripts or styles (set styles via el.style).
import * as gh from "./github.js";
import * as outbox from "./outbox.js";
import {
  OPTIONS, todayISO, nowHHMM, isDate, isTime, dailyPath, episodePath, standingPath,
  mergeChanged, hoursAsleepWindow, standingRise, hoursSinceDose, stamp, toYaml,
} from "./model.js";

export const APP_VERSION = "lukelog-v1"; // keep in step with VERSION in sw.js

const yaml = window.jsyaml;
const view = document.getElementById("view");
const URGENT_HR = 180;
const POTS_RISE = 40;
const SLEEP_TARGET = 9;

// ---------- small DOM helpers ----------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

function toast(msg, ms = 3000) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

const section = (title, ...kids) => h("section", { class: "card" }, h("h2", { text: title }), ...kids);
// A div, not a <label>: a label around a row of buttons would send every tap to the first one.
function field(label, input, hint) {
  for (const el of input.matches?.("input, textarea") ? [input] : input.querySelectorAll?.("input, textarea") || []) {
    if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", label);
  }
  return h("div", { class: "field", role: "group", "aria-label": label }, h("span", { text: label }), input, hint ? h("small", { text: hint }) : null);
}

// replaceChildren would print "null" for a skipped part.
const show = (...kids) => view.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

// Each navigation gets a number; a slow screen that finishes after the user has moved on draws nothing.
let routeId = 0;
const screen = () => {
  const id = routeId;
  return (...kids) => { if (id === routeId) show(...kids); };
};

// A row of buttons; multi = several can be on. onChange gets the new value (array or string).
function chips(options, value, onChange, { multi = false } = {}) {
  const wrap = h("div", { class: "chips", role: multi ? "group" : "radiogroup" });
  let cur = multi ? [...(value || [])] : value || "";
  const paint = () => {
    for (const b of wrap.children) {
      const on = multi ? cur.includes(b.dataset.v) : cur === b.dataset.v;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  };
  for (const o of options) {
    wrap.append(h("button", {
      type: "button", class: "chip", "data-v": o, text: o,
      onclick: () => {
        if (multi) cur = cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o];
        else cur = cur === o ? "" : o;
        paint();
        onChange(multi ? cur : cur);
      },
    }));
  }
  paint();
  return wrap;
}

// 0-10 pain scale as eleven buttons; tap the chosen one again to clear it.
function scale(value, onChange) {
  const opts = Array.from({ length: 11 }, (_, i) => String(i));
  const el = chips(opts, value === undefined || value === null ? "" : String(value), (v) => onChange(v === "" ? undefined : Number(v)));
  el.classList.add("scale");
  return el;
}

function timeInput(value, onChange) {
  const input = h("input", { type: "time", value: value || "", onchange: (e) => onChange(e.target.value || undefined) });
  const now = h("button", { type: "button", class: "small", text: "Now", onclick: () => { input.value = nowHHMM(); onChange(input.value); } });
  return h("div", { class: "row" }, input, now);
}

function numberInput(value, onChange, attrs = {}) {
  return h("input", { type: "number", inputmode: "numeric", value: value ?? "", ...attrs,
    onchange: (e) => onChange(e.target.value === "" ? undefined : Number(e.target.value)) });
}

function textInput(value, onChange, attrs = {}) {
  return h("input", { type: "text", value: value || "", ...attrs, onchange: (e) => onChange(e.target.value.trim() || undefined) });
}

function textArea(value, onChange) {
  return h("textarea", { rows: 3, onchange: (e) => onChange(e.target.value.trim() || undefined) }, value || "");
}

// ---------- data ----------

async function loadYaml(path) {
  try {
    const { text, sha } = await gh.getText(path);
    return { rec: yaml.load(text) || {}, sha };
  } catch (e) {
    if (e instanceof gh.GitHubError && e.status === 404) return { rec: {}, sha: undefined };
    throw e;
  }
}

// Read the latest copy, apply this device's changes, write it back (or queue it offline).
async function saveRecord(path, local, changed, loadedSha, loadedRec, message) {
  let latest = loadedRec, sha = loadedSha;
  try {
    ({ rec: latest, sha } = await loadYaml(path));
  } catch (e) {
    if (!(e instanceof gh.NetworkError)) throw e;
  }
  const who = gh.loadSettings().who;
  const merged = stamp(mergeChanged(latest, local, changed), who);
  const content = gh.textToBase64(toYaml(merged, yaml));
  const res = await outbox.perform([{ op: "put", path, content, sha, message: `${message}${who ? ` (${who})` : ""}` }]);
  updateSyncButton();
  return { merged, queued: res.queued };
}

function requireSetup() {
  if (gh.isConfigured()) return null;
  return section("Set up this device",
    h("p", { text: "Add the GitHub token in Settings first. Each phone needs it once." }),
    h("a", { class: "button", href: "#/settings", text: "Open Settings" }));
}

// ---------- Today (daily log) ----------

async function renderDaily(params) {
  const out = screen();
  const date = isDate(params.get("date")) ? params.get("date") : todayISO();
  out(h("p", { class: "muted", text: "Loading…" }));
  const setup = requireSetup();
  if (setup) return out(setup);
  let loaded;
  try {
    loaded = await loadYaml(dailyPath(date));
  } catch (e) {
    loaded = { rec: {}, sha: undefined };
    toast(e.message);
  }
  const rec = { date, ...structuredClone(loaded.rec) };
  const changed = new Set(["date"]);
  const set = (k, v) => { rec[k] = v; changed.add(k); dirty.hidden = false; };
  const setIn = (k, sub, v) => { set(k, { ...(rec[k] || {}), [sub]: v }); };

  const dayNav = h("div", { class: "row daynav" },
    h("button", { type: "button", class: "small", text: "‹ Day before", onclick: () => go("#/?date=" + shift(date, -1)) }),
    h("input", { type: "date", value: date, onchange: (e) => isDate(e.target.value) && go("#/?date=" + e.target.value) }),
    date < todayISO() ? h("button", { type: "button", class: "small", text: "Next day ›", onclick: () => go("#/?date=" + shift(date, 1)) }) : null);

  const sleepOut = h("p", { class: "muted" });
  const paintSleep = () => {
    const hrs = hoursAsleepWindow(rec.lights_out, rec.woke_up);
    sleepOut.textContent = hrs === null ? "" : `${hrs} h from lights out to waking${hrs < SLEEP_TARGET ? ` (under the ${SLEEP_TARGET} h target)` : ""}`;
    sleepOut.classList.toggle("warn", hrs !== null && hrs < SLEEP_TARGET);
  };
  paintSleep();

  const fears = rec.fears || {};
  const fearDetail = h("div", { class: "stack" },
    field("What scared him", textInput(fears.what, (v) => setIn("fears", "what", v), { placeholder: "e.g. thunderstorm" })),
    field("When", timeInput(fears.time, (v) => setIn("fears", "time", v))),
    field("How long (minutes)", numberInput(fears.minutes, (v) => setIn("fears", "minutes", v), { min: 0 })));
  fearDetail.hidden = fears.happened !== true;

  const dirty = h("span", { class: "dirty", text: "Unsaved changes" });
  dirty.hidden = true;
  const saveBtn = h("button", { type: "button", class: "primary", text: "Save" });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const { merged, queued } = await saveRecord(dailyPath(date), rec, changed, loaded.sha, loaded.rec, `Daily log ${date}`);
      loaded = { rec: merged, sha: undefined };
      dirty.hidden = true;
      toast(queued ? "Saved on this phone; will sync when online" : "Saved");
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      saveBtn.disabled = false;
    }
  });

  const other = rec.other_pain || {};
  out(
    dayNav,
    loaded.rec.updated_by ? h("p", { class: "muted", text: `Last saved by ${loaded.rec.updated_by}` }) : null,
    section("Medicine and meals",
      field("Vyvanse", timeInput(rec.vyvanse_time, (v) => set("vyvanse_time", v))),
      field("Breakfast", timeInput(rec.meals?.breakfast, (v) => setIn("meals", "breakfast", v))),
      field("Lunch", timeInput(rec.meals?.lunch, (v) => setIn("meals", "lunch", v))),
      field("Dinner", timeInput(rec.meals?.dinner, (v) => setIn("meals", "dinner", v)))),
    section("Feet",
      field("Foot pain this morning (0 none, 10 worst)", scale(rec.foot_pain?.am, (v) => setIn("foot_pain", "am", v))),
      field("Foot pain this evening", scale(rec.foot_pain?.pm, (v) => setIn("foot_pain", "pm", v))),
      field("Shoes worn today", chips(OPTIONS.shoes, rec.shoes, (v) => set("shoes", v), { multi: true }))),
    section("Other pain",
      field("Where", chips(OPTIONS.painSites, other.sites, (v) => setIn("other_pain", "sites", v), { multi: true })),
      field("Worst level today", scale(other.score, (v) => setIn("other_pain", "score", v)))),
    section("Fears",
      field("Any fear or panic today?", chips(["Yes", "No"], fears.happened === true ? "Yes" : fears.happened === false ? "No" : "",
        (v) => { setIn("fears", "happened", v === "Yes" ? true : v === "No" ? false : undefined); fearDetail.hidden = v !== "Yes"; })),
      fearDetail),
    section("Allergy-type symptoms",
      chips(OPTIONS.allergy, rec.allergy_symptoms, (v) => set("allergy_symptoms", v), { multi: true }),
      h("small", { class: "muted", text: "Two or more at once (e.g. hives with stomach upset): note the time in Notes." })),
    section("Sleep",
      field("Screens off", timeInput(rec.screens_off, (v) => set("screens_off", v))),
      field("Lights out", timeInput(rec.lights_out, (v) => { set("lights_out", v); paintSleep(); })),
      field("Woke up (next morning)", timeInput(rec.woke_up, (v) => { set("woke_up", v); paintSleep(); }),
        "Fill this in the next morning, or on the next evening's log."),
      sleepOut),
    section("Mood and notes",
      field("Mood", chips(OPTIONS.moods, rec.mood, (v) => set("mood", v || undefined))),
      field("Notes", textArea(rec.notes, (v) => set("notes", v)))),
    h("div", { class: "savebar" }, dirty, saveBtn));
}

function shift(date, days) {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + days);
  return todayISO(d);
}

// ---------- Heart-rate episode ----------

async function renderEpisode() {
  const out = screen();
  const setup = requireSetup();
  if (setup) return out(setup);
  const rec = { date: todayISO(), time: nowHHMM() };
  const changed = new Set(Object.keys(rec));
  const set = (k, v) => { rec[k] = v; changed.add(k); paintWarn(); paintDose(); };

  const warn = h("div", { class: "alert", role: "alert" });
  const paintWarn = () => {
    const urgent = (rec.peak_hr >= URGENT_HR) || (rec.symptoms || []).some((s) => s === "Chest pain" || s === "Short of breath");
    warn.hidden = !urgent;
    warn.textContent = "Chest pain, fainting, real breathlessness, a rate above 180 or an episode during exercise: get urgent care now, and log it afterwards.";
  };
  const doseOut = h("p", { class: "muted" });
  let dose;
  const paintDose = () => {
    const hrs = hoursSinceDose(dose, rec.time);
    doseOut.textContent = hrs === null ? "" : `${hrs} h after today's Vyvanse (${dose})`;
  };
  loadYaml(dailyPath(rec.date)).then(({ rec: day }) => { dose = day.vyvanse_time; paintDose(); }).catch(() => {});
  paintWarn();

  const saveBtn = h("button", { type: "button", class: "primary", text: "Save episode", onclick: async () => {
    if (!isDate(rec.date) || !isTime(rec.time)) return toast("Date and time are needed");
    saveBtn.disabled = true;
    try {
      const { queued } = await saveRecord(episodePath(rec.date, rec.time), rec, changed, undefined, {}, `HR episode ${rec.date} ${rec.time}`);
      toast(queued ? "Saved on this phone; will sync when online" : "Episode saved");
      go("#/history");
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      saveBtn.disabled = false;
    }
  } });

  out(
    h("h1", { text: "Heart-rate episode" }),
    h("p", { class: "muted", text: "For a resting heart rate of 120 or more. Photograph the watch screen if you can." }),
    warn,
    section("When",
      field("Date", h("input", { type: "date", value: rec.date, onchange: (e) => set("date", e.target.value) })),
      field("Start time", timeInput(rec.time, (v) => set("time", v))),
      doseOut,
      field("How long (minutes)", numberInput(rec.duration_min, (v) => set("duration_min", v), { min: 0 })),
      field("Peak heart rate (bpm)", numberInput(rec.peak_hr, (v) => set("peak_hr", v), { min: 30, max: 250 }))),
    section("What was happening",
      field("Position just before", chips(OPTIONS.positions, rec.position, (v) => set("position", v || undefined))),
      field("What he was doing", textInput(rec.activity, (v) => set("activity", v), { placeholder: "e.g. playing Xbox" })),
      field("Hours since he last ate", numberInput(rec.hours_since_meal, (v) => set("hours_since_meal", v), { min: 0, step: "0.5" })),
      field("How he felt", chips(OPTIONS.episodeSymptoms, rec.symptoms, (v) => set("symptoms", v), { multi: true })),
      field("Photo of the watch taken", chips(["Yes", "No"], "", (v) => set("photo", v === "Yes" ? true : v === "No" ? false : undefined))),
      field("Notes", textArea(rec.notes, (v) => set("notes", v)))),
    h("div", { class: "savebar" }, saveBtn));
}

// ---------- Standing test ----------

async function renderStanding() {
  const out = screen();
  const setup = requireSetup();
  if (setup) return out(setup);
  const rec = { date: todayISO(), time: nowHHMM(), standing_hr: {} };
  const changed = new Set(Object.keys(rec));
  const riseOut = h("p", { class: "result" });
  const paintRise = () => {
    const r = standingRise(rec);
    riseOut.textContent = r === null ? "" : `Largest rise: ${r} bpm${r >= POTS_RISE ? ` (at or above ${POTS_RISE}: the POTS pattern; repeat on other mornings)` : ""}`;
    riseOut.classList.toggle("warn", r !== null && r >= POTS_RISE);
  };
  const set = (k, v) => { rec[k] = v; changed.add(k); paintRise(); };
  const setHr = (min, v) => set("standing_hr", { ...rec.standing_hr, [min]: v });

  // A timer that says when to read the watch.
  const clock = h("p", { class: "clock", text: "" });
  let timer = null;
  const timerBtn = h("button", { type: "button", class: "small", text: "Start standing timer", onclick: () => {
    if (timer) { clearInterval(timer); timer = null; timerBtn.textContent = "Start standing timer"; clock.textContent = ""; return; }
    const t0 = Date.now();
    timerBtn.textContent = "Stop timer";
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      const due = [60, 180, 300, 600].find((x) => s >= x - 5 && s <= x + 5);
      clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} standing${due ? ` · read the ${due / 60}-minute heart rate now` : ""}`;
      clock.classList.toggle("warn", Boolean(due));
      if (s > 615) { clearInterval(timer); timer = null; timerBtn.textContent = "Start standing timer"; }
    }, 1000);
  } });

  const saveBtn = h("button", { type: "button", class: "primary", text: "Save test", onclick: async () => {
    saveBtn.disabled = true;
    try {
      const { queued } = await saveRecord(standingPath(rec.date, rec.time), rec, changed, undefined, {}, `Standing test ${rec.date}`);
      toast(queued ? "Saved on this phone; will sync when online" : "Test saved");
      go("#/history");
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      saveBtn.disabled = false;
    }
  } });

  out(
    h("h1", { text: "Standing test" }),
    h("p", { class: "muted", text: "Morning, before Vyvanse and breakfast. Lie still 10 minutes, read heart rate and blood pressure, then stand without leaning and read at 1, 3, 5 and 10 minutes. Stop if he feels faint." }),
    section("Lying down",
      field("Date", h("input", { type: "date", value: rec.date, onchange: (e) => set("date", e.target.value) })),
      field("Time", timeInput(rec.time, (v) => set("time", v))),
      field("Heart rate after 10 minutes lying (bpm)", numberInput(rec.lying_hr, (v) => set("lying_hr", v), { min: 30, max: 220 })),
      field("Blood pressure lying", textInput(rec.lying_bp, (v) => set("lying_bp", v), { placeholder: "e.g. 105/65", inputmode: "numeric" }))),
    section("Standing",
      timerBtn, clock,
      field("Heart rate at 1 minute", numberInput(undefined, (v) => setHr("1", v), { min: 30, max: 250 })),
      field("At 3 minutes", numberInput(undefined, (v) => setHr("3", v), { min: 30, max: 250 })),
      field("At 5 minutes", numberInput(undefined, (v) => setHr("5", v), { min: 30, max: 250 })),
      field("At 10 minutes", numberInput(undefined, (v) => setHr("10", v), { min: 30, max: 250 })),
      field("Blood pressure at 3 minutes standing", textInput(rec.standing_bp, (v) => set("standing_bp", v), { placeholder: "e.g. 100/70", inputmode: "numeric" })),
      field("Symptoms while standing", chips(OPTIONS.standingSymptoms, rec.symptoms, (v) => set("symptoms", v), { multi: true })),
      riseOut,
      field("Notes", textArea(rec.notes, (v) => set("notes", v)))),
    h("div", { class: "savebar" }, saveBtn));
}

// ---------- History ----------

async function renderHistory() {
  const out = screen();
  const setup = requireSetup();
  if (setup) return out(setup);
  out(h("h1", { text: "History" }), h("p", { class: "muted", text: "Loading…" }));
  const year = todayISO().slice(0, 4);
  const years = [year, String(+year - 1)];
  try {
    const [days, eps, stands] = await Promise.all(["daily", "episodes", "standing"].map(async (kind) =>
      (await Promise.all(years.map((y) => gh.listDir(`data/${kind}/${y}`)))).flat()
        .filter((f) => f.name.endsWith(".yaml")).sort((a, b) => b.name.localeCompare(a.name))));
    const recent = days.slice(0, 14);
    const recs = await Promise.all(recent.map((f) => loadYaml(f.path).then((r) => r.rec).catch(() => ({}))));
    const rows = recent.map((f, i) => {
      const r = recs[i];
      const date = f.name.slice(0, 10);
      const hrs = hoursAsleepWindow(r.lights_out, r.woke_up);
      const bits = [
        r.foot_pain?.am !== undefined || r.foot_pain?.pm !== undefined ? `feet ${r.foot_pain?.am ?? "–"}/${r.foot_pain?.pm ?? "–"}` : "",
        hrs !== null ? `${hrs} h sleep` : "",
        r.fears?.happened ? "fear" : "",
        (r.allergy_symptoms || []).length ? "allergy" : "",
        r.mood || "",
      ].filter(Boolean).join(" · ");
      return h("li", {}, h("a", { href: `#/?date=${date}` }, h("strong", { text: date }), " ", h("span", { class: "muted", text: bits || "no entries" })));
    });
    const list = (files) => files.slice(0, 10).map((f) => h("li", { text: f.name.replace(".yaml", "") }));
    out(
      h("h1", { text: "History" }),
      section("Last 14 logged days", rows.length ? h("ul", { class: "list" }, rows) : h("p", { class: "muted", text: "Nothing logged yet." })),
      section(`Heart-rate episodes (${eps.length})`, eps.length ? h("ul", { class: "list" }, list(eps)) : h("p", { class: "muted", text: "None yet." })),
      section(`Standing tests (${stands.length})`, stands.length ? h("ul", { class: "list" }, list(stands)) : h("p", { class: "muted", text: "None yet." })));
  } catch (e) {
    out(h("h1", { text: "History" }), h("p", { class: "warn", text: e.message }));
  }
}

// ---------- Settings ----------

async function renderSettings() {
  const out = screen();
  const s = gh.loadSettings();
  const draft = { ...s };
  const status = h("p", { class: "muted" });
  const pending = h("div");
  const paintPending = async () => {
    const ops = await outbox.list();
    pending.replaceChildren(ops.length
      ? h("ul", { class: "list" }, ops.map((o) => h("li", {}, `${o.path}${o.error ? ` — ${o.error}` : " — waiting"}`,
          o.error ? h("button", { type: "button", class: "small", text: "Discard", onclick: async () => { await outbox.remove(o.id); paintPending(); updateSyncButton(); } }) : null)))
      : h("p", { class: "muted", text: "Nothing waiting to sync." }));
  };
  paintPending();

  out(
    h("h1", { text: "Settings" }),
    section("Who is logging on this phone",
      chips(["Dave", "Joy"], draft.who, (v) => (draft.who = v))),
    section("GitHub",
      h("p", { class: "muted", text: "Create a fine-grained token at github.com → Settings → Developer settings → Fine-grained tokens. Resource owner: eason-family. Only select repositories: Luke-Health. Contents: Read and write. Longest expiry offered." }),
      field("Token", h("input", { type: "password", value: draft.token, autocomplete: "off", onchange: (e) => (draft.token = e.target.value.trim()) })),
      field("Token expires", h("input", { type: "date", value: draft.expires, onchange: (e) => (draft.expires = e.target.value) })),
      field("Owner", textInput(draft.owner, (v) => (draft.owner = v || "eason-family"))),
      field("Repository", textInput(draft.repo, (v) => (draft.repo = v || "Luke-Health"))),
      h("button", { type: "button", class: "primary", text: "Save and test", onclick: async () => {
        gh.saveSettings(draft);
        status.textContent = "Testing…";
        try {
          const info = await gh.repoInfo();
          status.textContent = `Connected to ${info.full_name}${info.private ? " (private)" : " — WARNING: this repo is public"}.`;
        } catch (e) {
          status.textContent = e.message;
        }
      } }),
      status),
    section("Waiting to sync", pending, h("button", { type: "button", class: "small", text: "Sync now", onclick: async () => {
      const n = await outbox.flush();
      toast(n ? `Synced ${n}` : "Nothing synced");
      paintPending();
      updateSyncButton();
    } })),
    h("p", { class: "muted", text: `Version ${APP_VERSION}` }));
}

// ---------- shell ----------

async function updateSyncButton() {
  const btn = document.getElementById("sync-btn");
  const n = (await outbox.list()).length;
  btn.hidden = n === 0;
  btn.textContent = `${n} waiting`;
}

function expiryBanner() {
  const { token, expires } = gh.loadSettings();
  if (!token || !isDate(expires)) return;
  const days = Math.round((new Date(expires + "T00:00:00") - new Date(todayISO() + "T00:00:00")) / 86400000);
  if (days <= 14) toast(days < 0 ? "Your GitHub token has expired: make a new one in Settings" : `Your GitHub token expires in ${days} days`, 8000);
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

const ROUTES = { "": renderDaily, episode: renderEpisode, standing: renderStanding, history: renderHistory, settings: renderSettings };

function route() {
  routeId++;
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const fn = ROUTES[path] || renderDaily;
  for (const a of document.querySelectorAll(".tabbar a")) a.classList.toggle("active", a.dataset.tab === (path || "today"));
  window.scrollTo(0, 0);
  fn(new URLSearchParams(query || ""));
}

document.getElementById("sync-btn").addEventListener("click", () => go("#/settings"));
window.addEventListener("hashchange", route);
window.addEventListener("online", () => outbox.flush().then(updateSyncButton).catch(() => {}));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
outbox.flush().then(updateSyncButton).catch(() => {});
expiryBanner();
route();
