# pi-skill-usage

Which skills earn their prompt cost, answered globally: `/skill-usage`, one table,
no arguments.

Every skill in `<available_skills>` costs tokens on every request. Most trackers
show you which skills fired; this one shows you what each one costs and when it
last earned that cost, using pi's own prompt formatter rather than an estimate.

```
Skill usage · 78 skills · 2841 tok · 69 never fired

  tok  skill                      sum  10  9  8  7  6  5  4  3  2  1 12 11 >12
  ---  -----                      ---  --  -  -  -  -  -  -  -  -  - -- -- ---
  152  ponytail-review              7   2  1  0  4  0  0  0  0  0  0  0  0   0
  120  xiangshan-nanhu-v5           7   0  0  0  0  0  0  0  0  0  0  0  0   7
  145  circle-generate-batch-i…     0   0  0  0  0  0  0  0  0  0  0  0  0   0
  146  home-manager-package-up…     0   0  0  0  0  0  0  0  0  0  0  0  0   0
  ...
```

**`tok`** is what the skill adds to every request. **`sum`** is how many times it
fired in total. The twelve numbers after that are fires per month, this month
first and going back — with today in October they are `10 9 … 1` of this year,
then `12 11` of last year — and **`>12`** is everything older than a year.

The `tok` total and the skill count are in the heading; the table itself is
nothing but skills, so it answers "what does this cost me", "which skills are
dead" (a row of zeros) and "is my use of skills fading" (the right-hand columns
filling up). Rows are ranked by `sum`, most-fired first, so everything that never
fired collects at the bottom in name order. A newly installed extension shows
zeros in `>12` until it has been running for a year.

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

`~/.pi/agent/skill-usage-v3.json`, one entry per skill, global across projects and
sessions. The version is in the filename on purpose: a pi window still running an
older extension reads another path, and would otherwise find this one empty and
rewrite it in the old shape. It looks like this:

```json
{
  "v": 3,
  "month": "2026-10",
  "skills": {
    "ponytail-review": {
      "m": [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2],
      "older": 9
    }
  }
}
```

`m` is indexed by month of the year: `m[0]` is January, `m[11]` is December. Each
slot holds the count for the most recent occurrence of that month, so with the
anchor in October `m[9]` is this October, `m[8]` this September, and `m[11]` last
December. The slot never moves; `older` is everything before the twelve-month
window. Thirteen numbers per skill, so the file is sized by how many skills exist,
not by how much you use them: nothing to prune, no retention setting worth having.

The slots are relative to `"month"`, so rollover is explicit: on every read the
window slides to today, and each month that leaves it is added to `older` and its
slot zeroed. Reads never shift it backwards — a clock that jumped is not a new
bucket, and a fire stamped before the window is counted in its own month's slot.
Writes are one read-modify-write per fire: re-read, roll, add one, atomic rename,
with nothing accumulated in memory, so a session left open across a month boundary
cannot misbucket a count. Two windows firing in the same instant can still lose one
count; the rename makes each write atomic, not the read-modify-write pair. A
corrupt or older-schema file reads as "nothing recorded yet".

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
