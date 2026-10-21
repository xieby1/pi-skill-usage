/**
 * Turning (skills pi loaded, ledger on disk) into the answer.
 *
 * Pure on purpose: nothing here imports pi or touches disk, so the table can be
 * tested without the peer package installed.
 */
import { fires, monthOf, MONTHS, type Ledger, type Usage } from "./ledger.ts";

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

/** Name column width; with the 13 month columns this keeps a row inside 80 columns. */
const NAME = 24;

/**
 * One row per prompt-visible skill: what its prompt cost is, how often it fired
 * in each of the last twelve months (this month first, then back, then
 * everything older). The totals live in the title, so every row is a skill.
 *
 * Fixed-width text rather than a markdown table: pi renders those through
 * `ctx.ui.select`, which truncates every line to the terminal width, and pi's
 * markdown table renderer puts a border around every column and cannot
 * right-align numbers.
 *
 * Skill names are ASCII identifiers, so slicing them keeps the columns aligned
 * without a width library.
 */
export function formatUsage(all: Row[], now = Date.now()): { title: string; lines: string[] } {
  const visible = all.filter((row) => row.promptVisible);
  if (visible.length === 0) {
    return { title: "Skill usage", lines: ["No prompt-visible skills are loaded in this session."] };
  }

  const nowMonth = monthOf(now);
  // Column i is the month i steps back; its slot is that month's number, which is
  // also the label, so the two cannot drift apart.
  const columns = Array.from({ length: MONTHS }, (_, i) => (nowMonth - i) % MONTHS);
  // Counts can outgrow a fixed column. Widen the columns to the data rather than
  // let one busy row drift out of line with the header.
  const monthWidth = Math.max(
    2,
    ...visible.flatMap((row) => Array.from(columns, (slot) => String(row.usage?.m[slot] ?? 0).length)),
  );
  const olderWidth = Math.max(3, ...visible.map((row) => String(row.usage?.older ?? 0).length));
  const cell = (value: string | number, width: number): string => String(value).padStart(width);
  const line = (tok: string, name: string, sum: string, m: Array<string | number>, older: string): string =>
    `${cell(tok, 5)}  ${name.length > NAME ? `${name.slice(0, NAME - 1)}…` : name.padEnd(NAME)}  ` +
    `${cell(sum, 4)}  ${m.map((n) => cell(n, monthWidth)).join(" ")} ${cell(older, olderWidth)}`;

  const header = line("tok", "skill", "sum", columns.map((slot) => slot + 1), ">12");
  const body = visible
    .sort((a, b) => (b.usage ? fires(b.usage) : 0) - (a.usage ? fires(a.usage) : 0) || a.name.localeCompare(b.name))
    .map((row) =>
      line(
        String(row.tokens),
        row.name,
        String(row.usage ? fires(row.usage) : 0),
        columns.map((slot) => row.usage?.m[slot] ?? 0),
        String(row.usage?.older ?? 0),
      ),
    );

  const never = visible.filter((row) => row.usage === null).length;
  const chars = visible.reduce((sum, row) => sum + row.chars, 0);
  return {
    title: `Skill usage · ${visible.length} skills · ${tokensOf(chars)} tok · ${never} never fired`,
    lines: [
      header,
      // Dash the header in place: the column gaps stay, so it lines up by construction.
      header.replace(/[^ ]/gu, "-"),
      ...body,
    ],
  };
}
