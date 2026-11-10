/**
 * Tests check.mjs end to end against local servers: a site that
 * is up, one that answers 500, an address nothing listens on, and a stand-in
 * for the alert webhook.
 *
 * Usage: node test-check.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { transitions, explain } from './check.mjs';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

// The rule on its own
const up = (url) => ({ name: url, url, up: true, cause: '' });
const down = (url) => ({ name: url, url, up: false, cause: 'HTTP 500' });
let t = transitions({}, [up('a'), down('b')], 'T1');
check('newly down alerts once', t.alerts.length === 1 && t.alerts[0].event === 'down' && t.next.b === 'T1', t);
t = transitions({ b: 'T1' }, [up('a'), down('b')], 'T2');
check('still down does not alert again and keeps the first time', t.alerts.length === 0 && t.next.b === 'T1', t);
t = transitions({ b: 'T1' }, [up('a'), up('b')], 'T3');
check('recovery alerts once and clears the state', t.alerts.length === 1 && t.alerts[0].event === 'up' && t.alerts[0].started_at === 'T1' && !t.next.b, t);
t = transitions({}, [up('a'), up('b')], 'T4');
check('all up, nothing to send', t.alerts.length === 0 && Object.keys(t.next).length === 0, t);

// A 429 is the network throttling the checker, not the site being down (Railway, 2026-11-10)
const limited = (url) => ({ name: url, url, up: false, limited: true, cause: 'the site answered with error 429' });
t = transitions({}, [limited('a')], 'L1');
check('429: a first throttled check sends nothing and records no outage', t.alerts.length === 0 && !t.next.a && t.next.__limited.a === 1, t);
let st = {};
let sent = 0;
for (let i = 1; i <= 5; i++) { t = transitions(st, [limited('a')], 'L' + i); sent += t.alerts.length; st = t.next; }
check('429: five throttled checks in a row (25 minutes) still send nothing', sent === 0 && st.__limited.a === 5, st);
t = transitions(st, [limited('a')], 'L6');
check('429: the sixth in a row (30 minutes) alerts once, in words', t.alerts.length === 1 && t.alerts[0].event === 'down' && /rate limited by the network for 6 checks/.test(t.alerts[0].cause) && t.next.a === 'L6', t);
t = transitions(t.next, [limited('a')], 'L7');
check('429: and not again while it continues', t.alerts.length === 0 && t.next.a === 'L6', t);
t = transitions({ a: 'T1' }, [limited('a')], 'L8');
check('429: a site already down stays down, with no false "up"', t.alerts.length === 0 && t.next.a === 'T1', t);
t = transitions(st, [up('a')], 'L9');
check('429: an answer clears the count and sends nothing for a site that was never down', t.alerts.length === 0 && Object.keys(t.next).length === 0, t);
t = transitions({ __limited: { a: 4 } }, [up('a')], 'L10');
t = transitions(t.next, [limited('a')], 'L11');
check('429: the count starts over after a good answer', t.alerts.length === 0 && t.next.__limited.a === 1, t);
t = transitions({ __limited: { a: 5 } }, [down('a')], 'L12');
check('429: a real failure alerts at once, whatever the throttled count was', t.alerts.length === 1 && t.alerts[0].event === 'down' && !t.next.__limited, t);

check('a failed address lookup reads as "address not found"', explain({ cause: { code: 'ENOTFOUND' } }) === 'address not found (ENOTFOUND)');
check('a timeout reads as "no answer"', explain({ name: 'TimeoutError' }) === 'no answer in 20 seconds');
check('an unknown failure keeps its code', explain({ cause: { code: 'EWHATEVER' }, message: 'fetch failed' }) === 'EWHATEVER');

// The script against real sockets
let healthy = false;
let limitedThen500 = 0;
let hookStatus = 200;
const received = [];
const site = http.createServer((req, res) => {
  if (req.url === '/ok') return res.writeHead(200).end('ok');
  if (req.url === '/limited') return res.writeHead(429).end('rate limited');
  if (req.url === '/limited-then-500') return res.writeHead(++limitedThen500 % 2 ? 429 : 500).end();
  res.writeHead(healthy ? 200 : 500).end();
});
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (hookStatus === 200) received.push(JSON.parse(body));
    res.writeHead(hookStatus).end('{}');
  });
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
await new Promise((r) => hook.listen(0, '127.0.0.1', r));
// A port that was open a moment ago and is now closed: nothing answers on it.
const gone = http.createServer();
await new Promise((r) => gone.listen(0, '127.0.0.1', r));
const closedPort = gone.address().port;
await new Promise((r) => gone.close(r));

const S = `http://127.0.0.1:${site.address().port}`;
const H = `http://127.0.0.1:${hook.address().port}/hook`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-'));
const sitesFile = path.join(dir, 'sites.json');
const stateFile = path.join(dir, 'state.json');
fs.writeFileSync(
  sitesFile,
  JSON.stringify([
    { name: 'Good', url: `${S}/ok` },
    { name: 'Flaky', url: `${S}/flaky` },
    { name: 'Nowhere', url: `http://127.0.0.1:${closedPort}/` },
  ])
);
const run = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['check.mjs'], {
      env: { ...process.env, OPS_ALERT_WEBHOOK_URL: H, UPTIME_STATE_FILE: stateFile, UPTIME_SITES_FILE: sitesFile, UPTIME_WAIT_MS: '50' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });

try {
  let r = await run();
  check('run 1: two sites down, two alerts delivered', received.length === 2 && received.every((a) => a.event === 'down' && a.source === 'uptime-check'), received);
  check('run 1: the alert names the site, the address and the cause', received.some((a) => a.site === 'Flaky' && a.url === `${S}/flaky` && a.cause === 'the site answered with error 500'), received);
  check('run 1: an address nothing answers on is explained in plain words', received.some((a) => a.site === 'Nowhere' && a.cause === 'connection refused (ECONNREFUSED)'), received);
  check('run 1: exits 0', r.code === 0, r.out);

  r = await run();
  check('run 2: still down, no new alert', received.length === 2, received);

  healthy = true;
  r = await run();
  check('run 3: Flaky recovered, one "up" alert', received.length === 3 && received[2].event === 'up' && received[2].site === 'Flaky', received);
  check('run 3: Nowhere is still remembered as down', Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).length === 1);

  healthy = false;
  hookStatus = 500;
  r = await run();
  check('run 4: webhook refuses, the run fails so it is visible', r.code === 1 && /alert not delivered/.test(r.out), r);
  hookStatus = 200;
  r = await run();
  check('run 5: the alert that was not delivered is sent on the next run', received.length === 4 && received[3].event === 'down' && received[3].site === 'Flaky', received);
  // A site that only ever answers 429, against real sockets: three checks in a row with UPTIME_LIMITED_MAX=3
  const limFile = path.join(dir, 'limited-sites.json');
  const limState = path.join(dir, 'limited-state.json');
  fs.writeFileSync(limFile, JSON.stringify([{ name: 'Throttled', url: `${S}/limited` }, { name: 'Mixed', url: `${S}/limited-then-500` }]));
  const before = received.length;
  const runLim = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['check.mjs'], {
        env: { ...process.env, OPS_ALERT_WEBHOOK_URL: H, UPTIME_STATE_FILE: limState, UPTIME_SITES_FILE: limFile, UPTIME_WAIT_MS: '50', UPTIME_LIMITED_MAX: '3' },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', (code) => resolve({ code, out }));
    });
  r = await runLim();
  const first = received.slice(before);
  check('429 run 1: a site answering only 429 sends no alert, a mixed 429/500 one alerts as down', first.length === 1 && first[0].site === 'Mixed' && first[0].event === 'down', first);
  check('429 run 1: the line says it was throttled, not down', /LTD\s+Throttled/.test(r.out) && /DOWN\s+Mixed/.test(r.out), r.out);
  await runLim();
  check('429 run 2: still no alert for the throttled site', received.slice(before).length === 1, received.slice(before));
  await runLim();
  const third = received.slice(before);
  check('429 run 3: after 3 in a row (the limit set for the test) it alerts once', third.length === 2 && third[1].site === 'Throttled' && /rate limited by the network for 3 checks/.test(third[1].cause), third);
} finally {
  site.close();
  hook.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
