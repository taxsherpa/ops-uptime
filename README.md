# ops-uptime

Checks every 5 minutes that Tax Sherpa's production sites answer, and tells a person when one stops.

## 1. Why this exists
taxsherpa.com was down from October 5 to October 9, 2026 and nobody knew. This check runs on GitHub's machines, outside Railway, so it keeps working when Railway is the thing that is broken.

It sends one alert when a site goes down and one when it comes back. A site that stays down does not alert again.

## 2. When it runs
By itself, every 5 minutes (`.github/workflows/uptime.yml`). GitHub can start a scheduled run late, so an alert may arrive 10 to 15 minutes after the outage. To run it now: Actions → uptime → Run workflow.

## 3. What it needs
- **Secret `OPS_ALERT_WEBHOOK_URL`** (Settings → Secrets and variables → Actions): the inbound webhook of the GoHighLevel workflow "Ops – Site down alert". That workflow sends the text message and the email. Without the secret the check still runs and prints what it would have sent.
- Nothing else. No dependencies to install.

This repo is public so that Actions minutes are not limited. It holds no secret: the sites in `sites.json` are public addresses.

## 4. How to use it
- **Add or remove a site:** edit `sites.json` (a name and an address per site) and push.
- **Change who gets alerted, or the wording:** edit the GoHighLevel workflow, not this repo.
- **Test the code:** `node test-check.mjs` (runs against local stand-ins; sends nothing).
- **Run the check on your machine without alerting:** `node check.mjs` with `OPS_ALERT_WEBHOOK_URL` unset.

A site counts as down when three attempts, 15 seconds apart, all fail to answer or answer with an error (400 or above).

## 5. Troubleshooting and limits
- **A run is red:** open it. "alert not delivered" means the site check worked but GoHighLevel did not accept the alert; the next run tries again. Check that the GoHighLevel workflow is published and the secret is the full webhook address.
- **No runs at all:** GitHub turns off scheduled workflows in a public repo after 60 days without a commit and emails a warning first. Each run re-enables the workflow to prevent that; if it still stops, Actions → uptime → Enable workflow.
- **It only checks that the address answers.** It does not check that a form submits or that a tool produces a result.
- **It does not fix anything.** Restart policies and healthchecks live in Railway.
- The state between runs is a small file kept for one day. If no run happened for a day, the next run assumes everything was up, so an outage already in progress alerts again.
