/**
 * Texting health check: warns a person before GoHighLevel's phone quality limit pauses our automated texts.
 *
 * Why: on 2026-11-11 one bulk send of 462 texts drew 21 STOP replies in a few hours, and GoHighLevel's LC Phone
 * "opt-out/error limit" paused every automated text for about 19 hours. Nobody knew until texts had failed, and the
 * uptime alerts that would have said so were texts too. This check counts, for the current day in New York time:
 *   - outbound texts by status, and failed texts whose error names a limit (the pause itself);
 *   - inbound opt-outs (a reply that is only STOP, STOPALL, UNSUBSCRIBE, CANCEL, END or QUIT).
 * It sends at most one "warning" and one "blocked" alert a day, through the same webhook as the uptime check, whose
 * GoHighLevel workflow sends a text and an email (the email still arrives while texts are paused).
 *
 * Read only on GoHighLevel. Variables:
 *   GHL_SMS_TOKEN          a Private Integration token with conversations read access only (set by hand in Railway)
 *   GHL_LOCATION_ID        the sub-account id
 *   OPS_ALERT_WEBHOOK_URL  where alerts go; without it they are only printed
 *   SMS_OPTOUT_WARN        opt-outs in one day that trigger the warning, default 8
 *   SMS_FAILED_WARN        failed texts in one day that trigger the warning, default 10
 *   SMS_STATE_FILE         default sms-health-state.json
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://services.leadconnectorhq.com';
const TZ = 'America/New_York';
const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)[\s.!]*$/i;
const LIMIT_ERROR = /limit/i;

export const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });

/** Start of the New York day that contains `ms`, as epoch ms. */
export function etDayStart(ms) {
  const day = etDay(ms);
  for (const off of [-4, -5]) {
    const t = Date.parse(`${day}T00:00:00${off === -4 ? '-04:00' : '-05:00'}`);
    if (etDay(t) === day && etDay(t - 1) !== day) return t;
  }
  return Date.parse(`${day}T00:00:00-05:00`);
}

/** Counts the day's texting from GoHighLevel message objects. */
export function classify(messages, dayStart) {
  const c = { sent: 0, delivered: 0, failed: 0, limitHits: 0, optOuts: 0 };
  for (const m of messages) {
    if (m.messageType !== 'TYPE_SMS' || Date.parse(m.dateAdded) < dayStart) continue;
    if (m.direction === 'outbound') {
      c.sent++;
      if (m.status === 'delivered') c.delivered++;
      if (m.status === 'failed') {
        c.failed++;
        if (LIMIT_ERROR.test(JSON.stringify(m.error ?? m.meta?.error ?? ''))) c.limitHits++;
      }
    } else if (m.direction === 'inbound' && OPT_OUT.test(String(m.body ?? ''))) {
      c.optOuts++;
    }
  }
  return c;
}

/** Which alerts to send now, given today's counts and what was already sent today. */
export function decide(counts, state, day, { optOutWarn, failedWarn }) {
  const sent = state.day === day ? state.sent : [];
  const alerts = [];
  const summary = `${counts.optOuts} opt-outs, ${counts.failed} failed of ${counts.sent} texts sent today`;
  if (counts.limitHits > 0 && !sent.includes('blocked')) {
    alerts.push({ level: 'blocked', cause: `GoHighLevel is pausing automated texts (phone quality limit). ${summary}. Texts will not go out until it lifts.` });
  }
  if ((counts.optOuts >= optOutWarn || counts.failed >= failedWarn) && !sent.includes('warning') && !sent.includes('blocked') && !alerts.length) {
    alerts.push({ level: 'warning', cause: `Close to GoHighLevel's texting limit: ${summary}. Pause any bulk send until tomorrow.` });
  }
  return { alerts, next: { day, sent: [...sent, ...alerts.map((a) => a.level)] } };
}

/** Reads every message of the conversations that changed today. `cache` maps conversation id to {last, messages}. */
export async function scan({ token, location, dayStart, cache = new Map(), fetchImpl = fetch }) {
  const H = { Authorization: `Bearer ${token}`, Version: '2021-07-28' };
  const get = async (path) => {
    const r = await fetchImpl(`${API}${path}`, { headers: H, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`GoHighLevel ${r.status} on ${path.split('?')[0]}`);
    return r.json();
  };
  const convs = [];
  for (let page = 0; page < 30; page++) {
    const after = convs.length ? `&startAfterDate=${convs.at(-1).lastMessageDate}` : '';
    const j = await get(`/conversations/search?locationId=${location}&limit=100&sort=desc&sortBy=last_message_date${after}`);
    const batch = j.conversations ?? [];
    convs.push(...batch);
    if (batch.length < 100 || batch.at(-1).lastMessageDate < dayStart) break;
  }
  const messages = [];
  for (const c of convs.filter((x) => x.lastMessageDate >= dayStart)) {
    let entry = cache.get(c.id);
    if (!entry || entry.last !== c.lastMessageDate) {
      const j = await get(`/conversations/${c.id}/messages?limit=50`);
      entry = { last: c.lastMessageDate, messages: (j.messages?.messages ?? []).filter((m) => m.messageType === 'TYPE_SMS') };
      cache.set(c.id, entry);
      await new Promise((r) => setTimeout(r, 60));
    }
    messages.push(...entry.messages);
  }
  return messages;
}

const cache = new Map();
let cacheDay = '';

export async function main({ now = Date.now(), fetchImpl = fetch } = {}) {
  const token = process.env.GHL_SMS_TOKEN;
  const location = process.env.GHL_LOCATION_ID;
  if (!token || !location) {
    console.log('sms-health: GHL_SMS_TOKEN or GHL_LOCATION_ID is not set, skipped');
    return;
  }
  const day = etDay(now);
  if (day !== cacheDay) { cache.clear(); cacheDay = day; }
  const stateFile = process.env.SMS_STATE_FILE || 'sms-health-state.json';
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run today */ }

  const counts = classify(await scan({ token, location, dayStart: etDayStart(now), cache, fetchImpl }), etDayStart(now));
  console.log(`sms-health ${day}: sent ${counts.sent}, delivered ${counts.delivered}, failed ${counts.failed} (limit ${counts.limitHits}), opt-outs ${counts.optOuts}`);

  const thresholds = { optOutWarn: Number(process.env.SMS_OPTOUT_WARN ?? 8), failedWarn: Number(process.env.SMS_FAILED_WARN ?? 10) };
  const { alerts, next } = decide(counts, state, day, thresholds);
  const hook = process.env.OPS_ALERT_WEBHOOK_URL;
  const delivered = [];
  for (const a of alerts) {
    console.log(`sms-health alert: ${a.level}  ${a.cause}`);
    if (!hook) { delivered.push(a.level); continue; }
    try {
      const res = await fetchImpl(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'down', site: `Texting (${a.level})`, url: 'https://app.gohighlevel.com', cause: a.cause, started_at: new Date(now).toISOString(), source: 'sms-health' }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      delivered.push(a.level);
    } catch (err) {
      console.error(`sms-health alert not delivered (${err.message}); retried next run`);
    }
  }
  // Only alerts that were delivered count as sent, so a refused one is retried on the next run.
  const sentToday = state.day === day ? state.sent : [];
  fs.writeFileSync(stateFile, JSON.stringify({ day, sent: [...sentToday, ...delivered] }, null, 2));
  return { counts, alerts, next };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
