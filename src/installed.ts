/**
 * Which skill set the table and the counting use, kept out of `usage.ts` so the
 * rule can be tested without the pi package installed.
 *
 * pi hands over the prompt set only once a request starts, and the command list is
 * the whole set only after `resources_discover` has contributed the paths other
 * extensions add — which happens after `session_start`. So the rule is "the prompt
 * set if there is one, otherwise ask the commands again, every time". Caching the
 * first answer hid every pi-hermes-memory skill for a whole session, and dropped
 * the fire of a `/skill:<name>` typed as the session's first message.
 */

export interface Installed {
  name: string;
  filePath: string;
  /** Characters this skill adds to the system prompt. */
  chars: number;
  promptVisible: boolean;
}

/** The prompt set once pi has given it, else whatever the command list says now. */
export function resolveSet(prompt: Installed[] | null, commands: () => Installed[]): Installed[] {
  return prompt ?? commands();
}
