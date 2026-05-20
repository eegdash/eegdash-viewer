# CodSpeed setup (one-time)

CodSpeed runs the same tinybench suite under Callgrind CPU simulation
for 0.56% CoV (vs 2-3% on raw GitHub runners). PR alerts trigger at
1.5% regression vs main baseline.

## Steps

1. Visit https://codspeed.io and sign up with the org's GitHub account.
2. Authorise the CodSpeed GitHub App on the eegdash/eegdash-viewer repo.
3. Copy the project token from the dashboard.
4. In the GitHub repo: Settings → Secrets and variables → Actions →
   New repository secret. Name: `CODSPEED_TOKEN`. Value: paste the token.
5. Push any commit to main. The workflow `.github/workflows/codspeed.yml`
   runs and publishes the first baseline.
6. Open any subsequent PR. CodSpeed posts a comment with the per-metric
   delta + percentile band; PRs with > 1.5% regression on any metric
   light a yellow flag (informational, NOT blocking by default).

## Tightening

After 30 days of CI history, edit `.github/workflows/codspeed.yml` and
add `fail-on-alert: true` to the `CodSpeedHQ/action` step. PRs with
significant regressions will then block merge.

## Costs

Free tier: 5 benchmark runs/day, unlimited PRs, 1 month history. Sufficient
for our cadence (~2-5 PRs/week).
