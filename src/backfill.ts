/**
 * Backfill: rebuild the ledger from the session logs pi already wrote.
 *
 * The sessions live in the same synced data directory as the ledger, so the logs
 * are the complete record: a rebuild credits every fire live counting saw, plus
 * the ones from before the extension was installed. It *replaces* the file
 * instead of adding to it, which is what makes it safe to run twice and safe to
 * run on whichever machine you happen to be at.
 *
 * Only structured records count. Tool results quote SKILL.md bodies, the system
 * prompt pastes the whole skill list, and docs contain the literal
 * `/skill:<name>` template, so anything text-shaped overcounts by an order of
 * magnitude.
 *
 * It also mirrors nothing from the live path on purpose: the name comes from the
 * skill's directory, not from the set installed today, so a skill renamed since
 * keeps the entry its fires were recorded under.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { monthOf, MONTHS, type Ledger, type Usage, writeLedger } from "./ledger.ts";
import { readTarget } from "./match.ts";

export interface Fire {
  name: string;
  /** Timestamp of the record that carried it, in ms. */
  at: number;
}

/** A skill file is any `SKILL.md`; the name is the directory above it, wherever it lives. */
const SKILL_PATH = /\/SKILL\.md$/u;
/**
 * Both shapes a fire takes in the log: the typed command, or the block pi expands it
 * into, body and all. Either starts the message, and the name ends at whitespace, at
 * the quote before `location`, or at the end, so a pasted fragment is not a fire.
 */
const FIRE = /^(?:\/skill:|<skill name=")([\w.:-]+)(?=$|\s|" location=")/u;

/** Everything the user text of a message says, string or block-shaped. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
}

/**
 * One session file's fires. `cwd` starts at the caller's and is replaced by the
 * session's own, because a `read` may name a relative path.
 */
export function firesIn(text: string, cwd = process.cwd()): Fire[] {
  const out: Fire[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a half-written last line is not a fire
    }
    const at = Date.parse(String(record?.timestamp ?? ""));
    if (!Number.isFinite(at)) continue;
    if (record.type === "session" && typeof record.cwd === "string") {
      cwd = record.cwd;
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message as { role?: unknown; content?: unknown } | undefined;
    if (!message) continue;

    if (message.role === "user") {
      const match = FIRE.exec(textOf(message.content).trimStart());
      if (match) out.push({ name: match[1], at });
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "toolCall" || block.name !== "read") continue;
      const path = (block.arguments as { path?: unknown } | undefined)?.path;
      if (typeof path !== "string") continue;
      const target = readTarget(cwd, path);
      if (!SKILL_PATH.test(target)) continue;
      const name = basename(dirname(target));
      if (name) out.push({ name, at });
    }
  }
  return out;
}

/**
 * Fold timestamped fires into the ledger shape: counts inside the twelve-month
 * window land in their month's slot, everything older in `older`. Months that
 * use the same slot (the same month a year apart) are never both in the window,
 * so a slot is assigned, not added to.
 */
export function toLedger(all: Fire[], now: number): Ledger {
  const anchor = monthOf(now);
  const months = new Map<string, Map<number, number>>();
  for (const fire of all) {
    const month = monthOf(fire.at);
    if (month > anchor) continue; // a clock that ran ahead is not a bucket
    const byMonth = months.get(fire.name) ?? new Map<number, number>();
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
    months.set(fire.name, byMonth);
  }

  const skills: Record<string, Usage> = {};
  for (const [name, byMonth] of months) {
    const m = Array.from({ length: MONTHS }, () => 0);
    let older = 0;
    for (const [month, count] of [...byMonth].sort((a, b) => a[0] - b[0])) {
      if (anchor - month >= MONTHS) older += count;
      else m[month % MONTHS] = count;
    }
    skills[name] = { m, older };
  }
  return { month: anchor, skills };
}

/** Every session `.jsonl` under `dir`, minus Syncthing's duplicate copies. */
function sessionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // A conflict copy is the same session twice: counting it doubles its fires.
    if (entry.name.includes("sync-conflict")) continue;
    if (entry.isDirectory()) out.push(...sessionFiles(path));
    else if (entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

/** Walk the session tree and rebuild the ledger from it. */
export function backfill(sessionsDir: string, now: number): { ledger: Ledger; sessions: number } {
  const all: Fire[] = [];
  let sessions = 0;
  for (const file of sessionFiles(sessionsDir)) {
    try {
      all.push(...firesIn(readFileSync(file, "utf8")));
      sessions += 1;
    } catch {
      // An unreadable session is skipped, not guessed at.
    }
  }
  return { ledger: toLedger(all, now), sessions };
}

/**
 * Replace the ledger, unless the scan found nothing: an empty tree — a `sessionDir`
 * this does not know about, a machine where the synced sessions have not arrived
 * yet — must not erase counts. Returns whether it wrote.
 */
export function commitBackfill(file: string, ledger: Ledger): boolean {
  if (Object.keys(ledger.skills).length === 0) return false;
  writeLedger(file, ledger);
  return true;
}
