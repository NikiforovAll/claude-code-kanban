const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { freshRateLimits } = require('../lib/rate-limits');

const NOW = 1_800_000_000;

describe('freshRateLimits', () => {
  it('takes each window from the freshest entry that has it', () => {
    const entries = [
      { _updatedAt: 1, rate_limits: { five_hour: { used_percentage: 10, resets_at: NOW + 60 }, seven_day: { used_percentage: 20, resets_at: NOW + 600 } } },
      { _updatedAt: 3, rate_limits: { five_hour: { used_percentage: 30, resets_at: NOW + 60 } } },
      { _updatedAt: 2, rate_limits: { seven_day: { used_percentage: 25, resets_at: NOW + 600 } } },
    ];
    assert.deepEqual(freshRateLimits(entries, NOW), {
      five_hour: { used_percentage: 30, resets_at: NOW + 60 },
      seven_day: { used_percentage: 25, resets_at: NOW + 600 },
    });
  });

  it('drops a window that has reset, and keeps one with no reset time', () => {
    const entries = [
      { _updatedAt: 5, rate_limits: { five_hour: { used_percentage: 90, resets_at: NOW - 1 }, seven_day: { used_percentage: 40 } } },
    ];
    assert.deepEqual(freshRateLimits(entries, NOW), { seven_day: { used_percentage: 40 } });
  });

  it('a newer entry with no limits does not hide an older valid one', () => {
    const entries = [
      { _updatedAt: 1, rate_limits: { five_hour: { used_percentage: 10, resets_at: NOW + 60 } } },
      { _updatedAt: 9, rate_limits: {} },
      { _updatedAt: 10 },
    ];
    assert.deepEqual(freshRateLimits(entries, NOW), { five_hour: { used_percentage: 10, resets_at: NOW + 60 } });
  });

  it('returns an empty object when nothing is valid', () => {
    assert.deepEqual(freshRateLimits([], NOW), {});
    assert.deepEqual(freshRateLimits(new Map([['a', { rate_limits: { five_hour: { used_percentage: 1, resets_at: NOW } } }]]).values(), NOW), {});
  });
});
