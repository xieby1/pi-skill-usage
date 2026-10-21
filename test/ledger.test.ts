import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { commitFire, emptyLedger, fires, MONTHS, parseLedger, readLedger, record, roll } from "../src/ledger.ts";

/** UTC month index, same arithmetic as the ledger. */
const at = (year: number, month: number, day = 15): number => Date.UTC(year, month - 1, day);
const monthly = (index: number, count: number): number[] =>
  Array.from({ length: MONTHS }, (_, i) => (i === index ? count : 0));

test("a fire lands in the current month slot", () => {
  const ledger = record(emptyLedger(at(2026, 10)), "a", at(2026, 10));
  assert.deepEqual(ledger.skills.a.m, monthly(0, 1));
  assert.equal(fires(ledger.skills.a), 1);
  assert.equal(ledger.skills.a.lastAt, at(2026, 10));
});

test("roll moves the window forward with the calendar", () => {
  const january = record(emptyLedger(at(2026, 1)), "a", at(2026, 1, 10));
  const february = roll(january, at(2026, 2, 1));
  assert.deepEqual(february.skills.a.m, monthly(1, 1));
  assert.equal(fires(february.skills.a), 1);
});

test("roll folds months that leave the window into older", () => {
  const ledger = record(emptyLedger(at(2025, 1)), "a", at(2025, 1));
  assert.deepEqual(roll(ledger, at(2025, 12)).skills.a.m, monthly(11, 1));
  const aYearOn = roll(ledger, at(2026, 1));
  assert.deepEqual(aYearOn.skills.a.m, monthly(0, 0));
  assert.equal(aYearOn.skills.a.older, 1);
  const yearsOn = roll(ledger, at(2029, 5));
  assert.deepEqual(yearsOn.skills.a.m, monthly(0, 0));
  assert.equal(yearsOn.skills.a.older, 1);
});

test("roll never shifts backwards, and a skewed clock writes to the current slot", () => {
  const ledger = record(emptyLedger(at(2026, 6)), "a", at(2026, 6));
  assert.equal(roll(ledger, at(2026, 5)), ledger);
  assert.deepEqual(record(ledger, "a", at(2026, 1)).skills.a.m, monthly(0, 2));
});

test("unusable files read as nothing recorded yet", () => {
  const now = at(2026, 10);
  assert.deepEqual(parseLedger(null, now).skills, {});
  assert.deepEqual(parseLedger("not json", now).skills, {});
  // v1 shape (no v, no month) is not migrated: one old record, deliberately lost.
  assert.deepEqual(parseLedger('{"a":{"count":2,"lastAt":5,"byModel":1,"byCommand":1}}', now).skills, {});
  assert.deepEqual(parseLedger('{"v":2,"month":"2026-10","skills":{"a":{"m":[1],"older":0}}}', now).skills, {});
  assert.deepEqual(parseLedger('{"v":2,"month":"oops","skills":{}}', now).skills, {});
});

test("parse drops skills with no fires and keeps the rest", () => {
  const now = at(2026, 10);
  const raw = JSON.stringify({
    v: 2,
    month: "2026-10",
    skills: {
      empty: { m: monthly(0, 0), older: 0, lastAt: 0 },
      old: { m: monthly(0, 0), older: 3, lastAt: 5 },
    },
  });
  const parsed = parseLedger(raw, now);
  assert.deepEqual(Object.keys(parsed.skills), ["old"]);
  assert.equal(parsed.month, 2026 * 12 + 9);
});

test("commitFire sums within a month and rolls across one", () => {
  const file = join(mkdtempSync(join(tmpdir(), "skill-usage-")), "skill-usage.json");
  commitFire(file, "a", at(2026, 10, 1));
  commitFire(file, "a", at(2026, 10, 20));
  assert.deepEqual(readLedger(file, at(2026, 10, 21)).skills.a.m, monthly(0, 2));

  commitFire(file, "a", at(2026, 11, 2));
  const after = readLedger(file, at(2026, 11, 3));
  assert.equal(after.skills.a.m[0], 1);
  assert.equal(after.skills.a.m[1], 2);
  assert.match(readFileSync(file, "utf8"), /"month": "2026-11"/);
});
