import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readTarget, skillCommand } from "../src/match.ts";

const cwd = "/work/repo";
const known = (name: string): boolean => ["ponytail", "x"].includes(name);

test("a read path is resolved the way pi's read tool resolves it", () => {
  assert.equal(readTarget(cwd, "skills/a/SKILL.md"), "/work/repo/skills/a/SKILL.md");
  assert.equal(readTarget(cwd, "/abs/SKILL.md"), "/abs/SKILL.md");

  // pi expands `~` and strips `@`, so a read written either way did happen and
  // must still be credited to the skill.
  assert.equal(readTarget(cwd, "~/.pi/agent/skills/a/SKILL.md"), join(homedir(), ".pi/agent/skills/a/SKILL.md"));
  assert.equal(readTarget(cwd, "@/abs/SKILL.md"), "/abs/SKILL.md");

  // Only `~` and `~/` are home; `~other/x` is an ordinary relative name.
  assert.equal(readTarget(cwd, "~"), homedir());
  assert.equal(readTarget(cwd, "~other/x"), "/work/repo/~other/x");
});

test("only a leading /skill: naming a loaded skill counts as a fire", () => {
  assert.equal(skillCommand("/skill:ponytail now", known), "ponytail");
  assert.equal(skillCommand("/skill:x", known), "x");

  // pi only expands at position 0, and only skills it loaded.
  assert.equal(skillCommand("  /skill:ponytail", known), undefined);
  assert.equal(skillCommand("please run /skill:ponytail", known), undefined);
  assert.equal(skillCommand("/skill:nope", known), undefined);
  assert.equal(skillCommand("/skill:", known), undefined);
});
