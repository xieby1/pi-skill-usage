/**
 * /skill-usage — which skills earn their prompt cost, computed globally.
 *
 * The installed set has two sources, because neither alone is complete:
 *
 * - `before_agent_start`'s `systemPromptOptions.skills` is what pi actually put
 *   in the prompt, including paths contributed through `resources_discover`
 *   (pi-hermes-memory and project memory skills are contributed that way).
 * - `pi.getCommands()` is available before the first request, but on this
 *   machine it only lists skills that were registered as slash commands, which
 *   misses the `resources_discover` ones.
 *
 * So the prompt set is authoritative once a request has started, and the
 * command set covers the cold start. Costs are measured with pi's own
 * formatter, not estimated.
 */
import {
  formatSkillsForPrompt,
  getAgentDir,
  loadSkillsFromDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { commitFire, readLedger } from "./ledger.ts";
import { inputSkill, readTarget } from "./match.ts";
import { formatUsage, rows, type Row } from "./report.ts";

interface Installed {
  name: string;
  filePath: string;
  chars: number;
  promptVisible: boolean;
}

/** Real path when it exists, resolved path otherwise: Nix store skills are symlinked. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * What each skill adds to the prompt: the size of the block with it, minus the
 * block without it. Skills excluded from the prompt (disableModelInvocation)
 * cost 0 and are marked invisible instead.
 */
function measure(skills: Skill[]): Installed[] {
  const whole = formatSkillsForPrompt(skills).length;
  return skills.map((skill) => ({
    name: skill.name,
    filePath: skill.filePath,
    chars: Math.max(
      0,
      whole - formatSkillsForPrompt(skills.filter((other) => other !== skill)).length,
    ),
    promptVisible: !skill.disableModelInvocation,
  }));
}

export default function skillUsage(pi: ExtensionAPI): void {
  // The v3 shape lives in its own file: a pi window still running an older
  // extension reads another path, finds nothing, and would rewrite it in the old
  // shape — which would erase this.
  // In a directory of its own so the directory can be a symlink to a synced
  // folder: the temp file and the rename stay inside the real directory, which a
  // file-level symlink would not survive (rename replaces the link).
  const ledgerFile = resolve(getAgentDir(), "skill-usage", "v3.json");
  let installed: Installed[] = [];
  let byPath = new Map<string, string>();
  /** False until pi hands over the prompt set; the command fallback is partial. */
  let authoritative = false;
  /** Key of the set the last measurement was made for: re-measuring is quadratic. */
  let measured: string | null = null;

  function adopt(list: Installed[]): void {
    installed = list;
    byPath = new Map(list.map((skill) => [canonical(skill.filePath), skill.name]));
  }

  /** Cold start only: ask pi for the skills it registered as commands. */
  function fromCommands(): Installed[] {
    const commands = typeof pi.getCommands === "function" ? pi.getCommands() : [];
    const skills: Skill[] = [];
    for (const command of commands) {
      if (command.source !== "skill") continue;
      const filePath = command.sourceInfo?.path;
      if (!filePath) continue;
      try {
        const dir = filePath.replace(/\/SKILL\.md$/u, "");
        const skill = loadSkillsFromDir({ dir, source: "path" }).skills[0];
        if (skill) skills.push(skill);
      } catch {
        // A skill pi lists but cannot re-read is skipped rather than guessed at.
      }
    }
    return measure(skills);
  }

  function ensureReady(): void {
    if (installed.length > 0) return;
    try {
      adopt(fromCommands());
    } catch {
      // Leave it empty: better to miss a count than to break the call.
    }
  }

  function note(name: string): void {
    try {
      // One read-modify-write per fire, so nothing in memory can misbucket a
      // count when a session is still open across a month boundary.
      commitFire(ledgerFile, name, Date.now());
    } catch {
      // Never let bookkeeping break the session.
    }
  }

  function currentRows(): Row[] {
    ensureReady();
    return rows(installed, readLedger(ledgerFile, Date.now()));
  }

  pi.on("before_agent_start", (event) => {
    const list = (event as { systemPromptOptions?: { skills?: Skill[] } }).systemPromptOptions?.skills;
    if (!Array.isArray(list)) return;
    authoritative = true;
    // An empty list is the truth too: with every skill removed, the table must
    // stop showing the ones that are gone.
    const key = list.map((skill) => `${skill.filePath}\n${skill.description.length}`).join("\u0000");
    if (key === measured) return;
    measured = key;
    adopt(measure(list));
  });

  pi.on("session_start", () => ensureReady());

  pi.on("tool_call", (event, ctx: ExtensionContext) => {
    if (event.toolName !== "read") return;
    const input = event.input as { path?: unknown };
    if (typeof input?.path !== "string") return;
    ensureReady();
    const wanted = canonical(readTarget(ctx.cwd, input.path));
    for (const [path, name] of byPath) {
      if (path === wanted) {
        note(name);
        return;
      }
    }
  });

  pi.on("input", (event) => {
    ensureReady();
    // Only count skills pi actually loaded, whatever the message claims.
    const name = inputSkill(event, (wanted) => installed.some((skill) => skill.name === wanted));
    if (name) note(name);
  });

  pi.registerCommand("skill-usage", {
    description: "Prompt cost and fires per month for every skill, as a table",
    handler: async (_args: string, ctx: ExtensionContext) => {
      let report: { title: string; lines: string[] };
      try {
        report = formatUsage(currentRows());
      } catch (error) {
        await ctx.ui.select("Skill usage", [
          `Could not read skills: ${error instanceof Error ? error.message : String(error)}`,
        ]);
        return;
      }
      if (!authoritative) {
        // First line, not the end of the table: a partial skill set must not be
        // read as the whole answer, and the fix (send a message) is one step away.
        report.lines.unshift(
          "Partial: pi only reveals the full skill set once a request has started.",
          "Send one message, then run this again.",
          "",
        );
      }
      await ctx.ui.select(report.title, report.lines);
    },
  });
}
