/**
 * Uptime check: asks every site in sites.json for a page and
 * tells a person when one stops answering, and again when it comes back.
 *
 * It exists because taxsherpa.com was down from 2026-10-05 to 2026-10-09 and
 * nobody knew. It runs on GitHub's machines (.github/workflows/uptime.yml), so
 * it keeps working when Railway is the thing that is broken.
 *
 * An alert is one POST to OPS_ALERT_WEBHOOK_URL, a GoHighLevel inbound webhook
 * whose workflow sends the text message and the email. One alert when a site
 * goes down and one when it recovers: the previous run's result is read from
 * UPTIME_STATE_FILE, so a site that stays down does not alert every run.
 *
 * Usage: node check.mjs
 *   OPS_ALERT_WEBHOOK_URL   where alerts go; without it they are only printed
 *   UPTIME_STATE_FILE       default uptime-state.json
 *   UPTIME_SITES_FILE       default sites.json
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const ATTEMPTS = 3;
const WAIT_MS = Number(process.env.UPTIME_WAIT_MS ?? 15000);
const TIMEOUT_MS = 20000;

/** The failure in words a person reads in a text message, with the technical code kept at the end. */
export function explain(err) {
  if (err.name === 'TimeoutError') return `no answer in ${TIMEOUT_MS / 1000} seconds`;
  const code = err.cause?.code || '';
  const plain = {
    ENOTFOUND: 'address not found',
    EAI_AGAIN: 'address lookup failed',
    ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection dropped',
    ETIMEDOUT: 'connection timed out',
    CERT_HAS_EXPIRED: 'security certificate expired',
    ERR_TLS_CERT_ALTNAME_INVALID: 'security certificate does not match the address',
  }[code];
  if (plain) return `${plain} (${code})`;
  return code || err.message;
}

/** A site is up when any of a few spaced attempts answers below 400. */
export async function probe(url) {
  let cause = '';
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i) await new Promise((r) => setTimeout(r, WAIT_MS));
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status < 400) return { up: true, cause: '' };
      cause = `the site answered with error ${res.status}`;
    } catch (err) {
      cause = explain(err);
    }
  }
  return { up: false, cause };
}

/**
 * Compares this run with the last one.
 *   prev:    { [url]: ISO time the site went down }
 *   results: [{ name, url, up, cause }]
 * Returns the alerts to send and the state to keep for the next run.
 */
export function transitions(prev, results, now) {
  const alerts = [];
  const next = {};
  for (const r of results) {
    const since = prev[r.url];
    if (!r.up) {
      next[r.url] = since || now;
      if (!since) alerts.push({ event: 'down', site: r.name, url: r.url, cause: r.cause, started_at: now });
    } else if (since) {
      alerts.push({ event: 'up', site: r.name, url: r.url, cause: 'Answering again', started_at: since });
    }
  }
  return { alerts, next };
}

async function main() {
  const sites = JSON.parse(fs.readFileSync(process.env.UPTIME_SITES_FILE || 'sites.json', 'utf8'));
  const stateFile = process.env.UPTIME_STATE_FILE || 'uptime-state.json';
  const hook = process.env.OPS_ALERT_WEBHOOK_URL;

  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    /* first run, or the last state expired: everything is assumed to have been up */
  }

  const results = await Promise.all(sites.map(async (s) => ({ ...s, ...(await probe(s.url)) })));
  for (const r of results) {
    console.log(`${r.up ? 'up  ' : 'DOWN'}  ${r.name}  ${r.url}${r.up ? '' : `  (${r.cause})`}`);
  }

  const { alerts, next } = transitions(prev, results, new Date().toISOString());
  let failed = 0;
  for (const a of alerts) {
    console.log(`alert: ${a.event}  ${a.site}`);
    if (!hook) continue;
    try {
      const res = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...a, source: 'uptime-check' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      failed++;
      console.error(`alert not delivered (${err.message})`);
      // Not recorded as sent, so the next run tries again.
      if (a.event === 'down') delete next[a.url];
      else next[a.url] = a.started_at;
    }
  }
  if (alerts.length && !hook) console.log('OPS_ALERT_WEBHOOK_URL is not set: alerts were printed, not sent.');

  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
