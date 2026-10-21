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

`/skill-usage buckets` is the same data as a 13-row histogram: fires per month for
the last 12 months, then everything older than that window.

```
/skill-usage buckets
78 prompt-visible skills, 2841 tokens on every request, fires per month:

   2026-10   23    9      412 tok
   2026-09   11   11      655 tok
   2026-08    6    5      223 tok
   ...
   2025-11    0    0        0 tok
>12 months    0    0        0 tok

Columns: fires, distinct skills that fired, their prompt rent. Months are UTC.
66 of 78 prompt-visible skills never fired: see /skill-usage unused.
```

Each skill is counted once per month it fired in, so `fires` sums across rows while
`tok` does not — it is the rent of the skills that were earning it that month.

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

`~/.pi/agent/skill-usage-v2.json`, one entry per skill, global across projects and
sessions. The version is in the filename on purpose: a pi window still running an
older extension reads the other file, and would otherwise find this one empty and
rewrite it in the old shape. It looks like this:

```json
{
  "v": 2,
  "month": "2026-10",
  "skills": {
    "ponytail-review": {
      "m": [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0],
      "older": 9,
      "lastAt": 1792573000000
    }
  }
}
```

`m[0]` is the current month, `m[11]` is eleven months back, `older` is anything
older than the window. Thirteen numbers per skill, so the file is sized by how many
skills exist, not by how much you use them: nothing to prune, no retention setting
worth having.

The month array only means something relative to `"month"`, so rollover is
explicit: on every read the window slides forward to today, spilling whatever
leaves it into `older`. Reads never shift it backwards — a clock that jumped is not
a new bucket. Writes are one read-modify-write per fire: re-read, roll, add one to
the current month, atomic rename, with nothing accumulated in memory, so a session
left open across a month boundary cannot misbucket a count. Two windows firing in
the same instant can still lose one count; the rename makes each write atomic, not
the read-modify-write pair. A corrupt or v1 file reads as "nothing recorded yet".

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

## Why write this instead of installing a tracker

`COMPARISON.md` records the survey: the unused list, global counting, bounded
storage and maintenance are not satisfied together by any published package, and
lists the specific flaw in each.

## License

MIT
