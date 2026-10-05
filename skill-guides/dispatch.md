# Dispatch guide

A dispatch is a plain Claude Code session that cck starts in its embedded terminal, with your spec as the first message. It is an ordinary session: it shows in the sidebar, its card links back to you, and the user can open its terminal at any time. cck only starts it.

## Spec

The started session sees only the spec, not this conversation, so the spec carries everything it needs.

cck sends nothing back. To hear from the session, the spec tells it to `SendMessage` you and names you. Your name is auto-assigned (e.g. `claude-code-hub-06`); `ListAgents` prints it as "This session is <name>".

## Start

```bash
claude-code-kanban dispatch start --cwd <dir> --spec-file <spec.md> --name <name> --group <group> --json -- <claude args>
```

- `--name` is the sidebar name and the session's peer name. Kebab-case and unique: `fix-login-redirect`.
- `--group` names the effort in kebab-case (`auth-refactor`) and shows the session under that sidebar group. Pass it on every dispatch that belongs to the effort; a dispatch without it goes to its project.
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
