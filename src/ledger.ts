/**
 * The usage ledger: how many times each skill fired, per month, globally.
 *
 * One entry per skill name: twelve monthly counters plus an `older` total, so the
 * file is sized by how many skills exist rather than by how much they are used.
 * Skills are counted in exactly two ways, both observable from an extension: a
 * `read` of the skill's file (which is what pi's prompt tells the model to do)
 * and `/skill:<name>` typed by the user.
 *
 * The monthly array is indexed by month of the year, so a slot keeps its meaning:
 * `m[0]` is always January. Each slot holds the most recent occurrence of its
 * month; `roll` slides the window when the calendar does, moving the months that
 * leave it into `older` so the array never grows.
 *
 * Writes are one read-modify-write per fire: re-read the file, roll it to now,
 * add one to the current month, rename over the target. Nothing is accumulated
 * in memory, so a session that crosses a month boundary cannot misbucket a
 * count, and a crash mid-write leaves the previous ledger intact.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Months kept per skill; anything older is folded into `older`. */
export const MONTHS = 12;

/** Bumped when the shape changes: an older file reads as "nothing recorded yet". */
const SCHEMA = 3;

export interface Usage {
  /**
   * Fires per month of the year: `m[0]` is January and `m[11]` is December, each
   * holding the count for its most recent occurrence, so in October `m[9]` is
   * this October, `m[8]` this September and `m[10]` last November.
   */
  m: number[];
  /** Fires before the oldest month kept. */
  older: number;
}

export interface Ledger {
  /** Anchor month as `year * 12 + monthIndex` (UTC): the newest month in the window. */
  month: number;
  skills: Record<string, Usage>;
}

/** UTC month of a timestamp, as `year * 12 + monthIndex`. */
export const monthOf = (at: number): number => {
  const d = new Date(at);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/** `2026-10` for `2026 * 12 + 9`. */
export const monthKey = (month: number): string =>
  `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}`;

export const fires = (usage: Usage): number => usage.m.reduce((sum, n) => sum + n, usage.older);

const zeros = (): number[] => Array.from({ length: MONTHS }, () => 0);

export function emptyLedger(now: number): Ledger {
  return { month: monthOf(now), skills: {} };
}

/** Tolerate anything on disk: unusable, including the older shapes, means "no data yet". */
export function parseLedger(raw: string | null, now: number): Ledger {
  const empty = emptyLedger(now);
  if (!raw) return empty;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data?.v !== SCHEMA || typeof data.month !== "string") return empty;
    const stamp = /^(\d{4})-(\d{2})$/u.exec(data.month);
    if (!stamp) return empty;
    const skills = data.skills;
    if (!skills || typeof skills !== "object" || Array.isArray(skills)) return empty;

    const out: Record<string, Usage> = {};
    for (const [name, value] of Object.entries(skills as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      if (!Array.isArray(v.m) || v.m.length !== MONTHS) continue;
      const usage: Usage = {
        m: v.m.map((n) => (typeof n === "number" && n > 0 ? Math.floor(n) : 0)),
        older: typeof v.older === "number" && v.older > 0 ? Math.floor(v.older) : 0,
      };
      // A skill with no fires is indistinguishable from an absent one.
      if (fires(usage) === 0) continue;
      out[name] = usage;
    }
    return { month: Number(stamp[1]) * 12 + Number(stamp[2]) - 1, skills: out };
  } catch {
    return empty;
  }
}

/**
 * Slide the window so every slot holds the most recent occurrence of its month.
 *
 * Slot `k` is the month whose number is `k + 1`, and the months that leave the
 * window are exactly `anchor + 1 … now`, so each of them is folded into `older`
 * and zeroed. With the anchor in October and now in February, slots 11, 12, 1 and
 * 2 are flushed: their November, December, January and February counts are now
 * over a year old.
 */
export function roll(ledger: Ledger, now: number): Ledger {
  const diff = monthOf(now) - ledger.month;
  if (!(diff > 0)) return ledger; // a stamp in the future is a skewed clock, not a new bucket
  const skills: Record<string, Usage> = {};
  for (const [name, usage] of Object.entries(ledger.skills)) {
    const m = [...usage.m];
    let older = usage.older;
    for (let k = 1; k <= Math.min(diff, MONTHS); k++) {
      const slot = (ledger.month + k) % MONTHS;
      older += m[slot];
      m[slot] = 0;
    }
    skills[name] = { m, older };
  }
  return { month: monthOf(now), skills };
}

export function record(ledger: Ledger, name: string, at: number): Ledger {
  const rolled = roll(ledger, at);
  const prev = rolled.skills[name] ?? { m: zeros(), older: 0 };
  const m = [...prev.m];
  // A fire stamped before the window (a clock that jumped) lands in its own
  // month's slot, which then holds the same month one year later.
  m[monthOf(at) % MONTHS] += 1;
  return {
    month: rolled.month,
    skills: { ...rolled.skills, [name]: { m, older: prev.older } },
  };
}

/** The ledger on disk, rolled to now so every slot holds its month in the window. */
export function readLedger(file: string, now: number): Ledger {
  let raw: string | null = null;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // A missing file is the normal first run.
  }
  return roll(parseLedger(raw, now), now);
}

/** Replace the file atomically: one temp file in the same directory, then a rename. */
export function writeLedger(file: string, ledger: Ledger): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = { v: SCHEMA, month: monthKey(ledger.month), skills: ledger.skills };
  // `null, 2` breaks every value, but the twelve month slots read as a row and a
  // changed count should touch one line: collapse digit-only arrays back to one.
  // A real newline can only sit at a structural position, since JSON escapes the
  // ones inside strings, so this cannot reach a skill name.
  const text = JSON.stringify(body, null, 2).replace(
    /\[\s*\n\s*([\d,\s]*?)\n\s*\]/gu,
    (_match, inner: string) => `[${inner.replace(/\s+/gu, " ").trim()}]`,
  );
  writeFileSync(tmp, `${text}\n`);
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort: nothing left to do if the cleanup fails too.
    }
    throw err;
  }
}

/**
 * One fire, one read-modify-write. Returns the ledger as written.
 *
 * Two windows firing at the same instant can still lose one count: the rename
 * makes each write atomic, not the read-modify-write pair.
 */
export function commitFire(file: string, name: string, at: number): Ledger {
  const next = record(readLedger(file, at), name, at);
  writeLedger(file, next);
  return next;
}
