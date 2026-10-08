# Show

The show overlay is a card at the top right of the embedded terminal. The Claude Code session in that terminal posts to it with the plugin's `show` tool. The card belongs to the terminal and the posts belong to the session: `/clear` and the `--resume` picker change the session id, but the terminal id stays.

## Parts

| Part | Where | Job |
|---|---|---|
| Mod | `plugin/.../hooks/show.ts` | Registers the `show` tool and posts to the board |
| Skill | `plugin/.../skills/show/SKILL.md` | HTML contract, theme variables, mermaid tips |
| Store and routes | `lib/show.js` | Posts on disk, the claim file watch, `/api/terminals/:terminalId/show` |
| Card | `public/app.js` and `public/style.css`, region `SHOW` | Renders the posts of the terminal on screen |

## Flow

```
terminal  ptyEnv sets CCK_URL and CCK_TERMINAL_ID (lib/terminal.js)
mod       session.start registers show, only when both vars are set and the session is interactive
model     show {title, kind?, key?, content? | file?}
mod       POST /api/terminals/<CCK_TERMINAL_ID>/show {sessionId, ...}, token from .cck/terminal-tokens/<port>.json
cck       store.post -> show:posted to each terminal of the session
board     GET the list and the post, render the card
```

- The mod reads the token on every post, because a restarted board writes a new one.
- Outside cck's terminal the mod registers no tool and drops the skill from the skill listing, so the model never sees either.
- POST and DELETE need the terminal token and a live terminal with that id. The GET routes need neither, because the board reads them.

## Posts

`show` takes one of three forms:

- **Inline:** `content`, at most 16 KB (`MAX_CONTENT_BYTES`). cck writes it to the post's file. A bigger body gets 413 with a message that names the claim form. The cap exists because inline content stays in the posting session's context.
- **Claim:** neither `content` nor `file`. cck answers with a `path` and does not create the file, because Claude Code's Write refuses to overwrite a file the session has not read. The model writes the card with Write and changes it with Edit. Until the file exists, GET answers `waiting: true` and the card shows "Waiting for content."
- **File:** `file`, an absolute path to an existing markdown, HTML, text or image file. cck reads it with `readPreviewFile` on each GET and does not watch it, so the card shows the file as it was when the card last loaded.

`kind` is `markdown` (default) or `html`, and sets the extension of the post's file. `key` names a card: a post with a key that exists replaces that card in place, keeps its id and file, and the board marks it updated. A claim with a new `kind` under the same key renames the file to the new extension.

## Storage

Each session's posts are in `<session scratchpad>/.cck/show/`:

- `index.json`: `{sessionId, posts: [{id, title, key, kind, file, updatedAt}]}`
- `<post id>.md` or `<post id>.html`: the content of an inline or claim post

The scratchpad is under the OS temp dir, so the folder goes with it and cck does not sweep it (`docs/retention.md`). `terminals.json` keeps the map of terminal id to its current session as `showSessions`, so the card comes back after a board restart. The map drops terminals that no longer exist.

## Refresh

cck watches the show folder of each session that a terminal maps to (`watch` in `lib/show.js`):

- A change to `<post id>.md|html` waits 200 ms (`SETTLE_MS`) for the writes to settle, then compares the file's mtime with the one cck last saw (`seen`, in memory). cck's own inline write records its mtime, so it is not a change.
- A change updates `updatedAt`, writes the index and sends `show:posted` with `replaced: true`. The store sends every `show:posted`, for a post and for a refresh, to each terminal that maps to the session (`notify`), so the board uses the same path for both.
- A refresh of an HTML card sets the iframe's `srcdoc` again, so its script state resets. The board keeps its scroll position.
- cck watches the long path (`fs.realpathSync.native`): libuv aborts the process on a change under an 8.3 short path.
- A watch closes when no terminal maps to its session any more, and when its folder is gone, because on Windows a watch on a deleted folder keeps the process alive.

## Card

The `SHOW` region runs nothing until the terminal view shows a terminal that has posts. It renders markdown with marked and DOMPurify, and HTML as authored in a sandboxed iframe (`allow-scripts`, no `allow-same-origin`, no `allow-popups`) with a CSP that blocks fetch and remote sub-resources. The card maps the skill's theme variables (`SHOW_TOKENS`) to the board's theme. The header has a pager, collapse, expand to fill the terminal, clear (DELETE, removes the session's show folder) and close until the next post. The user can resize the card; the size is kept in localStorage.

## Performance

- Startup: none. The store reads `showSessions` from `terminals.json`, which the board already loads.
- Per post: one index read and write, and one file write for inline content.
- Per save of a claim file: one `stat`, one index write and one SSE event, at most once per 200 ms per post.
- Watches: one `fs.watch` per session that has posts and a terminal, unref'd.
- Board: one list GET and one post GET per event for the terminal on screen.
