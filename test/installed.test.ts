import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSet, type Installed } from "../src/installed.ts";

const skill = (name: string): Installed => ({ name, filePath: `/s/${name}/SKILL.md`, chars: 10, promptVisible: true });

test("before any prompt set, the commands are asked again every time", () => {
  // pi's command list grows after session_start, when extensions contribute skill
  // paths. Answering the first call and caching it hid every contributed skill.
  const early = [skill("ponytail")];
  const late = [...early, skill("xiangshan-nanhu-v5")];
  let call = 0;
  const commands = (): Installed[] => (call++ === 0 ? early : late);

  assert.deepEqual(resolveSet(null, commands).map((s) => s.name), ["ponytail"]);
  assert.deepEqual(resolveSet(null, commands).map((s) => s.name), ["ponytail", "xiangshan-nanhu-v5"]);
});

test("once pi has handed over the prompt set, the commands are never read", () => {
  const prompt = [skill("a"), skill("b")];
  const commands = (): Installed[] => {
    throw new Error("the command set must not be read once the prompt set exists");
  };
  assert.equal(resolveSet(prompt, commands), prompt);
});

test("an empty prompt set is a set, not a missing one", () => {
  // Every skill removed is the truth: fall back to the command list and the
  // skills that are gone would reappear in the table.
  const commands = (): Installed[] => [skill("gone")];
  assert.deepEqual(resolveSet([], commands), []);
});
