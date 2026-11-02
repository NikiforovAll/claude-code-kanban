# Hub contract

Under Claude Code Hub, cck and the hub page talk through topics and actions. No single file holds both sides, so a change on one side can break the other with no failing test. This doc lists the parts and the rules that keep them in step.

## The parts

| Part | Where | What it holds |
|---|---|---|
| Manifest | `hub-app.json` | The action and topic names cck offers, its capabilities, its port |
| Handlers | `public/app.js`, `HUB_INTEGRATION` region | `hub.handle(...)` for each action, `hub.publish(...)` for each topic |
| Hub callers | hub `public/app.js` (voice), hub `lib/voice/grammar.js` (`COMMANDS`) | Which actions the hub invokes, with which params, in which order |
| Reference | hub `website/src/content/docs/extensibility/reference/built-in.mdx` | Params and payloads of each action and topic |
| Protocol | hub `docs/agents/sdk.md` | The SDK calls and the postMessage messages |

The reference page is the source of truth for params and payloads. Do not copy it here.

## Rules

- **Rename in every part.** A new or renamed action or topic changes the manifest, the handler, the hub caller and the reference in the same change. The hub reads `publishes` only at startup, so a new topic needs a hub restart.
- **Order is part of the contract.** The hub's call sequence is in the hub's `docs/agents/voice.md` (Live text). cck keeps it through `liveChain` and `hubNewSession`; a handler that skips them breaks the live dialog.
- **A handler error reaches only the console.** The chains catch it so later calls still run, and log it as `[hub] session.new` or `[hub] session.live`; the user sees a dialog that opens and stays empty.
- **The region calls helpers from other regions** (`fieldInserter`, `showSessionTerminal`, `respondWaiting`, ...). Rename or remove one only after `rg` over the region.

## Checks

- **Biome** fails the lint on a call to a removed or renamed helper in `public/app.js`. A new global from a `<script>` tag in `index.html` goes into `javascript.globals` in `biome.json`.
- **`test/hub.test.js`** runs the region in a vm with stubbed helpers. It checks payloads and handler logic, but a stub can hide a helper that no longer exists, which is why the lint rule is needed.
- **Hub `test/apps.test.js`** validates `hub-app.json`.
- **A real page.** For voice, replay the hub's calls on a scratch hub (see the hub's `CLAUDE.md` for its ports and `CCK_TERMINALS_FILE`) and read the dialog or the terminal.

## Mods

A hub mod (`mod.json` in an extension) adds CSS and JS to the board. Its JS runs after `app.js`, in the board's origin, and changes the board through the SDK's `ClaudeHub.mod`: `wrap(name, fn)` on a global function, `on(event, fn)` for an event. `mod-surface.json` lists the names a mod may use. Any other name can change in any release.

| Part | Where | What it holds |
|---|---|---|
| Surface | `mod-surface.json` | The functions, events and `data-hub-part` names, with what each one does, and the `states` of a part: the classes the board sets on it (`active` on a session card, the status on a task card) |
| Emits | `public/app.js`, `MOD_SURFACE` region | Wraps each render the events name and emits after it |
| Anchors | `data-hub-part="<name>"` in `public/index.html` and in render templates | The elements a mod's CSS and JS select |

Rules:

- **A surface name is a public API.** Rename or remove one only with a new `surface` number and a note in the release. Add names freely.
- **Keep a surface function a top-level `function` declaration** and call it by name, never through a saved reference (`sessionSearch(() => renderSessions())`, not `sessionSearch(renderSessions)`). A mod's wrap replaces `window[name]` after `app.js` has run, so a saved reference skips the mod.
- **`renderTaskCard` returns the same HTML for the same task.** The board rewrites a column only when its HTML changes, so a wrapper that adds a random or a time-based part rewrites the column on every tick.
- **Wrap the renders only when `ClaudeHub.mod?.list.length`**: an older hub's SDK has no `mod`, and with no mod installed the wrapper is work for no one.
- **A listed state is a public API too.** A mod's CSS may select a part's listed state class and no other board class. For light and dark it selects `:root[data-hub-mode="light"]`, which the SDK sets, not `body.light`. For colors it uses the SDK's theme vars (`--bg-*`, `--text-*`, `--accent` and the others in the hub's `lib/themes.js`), not the board's own.
- **`progress` is the bar's track (`.progress-bar`), `progress-fill` the bar inside it.** A mod styles the fill through `[data-hub-part="progress-fill"]`.

`test/mod-surface.test.js` checks that each function is a top-level declaration, that the region emits exactly the listed events, that each part is marked, and that each state is a class the board sets. The hub's `test/mods.test.js` checks its bundled mods against this file.
