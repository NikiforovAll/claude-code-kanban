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
- Outside cck's terminal an interactive session gets `show` too, as a board pane (below).
- POST and the two DELETE routes need the terminal token and a live terminal with that id. The GET routes need neither, because the board reads them.

## Outside the terminal

A session without `CCK_URL` and `CCK_TERMINAL_ID` has no overlay, so `show` adds the card as a pane of the session on the board instead, the same pane `claude-code-kanban pane add` makes:

```
mod       session.start registers show with title and file required
model     show {title, file}
mod       POST /api/panes/<session id> {target: file, title, show: true}, board from <config dir>/.cck/server.json
board     the pane opens in the background; the pane file watch refreshes it on each save
```

- The model writes the card to a file in its scratchpad first, as the `visualize` skill does with its pages: the mod has no claim path to hand out. A call without `file` sends nothing and asks for one.
- `show: true` renders the pane with the card's theme, like the header's pane button (Card, below). The same file again answers that its tab exists.
- `key`, `kind` and `base` are not in this tool's schema: the file's extension sets the kind, and the pane is the file.
- No `server.json`: the tool answers that the board is not running. A board error reaches the model with its text.
- The skill list keeps the `show` skill everywhere. The mod does not filter it: a managed `prepend` plugin can pass `prompt.attachment` over user plugins, so a filter there would not hold.

## Posts

`show` takes one of two forms. It takes no inline content: a body in the call stays in the posting session's context, and a file lets the session change the card with Edit. The server answers 400 to a body with `content`.

- **Claim:** no `file`. cck answers with a `path` and does not create the file, because Claude Code's Write refuses to overwrite a file the session has not read. The model writes the card with Write and changes it with Edit. Until the file exists, GET answers `waiting: true` and the card shows "Waiting for content."
- **File:** `file`, an absolute path to an existing markdown, HTML, text or image file. cck reads it with `readPreviewFile` on each GET and does not watch it, so the card shows the file as it was when the card last loaded. An `.svg` file is a `text` file to the previewer; the card draws it as HTML, with its XML prolog and doctype cut.

`kind` is `markdown` (default) or `html`, and sets the extension of the post's file. `key` names a card: a post with a key that exists replaces that card in place, keeps its id and file, and the board marks it updated. A claim with a new `kind` under the same key renames the file to the new extension.

`base` is an absolute path to an existing folder, kept on the post's index entry. A call stack's `path:line` links on the card resolve against it, else against the session's cwd. A worktree or a second repo needs it, because the session's cwd is a different checkout. A post without `base` under the same key drops the old one.

## Storage

Each session's posts are in `<session scratchpad>/.cck/show/`:

- `index.json`: `{sessionId, posts: [{id, title, key, kind, file, base, updatedAt}]}`
- `<post id>.md` or `<post id>.html`: the file of a claim post

The scratchpad is under the OS temp dir, so the folder goes with it and cck does not sweep it (`docs/retention.md`). `terminals.json` keeps the map of terminal id to its current session as `showSessions`, so the card comes back after a board restart. The map drops terminals that no longer exist. A session resumed from the board in a new terminal gets a new terminal id; a terminal with no entry takes the session it was started with when that session has posts (`startedSession`, from the host's terminal list), so its card comes back too. The board drops a PTY's terminal id when the PTY leaves the running list (`forgetEndedTerminals`), because a session resumed after its terminal ended runs under the same PTY id with a new terminal id.

## Refresh

cck watches the show folder of each session that a terminal maps to (`watch` in `lib/show.js`):

- A change to `<post id>.md|html` waits 200 ms (`SETTLE_MS`) for the writes to settle, then compares the file's mtime with the one cck last saw (`seen`, in memory), so a second watch event for one save, or a rename for a new `kind`, is not a change.
- A change updates `updatedAt`, writes the index and sends `show:posted` with `replaced: true`. The store sends every `show:posted`, for a post and for a refresh, to each terminal that maps to the session (`notify`), so the board uses the same path for both.
- A refresh of an HTML card sets the iframe's `srcdoc` again, so its script state resets. The board keeps its scroll position.
- cck watches the long path (`fs.realpathSync.native`): libuv aborts the process on a change under an 8.3 short path.
- A watch closes when no terminal maps to its session any more, and when its folder is gone, because on Windows a watch on a deleted folder keeps the process alive.

## Card

The `SHOW` region runs nothing until the terminal view shows a terminal that has posts. It renders markdown with marked and DOMPurify, and HTML as authored in a sandboxed iframe (`allow-scripts allow-forms`, no `allow-same-origin`, no `allow-popups`) with a CSP that blocks fetch and remote sub-resources. The card maps the skill's theme variables (`SHOW_TOKENS`) to the board's theme, and adds the chart palette `SHOW_PALETTE`: 8 series colors and a 5-step ramp, one set for light and one for dark, the same for every color theme. `test/show-card.test.js` checks it against each theme's surface. The header has a pager, dock, collapse, expand to fill the terminal, remove and close until the next post. Dock (Alt+Shift+Enter) puts the card in a side panel at the right of the terminal host: the terminal pane gets `show-docked` and `--show-dock-w`, the terminal frame shrinks by that width and refits, and expand is hidden. Collapsed or closed, a docked card gives the terminal its full width. The width starts at 40% of the host, leaves the terminal at least 320 px (`showDockWidth`), and is kept in localStorage (`cck-show-dock-w`, one for all terminals); a drag moves only the card and sets the terminal's width on release, because each change resizes the PTY. Remove deletes the post on screen (`DELETE .../show/<postId>`: drops it from `index.json`, deletes cck's copy of its content and sends `show:removed`; a file post's file stays). Shift+click on remove clears every post (`DELETE .../show`: removes the session's show folder and sends `show:cleared`). The user can resize the card; the size is kept in localStorage. Closed, collapsed, expanded and docked are kept per terminal id in localStorage (`showViews`), as flags that stack: a closed card reopens collapsed, expanded or docked, and a collapsed one un-collapses to expanded or docked if it was. A new terminal, such as a resumed session or a newly connected terminal, opens the card collapsed. After that, each terminal opens the card the way the user left it, across a reload too; a new post reopens a closed card; the board drops the ids that are not in a non-empty terminal list. Callstack folds are not kept. Text selected in the card takes review comments like a preview (the REVIEW region, source kind `show`): the list sits under the body, and Send goes to the posting session through `POST /api/sessions/:id/review`, with a line that names the card's file (`path` in the post's GET). The card's review is the base review of the terminal view, so a modal's review goes on top of it. Content grows with the card's width, from 1× at 480 px to 16/13 at 1000 px, at most 18/13: an HTML card through CSS `zoom` on its root, set by the frame's bridge on resize, so cards sized in px scale too; a markdown card through its font size in `cqi` on `.show-body`. While the card's body has focus, Ctrl +/-/0 changes the card's own text zoom (`showZoom`, stored apart from the `modalZoom` of previews, panes and show panes): a markdown card takes it through `--show-zoom` on `.show-md`, and an HTML card's bridge multiplies its own zoom by it (`cck-show:zoom`).

The card's keys are listed in the website's keyboard shortcuts page. Ctrl+Alt+` (`toggleShowFocus`) is a `terminalShortcut`, so it works from the terminal and the page; the hub's combo names cannot spell the backquote, so the hub never binds it. `showCardKey` handles the keys while the body has focus; collapse and close hide the body, so they give focus to the terminal. Focus on an HTML card goes into its frame (`focusShowBody`), so the card's own keys and the scroll keys reach its document. A frame focused before its document loads moves focus into the document on load (`createShowFrame`). The frame hands Ctrl+D, Alt+Enter, Alt+Shift+Enter and Esc back through `SHOW_CLAIMS`, which no other frame claims, and `[`, `]` and Alt+W through `PANE_CLAIMS`; text fields in the card keep them. The keys use Alt, like the pane keys, because Vimium owns plain letters and the board owns Ctrl+Enter. Expanded, the card stops six terminal rows above the bottom, in the terminal's font size (`--show-term-font`), so it clears the prompt and the status line. While the body or its frame has focus, the card has an accent outline, through the `focused` class (`syncShowFocus`). Focus that moves between the terminal's frame and the card's fires no event in the board and does not match `:focus-within`, so the card's frame reports its focus and blur (`cck-show:focus`). A click on the header or the ticks focuses the body, except close and collapse, and a render that replaces the body gives focus back to it. The header's pane button adds the post's file (`path`) as a pane of the posting session, titled with the post's title and marked `show: true` in the pane store (`lib/panes.js`). The board renders a marked HTML pane through `showSrcdoc`, like the card: theme tokens, chart palette, base styles and the width-fit zoom, and theme and text zoom changes reach it as they reach the card (`postToShowFrames`). Removing a post, or clearing the card, drops the show panes of those files (`onRemoved` → `panes.removeShow`); a plain pane of the same file stays.

## Add-ons

An add-on is a web page on the dock rail, from a server the user runs. It is not a pane and has no tab. `addon add` (the `/addon` skill) stores it in `.cck/addons.json` (`lib/addons.js`): `{version, nextId, global: [entry], sessions: {<sid>: {addons: [entry], params: {<addon id>: {k: v}}, updatedAt}}}`, an entry being `{id, url, title, icon?, run?, cwd?, params, addedAt}`. Ids (`a<n>`) are unique across scopes. Each scope holds at most 20; the same URL in the same scope returns the entry it has. `--global` entries show in every session and never expire; a session's entries and its param values expire with the session (`docs/retention.md`). Routes: `GET /api/addons?session=`, `POST /api/addons` (`{scope: 'global' | sid, url, title, icon, params}`, refused with `own_origin` on the board's or the hub's origin, with `missing_param` for a placeholder with no value), `PATCH /api/addons/:id` (`{session, params}`; an empty value drops the session's value) and `DELETE /api/addons/:id?session=` (a global id needs no session). They carry no token, like the pane routes, except a POST with `run`. **Auto-start.** A global entry on a localhost URL can hold `run` (one line, at most 1000 characters) and an absolute `cwd`; `addon add --global --run <cmd> --cwd <dir>` sends them with the terminal token, because the board will run that command line, and the same URL added again with `--run` replaces them. When the board creates the frame of such an entry for the first time in the page's life, it shows "Starting…" and calls `POST /api/addons/:id/start` (`startDockAddon`). The route (`lib/addon-runner.js`) connects to the URL's port; when nothing answers, it spawns `run` through the shell in `cwd` with `PORT` set and its output in `.cck/addons/<id>.log`, polls the port every 300 ms for 20 s, and answers `{state: 'up' | 'none' | 'failed', error?, log?}`. One start runs at a time per id, and at most 3 a minute. The child ends with the board (`process.on('exit')`, and the hub's `taskkill /f /t` on cck), and `DELETE` of the entry stops it. A second board on the config dir finds the port answering and starts nothing. A failed start shows the error, the log path and Retry; Reload checks the port again. Cost: nothing at board start; one TCP connect per frame creation, and a spawn only when the port is closed. Each write, and each change another process writes (a chokidar watch on the file), broadcasts `addon:changed` with no payload; the board refetches the list for its dock session (`fetchDockAddons`).

The board fills the URL for the terminal's session (`fillAddonUrl`, `addonValues`): `{sessionId}`, `{cwd}` (the session's cwd, else its project, else the New session spec's folder), `{project}`, and `{<param>}` from the session's value, else the entry's. Each value is URL-encoded. A URL pane can also go on the rail from its tab menu (`PATCH /api/panes/:sessionId/:paneId` with `{dock}`, `setDock` in `lib/panes.js`); it keeps its tab next to Board.

The rail is 30 px at the right edge of the terminal host (`renderDockRail`, from every `renderShow`, from `applyPaneLayout` for that session and from `fetchDockAddons`); a session with no item has no rail and no work. It holds Show while the terminal has posts, then the global add-ons, the session's, and the docked panes (`dockItems`); the same filled URL shows once. A button shows the add-on's icon, else the first letter of its title. A click puts that view in the dock and a click on the one on screen hides the dock: Show opens docked, an add-on hides the card under it (`under-addon`). The card's reopen chip is hidden while the rail is there. A post that arrives while an add-on is on screen puts a dot on Show. Show and add-ons share the dock width (`showDockW`) and its drag edge. The item on screen is kept per terminal id in localStorage (`cck-dock-addon-v1`), pruned with `showViews`.

A frame (`PANE_URL_SANDBOX`, like a URL pane) loads on the first click and is kept by item id while its filled URL stays the same, so `/clear` or a switch to another terminal with the same values does not reload it. Until the list for a new session arrives, the global entries of the last list stand, so their frames are kept. A frame hidden for 60 s (`DOCK_UNLOAD_MS`) is removed, and the next click loads it again. Each load gets the theme tokens (`cck-show:tokens`), and theme changes reach it through `postToShowFrames` (`.dock-addon-frame` is in `PANE_SHOW_FRAMES`). A docked pane's framing is probed like a pane's, once per target while the page lives; an add-on's is not, because it is built for the dock. The header has Open in a tab, Expand, Reload (drops the frame and loads it again), Remove (an add-on: `DELETE`, after a confirm for a global one; a docked pane: undock) and Close, which hides the dock. Expand (`setDockExpanded`, one flag for the page in `cck-dock-expanded-v1`, like the session log's full width) widens the panel over the terminal down to above its prompt rows, as the expanded card does; the terminal keeps its docked width, so the PTY does not resize. With focus in the dock (`isDockFocused`, the header or the frame; `dockHeadKey`), Alt+W hides the dock, Alt+Enter toggles Expand, and Esc goes back from Expand, else focuses the terminal. Focus that moves from the terminal's frame into a dock page leaves the board's `activeElement` on the terminal frame and fires no event in the board, so the page posts `cck-show:focus` `{on}` itself, as the show card's bridge does, and the panel gets `.focused`. A frame on another origin keeps its keys, so a dock frame is a host-keys frame (hub protocol §5.2, like a URL pane): `pushTerminalClaims` sends it `hub:hostKeys` with the pane claims plus `DOCK_CLAIMS` (Alt+Enter) and the hub's combos as claims (`comboClaims`, because a page with no hub SDK cannot forward them), on each load and each claims change. A page with the snippet in the addon skill's `references/build.md`, or with the hub SDK under the hub, posts each matching press back as `hub:hostKey`. The board replays a press only from a known frame and its origin, and only one it claimed. A page without the snippet keeps every key and shows no focus; the header still works. Ctrl+Alt+` (`toggleShowFocus`) treats the card as one more rail item: it goes to the item last on screen for that terminal (`dockLast`, `cck-dock-last-v1`, written by `renderDockRail` when the item on screen changes, pruned with the terminal), else the card when there are posts, else the first add-on. For an add-on it opens it and focuses its header, and from the dock or the card it goes back to the terminal; focus stays in the board, because a frame on another origin would keep the keys. Alt+Up/Down also work from the header, and focus goes with the step: to the header of the add-on it opens, or into the show card. The session comes from the show list, else the terminal's PTY id, which is the session it started.

## Actions

Any HTML preview (the card, a pane, the preview modal) can send the user's answer to the session. The `reviewBridge` script in the frame posts `cck-review:` `action` for a click on a `[data-cck-action="<name>"]` element (with the fields of its form, if it is in one), and for a submit of a `form[data-cck-submit="<name>"]` with all its fields and the submitter (`FormData`, a repeated name becomes a list). The label is the clicked element's text, else the action name. The bridge stops every submit, so a form cannot load a page into its frame. The board sends only while `navigator.userActivation.isActive` is true, so a script cannot answer without a click, and it drops the same action with the same fields within 1 s. `sendPreviewAction` finds the frame's review target (`reviewOptsOfFrame`) and posts `POST /api/sessions/:id/action` (`lib/preview-action.js`), which checks the name and caps the fields, writes the answer to `.cck/reviews/<sid>/` with the fields as JSON, and delivers it like a review: the doorbell line `User submitted "<name>" on <where>: <file>`, else a terminal paste, else the clipboard.

## Performance

- Startup: none. The store reads `showSessions` from `terminals.json`, which the board already loads.
- Per post: one index read and write.
- Per removed post: one `stat` of the pane store (a read only when it changed), and one write when the post had a show pane.
- Per save of a claim file: one `stat`, one index write and one SSE event, at most once per 200 ms per post.
- Watches: one `fs.watch` per session that has posts and a terminal, unref'd.
- Board: one list GET and one post GET per event for the terminal on screen.
- Per action: nothing until a click; then one file write and one doorbell line.
- Dock: nothing until used. A dock, undock or drag release refits the terminal once, which resizes the PTY, and Claude Code redraws. The card's existing host observer sets the width, and writes it only when it changed.
- Add-ons: one small file read at start and on each change, and one SSE event per write. The board does one add-on GET per dock session change and per `addon:changed`, and a filter of the pane layout it already holds (one pane GET when the terminal's session is not the one on screen). Each render fills the URLs with string work. With items: a rail render that writes the DOM only when it changed, one refit when the rail appears or goes, and one iframe per item opened, removed after 60 s hidden. Theme tokens: one `postMessage` per frame load.
- Per post outside the terminal: one `server.json` read and one pane POST; the board's existing pane file watch does the refresh.
