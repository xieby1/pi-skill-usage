import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { inputSkill, readTarget } from "../src/match.ts";

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
  const typed = (text: string) => inputSkill({ text, source: "interactive" }, known);
  assert.equal(typed("/skill:ponytail now"), "ponytail");
  assert.equal(typed("/skill:x"), "x");

  // pi only expands at position 0, and only skills it loaded.
  assert.equal(typed("  /skill:ponytail"), undefined);
  assert.equal(typed("please run /skill:ponytail"), undefined);
  assert.equal(typed("/skill:nope"), undefined);
  assert.equal(typed("/skill:"), undefined);
});

test("an extension alias counts the same as typing it", () => {
  // ponytail's `/ponytail-help` sends exactly this text through sendUserMessage,
  // so the sender must not decide whether the fire is counted.
  assert.equal(inputSkill({ text: "/skill:ponytail", source: "extension" }, known), "ponytail");

  // A message with no text is not a fire, whatever the source.
  assert.equal(inputSkill({ text: undefined, source: "rpc" }, known), undefined);
});
