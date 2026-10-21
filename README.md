# pi-skill-usage

Which skills earn their prompt cost, answered globally: `/skill-usage unused`.

Every skill in `<available_skills>` costs tokens on every request. Most trackers
show you which skills fired; this one shows you the ones that never did, sorted
by what they actually cost, using pi's own prompt formatter rather than an
estimate.

```
/skill-usage unused
69 of 78 prompt-visible skills have never fired, costing 2841 tokens on every request:

   152  ponytail-review
   146  home-manager-git-ssh-guest-keys
   145  circle-generate-batch-import-json
   ...
```

`/skill-usage cost` lists every prompt-visible skill with its cost, fire count and
last use.

## Install

```bash
pi install npm:pi-skill-usage
```

Or, without installing:

```bash
pi -e npm:pi-skill-usage
```

## What counts as a fire

Two things, both observable from an extension:

- **model** — the agent `read`s a skill's `SKILL.md`. pi's prompt tells it to do
  exactly that when a task matches.
- **command** — you type `/skill:<name>`.

A skill driven through its own `scripts/` by `bash`, without either of those, is
not credited. Nothing can see that.

## Storage

`~/.pi/agent/skill-usage.json`, one aggregate entry per skill, global across
projects and sessions:

```json
{ "ponytail-review": { "count": 12, "lastAt": 1792573000000, "byModel": 9, "byCommand": 3 } }
```

Sized by how many skills exist, not by how much you use them, so there is nothing
to prune and no retention setting worth having. Writes re-read and sum before an
atomic rename, so concurrent pi windows never lose each other's counts; a corrupt
file reads as "nothing recorded yet".

Counts start when the extension is installed — there is no backfill from old
sessions.

## Where the installed set comes from

Two sources, because neither alone is complete:

- `before_agent_start`'s `systemPromptOptions.skills` — exactly what pi put in the
  prompt, including paths contributed through `resources_discover`. On a machine
  using pi-hermes-memory, most skills arrive this way and are *not* registered as
  slash commands.
- `pi.getCommands()` — available before the first request, but only lists skills
  that pi registered as commands.

The prompt set wins once a request has started. Before that, the command set is
all that exists, so `/skill-usage` marks itself **Partial** and tells you to send
one message first. Re-scanning known skill directories, or calling `loadSkills()`
with default paths, misses nearly everything on a configured machine — that
mistake is why some trackers answer "No skills loaded" in a fresh session.

## License

MIT
