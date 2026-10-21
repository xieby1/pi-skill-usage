import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { backfill, commitBackfill, firesIn, toLedger, type Fire } from "../src/backfill.ts";
import { emptyLedger, fires, MONTHS, readLedger, record, writeLedger } from "../src/ledger.ts";

const at = (year: number, month: number, day = 15): number => Date.UTC(year, month - 1, day);
const monthly = (month: number, count: number): number[] =>
  Array.from({ length: MONTHS }, (_, i) => (i === month - 1 ? count : 0));

/** Records shaped like pi writes them, one per line. */
const session = (cwd: string, records: Array<[string, unknown]>): string =>
  [
    JSON.stringify({ type: "session", version: 3, cwd }),
    ...records.map(([timestamp, message]) => JSON.stringify({ type: "message", timestamp, message })),
  ].join("\n") + "\n";

const read = (path: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", name: "read", arguments: { path } }],
});

const typed = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

test("only the two live rules count, never text that merely looks like them", () => {
  const text = session("/home/u/work", [
    ["2026-09-01T00:00:00Z", typed("/skill:ponytail-review")],
    ["2026-09-02T00:00:00Z", typed("please read /skill:ponytail-review")],
    ["2026-09-03T00:00:00Z", read("~/.pi/agent/extensions/ponytail/skills/ponytail/SKILL.md")],
    ["2026-09-04T00:00:00Z", read("skills/local-skill/SKILL.md")],
    ["2026-09-05T00:00:00Z", read("README.md")],
    ["2026-09-06T00:00:00Z", { role: "toolResult", content: "see /skills/fake/SKILL.md" }],
    ["2026-09-07T00:00:00Z", { role: "assistant", content: [{ type: "text", text: "/skill:fake" }] }],
  ]);
  assert.deepEqual(
    firesIn(text).map((fire) => fire.name),
    ["ponytail-review", "ponytail", "local-skill"],
  );
});

test("a fire is credited to the skill's directory, so a rename keeps its old entry", () => {
  const text = session("/home/u/work", [
    ["2026-09-03T00:00:00Z", read("@/nix/store/abc-pkg/skills/old-name/SKILL.md")],
  ]);
  assert.equal(firesIn(text)[0].name, "old-name");
});

test("a conflict copy is the same session twice, so it is not scanned", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-usage-"));
  const project = join(dir, "sessions", "--work--");
  mkdirSync(project, { recursive: true });
  const body = session("/home/u/work", [["2026-09-01T00:00:00Z", typed("/skill:ponytail")]]);
  writeFileSync(join(project, "2026-09-01T00-00-00-000Z_one.jsonl"), body);
  writeFileSync(join(project, "2026-09-01T00-00-00-000Z_one.sync-conflict-20260902-000000-ABC.jsonl"), body);

  const { ledger, sessions } = backfill(join(dir, "sessions"), at(2026, 10));
  assert.equal(sessions, 1);
  assert.deepEqual(ledger.skills.ponytail.m, monthly(9, 1));
});

test("fires inside the window land in their month, older ones in older", () => {
  const all: Fire[] = [
    { name: "a", at: at(2025, 1) }, // 21 months back: out
    { name: "a", at: at(2025, 9) }, // 13 months back: out, same slot as 2026-09
    { name: "a", at: at(2026, 9) },
    { name: "a", at: at(2026, 9) },
    { name: "a", at: at(2026, 10) },
    { name: "b", at: at(2026, 12) }, // a clock that ran ahead of the anchor
  ];
  const ledger = toLedger(all, at(2026, 10));
  assert.equal(ledger.month, 2026 * 12 + 9);
  // September twice, October once, and 2025-09 folded out rather than added to September.
  assert.deepEqual(ledger.skills.a.m, [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0]);
  assert.equal(ledger.skills.a.older, 2);
  assert.equal(fires(ledger.skills.a), 5);
  assert.equal(ledger.skills.b, undefined);
});

test("a rebuild replaces the file, so a second run changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-usage-"));
  const project = join(dir, "sessions", "--work--");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "2026-09-01T00-00-00-000Z_one.jsonl"),
    session("/home/u/work", [["2026-09-01T00:00:00Z", typed("/skill:ponytail")]]),
  );
  const file = join(dir, "v3.json");
  const run = (): number => {
    const { ledger } = backfill(join(dir, "sessions"), at(2026, 10));
    writeLedger(file, ledger);
    return fires(readLedger(file, at(2026, 10)).skills.ponytail);
  };
  assert.equal(run(), 1);
  assert.equal(run(), 1);
});

test("a scan that finds nothing leaves the ledger alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-usage-"));
  const file = join(dir, "v3.json");
  writeLedger(file, record(emptyLedger(at(2026, 10)), "ponytail", at(2026, 10)));

  assert.equal(commitBackfill(file, toLedger([], at(2026, 10))), false);
  assert.equal(fires(readLedger(file, at(2026, 10)).skills.ponytail), 1);
});
