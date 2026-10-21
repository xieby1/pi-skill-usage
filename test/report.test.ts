import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBuckets, formatCost, formatUnused, rows, tokensOf, unusedRows } from "../src/report.ts";
import { MONTHS, type Ledger, type Usage } from "../src/ledger.ts";

const monthly = (index: number, count: number): number[] =>
  Array.from({ length: MONTHS }, (_, i) => (i === index ? count : 0));

/** 2026-10, the anchor for every fixture below. */
const now = Date.UTC(2026, 9, 15);
const ledger: Ledger = { month: 2026 * 12 + 9, skills: { used: { m: monthly(2, 3), older: 0, lastAt: 5 } } };

const installed = [
  { name: "wide", chars: 400, promptVisible: true },
  { name: "narrow", chars: 40, promptVisible: true },
  { name: "hidden", chars: 400, promptVisible: false },
  { name: "used", chars: 80, promptVisible: true },
];

test("tokensOf rounds up at four characters per token", () => {
  assert.equal(tokensOf(0), 0);
  assert.equal(tokensOf(1), 1);
  assert.equal(tokensOf(400), 100);
});

test("unusedRows is prompt-visible only, costliest first", () => {
  assert.deepEqual(unusedRows(rows(installed, ledger)).map((row) => row.name), ["wide", "narrow"]);
});

test("a skill with zero recorded fires counts as unused", () => {
  const zeroed: Ledger = { month: ledger.month, skills: { used: { m: monthly(0, 0), older: 0, lastAt: 0 } } };
  assert.deepEqual(unusedRows(rows(installed, zeroed)).map((row) => row.name), ["wide", "used", "narrow"]);
});

test("formatUnused reports how many of how many, and the wasted total", () => {
  const lines = formatUnused(rows(installed, ledger));
  assert.match(lines[0], /^2 of 3 prompt-visible skills have never fired, costing 110 tokens/);
  assert.match(lines.join("\n"), /wide/);
  assert.doesNotMatch(lines.join("\n"), /hidden/);
});

test("formatUnused handles an empty install and a fully used set", () => {
  assert.match(formatUnused(rows([], { month: ledger.month, skills: {} })).join("\n"), /No prompt-visible skills/);
  const allUsed: Ledger = {
    month: ledger.month,
    skills: { wide: ledger.skills.used, narrow: ledger.skills.used, used: ledger.skills.used },
  };
  assert.match(formatUnused(rows(installed, allUsed))[0], /All 3 prompt-visible skills have fired/);
});

test("formatCost shows counts and last use", () => {
  const text = formatCost(rows(installed, ledger)).join("\n");
  assert.match(text, /3 prompt-visible skills, 130 tokens on every request/);
  assert.match(text, /used +3x/);
  assert.match(text, /wide +never/);
  assert.doesNotMatch(text, /hidden/);
});

test("formatBuckets is fires per month, then everything older than the window", () => {
  const skills: Record<string, Usage> = {
    this: { m: monthly(0, 2), older: 0, lastAt: now },
    then: { m: monthly(3, 1), older: 0, lastAt: now },
    old: { m: monthly(0, 0), older: 3, lastAt: 5 },
  };
  const list = [
    { name: "this", chars: 400, promptVisible: true },
    { name: "then", chars: 40, promptVisible: true },
    { name: "old", chars: 80, promptVisible: true },
    { name: "never", chars: 80, promptVisible: true },
    { name: "hidden", chars: 400, promptVisible: false },
  ];
  const lines = formatBuckets(rows(list, { month: ledger.month, skills }), now);
  const text = lines.join("\n");

  assert.match(lines[0], /^4 prompt-visible skills, 150 tokens on every request/);
  assert.match(text, /2026-10 +2 +1 +100 tok/);
  assert.match(text, /2026-07 +1 +1 +10 tok/); // three months back
  assert.match(text, />12 months +3 +1 +20 tok/);
  assert.match(text, /1 of 4 prompt-visible skills never fired/);
  assert.equal(lines.filter((line) => line.endsWith(" tok")).length, 13);
  assert.doesNotMatch(text, /hidden/);
});
