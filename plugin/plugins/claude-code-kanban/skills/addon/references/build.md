# Build an add-on

An add-on is one HTML page and a small server that serves it. The board frames the page by its URL, so any stack works; this guide uses Node with no dependencies. The build is done when the server answers 200 and `addon add` printed an id.

## 1. Write the server and the page

Put them in a folder of their own, outside the project when the add-on serves more than one project:

```js
// server.js: node server.js [port]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.env.PORT || process.argv[2]) || 4100;
const page = fs.readFileSync(path.join(__dirname, 'index.html'));
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/`));
```

The server binds to `127.0.0.1` and sends its pages with no `X-Frame-Options` or `frame-ancestors` header, so the board can frame them.

## 2. Read the context from the URL

The URL is the page's only input from the board. The page reads the values the board filled in, such as `?cwd={cwd}`, from `location.search`, and passes them to its server on each request.

## 3. Take the board's theme

Style the page with the variables of the HTML contract in [the show skill](../../show/SKILL.md#html-contract), in its flat style. Set fallback values for them in `:where(:root)`, and apply the board's values from its message, which it sends on each load and each theme change:

```js
addEventListener('message', (e) => {
  if (e.source !== parent || e.data?.type !== 'cck-show:tokens') return;
  for (const [k, v] of Object.entries(e.data.tokens)) document.documentElement.style.setProperty(k, v);
});
```

## 4. Hand back the board's keys and focus

While the page has focus, it gets every key press, so the board's keys (Alt+Enter to expand, Alt+W, Alt+↑/↓, the terminal and hub keys) stop working, and the board cannot tell that the dock has focus. Put this script in the page, as it is. The board sends the presses it wants (`hub:hostKeys`), the script hands only those back, and it reports focus so the dock lights up:

```js
let boardKeys = new Set();
let board = null;
const sigs = (e) => {
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'].filter(Boolean).join('+');
  return [e.code && `${mods}|c:${e.code}`, e.key && e.key !== 'Unidentified' && `${mods}|k:${e.key.toLowerCase()}`];
};
addEventListener('message', (e) => {
  if (e.source !== parent || e.data?.type !== 'hub:hostKeys') return;
  board = e.origin;
  boardKeys = new Set(e.data.keys.map((k) => sigs(k).find(Boolean)));
});
addEventListener('keydown', (e) => {
  if (!board || !sigs(e).some((s) => boardKeys.has(s))) return;
  e.preventDefault();
  parent.postMessage({ type: 'hub:hostKey', key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }, board);
}, true);
for (const on of [true, false]) addEventListener(on ? 'focus' : 'blur', () => parent.postMessage({ type: 'cck-show:focus', on }, '*'));
```

## 5. Push updates

When the content follows files, the server watches them (`fs.watch`) and pushes each change to the page over server-sent events (`text/event-stream`), and the page updates in place. A push costs nothing while nothing changes; the board unloads a page hidden for a minute.

## 6. Fit the dock

The dock is 360 to 900 px wide and the full height of the terminal. Lay the page out in normal flow that wraps at 360 px, and let the body scroll.

## 7. Run and register

1. Start the server where the user can see and stop it, such as a tmux window, or ask the user to start it.
2. Check that it answers 200: `curl -s -o /dev/null -w '%{http_code}' http://localhost:4100/`.
3. Register it with `claude-code-kanban addon add "<url>" --title <t>`. When the user asked for every session, add `--global --run "<start command>" --cwd <server folder>`, so the board starts the server when the add-on opens. The server reads its port from `PORT`.
4. Tell the user it is on the rail. For a session add-on, also give the command that starts the server again after a restart.
