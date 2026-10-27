# QA Studio

**Before any step, read docs/PLAN.md and docs/PROGRESS.md.** Full product spec: docs/PRODUCT.md.
If demo-local/NOTES.md exists, read it too.

## What it is
QA Studio is an AI-powered quality engineering platform for web applications.
It runs the Guided-mode loop: Connect, Understand, Plan, Investigate, Judge, Validate, Automate.
The engineer advances each stage and sees what every component received, decided and produced.
The engine is generic: nothing about a particular application under test lives in this repository.
App-specific material (target apps, specs, recordings, demo scripts) lives in demo-local/, which is never tracked.

Out of scope for now: QA Studio auth, roles, permissions, credential vaults, CI/CD, Assisted and Autonomous modes.

## Stack and ports
- pnpm workspace monorepo, TypeScript strict everywhere (TS 6; typescript-eslint does not support TS 7 yet).
- apps/web: Next.js App Router + Tailwind v4 + shadcn/ui — :3000 (`/health` page)
- apps/api: Fastify + zod, Platform API + Run Orchestrator — :3001
- apps/worker: pg-boss consumer, runs Playwright — health on :3002
- Postgres 16 via docker-compose on :5433. Job queue = pg-boss (no Redis).
- Evidence files: ./data/evidence (gitignored). Env: copy .env.example to .env.
- Ports are defined once in `PORTS` in packages/core.
- Spec files for import: docs/inputs (or INPUTS_DIR). LLM recordings: data/recordings, or demo-local/recordings in demo mode.

## Commands
```
docker compose up -d     # Postgres on 5433
pnpm install
pnpm dev                 # all apps, labelled output
pnpm db:generate         # drizzle-kit generate from packages/db/src/schema.ts
pnpm db:migrate
pnpm db:seed             # wipes all projects; creates Demo Org and Team A only
pnpm test                # vitest, files: {apps,packages}/*/src/**/*.test.ts (+ demo-local/tests when present)
pnpm typecheck
pnpm lint
pnpm demo                # runs demo-local/scripts/demo.ts; prints "demo-local not found" without it
pnpm demo:seed           # runs the demo-local seed; prints "demo-local not found" without it
pnpm check:private       # part of pnpm lint: nothing from demo-local/ is tracked, no denylisted term (demo-local/denylist.txt)
```
If `pnpm` is missing: `corepack enable --install-directory ~/.local/bin`.
New deps with build scripts must be listed under `allowBuilds` in pnpm-workspace.yaml.

## Folder map
```
apps/web               Next.js UI
apps/api/src           Fastify Platform API + Run Orchestrator
apps/worker/src        pg-boss jobs, Playwright, evidence capture
packages/core/src      shared types, zod schemas, constants, glossary
packages/db            Drizzle schema (src/schema.ts) and migrations (drizzle/)
packages/intelligence  planner, selector, judge, validator, test generator
docs/                  PRODUCT.md, PLAN.md, PROGRESS.md, inputs/ (sanitized spec files)
data/                  evidence and recordings (gitignored)
demo-local/            private, gitignored: target apps (demo-local/apps/*), demo scripts and docs; template in demo-local.example/
```

## Conventions
- zod at every API boundary (request and response).
- Every record carries projectId. Projects never see each other's data.
- Every AI call stores its full input and output (StageRecord). LLM_MODE = live | replay | record.
- Credentials are read from env by the worker at runtime and never appear in prompts, logs or the database.
- AI observations never become authoritative requirements automatically (they enter as `observed` + `needs_review`).
- Infrastructure failures are never product defects (use verdict `infra_failure`).
- Anything simulated is labelled "Simulated" in data and UI.
- AI conclusions must reference real Evidence ids. Potential findings need independent validation.
- After finishing a step: tick it in docs/PLAN.md, add an entry to docs/PROGRESS.md, commit as "step N: ...".

## Glossary (exact names in code, API and UI; enums in packages/core)
- **Project** (isSimulated flag), **Environment** (base URL, auth config). **Org** and **Team** are simple tables only.
- **Requirement**: authority = authoritative | observed | unknown; status = needs_review | approved | rejected; carries source (file, location, quote).
- **Mission**: candidate investigation. **Selection**: deterministic ranking with per-factor scores.
- **Run**: one investigation; mode = guided | suite | release (suite and release are started by the GitHub connection; trigger names the pull request or release). **Stage**: plan | select | investigate | judge | validate | automate. **StageRecord** stores input, decision, output.
- **Evidence**: screenshot | dom | console | network | trace, each with an id.
- **Verdict**: correct | observational | inconclusive | potential_defect | infra_failure.
- **Finding**: potential -> confirmed | not_reproduced | dismissed. **ValidationAttempt**: one fresh reproduction.
- **RegressionTest**: proposed -> validated | rejected -> promoted. **TestResult**: one execution.
- **GithubConnection** (one repository per project; token env var NAME only), **GithubEvent** (pull request head SHA or release tag, triggers once).
