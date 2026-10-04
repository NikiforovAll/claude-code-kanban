// A terminal viewer in its own process, so it keeps typing while the test's thread is blocked.
// argv: port, token, session id. Reports the slowest echo of keys typed over `ms`.
const WebSocket = require('ws');

const [port, token, id] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers: { origin: `http://localhost:${port}` } });
let out = '';
let waiting = null;

ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token, id, mode: 'shell', cols: 80, rows: 24 })));
ws.on('message', (d, bin) => {
  if (!bin) {
    if (JSON.parse(d.toString()).t === 'ready') process.send({ t: 'ready' });
    return;
  }
  out += d.toString('utf8');
  if (waiting && out.includes(waiting.mark)) waiting.done();
});

function echo(mark) {
  return new Promise((resolve) => {
    const t = Date.now();
    waiting = { mark, done: () => { waiting = null; resolve(Date.now() - t); } };
    ws.send(JSON.stringify({ t: 'in', d: `echo ${mark}\r` }));
  });
}

process.on('message', async (msg) => {
  if (msg.t !== 'go') return;
  const latencies = [];
  const end = Date.now() + msg.ms;
  for (let i = 0; Date.now() < end; i++) {
    latencies.push(await echo(`mk${i}-${process.pid}`));
    await new Promise((r) => setTimeout(r, 50));
  }
  process.send({ t: 'result', latencies });
  ws.close();
  process.disconnect();
});
