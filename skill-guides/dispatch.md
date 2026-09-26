# Dispatch guide

A dispatch is one Claude Code session that cck starts for a task, in its embedded terminal. It shows in the sidebar under the session that started it, the user can open its terminal at any time, and it settles with one report: `succeeded`, `failed`, or `exited` (the terminal ended with no report).

## Before you dispatch

Dispatch when the task can run on its own and you would otherwise wait for it. Do the work yourself when it is small or needs this conversation's context that you cannot write down.

Every spec must be self-contained. The started session sees only the spec, not this conversation. Name:

- **Target:** the files, component, or environment in scope.
- **Change:** the concrete result to produce.
- **Constraints:** invariants and do-not-touch boundaries.
- **Ownership:** what it may edit. Two dispatches must not edit the same files unless each runs in its own `--worktree`.
- **Acceptance:** the test, output, or evidence that proves it is done.

## Start

```bash
claude-code-kanban dispatch start --cwd <dir> --spec-file <spec.md> [--name <name>] [--model haiku|sonnet|opus|fable] [--worktree [name]] --json
```

- `--cwd` must be a project cck already knows (default: the current dir).
- Prefer `--spec-file` over `--spec` for anything longer than a line: no shell quoting.
- The result holds the `dispatch` id and the `session` id. Keep both.
- Start every independent dispatch before you wait on any of them.

## Collect the result

Two channels, use either or both:

- **Inbox:** this skill armed it. Lines `cck:1 dispatch.<status> <id> ...` arrive on their own while you keep working.
- **Wait:** block until one settles.

```bash
claude-code-kanban dispatch wait [<id>...] --timeout 15m --json
```

It returns `settled`, `running`, and `timeout`. Each call returns as soon as any watched dispatch settles, so call it again with the ids still running. A timeout is a checkpoint, not a failure: the session may still be working. Look before you act:

```bash
claude-code-kanban dispatch list --json
claude-code-kanban session peek <session-id> --limit 20
```

Never start a duplicate of a dispatch that is still `running`. Only `exited` or a `failed` report justifies a retry.

## Report to the user

For each dispatch: its outcome, the summary, and what you checked yourself. The summary is the started session's own claim. Verify it (run the tests, read the diff) before you tell the user the work is done.

## If you are the started session

Your prompt begins with `[cck dispatch <id>]` and holds the exact `dispatch done` command, with your capability. Copy it; do not rebuild its flags.

- Do only the task in your prompt.
- Report exactly once, when the task is done or when you cannot finish it. Use `--outcome failed` when it is not done; never hide a failure in the summary text.
- The summary is three sentences: what changed, what you found, what remains. Use `--summary-file` if it needs quotes.
- You cannot ask the starting session questions. If you are blocked on a decision, report `failed` and put the question in the summary.
- After you report, stop.
