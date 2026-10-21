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

import { commitLedger, readLedger, record, type Ledger } from "./ledger.ts";
import { formatCost, formatUnused, rows, type Row } from "./report.ts";

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
  const ledgerFile = resolve(getAgentDir(), "skill-usage.json");
  let ledger: Ledger = readLedger(ledgerFile);
  let installed: Installed[] = [];
  let byPath = new Map<string, string>();
  /** False until pi hands over the prompt set; the command fallback is partial. */
  let authoritative = false;

  function adopt(list: Installed[]): void {
    if (list.length === 0) return; // never replace a good set with nothing
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

  function note(name: string, by: "model" | "command"): void {
    ledger = record(ledger, name, by, Date.now());
    try {
      // Aggregate counters, so this file stays tiny; re-read and sum inside
      // commitLedger keeps concurrent pi windows from overwriting each other.
      ledger = commitLedger(ledgerFile, ledger);
    } catch {
      // Never let bookkeeping break the session.
    }
  }

  function currentRows(): Row[] {
    ensureReady();
    ledger = readLedger(ledgerFile);
    return rows(installed, ledger);
  }

  pi.on("before_agent_start", (event) => {
    const list = (event as { systemPromptOptions?: { skills?: Skill[] } }).systemPromptOptions?.skills;
    if (Array.isArray(list) && list.length > 0) {
      authoritative = true;
      adopt(measure(list));
    }
  });

  pi.on("session_start", () => ensureReady());

  pi.on("tool_call", (event, ctx: ExtensionContext) => {
    if (event.toolName !== "read") return;
    const input = event.input as { path?: unknown };
    if (typeof input?.path !== "string") return;
    ensureReady();
    const wanted = canonical(resolve(ctx.cwd, input.path));
    for (const [path, name] of byPath) {
      if (path === wanted) {
        note(name, "model");
        return;
      }
    }
  });

  pi.on("input", (event) => {
    if (event.source === "extension" || typeof event.text !== "string") return;
    const match = /^\s*\/skill:([\w.:-]+)/u.exec(event.text);
    if (!match) return;
    ensureReady();
    const name = match[1];
    // Only count skills pi actually loaded, whatever the message claims.
    if (installed.some((skill) => skill.name === name)) note(name, "command");
  });

  pi.registerCommand("skill-usage", {
    description: "Prompt cost and fire counts per skill: /skill-usage [unused|cost]",
    handler: async (args: string, ctx: ExtensionContext) => {
      const route = args.trim().toLowerCase() || "unused";
      if (route !== "unused" && route !== "cost") {
        await ctx.ui.select("Skill usage", ["Usage: /skill-usage [unused | cost]"]);
        return;
      }
      let list: Row[];
      try {
        list = currentRows();
      } catch (error) {
        await ctx.ui.select("Skill usage", [
          `Could not read skills: ${error instanceof Error ? error.message : String(error)}`,
        ]);
        return;
      }
      const lines = route === "cost" ? formatCost(list) : formatUnused(list);
      if (!authoritative) {
        lines.push(
          "",
          "Partial: pi only reveals the full skill set once a request has started.",
          "Send one message, then run this again.",
        );
      }
      await ctx.ui.select(`Skill usage · ${route}`, lines);
    },
  });
}
