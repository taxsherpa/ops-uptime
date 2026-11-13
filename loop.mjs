/**
 * Runs the uptime check every 5 minutes, for a service that stays on (Railway).
 *
 * Why not a scheduled job: each scheduled run starts from an empty disk, so the
 * note "this site is already down and was alerted" would be lost every time and
 * a site that stays down would text a person every 5 minutes. A service that
 * stays on keeps that note (UPTIME_STATE_FILE) between runs. It is lost only when
 * the service restarts or redeploys, and then a site that is down at that moment
 * alerts once more.
 *
 * GitHub's schedule (.github/workflows/uptime.yml) started 36 runs in 130 hours
 * against the 1,550 a 5-minute schedule promises, which is why this exists.
 *
 * Usage: node loop.mjs   (the variables are the ones check.mjs reads, plus
 *   UPTIME_EVERY_SECONDS   time between the starts of two checks, default 300
 *   SMS_EVERY_MINUTES      time between two texting health checks (sms-health.mjs), default 30;
 *                          that check runs only when GHL_SMS_TOKEN and GHL_LOCATION_ID are set)
 */

import { main } from './check.mjs';
import { main as smsHealth } from './sms-health.mjs';

const EVERY_MS = Math.max(1, Number(process.env.UPTIME_EVERY_SECONDS ?? 300)) * 1000;
const SMS_EVERY_MS = Math.max(1, Number(process.env.SMS_EVERY_MINUTES ?? 30)) * 60 * 1000;
let lastSms = 0;

let stopping = false;
let wake = null;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    // Railway sends SIGTERM on every redeploy: leave quietly, mid-wait or mid-check.
    stopping = true;
    console.log(`${signal}: stopping`);
    if (wake) wake();
  });
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

console.log(`uptime loop started, a check every ${EVERY_MS / 1000} seconds`);
while (!stopping) {
  const startedAt = Date.now();
  console.log(`--- check at ${new Date(startedAt).toISOString()}`);
  try {
    await main();
  } catch (err) {
    // A bad run (unreadable sites file, a crash) must not end the loop: the next one may be fine.
    console.error(`check crashed: ${err.stack || err.message}`);
  }
  if (Date.now() - lastSms >= SMS_EVERY_MS) {
    lastSms = Date.now();
    try {
      await smsHealth();
    } catch (err) {
      // GoHighLevel down or the token refused: log it, keep the uptime loop going.
      console.error(`sms-health failed: ${err.message}`);
    }
  }
  // check.mjs sets exitCode 1 when an alert was not delivered; here that is already
  // logged and retried on the next run, and a leftover 1 would make a clean stop look like a failure.
  process.exitCode = 0;
  // Next check starts EVERY_MS after this one started, not after it ended; never overlaps.
  await sleep(Math.max(0, EVERY_MS - (Date.now() - startedAt)));
}
