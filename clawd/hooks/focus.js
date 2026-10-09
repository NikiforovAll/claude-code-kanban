'use strict';

// UserPromptSubmit: tells Clawd which session the board shows, only when it changed since the last
// message of this chat. A board that does not answer adds nothing, so the message still goes through.
// SessionStart after a compact forgets the last one: the summary may drop the line.
const fs = require('node:fs');
const path = require('node:path');

function describe(f) {
  if (!f.sessionId) return 'Focused session: none. The board shows a project view or no session.';
  return [
    `Focused session: ${f.sessionId}${f.name ? ` "${f.name}"` : ''}`,
    f.project && `project ${f.project}`,
    f.gitBranch && `branch ${f.gitBranch}`,
    f.transcript && `transcript ${f.transcript}`,
  ]
    .filter(Boolean)
    .join(', ');
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (!process.env.CCK_URL || !input.cwd) return;
  const seenFile = path.join(input.cwd, 'focus-seen.txt');
  if (input.hook_event_name === 'SessionStart') return fs.rmSync(seenFile, { force: true });
  let seen = '';
  try {
    const [chat, focusId] = fs.readFileSync(seenFile, 'utf8').split(' ');
    if (chat === input.session_id) seen = focusId;
  } catch {}
  const url = `${process.env.CCK_URL}/api/clawd/context?seen=${encodeURIComponent(seen)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (res.status !== 200) return;
  const focus = await res.json();
  fs.writeFileSync(seenFile, `${input.session_id} ${focus.sessionId}`);
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: describe(focus) } }),
  );
}

main().catch(() => {});
