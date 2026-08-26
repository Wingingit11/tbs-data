# FLIP question pipeline (sidecar)

Autonomous question replenishment for the FLIP game on lookaburra.com.au.
Runs entirely inside this repo. The Lookaburra site is never redeployed for a
question update — the client reads `flip/` over jsDelivr at runtime.

## Public vs internal

**Public** (served by jsDelivr, world-readable):
- `flip/questions.json` — trimmed runtime records only
- `flip/schedule.json` — published daily games

**Internal** (in the repo, never fetched by the client):
- `questions.internal.json` — full authoritative records incl. verifier notes
- `history.internal.json` — canonical publication history (365-day repeat rules)
- `schedule.internal.json`, `diagnostics.internal.json`, `runway.internal.json`
- `batches/` — candidates, verified, rejected
- `audit/` — one snapshot per run

## Manual run
Actions → **FLIP replenish** → Run workflow. Cap defaults to 10.

## Enabling the weekly schedule
Only after a reviewed pilot: uncomment the two `schedule:` lines in
`.github/workflows/flip-replenish.yml`.

## Secrets
`ANTHROPIC_API_KEY` only. Commits use the built-in `GITHUB_TOKEN`.
