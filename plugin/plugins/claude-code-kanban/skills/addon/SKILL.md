---
name: addon
description: Dock add-ons, pages on the rail beside cck's embedded terminal. Use to build a new add-on, or to add, list, set or remove one.
argument-hint: '[add <url> | list | set <id> k=v | rm <id> | build <what>] [--global]'
---

# Dock add-ons

An add-on is a page from a server the user runs. It stays on the dock rail of this session, or of every session with `--global`, until it is removed. For a view of this conversation only, post a show card instead.

## Add, list, set, remove

1. Read `claude-code-kanban help addon <verb>`. It names the URL placeholders the board fills per session and when `--global` applies.
2. Run `claude-code-kanban addon <verb> ...` and report its output line to the user. The user opens the add-on from the rail.

## Build a new add-on

When the page does not exist yet, follow [references/build.md](references/build.md), then register it as above.
