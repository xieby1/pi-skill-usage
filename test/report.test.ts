import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCost, formatUnused, rows, tokensOf, unusedRows } from "../src/report.ts";

const installed = [
  { name: "wide", chars: 400, promptVisible: true },
  { name: "narrow", chars: 40, promptVisible: true },
  { name: "hidden", chars: 400, promptVisible: false },
  { name: "used", chars: 80, promptVisible: true },
];

const ledger = { used: { count: 3, lastAt: 5, byModel: 2, byCommand: 1 } };

test("tokensOf rounds up at four characters per token", () => {
  assert.equal(tokensOf(0), 0);
  assert.equal(tokensOf(1), 1);
  assert.equal(tokensOf(400), 100);
});

test("unusedRows is prompt-visible only, costliest first", () => {
  assert.deepEqual(unusedRows(rows(installed, ledger)).map((row) => row.name), ["wide", "narrow"]);
});

test("a skill with zero recorded fires counts as unused", () => {
  const zeroed = { used: { count: 0, lastAt: 0, byModel: 0, byCommand: 0 } };
  assert.deepEqual(unusedRows(rows(installed, zeroed)).map((row) => row.name), ["wide", "used", "narrow"]);
});

test("formatUnused reports how many of how many, and the wasted total", () => {
  const lines = formatUnused(rows(installed, ledger));
  assert.match(lines[0], /^2 of 3 prompt-visible skills have never fired, costing 110 tokens/);
  assert.match(lines.join("\n"), /wide/);
  assert.doesNotMatch(lines.join("\n"), /hidden/);
});

test("formatUnused handles an empty install and a fully used set", () => {
  assert.match(formatUnused(rows([], {})).join("\n"), /No prompt-visible skills/);
  const allUsed = { wide: ledger.used, narrow: ledger.used, used: ledger.used };
  assert.match(formatUnused(rows(installed, allUsed))[0], /All 3 prompt-visible skills have fired/);
});

test("formatCost shows counts and last use", () => {
  const text = formatCost(rows(installed, ledger)).join("\n");
  assert.match(text, /3 prompt-visible skills, 130 tokens on every request/);
  assert.match(text, /used +3x/);
  assert.match(text, /wide +never/);
  assert.doesNotMatch(text, /hidden/);
});
