/**
 * The usage ledger: how many times each skill fired, globally.
 *
 * One aggregate entry per skill name, so the file is sized by how many skills
 * exist, not by how much they are used. Skills are counted in exactly two ways,
 * both observable from an extension: a `read` of the skill's file (which is what
 * pi's prompt tells the model to do) and `/skill:<name>` typed by the user.
 *
 * Writes are atomic and additive: re-read the file, sum the counts, rename over
 * the target. Two pi windows on the same machine therefore never clobber each
 * other, and a crash mid-write leaves the previous ledger intact.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Usage {
  count: number;
  lastAt: number;
  byModel: number;
  byCommand: number;
}

export type Ledger = Record<string, Usage>;

const zero = (): Usage => ({ count: 0, lastAt: 0, byModel: 0, byCommand: 0 });

/** Tolerate anything on disk: a corrupt ledger means "nothing recorded yet". */
export function parseLedger(raw: string | null): Ledger {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Ledger = {};
    for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const count = typeof v.count === "number" && v.count >= 0 ? Math.floor(v.count) : 0;
      if (count === 0) continue;
      out[name] = {
        count,
        lastAt: typeof v.lastAt === "number" ? v.lastAt : 0,
        byModel: typeof v.byModel === "number" ? Math.floor(v.byModel) : 0,
        byCommand: typeof v.byCommand === "number" ? Math.floor(v.byCommand) : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function record(ledger: Ledger, name: string, by: "model" | "command", at: number): Ledger {
  const prev = ledger[name] ?? zero();
  return {
    ...ledger,
    [name]: {
      count: prev.count + 1,
      lastAt: Math.max(prev.lastAt, at),
      byModel: prev.byModel + (by === "model" ? 1 : 0),
      byCommand: prev.byCommand + (by === "command" ? 1 : 0),
    },
  };
}

/** Sum two ledgers; never loses a side's counts. */
export function mergeLedgers(a: Ledger, b: Ledger): Ledger {
  const out: Ledger = {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[name];
    const y = b[name];
    out[name] = x && y
      ? {
          count: x.count + y.count,
          lastAt: Math.max(x.lastAt, y.lastAt),
          byModel: x.byModel + y.byModel,
          byCommand: x.byCommand + y.byCommand,
        }
      : { ...(x ?? y) };
  }
  return out;
}

export function readLedger(file: string): Ledger {
  try {
    return parseLedger(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Fold `pending` into the ledger on disk and swap it in. Returns the merged view. */
export function commitLedger(file: string, pending: Ledger): Ledger {
  const merged = mergeLedgers(readLedger(file), pending);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
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
  return merged;
}
