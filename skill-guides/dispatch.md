# Dispatch guide

A dispatch is a plain Claude Code session that cck starts in its embedded terminal, with your spec as the first message. It is an ordinary session: it shows in the sidebar, its card links back to you, and the user can open its terminal at any time. cck only starts it.

## Spec

The started session sees only the spec, not this conversation, so the spec carries everything it needs.

cck sends nothing back. To hear from the session, the spec tells it to `SendMessage` you and names you. Your name is auto-assigned (e.g. `claude-code-hub-06`); `ListAgents` prints it as "This session is <name>".

## Start

```bash
claude-code-kanban dispatch start --cwd <dir> --spec-file <spec.md> --name <name> (--child | --group <group>) --json -- <claude args>
```

- `--name` is the sidebar name and the session's peer name. Kebab-case and unique: `fix-login-redirect`.
- Every dispatch picks its **place** in the sidebar. Ask one question: will its result come back to you?
  - Yes: `--child`. It is your part of the work (a fix, a review, research you will use). Its card shows under yours, wherever yours is.
  - No: `--group <group>`. It is separate work the user follows on the board (a handoff, an unrelated task). `<group>` names the effort (`auth-refactor`, or a path like `auth-refactor/api`); pass the same group to each dispatch in that effort. A group it makes goes when none of its sessions shows as active; an existing group stays.
  - If you cannot tell, ask the user in one line before you start the session.
- `--spec-file` keeps a long spec out of shell quoting.
- Everything after `--` goes to `claude` as it is: any flag in `claude --help`, e.g. `-- --permission-mode auto --add-dir ../shared`. Keep each value one shell word of plain characters (no quotes, `%` or control characters); long text belongs in the spec. cck owns the session id, name, model and worktree, so pass those with its own flags.
- After a cck restart the terminal comes back with `claude --resume <id>` alone, so the args after `--` apply to the first run only.
- The result holds the `session` id.

`claude-code-kanban help dispatch start` lists cck's flags (`--model`, `--worktree` and more); `claude --help` lists the ones you can pass after `--`.

## Messages and status

A message from the session arrives here as a new turn. Reply with `SendMessage` to its name.

A crashed session sends nothing. To learn when one ends, `SendMessage` it with `notify_when_idle: true`, or look:

```bash
claude-code-kanban dispatch list --json            # still running in cck's terminal
claude-code-kanban session view <session-id>       # its transcript path; read the last lines
```
