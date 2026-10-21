/**
 * Turning (skills pi loaded, ledger on disk) into the answer.
 *
 * Pure on purpose: the prompt-cost function is injected, so this file can be
 * tested without pi and without touching disk.
 */
import { fires, monthKey, monthOf, MONTHS, type Ledger, type Usage } from "./ledger.ts";

export interface Row {
  name: string;
  /** Characters this skill adds to the system prompt. */
  chars: number;
  /** Rough tokens, same 4-chars-per-token rule pi's own code uses. */
  tokens: number;
  /** Whether the skill is in <available_skills> at all. */
  promptVisible: boolean;
  /** Null when the skill has never fired. */
  usage: Usage | null;
}

export const tokensOf = (chars: number): number => Math.ceil(chars / 4);

export function rows(installed: Array<{ name: string; chars: number; promptVisible: boolean }>, ledger: Ledger): Row[] {
  return installed.map((skill) => {
    const usage = ledger.skills[skill.name];
    return {
      name: skill.name,
      chars: skill.chars,
      tokens: tokensOf(skill.chars),
      promptVisible: skill.promptVisible,
      usage: usage && fires(usage) > 0 ? usage : null,
    };
  });
}

/** Never fired, costliest first: the ones paying rent without earning it. */
export function unusedRows(all: Row[]): Row[] {
  return all
    .filter((row) => row.promptVisible && row.usage === null)
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
}

export function formatUnused(all: Row[]): string[] {
  const unused = unusedRows(all);
  const observed = all.filter((row) => row.promptVisible).length;
  const wasted = unused.reduce((sum, row) => sum + row.chars, 0);

  if (unused.length === 0) {
    return [
      `All ${observed} prompt-visible skills have fired.`,
      observed === 0 ? "No prompt-visible skills are loaded in this session." : "",
    ].filter(Boolean);
  }

  const width = Math.max(6, ...unused.map((row) => row.name.length));
  return [
    `${unused.length} of ${observed} prompt-visible skills have never fired, ` +
      `costing ${tokensOf(wasted)} tokens on every request:`,
    "",
    ...unused.map((row) => `${String(row.tokens).padStart(6)}  ${row.name.padEnd(width)}`),
    "",
    "Counts are global and start when the extension was installed.",
    "Hidden (explicit-only) skills are excluded: they cost nothing until invoked.",
  ];
}

/**
 * Fires per month across all prompt-visible skills, then one row for everything
 * older than the window. The caller must have rolled the ledger to `now`, so
 * `m[0]` is this month.
 */
export function formatBuckets(all: Row[], now = Date.now()): string[] {
  const visible = all.filter((row) => row.promptVisible);
  if (visible.length === 0) return ["No prompt-visible skills are loaded in this session."];

  const buckets = Array.from({ length: MONTHS + 1 }, () => ({ fires: 0, skills: 0, chars: 0 }));
  for (const row of visible) {
    if (!row.usage) continue;
    // Index MONTHS is the `older` slot: same shape, one extra row.
    for (const [index, count] of [...row.usage.m, row.usage.older].entries()) {
      if (count === 0) continue;
      const slot = buckets[index];
      slot.fires += count;
      slot.skills += 1;
      slot.chars += row.chars;
    }
  }

  const nowMonth = monthOf(now);
  const label = (index: number): string => (index === MONTHS ? ">12 months" : monthKey(nowMonth - index));
  const total = visible.reduce((sum, row) => sum + row.chars, 0);
  const never = unusedRows(all).length;

  return [
    `${visible.length} prompt-visible skills, ${tokensOf(total)} tokens on every request, fires per month:`,
    "",
    ...buckets.map(
      (slot, index) =>
        `${label(index).padStart(10)}  ${String(slot.fires).padStart(5)}  ${String(slot.skills).padStart(3)}  ` +
        `${String(tokensOf(slot.chars)).padStart(6)} tok`,
    ),
    "",
    "Columns: fires, distinct skills that fired, their prompt rent. Months are UTC.",
    `${never} of ${visible.length} prompt-visible skills never fired: see /skill-usage unused.`,
  ];
}

export function formatCost(all: Row[]): string[] {
  const visible = all.filter((row) => row.promptVisible).sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
  const total = visible.reduce((sum, row) => sum + row.chars, 0);
  if (visible.length === 0) return ["No prompt-visible skills are loaded in this session."];

  const width = Math.max(6, ...visible.map((row) => row.name.length));
  return [
    `${visible.length} prompt-visible skills, ${tokensOf(total)} tokens on every request:`,
    "",
    ...visible.map((row) => {
      const used = row.usage ? `${fires(row.usage)}x` : "never";
      const last = row.usage ? new Date(row.usage.lastAt).toISOString().slice(0, 10) : "-";
      return `${String(row.tokens).padStart(6)}  ${row.name.padEnd(width)}  ${used.padStart(6)}  ${last}`;
    }),
  ];
}
