'use strict';

// Program Status Protocol, OSC 7501, revision 0.4:
// https://www.superlogical.com/rex/docs/build/program-status
// A program in the terminal reports what it is doing; claude-code sends it once the
// terminal answers the feature query. Every report is untrusted input.

const OSC_CODE = 7501;
const QUERY_REPLY = '\x1b]7501;?\x1b\\';
const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error']);
const KINDS = new Set(['permission', 'question', 'auth']);
const TRANSIENT = new Set(['working', 'blocked']);
const ATTENTION = { blocked: 4, working: 3, error: 2, done: 2, idle: 1 };

const MAX_SEQUENCE = 4096;
const MAX_KEY = 16;
const MAX_RECORDS = 256;
const MAX_ID = 128;
const MAX_DEPTH = 8;
const TEXT_LIMITS = { msg: [2732, 2048], title: [256, 192] };

const KEY_RE = /^[a-z]+$/;
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const PROGRESS_RE = /^(?:100|[1-9]?\d)$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the spec refuses C0, DEL and C1 in decoded text
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// The spec asks a terminal to disarm bidi overrides and invisible format characters before it shows a msg.
const FORMAT_RE = /[؜​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const SHOWN_MSG = 160;
const PROGRESS_STEP = 10;

function shownText(text) {
  const clean = text.replace(FORMAT_RE, '').trim();
  return clean.length > SHOWN_MSG ? `${clean.slice(0, SHOWN_MSG - 1)}…` : clean;
}

function decodeText(value, [maxEncoded, maxDecoded]) {
  if (value.length > maxEncoded || !BASE64_RE.test(value) || value.length % 4 === 1) return null;
  let text;
  try {
    text = utf8.decode(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
  if (Buffer.byteLength(text) > maxDecoded || CONTROL_RE.test(text)) return null;
  return text;
}

function validId(id) {
  if (id.length > MAX_ID) return false;
  const segments = id.split('/');
  return segments.length <= MAX_DEPTH && segments.every((s) => SEGMENT_RE.test(s));
}

// Null when the spec says to drop the whole report.
function parseReport(data) {
  if (Buffer.byteLength(data) > MAX_SEQUENCE) return null;
  const pairs = {};
  for (const raw of data.split(':')) {
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!key || key.length > MAX_KEY || !KEY_RE.test(key) || !VALUE_RE.test(value)) continue;
    pairs[key] = value;
  }
  const state = pairs.state;
  if (state !== 'clear' && !STATES.has(state)) return null;
  const id = pairs.id ?? '';
  if (pairs.id !== undefined && !validId(id)) return null;
  const report = { state, id };
  for (const key of ['msg', 'title']) {
    if (pairs[key] === undefined) continue;
    const text = decodeText(pairs[key], TEXT_LIMITS[key]);
    if (text === null) return null;
    report[key] = text;
  }
  if (pairs.app !== undefined && APP_RE.test(pairs.app)) report.app = pairs.app;
  if (state === 'blocked' && KINDS.has(pairs.kind)) report.kind = pairs.kind;
  if (TRANSIENT.has(state) && PROGRESS_RE.test(pairs.progress ?? '')) report.progress = Number(pairs.progress);
  return report;
}

const isUnder = (id, parent) => !parent || id === parent || id.startsWith(`${parent}/`);

function parentOf(id) {
  if (!id) return null;
  const slash = id.lastIndexOf('/');
  return slash < 0 ? '' : id.slice(0, slash);
}

function createProgramStatus() {
  const records = new Map();
  let seq = 0;

  function appOf(id) {
    for (let at = id; at !== null; at = parentOf(at)) {
      const app = records.get(at)?.app;
      if (app) return app;
    }
    return null;
  }

  function summary() {
    let best = null;
    for (const [id, r] of records) {
      const rank = ATTENTION[r.state];
      if (!best || rank > best.rank || (rank === best.rank && r.seq > best.r.seq)) best = { id, r, rank };
    }
    if (!best) return null;
    const { r, id } = best;
    return {
      state: r.state,
      kind: r.kind || null,
      app: appOf(id),
      msg: r.msg || null,
      progress: r.progress === undefined ? null : Math.floor(r.progress / PROGRESS_STEP) * PROGRESS_STEP,
    };
  }

  function apply(report) {
    if (report.state === 'clear') {
      for (const id of [...records.keys()]) if (isUnder(id, report.id)) records.delete(id);
      return;
    }
    records.delete(report.id);
    if (records.size >= MAX_RECORDS) records.delete(records.keys().next().value);
    const { id, ...rest } = report;
    if (rest.msg) rest.msg = shownText(rest.msg);
    records.set(id, { ...rest, seq: ++seq });
  }

  function dropWhere(test) {
    for (const [id, r] of records) if (test(r)) records.delete(id);
  }

  function track(fn) {
    const before = JSON.stringify(summary());
    fn();
    return JSON.stringify(summary()) !== before;
  }

  return {
    handle(data) {
      if (data === '?') return 'query';
      const report = parseReport(data);
      return report ? track(() => apply(report)) : false;
    },
    dropTransient: () => track(() => dropWhere((r) => TRANSIENT.has(r.state))),
    reset: () => track(() => records.clear()),
    summary,
  };
}

module.exports = { OSC_CODE, QUERY_REPLY, parseReport, createProgramStatus };
