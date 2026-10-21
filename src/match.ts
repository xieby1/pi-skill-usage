/**
 * The two rules that decide what counts as a fire, kept out of `usage.ts` so
 * they can be tested without the pi package installed.
 *
 * Both mirror pi exactly, because a fire the extension invents or misses is a
 * wrong answer to the only question this package asks.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The file a `read` call names, resolved the way pi's read tool resolves it: a
 * leading `@` is a file-reference marker, and a leading `~` is the home
 * directory. pi expands only `~` and `~/`, so `~other/x` is an ordinary name.
 */
export function readTarget(cwd: string, path: string): string {
  const bare = path.replace(/^@/u, "");
  const expanded = bare === "~" || bare.startsWith("~/") ? join(homedir(), bare.slice(2)) : bare;
  return resolve(cwd, expanded);
}

/**
 * The skill an `input` event fires, if any. pi expands `/skill:<name>` only at the
 * very start of the text (`startsWith`, after the editor trims), and only for a
 * skill it loaded, so a command in the middle of a sentence is not a fire.
 *
 * `source` is ignored on purpose: an extension alias such as ponytail's
 * `/ponytail-help` sends this same text, and pi expands it the same way.
 */
export function inputSkill(
  event: { text?: unknown; source: string },
  known: (name: string) => boolean,
): string | undefined {
  if (typeof event.text !== "string") return undefined;
  const match = /^\/skill:([\w.:-]+)/u.exec(event.text);
  return match && known(match[1]) ? match[1] : undefined;
}
