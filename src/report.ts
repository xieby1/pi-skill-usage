/**
 * Turning (skills pi loaded, ledger on disk) into the answer.
 *
 * Pure on purpose: the prompt-cost function is injected, so this file can be
 * tested without pi and without touching disk.
 */
import type { Ledger } from "./ledger.ts";

export interface Row {
  name: string;
  /** Characters this skill adds to the system prompt. */
  chars: number;
  /** Rough tokens, same 4-chars-per-token rule pi's own code uses. */
  tokens: number;
  /** Whether the skill is in <available_skills> at all. */
  promptVisible: boolean;
  usage: { count: number; lastAt: number; byModel: number; byCommand: number } | null;
}

export const tokensOf = (chars: number): number => Math.ceil(chars / 4);

export function rows(installed: Array<{ name: string; chars: number; promptVisible: boolean }>, ledger: Ledger): Row[] {
  return installed.map((skill) => {
    const usage = ledger[skill.name];
    return {
      name: skill.name,
      chars: skill.chars,
      tokens: tokensOf(skill.chars),
      promptVisible: skill.promptVisible,
      usage: usage && usage.count > 0 ? usage : null,
    };
  });
}

/** Never fired, costliest first: the ones paying rent without earning it. */
export function unusedRows(all: Row[]): Row[] {
  return all
    .filter((row) => row.promptVisible && row.usage === null)
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
}

export function formatUnused(all: Row[], now = Date.now()): string[] {
  const unused = unusedRows(all);
  const observed = all.filter((row) => row.promptVisible).length - unused.length;
  const wasted = unused.reduce((sum, row) => sum + row.chars, 0);

  if (unused.length === 0) {
    return [
      `All ${observed} prompt-visible skills have fired.`,
      observed === 0 ? "No prompt-visible skills are loaded in this session." : "",
    ].filter(Boolean);
  }

  const width = Math.max(6, ...unused.map((row) => row.name.length));
  return [
    `${unused.length} of ${observed + unused.length} prompt-visible skills have never fired, ` +
      `costing ${tokensOf(wasted)} tokens on every request:`,
    "",
    ...unused.map((row) => `${String(row.tokens).padStart(6)}  ${row.name.padEnd(width)}`),
    "",
    "Counts are global, aggregate, and start when the extension was installed.",
    "Hidden (explicit-only) skills are excluded: they cost nothing until invoked.",
  ];
}

export function formatCost(all: Row[], now = Date.now()): string[] {
  const visible = all.filter((row) => row.promptVisible).sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
  const total = visible.reduce((sum, row) => sum + row.chars, 0);
  if (visible.length === 0) return ["No prompt-visible skills are loaded in this session."];

  const width = Math.max(6, ...visible.map((row) => row.name.length));
  return [
    `${visible.length} prompt-visible skills, ${tokensOf(total)} tokens on every request:`,
    "",
    ...visible.map((row) => {
      const used = row.usage ? `${row.usage.count}x` : "never";
      const last = row.usage ? new Date(row.usage.lastAt).toISOString().slice(0, 10) : "-";
      return `${String(row.tokens).padStart(6)}  ${row.name.padEnd(width)}  ${used.padStart(6)}  ${last}`;
    }),
  ];
}
