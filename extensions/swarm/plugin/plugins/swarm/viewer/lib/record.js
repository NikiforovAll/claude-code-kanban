'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const recordFile = (config) => path.join(config, '.cck', 'swarm-viewer.json');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readRecord(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// A dead viewer's pid and port can be reused, so the health route must name this config dir.
// http.get with no agent, not fetch: on Windows, process.exit while an undici socket is still
// closing trips a libuv assertion.
function liveRecord(file, config) {
  const record = readRecord(file);
  if (!Number.isInteger(record?.pid) || !Number.isInteger(record?.port) || !alive(record.pid)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: record.port, path: '/api/health', headers: { host: 'localhost' }, agent: false, timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => {
        try {
          const h = JSON.parse(body);
          resolve(res.statusCode === 200 && h.pid === record.pid && samePath(h.configDir, config) ? record : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function claimRecord(file, config, port) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = `${JSON.stringify({ pid: process.pid, port, configDir: config })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
      return { claimed: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const stale = readText(file);
    const live = await liveRecord(file, config);
    if (live) return { claimed: false, live };
    if (stale !== null && readText(file) === stale) fs.rmSync(file, { force: true });
  }
  return { claimed: false, live: null };
}

function removeRecord(file) {
  if (readRecord(file)?.pid === process.pid) fs.rmSync(file, { force: true });
}

module.exports = { recordFile, readRecord, liveRecord, claimRecord, removeRecord };
