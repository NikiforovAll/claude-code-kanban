# Show

The show overlay is a card at the top right of the embedded terminal. The Claude Code session in that terminal posts to it with the plugin's `show` tool. The card belongs to the terminal and the posts belong to the session: `/clear` and the `--resume` picker change the session id, but the terminal id stays.

## Parts

| Part | Where | Job |
|---|---|---|
| Mod | `plugin/.../hooks/show.ts` | Registers the `show` tool and posts to the board |
| Skill | `plugin/.../skills/show/SKILL.md` | HTML contract, theme variables, mermaid tips; `references/` holds the chart, mockup and diagram guides, which the agent reads only for that kind of card |
| Store and routes | `lib/show.js` | Posts on disk, the claim file watch, `/api/terminals/:terminalId/show` |
| Card | `public/app.js` and `public/style.css`, region `SHOW` | Renders the posts of the terminal on screen |

## Flow

```
terminal  ptyEnv sets CCK_URL and CCK_TERMINAL_ID (lib/terminal.js)
mod       session.start registers show, only when both vars are set and the session is interactive
model     show {title, kind?, key?, file?}
mod       POST /api/terminals/<CCK_TERMINAL_ID>/show {sessionId, ...}, token from .cck/terminal-tokens/<port>.json
cck       store.post -> show:posted to each terminal of the session
board     GET the list and the post, render the card
```

- The mod reads the token on every post, because a restarted board writes a new one.
- Outside cck's terminal the mod registers no tool and drops the skill from the skill listing, so the model never sees either.
- POST and the two DELETE routes need the terminal token and a live terminal with that id. The GET routes need neither, because the board reads them.

## Posts

`show` takes one of two forms. It takes no inline content: a body in the call stays in the posting session's context, and a file lets the session change the card with Edit. The server answers 400 to a body with `content`.

- **Claim:** no `file`. cck answers with a `path` and does not create the file, because Claude Code's Write refuses to overwrite a file the session has not read. The model writes the card with Write and changes it with Edit. Until the file exists, GET answers `waiting: true` and the card shows "Waiting for content."
- **File:** `file`, an absolute path to an existing markdown, HTML, text or image file. cck reads it with `readPreviewFile` on each GET and does not watch it, so the card shows the file as it was when the card last loaded. An `.svg` file is a `text` file to the previewer; the card draws it as HTML, with its XML prolog and doctype cut.

`kind` is `markdown` (default) or `html`, and sets the extension of the post's file. `key` names a card: a post with a key that exists replaces that card in place, keeps its id and file, and the board marks it updated. A claim with a new `kind` under the same key renames the file to the new extension.

## Storage

Each session's posts are in `<session scratchpad>/.cck/show/`:

- `index.json`: `{sessionId, posts: [{id, title, key, kind, file, updatedAt}]}`
- `<post id>.md` or `<post id>.html`: the file of a claim post

The scratchpad is under the OS temp dir, so the folder goes with it and cck does not sweep it (`docs/retention.md`). `terminals.json` keeps the map of terminal id to its current session as `showSessions`, so the card comes back after a board restart. The map drops terminals that no longer exist. A session resumed from the board in a new terminal gets a new terminal id; a terminal with no entry takes the session it was started with when that session has posts (`startedSession`, from the host's terminal list), so its card comes back too.

## Refresh

cck watches the show folder of each session that a terminal maps to (`watch` in `lib/show.js`):

- A change to `<post id>.md|html` waits 200 ms (`SETTLE_MS`) for the writes to settle, then compares the file's mtime with the one cck last saw (`seen`, in memory), so a second watch event for one save, or a rename for a new `kind`, is not a change.
- A change updates `updatedAt`, writes the index and sends `show:posted` with `replaced: true`. The store sends every `show:posted`, for a post and for a refresh, to each terminal that maps to the session (`notify`), so the board uses the same path for both.
- A refresh of an HTML card sets the iframe's `srcdoc` again, so its script state resets. The board keeps its scroll position.
- cck watches the long path (`fs.realpathSync.native`): libuv aborts the process on a change under an 8.3 short path.
- A watch closes when no terminal maps to its session any more, and when its folder is gone, because on Windows a watch on a deleted folder keeps the process alive.

## Card

The `SHOW` region runs nothing until the terminal view shows a terminal that has posts. It renders markdown with marked and DOMPurify, and HTML as authored in a sandboxed iframe (`allow-scripts`, no `allow-same-origin`, no `allow-popups`) with a CSP that blocks fetch and remote sub-resources. The card maps the skill's theme variables (`SHOW_TOKENS`) to the board's theme, and adds the chart palette `SHOW_PALETTE`: 8 series colors and a 5-step ramp, one set for light and one for dark, the same for every color theme. `test/show-card.test.js` checks it against each theme's surface. The header has a pager, collapse, expand to fill the terminal, remove and close until the next post. Remove deletes the post on screen (`DELETE .../show/<postId>`: drops it from `index.json`, deletes cck's copy of its content and sends `show:removed`; a file post's file stays). Shift+click on remove clears every post (`DELETE .../show`: removes the session's show folder and sends `show:cleared`). The user can resize the card; the size is kept in localStorage. Closed, collapsed and expanded are kept per terminal id in localStorage (`showViews`), as flags that stack: a closed card reopens collapsed or expanded, and a collapsed one un-collapses to expanded if it was. Each terminal opens the card the way the user left it, across a reload too; a new post reopens a closed card; the board drops the ids that are not in a non-empty terminal list. Callstack folds are not kept. Text selected in the card takes review comments like a preview (the REVIEW region, source kind `show`): the list sits under the body, and Send goes to the posting session through `POST /api/sessions/:id/review`, with a line that names the card's file (`path` in the post's GET). The card's review is the base review of the terminal view, so a modal's review goes on top of it. Content grows with the card's width, from 1× at 480 px to 16/13 at 1000 px, at most 18/13: an HTML card through CSS `zoom` on its root, set by the frame's bridge on resize, so cards sized in px scale too; a markdown card through its font size in `cqi` on `.show-body`. While the card's body has focus, Ctrl +/-/0 changes the board's text zoom (`modalZoom`, shared with previews and panes): a markdown card takes it through `.modal-zoomable`, and an HTML card's bridge multiplies its own zoom by it (`cck-show:zoom`).

The card's keys are listed in the website's keyboard shortcuts page. Ctrl+Alt+` (`toggleShowFocus`) is a `terminalShortcut`, so it works from the terminal and the page; the hub's combo names cannot spell the backquote, so the hub never binds it. `showCardKey` handles the keys while the body has focus; collapse and close hide the body, so they give focus to the terminal. An HTML card's frame hands Ctrl+D, Alt+Enter and Esc back through `SHOW_CLAIMS`, which no other frame claims, and Alt+W through `PANE_CLAIMS`; text fields in the card keep them. The keys use Alt, like the pane keys, because Vimium owns plain letters and the board owns Ctrl+Enter. Expanded, the card stops six terminal rows above the bottom, in the terminal's font size (`--show-term-font`), so it clears the prompt and the status line. While the body or its frame has focus, the card has an accent outline, through the `focused` class (`syncShowFocus`). Focus that moves between the terminal's frame and the card's fires no event in the board and does not match `:focus-within`, so the card's frame reports its focus and blur (`cck-show:focus`). A click on the header or the ticks focuses the body, except close and collapse, and a render that replaces the body gives focus back to it. The header's pane button adds the post's file (`path`) as a pane of the posting session, titled with the post's title and marked `show: true` in the pane store (`lib/panes.js`). The board renders a marked HTML pane through `showSrcdoc`, like the card: theme tokens, chart palette, base styles and the width-fit zoom, and theme and text zoom changes reach it as they reach the card (`postToShowFrames`). Removing a post, or clearing the card, drops the show panes of those files (`onRemoved` → `panes.removeShow`); a plain pane of the same file stays.

## Performance

- Startup: none. The store reads `showSessions` from `terminals.json`, which the board already loads.
- Per post: one index read and write.
- Per removed post: one `stat` of the pane store (a read only when it changed), and one write when the post had a show pane.
- Per save of a claim file: one `stat`, one index write and one SSE event, at most once per 200 ms per post.
- Watches: one `fs.watch` per session that has posts and a terminal, unref'd.
- Board: one list GET and one post GET per event for the terminal on screen.
