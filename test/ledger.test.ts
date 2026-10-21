import assert from "node:assert/strict";
import { test } from "node:test";

import { commitLedger, mergeLedgers, parseLedger, readLedger, record } from "../src/ledger.ts";

test("parseLedger tolerates junk and drops zero counts", () => {
  assert.deepEqual(parseLedger(null), {});
  assert.deepEqual(parseLedger("not json"), {});
  assert.deepEqual(parseLedger("[]"), {});
  const ledger = parseLedger('{"a":{"count":2,"lastAt":5,"byModel":1,"byCommand":1},"b":{"count":0}}');
  assert.deepEqual(ledger, { a: { count: 2, lastAt: 5, byModel: 1, byCommand: 1 } });
});

test("record splits model from command", () => {
  let ledger = record({}, "ponytail", "model", 100);
  ledger = record(ledger, "ponytail", "command", 90);
  assert.deepEqual(ledger.ponytail, { count: 2, lastAt: 100, byModel: 1, byCommand: 1 });
});

test("mergeLedgers adds counts on both sides", () => {
  const a = { x: { count: 2, lastAt: 10, byModel: 2, byCommand: 0 } };
  const b = { x: { count: 3, lastAt: 20, byModel: 0, byCommand: 3 }, y: { count: 1, lastAt: 5, byModel: 1, byCommand: 0 } };
  const merged = mergeLedgers(a, b);
  assert.deepEqual(merged.x, { count: 5, lastAt: 20, byModel: 2, byCommand: 3 });
  assert.deepEqual(merged.y, { count: 1, lastAt: 5, byModel: 1, byCommand: 0 });
});

test("commitLedger is additive across writers and survives a corrupt file", async () => {
  const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/pi-skill-usage-"));
  const file = `${dir}/skill-usage.json`;

  commitLedger(file, { a: { count: 1, lastAt: 1, byModel: 1, byCommand: 0 } });
  // A second "process" that still holds the old view must not erase the first write.
  commitLedger(file, { a: { count: 1, lastAt: 2, byModel: 1, byCommand: 0 } });
  assert.equal(readLedger(file).a.count, 2);

  await import("node:fs").then((fs) => fs.writeFileSync(file, "{ truncated"));
  assert.deepEqual(readLedger(file), {});
  const recovered = commitLedger(file, { b: { count: 1, lastAt: 3, byModel: 0, byCommand: 1 } });
  assert.deepEqual(Object.keys(recovered), ["b"]);
});
