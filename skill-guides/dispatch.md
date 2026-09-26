# Dispatch guide

A dispatch is one Claude Code session that cck starts for a task, in its embedded terminal. It is an ordinary session, not a child: it shows in the sidebar like any other, and the user can open its terminal at any time.

A dispatch is **fire-and-forget** by default: you hand the task off, and the user watches it in the sidebar. Add `--report` only when you need the outcome back: the user asked you to collect it, or your next step depends on it.

## Write the spec

The started session sees only the spec, not this conversation, so every spec is self-contained. Name:

- **Target:** the files, component, or environment in scope.
- **Change:** the concrete result to produce.
- **Constraints:** invariants and do-not-touch boundaries.
- **Ownership:** what it may edit. Two dispatches edit the same files only when each runs in its own `--worktree`.
- **Acceptance:** the test, output, or evidence that proves it is done.

Dispatch when the task can run on its own. Do the work yourself when it is small or needs context from this conversation that you cannot write down.

## Start

```bash
claude-code-kanban dispatch start --cwd <dir> --spec-file <spec.md> --name <name> --group <group> [--report] [--model haiku|sonnet|opus|fable] [--worktree [name]] --json
```

- `--cwd` must be a project cck already knows (default: the current dir).
- `--spec-file` over `--spec` for anything longer than a line: no shell quoting.
- `--name` is what the user sees in the sidebar. Kebab-case, saying what the session does: `fix-login-redirect`, not `task-1`.
- `--group` names the effort, in kebab-case (`auth-refactor`), and shows the new session and this session together under one sidebar group. Pass it on your first dispatch; later dispatches join the same group without it. A group goes away when its sessions end, unless the user pins a member or keeps the group.
- The result holds the `dispatch` id and the `session` id.

## Fire-and-forget

Tell the user the session name, its group, and the dispatch id, then carry on with your own work or end your turn. The dispatch is yours to forget: the user follows it in the sidebar.

## With `--report`

The started session settles with one report, `succeeded` or `failed`, or as `exited` when its terminal ends first. Start every independent dispatch first, then collect. Two channels, use either or both:

- **Inbox:** this skill armed it. Lines `cck:1 dispatch.<status> <id> ...` arrive on their own while you keep working.
- **Wait:** block until one settles.

```bash
claude-code-kanban dispatch wait [<id>...] --timeout 15m --json
```

It returns `settled`, `running`, and `timeout`, as soon as any watched dispatch settles; call it again with the ids still running. A timeout is a checkpoint: the session may still be working. Look before you act:

```bash
claude-code-kanban dispatch list --json
claude-code-kanban session peek <session-id> --limit 20
```

A dispatch still `running` is still working; retry only after a `failed` report or an `exited` one.

The summary is the started session's own claim. Verify it (run the tests, read the diff), then give the user each dispatch's outcome, the summary, and what you checked. Done when every `--report` dispatch has settled and each summary is verified.

## If you are the started session

When the starting session asked for a report, your prompt begins with `[cck dispatch <id>]` and holds the exact `dispatch done` command with your capability. Copy that command verbatim. Without that line, just do the task; there is nothing to report.

- Do only the task in your prompt.
- Report exactly once, when the task is done or when you cannot finish it. Use `--outcome failed` when it is not done, and say why in the summary.
- The summary is three sentences: what changed, what you found, what remains. Use `--summary-file` if it needs quotes.
- The starting session cannot answer questions. If you are blocked on a decision, report `failed` with the question in the summary.
- After you report, stop.
