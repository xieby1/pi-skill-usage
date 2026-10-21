/**
 * /skill-usage — which skills earn their prompt cost, computed globally.
 *
 * The installed set has two sources, because one of them arrives late:
 *
 * - `before_agent_start`'s `systemPromptOptions.skills` is what pi actually put
 *   in the prompt, including paths contributed through `resources_discover`
 *   (pi-hermes-memory and project memory skills are contributed that way).
 * - `pi.getCommands()` is available before the first request, and reads the same
 *   resource loader the prompt is built from — but only once `resources_discover`
 *   has contributed its paths, which happens after `session_start`. Reading it
 *   there (and caching that answer) sees 6 skills where the prompt has 28.
 *
 * So the prompt set is authoritative once a request has started, and the command
 * set, re-read on every cold-start use, covers everything before that. Costs are
 * measured with pi's own formatter, not estimated.
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
import { basename, dirname, resolve } from "node:path";

import { backfill, commitBackfill } from "./backfill.ts";
import { resolveSet, type Installed } from "./installed.ts";
import { commitFire, fires, readLedger } from "./ledger.ts";
import { inputSkill, readTarget } from "./match.ts";
import { formatUsage, rows, type Row } from "./report.ts";

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
  /** The prompt set, once pi has handed it over; the command set is read until then. */
  let promptSet: Installed[] | null = null;
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

  /** Take the prompt set if pi has given it, else re-read the command set. */
  function refresh(): void {
    try {
      adopt(resolveSet(promptSet, fromCommands));
    } catch {
      // Keep whatever is already adopted: better to miss a count than to break the call.
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
    refresh();
    return rows(installed, readLedger(ledgerFile, Date.now()));
  }

  pi.on("before_agent_start", (event) => {
    const list = (event as { systemPromptOptions?: { skills?: Skill[] } }).systemPromptOptions?.skills;
    if (!Array.isArray(list)) return;
    // An empty list is the truth too: with every skill removed, the table must
    // stop showing the ones that are gone.
    const key = list.map((skill) => `${skill.filePath}\n${skill.description.length}`).join("\u0000");
    if (key === measured) return;
    measured = key;
    promptSet = measure(list);
    adopt(promptSet);
  });

  pi.on("tool_call", (event, ctx: ExtensionContext) => {
    if (event.toolName !== "read") return;
    const input = event.input as { path?: unknown };
    if (typeof input?.path !== "string") return;
    refresh();
    const wanted = canonical(readTarget(ctx.cwd, input.path));
    for (const [path, name] of byPath) {
      if (path === wanted) {
        note(name);
        return;
      }
    }
  });

  pi.on("input", (event) => {
    // The first message of a session arrives before any prompt set exists.
    refresh();
    // Only count skills pi actually loaded, whatever the message claims.
    const name = inputSkill(event, (wanted) => installed.some((skill) => skill.name === wanted));
    if (name) note(name);
  });

  /**
   * The root of pi's session tree. `getSessionDir()` is where sessions are written:
   * a per-project subdirectory of the default root, or a configured `sessionDir`
   * as-is. `PI_SESSION_FILE` is no use here — pi sets it for bash tool children,
   * not for this process.
   */
  function sessionsDir(ctx: ExtensionContext): string {
    const dir = ctx.sessionManager.getSessionDir();
    return basename(dir).startsWith("--") ? dirname(dir) : dir;
  }

  // The command set is the whole set once `resources_discover` has run, so there is
  // nothing partial left to warn about: the table is the answer either way.
  const report = (): { title: string; lines: string[] } => formatUsage(currentRows());

  const show = async (
    lines: () => { title: string; lines: string[] },
    ctx: ExtensionContext,
  ): Promise<void> => {
    try {
      const { title, lines: body } = lines();
      await ctx.ui.select(title, body);
    } catch (error) {
      await ctx.ui.select("Skill usage", [
        `Could not read skills: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  };

  pi.registerCommand("skill-usage", {
    description: "Prompt cost and fires per month for every skill, as a table",
    handler: async (_args: string, ctx: ExtensionContext) => show(report, ctx),
  });

  // Its own command, not a flag: it is a one-shot rebuild, and running it is the
  // only way to lose the live counts it replaces.
  pi.registerCommand("skill-usage-backfill", {
    description: "Rebuild the ledger from the session logs, then show the table",
    handler: async (_args: string, ctx: ExtensionContext) =>
      show(() => {
        const { ledger, sessions } = backfill(sessionsDir(ctx), Date.now());
        // Nothing found means the scan hit the wrong tree: the counts stay.
        if (!commitBackfill(ledgerFile, ledger)) {
          return { title: "Skill usage", lines: ["No fires in the session logs. Ledger left untouched."] };
        }
        const total = Object.values(ledger.skills).reduce((sum, usage) => sum + fires(usage), 0);
        const usage = report();
        usage.lines.unshift(
          `Rebuilt from ${sessions} session logs: ${total} fires, ${Object.keys(ledger.skills).length} skills.`,
          "Safe to run again: it replaces the file rather than adding to it.",
          "",
        );
        return usage;
      }, ctx),
  });
}
