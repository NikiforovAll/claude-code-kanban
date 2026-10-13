# Is a swarm worth it?

A swarm pays off on **fan-out** work: a small shared core, then several parts that workers build at the same time. On other work it costs more and finishes later than one session.

## What a swarm costs

Each worker builds its own picture of the codebase, and coordination (claims, publications, applies, assembly, the supervisor's check) adds a few minutes that do not shrink with the task. Measured with 2 workers against one session on the same task:

- 2.3 to 2.6 times the output tokens.
- 2.3 to 3.4 times the cache reads.
- 1.3 to 1.7 times the wall time, on a task one session finishes in 10 minutes.

More findings, a written brief or a longer spec did not lower the cost: each worker still reads the code itself.

## What a swarm gives

- **Isolation**: each worker works in its own worktree, and the project stays as it is until `end` delivers the result.
- **Review depth**: in blind reviews the swarm's code beat the single session's in 2 of 3 comparisons: shared helpers in place of copies, types that match the runtime value, and 5 to 7 times the test lines.
- **Scope creep**: workers add error codes, checks and tests the goal did not ask for.

## Fit

A good fit has most of these:

- One session takes more than about 30 minutes, or fails often on it.
- The work fans out: after the core, 3 or more parts that live in separate files or layers, such as the parse, export and serialization paths of one feature.
- Each acceptance check is a command (tests, type check), so the supervisor can check a complete result.
- The user values review depth and tests over speed and tokens.

A poor fit has any of these:

- One session does it in about 15 minutes or less.
- The work is a **chain**: each part needs the one before it.
- The change sits in one file or one function.
- The next step depends on what the last one found, as in debugging or exploration.

## Split for fan-out

A chain in the task list removes the gain: in one run, a worker did the core and then the part that needed it, about 13 minutes in a row, and the other worker ran out of tasks and waited. Seed the core as one task and each fan-out part as its own task, and say in each part what it takes from the core, so a worker can start against the core's interface before the core lands.

## Evidence

DeepSWE v1.1 task `dynamodb-toolbox-conditional-attribute-requirements` (TypeScript, 36 files), sonnet, 2 workers, 4 swarm runs and 1 single-session run, October 2026. Every run passed the hidden tests. On public results for this task, Claude models pass 86% of tries, so it is too easy to show a swarm's value; it measures the cost.

| | Single session | Swarm |
|---|---|---|
| Wall time | 9.8 min | 12.8 to 16.8 min |
| Output tokens | 36k | 82k to 93k |
| Cache reads | 6.1M | 14.2M to 20.7M |
| Diff lines | 1,412 | 2,217 to 2,499 |
