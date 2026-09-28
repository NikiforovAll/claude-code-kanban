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
claude-code-kanban dispatch start --cwd <dir> --spec-file <spec.md> --name <name> --group <group> --peer <your-peer> [--report] --json
```

`claude-code-kanban help dispatch start` lists every flag (model, worktree, and the rest). `project list` shows the folders `--cwd` accepts. How to choose the values:

- `--peer` is your own peer name: the first line of `ListAgents` ("This session is `<name>`"). Pass it whenever you have the `ListAgents` tool. cck then tells the started session to ask you with `SendMessage` instead of failing on a question. See [Peer](#peer).
- `--spec-file` over `--spec` for anything longer than a line: no shell quoting.
- `--name` is what the user sees in the sidebar. Kebab-case, saying what the session does: `fix-login-redirect`, not `task-1`.
- `--group` names the effort, in kebab-case (`auth-refactor`), and shows the new session under that sidebar group. This session stays where it is. Pass it on your first dispatch; later dispatches join the same group without it. A group goes away when its sessions end, unless the user pins a member or keeps the group.
- The result holds the `dispatch` id and the `session` id.

## Fire-and-forget

Tell the user the session name, its group, and the dispatch id, then carry on with your own work or end your turn. The user follows the dispatch in the sidebar. With `--peer`, its questions still reach you as new turns.

## With `--report`

The started session settles with one report, `succeeded` or `failed`, or as `exited` when its terminal ends first. Start every independent dispatch first, then collect. Two channels, use either or both:

- **Inbox:** this skill armed it. Lines `cck:1 dispatch.<status> <id> ...` arrive on their own while you keep working.
- **Wait:** block until one settles.

```bash
claude-code-kanban dispatch wait [<id>...] --timeout 15m --json
```

Call it again with the ids still running (`help dispatch wait` has the output fields). A timeout is a checkpoint: the session may still be working. Look before you act:

```bash
claude-code-kanban dispatch list --json
claude-code-kanban session peek <session-id> --limit 20
```

A dispatch still `running` is still working; retry only after a `failed` report or an `exited` one.

The summary is the started session's own claim. Verify it (run the tests, read the diff), then give the user each dispatch's outcome, the summary, and what you checked. Done when every `--report` dispatch has settled and each summary is verified.

## Peer

A dispatch is a Claude Code peer under its `--name`, so `SendMessage` reaches it and it reaches you. The peer channel carries the conversation. The report carries the record: only `dispatch done` settles a dispatch, ends `dispatch wait`, and shows in the sidebar.

- **Answer questions.** A question or a finding from the dispatch arrives as a new turn. Answer it yourself, or ask the user when the decision is theirs, then send the answer back.
- **Steer.** Send a short, self-contained message to the dispatch's name. It arrives between the receiver's steps, never inside a subagent or a running workflow.
- **Limits.** A session in another permission mode can hold a message until its user approves it, so anything the result depends on goes in the report. A dispatch that restarts ends as `exited` and cannot report, so its result comes back as a message.

## If you are the started session

Your prompt begins with `[cck dispatch <id>]` and holds your instructions: the peer to ask, and with a report the exact `dispatch done` command. Follow them. Without that line, the prompt is the task alone.

- Ask the peer with `SendMessage` when you need a decision or find something that changes the task, and keep working on what does not depend on the answer.
- The summary is three sentences: what changed, what you found, what remains. Use `--summary-file` if it needs quotes.
- After you report, a message from the peer is a new request: answer it.
