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
