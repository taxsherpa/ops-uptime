/**
 * Tests loop.mjs: the always-on runner. Starts it against local stand-ins (a site
 * that can be flipped up and down, and an alert webhook) with a check every second
 * and watches what it does over time.
 *
 * Usage: node test-loop.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

let healthy = false;
let hookStatus = 200;
const received = [];
const site = http.createServer((req, res) => res.writeHead(healthy ? 200 : 500).end());
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-loop-'));
const sitesFile = path.join(dir, 'sites.json');
const stateFile = path.join(dir, 'state.json');
const goodSites = JSON.stringify([{ name: 'Flaky', url: `http://127.0.0.1:${site.address().port}/` }]);
fs.writeFileSync(sitesFile, goodSites);

let out = '';
const child = spawn(process.execPath, ['loop.mjs'], {
  env: {
    ...process.env,
    OPS_ALERT_WEBHOOK_URL: `http://127.0.0.1:${hook.address().port}/hook`,
    UPTIME_STATE_FILE: stateFile,
    UPTIME_SITES_FILE: sitesFile,
    UPTIME_WAIT_MS: '20',
    UPTIME_EVERY_SECONDS: '1',
  },
});
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
let exited = null;
child.on('exit', (code, signal) => (exited = { code, signal }));
const checks = () => (out.match(/^--- check at /gm) || []).length;
const alerts = (event) => received.filter((a) => a.event === event && a.site === 'Flaky').length;

try {
  check('the loop starts and says how often it checks', await waitFor(() => /a check every 1 seconds/.test(out)), out);

  // A site that stays down: many checks, one alert.
  check('it keeps checking by itself (3 checks within the first seconds)', await waitFor(() => checks() >= 3), { checks: checks() });
  const seenAtDown = checks();
  check('a down site alerts once...', await waitFor(() => alerts('down') === 1), received);
  await waitFor(() => checks() >= seenAtDown + 3);
  check('...and not again on the checks that follow, because the loop remembers it', alerts('down') === 1 && received.length === 1, received);

  // Recovery.
  healthy = true;
  check('recovery alerts once', await waitFor(() => alerts('up') === 1), received);
  const seenAtUp = checks();
  await waitFor(() => checks() >= seenAtUp + 2);
  check('and not again while it stays up', alerts('up') === 1 && received.length === 2, received);

  // A bad run does not end the loop.
  fs.writeFileSync(sitesFile, '{ not json');
  check('an unreadable sites file is logged, not fatal', await waitFor(() => /check crashed/.test(out)), out);
  const seenAtBad = checks();
  check('the loop is still checking after the crash', await waitFor(() => checks() >= seenAtBad + 2) && exited === null, { exited });
  fs.writeFileSync(sitesFile, goodSites);
  await waitFor(() => checks() >= seenAtBad + 4);
  check('once the file is fixed, it carries on without a false alert', received.length === 2, received);

  // The webhook refuses: the loop keeps going and retries until it is delivered.
  healthy = false;
  hookStatus = 500;
  check('a refused alert is reported', await waitFor(() => /alert not delivered/.test(out)), out);
  const seenAtRefused = checks();
  await waitFor(() => checks() >= seenAtRefused + 2);
  check('the loop survives a refusing webhook', exited === null, { exited });
  hookStatus = 200;
  check('the alert is delivered on a later check, once', await waitFor(() => alerts('down') === 2), received);
  const seenAtRetried = checks();
  await waitFor(() => checks() >= seenAtRetried + 3);
  check('and then it is not repeated', alerts('down') === 2, received);

  // Stopping. Windows cannot deliver SIGTERM to a child, so this part runs on Linux and macOS only.
  if (process.platform === 'win32') {
    console.log('  skip  clean stop on SIGTERM (not deliverable on Windows; Railway runs Linux)');
  } else {
    const t0 = Date.now();
    child.kill('SIGTERM');
    check('SIGTERM stops it quickly and cleanly', (await waitFor(() => exited !== null, 5000)) && exited.code === 0 && Date.now() - t0 < 3000, exited);
  }
} finally {
  if (exited === null) child.kill();
  site.close();
  hook.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
