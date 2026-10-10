const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];

function board({ modes, open = null, focused = false }) {
  const calls = [];
  const ctx = {
    termState: { sessionId: open },
    terminalModes: () => modes,
    setTerminalMode: (id, on) => {
      if (!on) modes.delete(id);
      calls.push(`mode:${id}:${on}`);
    },
    terminalPaneFocused: () => focused,
    leaveTerminalPane: () => calls.push('leave'),
    detachTerminal: () => calls.push('detach'),
    syncTerminal: () => calls.push('sync'),
    dropPlaceholder: (id) => calls.push(`drop:${id}`),
  };
  vm.runInNewContext(`${fn('exitTerminalMode')}\n${fn('onTerminalEnded')}`, ctx);
  return { ctx, calls };
}

describe('terminal:ended on the board', () => {
  it('clears terminal mode, so focusing the session does not resume claude', () => {
    const modes = new Set(['a', 'b']);
    const { ctx, calls } = board({ modes });
    ctx.onTerminalEnded('a');
    assert.deepEqual([...modes], ['b']);
    assert.deepEqual(calls, ['mode:a:false', 'sync', 'drop:a']);
  });

  it('detaches the open terminal and leaves its pane first', () => {
    const { ctx, calls } = board({ modes: new Set(['a']), open: 'a', focused: true });
    ctx.onTerminalEnded('a');
    assert.deepEqual(calls, ['leave', 'detach', 'mode:a:false', 'sync', 'drop:a']);
  });

  it('detaches the open terminal when a same-origin tab already cleared its mode', () => {
    const { ctx, calls } = board({ modes: new Set(), open: 'a' });
    ctx.onTerminalEnded('a');
    assert.deepEqual(calls, ['detach', 'mode:a:false', 'sync', 'drop:a']);
  });

  it('only drops a placeholder for a session not open and not in terminal mode', () => {
    const { ctx, calls } = board({ modes: new Set(['b']), open: 'c' });
    ctx.onTerminalEnded('a');
    assert.deepEqual(calls, ['drop:a']);
  });
});
