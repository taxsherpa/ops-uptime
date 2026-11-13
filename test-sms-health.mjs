/**
 * Tests for sms-health.mjs with a stand-in for GoHighLevel and for the alert webhook. Nothing real is called.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, decide, etDayStart, main } from './sms-health.mjs';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) { failures++; console.log('      ', JSON.stringify(detail)); }
};

const NOW = Date.parse('2026-11-13T18:00:00Z'); // 1 PM in New York
const START = etDayStart(NOW);
check('day start is midnight in New York', new Date(START).toISOString() === '2026-11-13T05:00:00.000Z', new Date(START).toISOString());
check('day start in summer time', new Date(etDayStart(Date.parse('2026-07-01T12:00:00Z'))).toISOString() === '2026-07-01T04:00:00.000Z');

const at = (h) => new Date(START + h * 3600e3).toISOString();
const sms = (direction, status, body, h, error) => ({ messageType: 'TYPE_SMS', direction, status, body, dateAdded: at(h), ...(error ? { error } : {}) });
const day = [
  sms('outbound', 'delivered', 'Hi', 9), sms('outbound', 'delivered', 'Hi', 9), sms('outbound', 'failed', 'Hi', 10, 'carrier rejected'),
  sms('inbound', '', 'STOP', 10), sms('inbound', '', ' stop. ', 11), sms('inbound', '', 'Stop texting me please', 11),
  sms('inbound', '', 'unsubscribe', 12), sms('outbound', 'delivered', 'old', -3), { messageType: 'TYPE_EMAIL', direction: 'outbound', status: 'failed', dateAdded: at(9) },
];
const c = classify(day, START);
check('counts only today\'s texts', c.sent === 3 && c.delivered === 2 && c.failed === 1, c);
check('opt-outs: bare STOP words only, not a sentence', c.optOuts === 3, c);
check('a carrier error is not a limit hit', c.limitHits === 0, c);
const blockedDay = [...day, sms('outbound', 'failed', 'Hi', 13, { message: "today's opt-out/error limit reached" })];
check('a limit error counts as a limit hit', classify(blockedDay, START).limitHits === 1);

const T = { optOutWarn: 8, failedWarn: 10 };
let d = decide({ ...c, optOuts: 3 }, {}, '2026-11-13', T);
check('quiet day: no alert', d.alerts.length === 0, d);
d = decide({ ...c, optOuts: 8 }, {}, '2026-11-13', T);
check('8 opt-outs: one warning', d.alerts.length === 1 && d.alerts[0].level === 'warning', d);
d = decide({ ...c, optOuts: 12 }, d.next, '2026-11-13', T);
check('warning is sent once a day', d.alerts.length === 0, d);
d = decide({ ...c, optOuts: 12, limitHits: 2 }, d.next, '2026-11-13', T);
check('the pause itself alerts even after a warning', d.alerts.length === 1 && d.alerts[0].level === 'blocked', d);
d = decide({ ...c, optOuts: 12, limitHits: 2 }, d.next, '2026-11-14', T);
check('a new day starts over', d.alerts.length === 1 && d.alerts[0].level === 'blocked', d);
d = decide({ ...c, failed: 10 }, {}, '2026-11-13', T);
check('10 failed texts: warning', d.alerts.length === 1 && d.alerts[0].level === 'warning', d);

// End to end with a fake GoHighLevel and webhook.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-health-'));
process.env.GHL_SMS_TOKEN = 'test-token';
process.env.GHL_LOCATION_ID = 'loc1';
process.env.SMS_STATE_FILE = path.join(dir, 'state.json');
process.env.OPS_ALERT_WEBHOOK_URL = 'https://hook.test/alert';
const optOuts = Array.from({ length: 9 }, (_, i) => sms('inbound', '', 'STOP', 9 + i / 10));
const posted = [];
let messageCalls = 0;
let hookOk = false;
const fake = async (url, opts = {}) => {
  const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
  if (url.startsWith('https://hook.test')) { posted.push(JSON.parse(opts.body)); return json({}, hookOk ? 200 : 500); }
  if (!opts.headers?.Authorization?.endsWith('test-token')) return json({}, 401);
  if (url.includes('/conversations/search')) return json({ conversations: [{ id: 'c1', lastMessageDate: START + 3600e3 }, { id: 'c2', lastMessageDate: START - 3600e3 }] });
  if (url.includes('/conversations/c1/messages')) { messageCalls++; return json({ messages: { messages: optOuts } }); }
  return json({}, 404);
};
let r = await main({ now: NOW, fetchImpl: fake });
check('webhook refused: alert attempted', posted.length === 1 && posted[0].source === 'sms-health', posted);
check('a refused alert is not recorded as sent', JSON.parse(fs.readFileSync(process.env.SMS_STATE_FILE, 'utf8')).sent.length === 0);
check('yesterday\'s conversation is not read', messageCalls === 1, { messageCalls });
hookOk = true;
r = await main({ now: NOW, fetchImpl: fake });
check('retried and delivered next run', posted.length === 2 && JSON.parse(fs.readFileSync(process.env.SMS_STATE_FILE, 'utf8')).sent.join() === 'warning');
check('an unchanged conversation is not read again', messageCalls === 1, { messageCalls });
await main({ now: NOW + 600e3, fetchImpl: fake });
check('no repeat alert the same day', posted.length === 2, posted.length);
delete process.env.GHL_SMS_TOKEN;
check('without a token the check is skipped', (await main({ now: NOW, fetchImpl: fake })) === undefined);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
