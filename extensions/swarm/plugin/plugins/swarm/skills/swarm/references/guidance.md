# Is a swarm worth it?

A swarm pays off on **fan-out** work: a small shared core, then several parts that workers build at the same time. On other work it costs more and finishes later than one session.

## What a swarm costs

- **Fixed overhead.** Each worker builds its own picture of the codebase, and coordination (claims, publications, applies, assembly, the supervisor's check) adds minutes that do not shrink with the task. A longer spec, a written brief or more findings do not remove it: each worker still reads the code itself.
- **Scale.** Expect about 2 to 3 times the tokens of one session. On a short task the swarm also finishes later.

## What a swarm gives

- **Parallel parts.** Workers build independent parts at the same time. Only this shortens the wall time.
- **Isolation.** Each worker works in its own worktree, and the project stays as it is until `end` delivers the result.
- **Review depth.** Results tend to have more tests, shared helpers in place of copies, and types that match the runtime value.
- **Scope creep.** Workers add error codes, checks and tests the goal did not ask for.

## Fit

A good fit has most of these:

- One session takes more than about 30 minutes, or fails often on it.
- The work fans out: after the core, 3 or more parts that live in separate files or layers.
- Each acceptance check is a command (tests, type check), so the supervisor can check a complete result.
- The user values review depth and tests over speed and tokens.

A poor fit has any of these:

- One session does it in about 15 minutes or less.
- The work is a **chain**: each part needs the one before it.
- The change sits in one file or one function.
- The next step depends on what the last one found, as in debugging or exploration.

## Split for fan-out

A chain in the task list removes the gain: one worker builds the parts in a row while the others run out of tasks and wait. Seed the core as one task and each fan-out part as its own task, and say in each part which interface it takes from the core, so a worker can start against that interface before the core lands.

## Check the seams

Each worker tests its own part, so a defect hides at a **seam**, where one worker's part meets another's or meets existing code. Write acceptance checks that cross the seams: the new behavior combined with each existing kind it touches, not only on its own. Before you end the swarm, run those checks against the assembled result.
