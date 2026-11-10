/**
 * Uptime check: asks every site in sites.json for a page and
 * tells a person when one stops answering, and again when it comes back.
 *
 * It exists because taxsherpa.com was down from 2026-10-05 to 2026-10-09 and
 * nobody knew. loop.mjs runs it every 5 minutes as an always-on service; the
 * GitHub workflow (.github/workflows/uptime.yml) is the slower copy that stays up
 * when Railway is the thing that is broken.
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
// A 429 ("too many requests") is the network telling the checker to slow down, not the site being down: on 2026-11-10 Railway's
// network rate-limited this checker twice and sent 20+ false "down" texts while the sites kept serving visitors. A site that only
// answers 429 is "could not check": no alert either way, until it has lasted this many checks in a row (6 x 5 minutes = 30).
const LIMITED_MAX = Number(process.env.UPTIME_LIMITED_MAX ?? 6);
const LIMITED_KEY = '__limited';

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

/**
 * A site is up when any of a few spaced attempts answers below 400.
 * When every attempt was answered with 429 the result is { up: false, limited: true }: the check was throttled, so it says
 * nothing about the site (see LIMITED_MAX). Any other failure among the attempts makes it an ordinary "down".
 */
export async function probe(url) {
  let cause = '';
  let onlyLimited = true;
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i) await new Promise((r) => setTimeout(r, WAIT_MS));
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status < 400) return { up: true, cause: '' };
      if (res.status !== 429) onlyLimited = false;
      cause = `the site answered with error ${res.status}`;
    } catch (err) {
      onlyLimited = false;
      cause = explain(err);
    }
  }
  return onlyLimited ? { up: false, limited: true, cause } : { up: false, cause };
}

/**
 * Compares this run with the last one.
 *   prev:    { [url]: ISO time the site went down, __limited: { [url]: checks in a row that were throttled } }
 *   results: [{ name, url, up, cause, limited? }]
 * Returns the alerts to send and the state to keep for the next run.
 * A throttled check (limited) changes nothing: a site that was up stays up, one that was down stays down. Only after
 * LIMITED_MAX throttled checks in a row is it reported, as down, with the reason in words.
 */
export function transitions(prev, results, now) {
  const alerts = [];
  const next = {};
  const prevLimited = prev[LIMITED_KEY] || {};
  const limitedNow = {};
  for (const r of results) {
    const since = prev[r.url];
    if (r.limited) {
      const n = (prevLimited[r.url] || 0) + 1;
      limitedNow[r.url] = n;
      if (since) next[r.url] = since;
      else if (n >= LIMITED_MAX) {
        next[r.url] = now;
        alerts.push({ event: 'down', site: r.name, url: r.url, cause: `rate limited by the network for ${n} checks in a row (${r.cause})`, started_at: now });
      }
      continue;
    }
    if (!r.up) {
      next[r.url] = since || now;
      if (!since) alerts.push({ event: 'down', site: r.name, url: r.url, cause: r.cause, started_at: now });
    } else if (since) {
      alerts.push({ event: 'up', site: r.name, url: r.url, cause: 'Answering again', started_at: since });
    }
  }
  if (Object.keys(limitedNow).length) next[LIMITED_KEY] = limitedNow;
  return { alerts, next };
}

export async function main() {
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
    console.log(`${r.up ? 'up  ' : r.limited ? 'LTD ' : 'DOWN'}  ${r.name}  ${r.url}${r.up ? '' : `  (${r.limited ? 'throttled by the network, not counted as down: ' : ''}${r.cause})`}`);
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
