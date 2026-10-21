import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { commitFire, emptyLedger, fires, MONTHS, parseLedger, readLedger, record, roll, writeLedger } from "../src/ledger.ts";

/** UTC month index, same arithmetic as the ledger. */
const at = (year: number, month: number, day = 15): number => Date.UTC(year, month - 1, day);
/** A 12-slot array with one month's count filled in, addressing slots 1-12 like a calendar. */
const monthly = (month: number, count: number): number[] =>
  Array.from({ length: MONTHS }, (_, i) => (i === month - 1 ? count : 0));
const slots = (ledger: { skills: Record<string, { m: number[] }> }, name = "a"): string =>
  ledger.skills[name].m.map((n, i) => (n === 0 ? "" : `${i + 1}:${n}`)).filter(Boolean).join(" ");

test("a fire lands in its own month's slot", () => {
  const ledger = record(emptyLedger(at(2026, 10)), "a", at(2026, 10));
  assert.deepEqual(ledger.skills.a.m, monthly(10, 1));
  assert.equal(fires(ledger.skills.a), 1);
});

test("slots never move while the window slides", () => {
  const october = record(emptyLedger(at(2026, 10)), "a", at(2026, 10));
  const november = roll(october, at(2026, 11));
  // October's count stays in October's slot; only the anchor moves.
  assert.equal(slots(november), "10:1");
  assert.equal(november.month, 2026 * 12 + 10);
});

test("a month that leaves the window is folded into older and its slot cleared", () => {
  const january = record(emptyLedger(at(2026, 1)), "a", at(2026, 1));
  // Window after the roll is February 2026 … January 2027: January 2026 is out.
  const next = roll(january, at(2027, 1));
  assert.deepEqual(next.skills.a.m, monthly(1, 0));
  assert.equal(next.skills.a.older, 1);

  // One month earlier it is still inside the window.
  assert.equal(slots(roll(january, at(2026, 12))), "1:1");
});

test("every month that leaves the window adds to older, and later flushes keep it", () => {
  let ledger = emptyLedger(at(2025, 11));
  ledger = record(ledger, "a", at(2025, 11)); // November 2025
  ledger = record(roll(ledger, at(2026, 1)), "a", at(2026, 1)); // January 2026

  // Both months leave in one roll: older is the sum, not the last slot seen.
  const past = roll(ledger, at(2027, 2));
  assert.equal(past.skills.a.older, 2);
  assert.equal(fires(past.skills.a), 2, "no count lost");

  // A later roll that flushes an empty slot must not reset what older already holds.
  assert.equal(roll(past, at(2027, 3)).skills.a.older, 2);
});

test("rolling more than a year empties every slot into older", () => {
  const ledger = record(emptyLedger(at(2025, 1)), "a", at(2025, 1));
  const yearsOn = roll(ledger, at(2029, 5));
  assert.deepEqual(yearsOn.skills.a.m, monthly(1, 0));
  assert.equal(yearsOn.skills.a.older, 1);
});

test("roll survives a wrap past January and drops only the months that left", () => {
  let ledger = emptyLedger(at(2025, 11));
  ledger = record(ledger, "a", at(2025, 11)); // November 2025
  ledger = record(roll(ledger, at(2025, 12)), "a", at(2025, 12)); // December 2025

  // February 2026: the window still reaches back to November 2025, nothing leaves.
  const february = roll(ledger, at(2026, 2));
  assert.equal(february.skills.a.older, 0);
  assert.equal(slots(february), "11:1 12:1");

  // November 2026: the window starts at December 2025, so November 2025 leaves.
  const november = roll(ledger, at(2026, 11));
  assert.equal(november.skills.a.older, 1, "November 2025 leaves");
  assert.equal(november.skills.a.m[11], 1, "December 2025 stays");
  assert.equal(november.skills.a.m[10], 0, "November's slot is cleared");
});

test("roll never shifts backwards, and a skewed clock keeps its own month slot", () => {
  const ledger = record(emptyLedger(at(2026, 6)), "a", at(2026, 6));
  assert.equal(roll(ledger, at(2026, 5)), ledger);
  // A fire stamped in January is counted in January's slot, not in June's.
  assert.deepEqual(record(ledger, "a", at(2026, 1)).skills.a.m, monthly(1, 1).map((n, i) => n + monthly(6, 1)[i]));
});

test("unusable files read as nothing recorded yet", () => {
  const now = at(2026, 10);
  assert.deepEqual(parseLedger(null, now).skills, {});
  assert.deepEqual(parseLedger("not json", now).skills, {});
  // v1 and v2 shapes are not migrated: one old record, deliberately lost.
  assert.deepEqual(parseLedger('{"a":{"count":2,"lastAt":5,"byModel":1,"byCommand":1}}', now).skills, {});
  assert.deepEqual(parseLedger('{"v":2,"month":"2026-10","skills":{"a":{"m":[1,0,0,0,0,0,0,0,0,0,0,0],"older":0}}}', now).skills, {});
  assert.deepEqual(parseLedger('{"v":3,"month":"2026-10","skills":{"a":{"m":[1],"older":0}}}', now).skills, {});
  assert.deepEqual(parseLedger('{"v":3,"month":"oops","skills":{}}', now).skills, {});
});

test("parse drops skills with no fires and keeps the rest", () => {
  const now = at(2026, 10);
  const raw = JSON.stringify({
    v: 3,
    month: "2026-10",
    skills: {
      empty: { m: monthly(1, 0), older: 0 },
      old: { m: monthly(1, 0), older: 3 },
    },
  });
  const parsed = parseLedger(raw, now);
  assert.deepEqual(Object.keys(parsed.skills), ["old"]);
  assert.equal(parsed.month, 2026 * 12 + 9);
});

test("a fire into a symlinked directory lands in the real one", () => {
  // What lets the ledger live in a synced folder: the directory is the symlink,
  // so the temp file and the rename both happen inside the real directory.
  const root = mkdtempSync(join(tmpdir(), "skill-usage-"));
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "link"));
  commitFire(join(root, "link", "v3.json"), "a", at(2026, 10));
  assert.equal(slots(readLedger(join(root, "real", "v3.json"), at(2026, 10))), "10:1");
  assert.ok(lstatSync(join(root, "link")).isSymbolicLink(), "the rename must not replace the link");
});

test("commitFire sums within a month, rolls across one, and keeps other skills", () => {
  const file = join(mkdtempSync(join(tmpdir(), "skill-usage-")), "skill-usage.json");
  commitFire(file, "a", at(2026, 10, 1));
  commitFire(file, "a", at(2026, 10, 20));
  assert.deepEqual(readLedger(file, at(2026, 10, 21)).skills.a.m, monthly(10, 2));

  commitFire(file, "b", at(2026, 10, 22));
  const both = readLedger(file, at(2026, 10, 23));
  assert.equal(slots(both, "a"), "10:2", "a fire on b must not erase a");
  assert.equal(slots(both, "b"), "10:1");

  commitFire(file, "a", at(2026, 11, 2));
  const after = readLedger(file, at(2026, 11, 3));
  assert.equal(slots(after), "10:2 11:1");
  assert.match(readFileSync(file, "utf8"), /"month": "2026-11"/);
  assert.match(readFileSync(file, "utf8"), /"v": 3/u);
});

test("the month slots stay on one line and still read back as numbers", () => {
  const file = join(mkdtempSync(join(tmpdir(), "skill-usage-")), "skill-usage.json");
  const ledger = record(emptyLedger(at(2026, 10)), "a", at(2026, 10));
  writeLedger(file, ledger);
  const text = readFileSync(file, "utf8");
  assert.match(text, /"m": \[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0\]/u);
  assert.deepEqual(readLedger(file, at(2026, 10)).skills.a.m, monthly(10, 1));
});
