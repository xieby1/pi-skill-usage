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
one message first.

`pi.getCommands()` is built at startup from the fully resolved skill set
(`dist/core/agent-session.js`, `_bindExtensionCore`):

```js
const skills = this._resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    source: "skill",
    sourceInfo: skill.sourceInfo,
}));
```

Extension-contributed paths (`pi-hermes-memory/skills`,
`projects-memory/<project>/skills`), `.agents/skills` and package skills are all
included, and it is available before any request. Re-scanning known skill
directories, or calling `loadSkills()` with default paths, would miss nearly
everything on a configured machine — that mistake is why some trackers answer
"No skills loaded" in a fresh session.

## Why write this instead of installing a tracker

Decision record for "which of my skills are dead weight?", written 2026-10-21
against `pi-coding-agent` 1.2.0. Four requirements, none of which any published
package satisfied together:

- **R1 — answers the question.** Reports the skills that have *not* fired, not just
  the ones that have. Reading a list of used skills and subtracting my own installed
  set by hand is the thing I wanted to stop doing.
- **R2 — global.** One answer across projects. "Unused in this repo" is a weaker
  question than "unused everywhere", and most of my skills are global
  (`pi-hermes-memory/skills`).
- **R3 — bounded storage.** Usage counters must not grow without limit, or must come
  with a retention mechanism. A log that only `rm` can shrink is a liability.
- **R4 — maintained.** Reasonable release cadence and some evidence that someone else
  uses it, or code small enough to audit in one sitting.

The trust boundary is the one described above, in
[What counts as a fire](#what-counts-as-a-fire).

| package | version / last release | R1 unused | R2 global | R3 bounded | R4 maintained | verdict |
|---|---|---|---|---|---|---|
| `pi-tool-stats` | 1.1.1, 2026-05-31 | yes | yes | no — 2 records per tool call, ~43 MB/year, `rm` only | no — 3 versions, no repo link, single author | rejected: storage + abandonment |
| `@pify/skills` | 0.4.0, 2026-09-17 | yes | **no** — per-project ledger | yes — aggregate, flat | weak — 0 stars, but active | rejected: project-keyed only |
| `@narumitw/pi-analytics` | 0.49.11, 2026-09-20 | **no** — lists used skills only | yes | weak — JSONL generations, no retention setting | yes — 721-star repo, 14 releases | best of the packages, still fails R1 |
| `@signalridge/pi-analytics` | 1.4.0, 2026-10-18 | no — same design as narumitw | yes | weak — same | weak — 4 stars, marked experimental | rejected: clone with less traction |
| `pi-local-stats` | 0.0.4, 2026-09-09 | no — skills are one dashboard tab | yes | yes — SQLite index, rebuildable | weak — 1 star | rejected: no unused view |
| `pi-tokenburn` | 0.5.8, 2026-10-15 | no — tokens/cost only | yes | yes — per-file cache over sessions | yes — active CI | rejected: wrong metric |
| `@hank-warren/pi-stats` | 0.5.0, 2026-09-28 | no — Overview/Models/Tools/Projects | yes | yes — session-derived | weak — 1 star | rejected: no skills view |

Star counts for the whole niche, as context for how much R4 can actually be
satisfied: the ceiling for a *dedicated* tracker is 721 stars, and that is a
monorepo where analytics is one of ~30 packages. Every high-star repo in the
ecosystem (`can1357/oh-my-pi` 36k, `vercel-labs/skills` 36k installer,
`backnotprop/plannotator` 9.6k, `nicobailon/pi-subagents` 4k) is a different tool,
not a skill-usage tracker. Picking by stars is not available here.

### `pi-tool-stats`: good report, unbounded file

Storage is `~/.pi/agent/tool-stats.jsonl`, one line per event, `appendFileSync`, path
hardcoded, no rotation, no retention, no reset command. Measured on this machine: 243
sessions over 34 days = 9150 tool calls = ~270/day; two ~220-byte records per call =
~118 KB/day = **~43 MB/year**. Every `/tool-stats` reads and parses the entire file.

Its unused report is genuinely good: `PROMPT-VISIBLE UNUSED SKILLS` with approximate
prompt tokens, plus an `EXPLICIT-ONLY UNUSED SKILLS` section. That is why it was
installed first.

### `@pify/skills`: right data model, wrong key

Ledger is `~/.pi/agent/pify-skills/<sha256(lowercased cwd)[0:12]>.json`, one aggregate
entry per skill. Flat forever — the right data model, and `commitLedger` re-reads and
*sums* before an atomic temp+rename, so concurrent pi windows do not clobber each
other. Two disqualifiers:

1. **Project-keyed by design.** `resolveLedger` hashes `cwd`; `/skills` only ever reads
   the current project's file. No global route. A skill used in another repo shows as
   unused.
2. **Cold-start gap.** Before the first request it falls back to
   `loadSkills({ skillPaths: [], includeDefaults: true })`, which scans only
   `~/.pi/agent/skills` and `<cwd>/.pi/skills` — neither exists on this machine, so a
   fresh pi instance answers `/skills unused` with `No skills loaded.` until one prompt
   has settled.

Skill costs, though, are *measured*: `formatSkillsForPrompt([])` against
`formatSkillsForPrompt([skill])`, the same function that builds the real prompt block.
This package does the same thing, one skill at a time.

The result is about 450 lines of extension plus 240 of tests, no dependencies, nothing
to rebase.

## License

MIT
