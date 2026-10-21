/**
 * The usage ledger: how many times each skill fired, per month, globally.
 *
 * One entry per skill name: twelve monthly counters plus an `older` total, so the
 * file is sized by how many skills exist rather than by how much they are used.
 * Skills are counted in exactly two ways, both observable from an extension: a
 * `read` of the skill's file (which is what pi's prompt tells the model to do)
 * and `/skill:<name>` typed by the user.
 *
 * The monthly array is relative to an anchor month stored in the file: a
 * histogram whose slot 0 has no date is unreadable the moment a month rolls
 * over. `roll` shifts the window forward when the calendar does, spilling
 * whatever leaves it into `older`.
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
const SCHEMA = 2;

export interface Usage {
  /** Fires per month, `m[0]` being the ledger's anchor month. */
  m: number[];
  /** Fires before the oldest month kept. */
  older: number;
  /** Last fire, for day-level recency in the report. 0 = never. */
  lastAt: number;
}

export interface Ledger {
  /** Anchor month as `year * 12 + monthIndex` (UTC): the month `m[0]` refers to. */
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

/** Tolerate anything on disk: unusable, including the v1 shape, means "no data yet". */
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
        lastAt: typeof v.lastAt === "number" && v.lastAt > 0 ? v.lastAt : 0,
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

/** Slide the window so `m[0]` is now's month, folding what falls out into `older`. */
export function roll(ledger: Ledger, now: number): Ledger {
  const diff = monthOf(now) - ledger.month;
  if (!(diff > 0)) return ledger; // a stamp in the future is a skewed clock, not a new bucket
  const keep = Math.min(diff, MONTHS);
  const skills: Record<string, Usage> = {};
  for (const [name, usage] of Object.entries(ledger.skills)) {
    skills[name] = {
      // Old slot j becomes slot j + diff in the new frame.
      m: Array.from({ length: MONTHS }, (_, i) => usage.m[i - diff] ?? 0),
      older: usage.older + usage.m.slice(MONTHS - keep).reduce((sum, n) => sum + n, 0),
      lastAt: usage.lastAt,
    };
  }
  return { month: monthOf(now), skills };
}

export function record(ledger: Ledger, name: string, at: number): Ledger {
  const rolled = roll(ledger, at);
  const prev = rolled.skills[name] ?? { m: zeros(), older: 0, lastAt: 0 };
  const m = [...prev.m];
  m[0] += 1;
  return {
    month: rolled.month,
    skills: { ...rolled.skills, [name]: { m, older: prev.older, lastAt: Math.max(prev.lastAt, at) } },
  };
}

/** The ledger on disk, rolled to now so `m[0]` is the current month. */
export function readLedger(file: string, now: number): Ledger {
  let raw: string | null = null;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // A missing file is the normal first run.
  }
  return roll(parseLedger(raw, now), now);
}

/**
 * One fire, one read-modify-write. Returns the ledger as written.
 *
 * Two windows firing at the same instant can still lose one count: the rename
 * makes each write atomic, not the read-modify-write pair.
 */
export function commitFire(file: string, name: string, at: number): Ledger {
  const next = record(readLedger(file, at), name, at);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: SCHEMA, month: monthKey(next.month), skills: next.skills }, null, 2)}\n`);
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
  return next;
}
