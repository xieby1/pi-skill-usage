import assert from "node:assert/strict";
import { test } from "node:test";

import { formatUsage, rows, tokensOf } from "../src/report.ts";
import { MONTHS, type Ledger } from "../src/ledger.ts";

/** A 12-slot array addressed by calendar month, 1 = January. */
const monthly = (month: number, count: number): number[] =>
  Array.from({ length: MONTHS }, (_, i) => (i === month - 1 ? count : 0));

/** 2026-10, the anchor for every fixture below. */
const now = Date.UTC(2026, 9, 15);
const ledger: Ledger = { month: 2026 * 12 + 9, skills: { used: { m: monthly(8, 3), older: 0 } } };

const installed = [
  { name: "wide", chars: 400, promptVisible: true },
  { name: "narrow", chars: 40, promptVisible: true },
  { name: "hidden", chars: 400, promptVisible: false },
  { name: "used", chars: 80, promptVisible: true },
];

/** Name column is the longest installed name, so the offsets below move with it. */
const NAME_W = Math.max("skill".length, ...installed.map((skill) => skill.name.length));
const SUM_START = 7 + NAME_W + 2;
const MONTH_START = SUM_START + 4 + 2;

/** Fixed column offsets, so a test fails if the columns stop lining up. */
const cell = (line: string, start: number, width: number): string => line.slice(start, start + width).trim();
const tok = (line: string): string => cell(line, 0, 5);
const name = (line: string): string => cell(line, 7, NAME_W);
const sum = (line: string): string => cell(line, SUM_START, 4);
const month = (line: string, index: number): string => cell(line, MONTH_START + index * 3, 2);
const older = (line: string): string => cell(line, line.length - 3, 3);
const months = (line: string): string[] => Array.from({ length: MONTHS }, (_, i) => month(line, i));

const report = (all: Parameters<typeof formatUsage>[0], at = now) => formatUsage(all, at);

test("tokensOf rounds up at four characters per token", () => {
  assert.equal(tokensOf(0), 0);
  assert.equal(tokensOf(1), 1);
  assert.equal(tokensOf(400), 100);
});

test("rows treats a zero-fire entry as never fired", () => {
  const zeroed: Ledger = { month: ledger.month, skills: { used: { m: monthly(1, 0), older: 0 } } };
  assert.deepEqual(rows(installed, zeroed).map((row) => row.usage), [null, null, null, null]);
  assert.equal(rows(installed, ledger)[3].usage?.m[7], 3, "August's fires are kept");
});

test("the table has one width for every line, and months run newest first", () => {
  const lines = report(rows(installed, ledger)).lines;
  assert.equal(new Set(lines.map((line) => line.length)).size, 1);
  assert.equal(lines[0].length, 60);

  assert.deepEqual(months(lines[0]), ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "12", "11"]);
  assert.equal(older(lines[0]), ">12");
  assert.equal(name(lines[0]), "skill");
  // The rule under the header keeps the column gaps and dashes everything else.
  assert.match(lines[1], /^[ -]+$/u);
  assert.equal(lines[1].length, lines[0].length);
});

test("each skill row shows its rent, its fires and its own months", () => {
  const lines = report(rows(installed, ledger)).lines;
  const used = lines.find((line) => name(line) === "used")!;
  assert.equal(tok(used), "20");
  assert.equal(sum(used), "3");
  assert.equal(month(used, 2), "3"); // three fires in August, the third column

  const never = lines.find((line) => name(line) === "wide")!;
  assert.equal(tok(never), "100");
  assert.equal(sum(never), "0");
  assert.deepEqual(months(never), Array.from({ length: MONTHS }, () => "0"));
});

test("rows are sorted by fire count, hidden skills are left out, and the title counts", () => {
  const result = report(rows(installed, ledger));
  // `used` fired 3 times, so it leads; the never-fired rows follow by name.
  assert.deepEqual(result.lines.slice(2).map(name), ["used", "narrow", "wide"]);
  assert.match(result.title, /^Skill usage · 3 skills · 130 tok · 2 never fired$/u);
  assert.doesNotMatch(result.lines.join("\n"), /hidden/u);
});

test("older-than-a-year fires land in the last column", () => {
  const old: Ledger = { month: ledger.month, skills: { used: { m: monthly(1, 0), older: 4 } } };
  const line = report(rows(installed, old)).lines.find((l) => name(l) === "used")!;
  assert.equal(older(line), "4");
  assert.equal(sum(line), "4");
  assert.deepEqual(months(line), Array.from({ length: MONTHS }, () => "0"));
});

test("a long skill name widens the table instead of being clipped", () => {
  const name = "circle-generate-batch-import-json";
  const long = [{ name, chars: 40, promptVisible: true }];
  const lines = report(rows(long, { month: ledger.month, skills: {} })).lines;
  assert.equal(new Set(lines.map((line) => line.length)).size, 1);
  assert.equal(lines[2].slice(7, 7 + name.length), name);
  assert.equal(lines[0].slice(7, 7 + name.length), "skill".padEnd(name.length));
});

test("a count wider than its column widens the column, not the row", () => {
  // 150 fires in one month and 1200 in `>12`: both are wider than the default cells.
  const busy: Ledger = { month: ledger.month, skills: { used: { m: monthly(10, 150), older: 1200 } } };
  const lines = report(rows(installed, busy)).lines;
  assert.equal(new Set(lines.map((line) => line.length)).size, 1);

  const used = lines.find((line) => name(line) === "used")!;
  // Month cells grew to three characters, so the first month starts one column later.
  assert.equal(cell(used, MONTH_START, 3), "150");
  assert.equal(cell(used, lines[0].length - 4, 4), "1200");
});

test("an install with no prompt-visible skills says so", () => {
  const result = report([]);
  assert.deepEqual(result.lines, ["No prompt-visible skills are loaded in this session."]);
  assert.equal(result.title, "Skill usage");
});
