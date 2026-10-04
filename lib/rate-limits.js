// Rate limits belong to the account, so each window comes from the freshest context-status
// file that has it. A window whose `resets_at` (epoch seconds) has passed is dropped: its
// percent is from before the reset. A window with no `resets_at` is kept.

const WINDOWS = ['five_hour', 'seven_day'];

function freshRateLimits(entries, nowSec) {
  const best = {};
  for (const e of entries) {
    for (const w of WINDOWS) {
      const limit = e?.rate_limits?.[w];
      if (limit?.used_percentage == null) continue;
      if (limit.resets_at != null && limit.resets_at <= nowSec) continue;
      const at = e._updatedAt || 0;
      if (!best[w] || at > best[w].at) best[w] = { at, limit };
    }
  }
  return Object.fromEntries(Object.entries(best).map(([w, b]) => [w, b.limit]));
}

module.exports = { freshRateLimits };
