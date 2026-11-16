// Record shapes, file paths and small calculations. No DOM and no network, so it runs in Node
// tests too. The Python side (src/lukelog/schema.py) checks the same shapes: change both together.

export const SCHEMA_VERSION = 1;

export const OPTIONS = {
  shoes: ["Crocs", "Trainers", "Trainers with orthoses", "Recovery sandals", "Barefoot or socks", "Other"],
  painSites: ["Feet", "Knees", "Legs", "Hips", "Back", "Neck", "Hands or wrists", "Chest", "Stomach", "Head"],
  allergy: ["Itch or hives", "Flushing", "Stomach upset", "Wheeze or cough", "Throat tightness", "Runny nose or eyes"],
  moods: ["Good", "OK", "Low", "Anxious", "Irritable", "Tired"],
  painkillers: ["Ibuprofen", "Acetaminophen"],
  exercise: ["Foot exercises", "PT exercises", "Walk", "Swim", "Bike", "Training", "Other"],
  positions: ["Lying", "Sitting", "Standing", "Just stood up", "Walking", "After exercise"],
  episodeSymptoms: ["Pounding heart", "Dizzy", "Chest pain", "Short of breath", "Flushing", "Sweaty", "Shaky", "Scared", "None"],
  standingSymptoms: ["Dizzy", "Light-headed", "Blurry vision", "Nausea", "Shaky", "None"],
};

const pad = (n) => String(n).padStart(2, "0");

export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function nowHHMM(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
export const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || "");

export const dailyPath = (date) => `data/daily/${date.slice(0, 4)}/${date}.yaml`;
export const episodePath = (date, time) => `data/episodes/${date.slice(0, 4)}/${date}-${time.replace(":", "")}.yaml`;
export const standingPath = (date, time) => `data/standing/${date.slice(0, 4)}/${date}-${time.replace(":", "")}.yaml`;

// Drop empty strings, empty lists, empty objects and nulls, recursively, so files stay short.
export function clean(value) {
  if (Array.isArray(value)) {
    const out = value.map(clean).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = clean(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (value === "" || value === null || value === undefined) return undefined;
  if (typeof value === "number" && Number.isNaN(value)) return undefined;
  return value;
}

// Two parents can edit the same day. Apply only the fields this device changed on top of the
// latest copy from GitHub, so the other person's entries survive. Unknown fields are kept.
export function mergeChanged(latest, local, changedKeys) {
  const out = { ...(latest || {}) };
  for (const k of changedKeys) {
    if (local[k] === undefined) delete out[k];
    else out[k] = local[k];
  }
  return out;
}

// Hours from lights out to waking the next morning (crosses midnight).
export function hoursAsleepWindow(lightsOut, wokeUp) {
  if (!isTime(lightsOut) || !isTime(wokeUp)) return null;
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  let d = mins(wokeUp) - mins(lightsOut);
  if (d <= 0) d += 24 * 60;
  return Math.round((d / 60) * 10) / 10;
}

// Largest standing heart-rate rise over the lying value, in bpm.
export function standingRise(rec) {
  const lying = Number(rec?.lying_hr);
  const vals = Object.values(rec?.standing_hr || {}).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!Number.isFinite(lying) || lying <= 0 || !vals.length) return null;
  return Math.max(...vals) - lying;
}

// Hours from the day's Vyvanse dose to an episode, or null.
export function hoursSinceDose(doseTime, episodeTime) {
  if (!isTime(doseTime) || !isTime(episodeTime)) return null;
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  const d = mins(episodeTime) - mins(doseTime);
  return d < 0 ? null : Math.round((d / 60) * 10) / 10;
}

export function stamp(rec, who, now = new Date()) {
  return { ...rec, schema: SCHEMA_VERSION, updated: now.toISOString().replace(/\.\d{3}Z$/, "Z"), updated_by: who || undefined };
}

// YAML text for a record. Every string is quoted so "07:30" never reads as a number.
export function toYaml(rec, yaml) {
  return yaml.dump(clean(rec) || {}, { forceQuotes: true, quotingType: '"', lineWidth: 100, sortKeys: false });
}
