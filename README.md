# ops-uptime

Checks every 5 minutes that Tax Sherpa's production sites answer, and tells a person when one stops.

## 1. Why this exists
taxsherpa.com was down from October 5 to October 9, 2026 and nobody knew.

The first version ran on GitHub's schedule. Measured over 130 hours (October 13 to 18) it started 36 runs where a 5-minute schedule promises about 1,550: a typical wait of almost 4 hours between runs, the longest 7.6. So the check now runs as a small service that stays on (`loop.mjs`, section 2). The GitHub schedule is kept as the slower copy that does not depend on Railway.

It sends one alert when a site goes down and one when it comes back. A site that stays down does not alert again.

## 2. When it runs
- **Main: `loop.mjs`, a service that stays on in Railway** (project `ops-uptime`). It starts a check every 5 minutes and keeps the note "this site is already down and was alerted" between checks, so a site that stays down alerts once. A scheduled Railway job would not do: it starts from an empty disk each time and would text a person every 5 minutes. The note is lost when the service restarts or redeploys; a site that is down at that moment alerts once more.
- **Copy: GitHub's schedule** (`.github/workflows/uptime.yml`). It runs late and rarely, but it does not depend on Railway. **While both run, an outage can alert twice** (the fast one from Railway, a late one from GitHub). Once the Railway service has proved itself, decide whether to turn the GitHub schedule off (Actions → uptime → ⋯ → Disable workflow); the cost is that nothing watches the sites if Railway itself is down.
- To run a check now from GitHub: Actions → uptime → Run workflow.

## 3. What it needs
- **In Railway: the variable `OPS_ALERT_WEBHOOK_URL`**, the same address as the GitHub secret below. Set it by hand in the Railway panel; never write it in a file.
- **In GitHub: secret `OPS_ALERT_WEBHOOK_URL`** (Settings → Secrets and variables → Actions): the inbound webhook of the GoHighLevel workflow "Ops – Site down alert". That workflow sends the text message and the email. Without the secret the check still runs and prints what it would have sent.
- Nothing else. No dependencies to install.

This repo is public so that Actions minutes are not limited. It holds no secret: the sites in `sites.json` are public addresses.

## 4. Deploy to Railway (once)
1. Railway → New Project → Deploy from GitHub repo → `taxsherpa/ops-uptime`. Name the project `ops-uptime`.
2. Service → Variables → add `OPS_ALERT_WEBHOOK_URL`, then Deploy.
3. Service → Settings: the start command is `npm start` (it is in `package.json`; nothing to type) and the restart policy is **Always**.
4. Service → Deployments → View logs: a line `--- check at …` every 5 minutes, and `up` for each site.
5. Every push to `master` redeploys it, and a redeploy loses the "already alerted" note (see section 2).

## 5. How to use it
- **Add or remove a site:** edit `sites.json` (a name and an address per site) and push.
- **Change who gets alerted, or the wording:** edit the GoHighLevel workflow, not this repo.
- **Test the code:** `npm test` (`test-check.mjs` and `test-loop.mjs`, against local stand-ins; sends nothing). The clean-stop-on-SIGTERM check in `test-loop.mjs` only runs on Linux and macOS.
- **Run the check on your machine without alerting:** `node check.mjs` with `OPS_ALERT_WEBHOOK_URL` unset.

A site counts as down when three attempts, 15 seconds apart, all fail to answer or answer with an error (400 or above).

## 6. Troubleshooting and limits
- **No `--- check` line in the Railway logs for 10 minutes:** the service is down or stuck. Redeploy it from Deployments. This is the one failure that alerts nobody, which is why the GitHub copy exists.
- **A GitHub run is red:** open it. "alert not delivered" means the site check worked but GoHighLevel did not accept the alert; the next run tries again. Check that the GoHighLevel workflow is published and the secret is the full webhook address.
- **No runs at all:** GitHub turns off scheduled workflows in a public repo after 60 days without a commit and emails a warning first. Each run re-enables the workflow to prevent that; if it still stops, Actions → uptime → Enable workflow.
- **It only checks that the address answers.** It does not check that a form submits or that a tool produces a result.
- **It does not fix anything.** Restart policies and healthchecks live in Railway.
- The state between runs is a small file kept for one day. If no run happened for a day, the next run assumes everything was up, so an outage already in progress alerts again.
