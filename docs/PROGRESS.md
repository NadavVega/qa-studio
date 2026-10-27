# Progress

Engine-only history. The detailed history, including everything about the demo target applications, is kept
in the private profile (demo-local/docs/PROGRESS.md) when present.

## Step 0 — Scaffold and memory (2026-10-26)
Done: pnpm workspace (apps/web Next.js + Tailwind v4 + shadcn config, apps/api Fastify, apps/worker pg-boss, packages/core glossary as zod enums + PORTS, packages/db Drizzle, packages/intelligence), docker-compose Postgres 16 on 5433, .env.example, root scripts, CLAUDE.md, docs/PRODUCT.md, PLAN.md, PROGRESS.md.

Notes:
- pnpm 12 via corepack (`~/.local/bin`). Build-script deps need `allowBuilds` in pnpm-workspace.yaml.
- TypeScript pinned to 6 because typescript-eslint does not support TS 7.
- shadcn components: `pnpm dlx shadcn@latest add <component>` in apps/web.

## Step 1 — Data model and Projects API (2026-10-26)
Done: tables for the whole glossary; Postgres enums built from the zod enums in @qa/core; every project-scoped table has project_id with cascade delete. GET/POST /projects with nested environments, zod on bodies and responses (400 with treeified error, 404 for unknown ids).

Notes:
- environments.auth_config is a strict object of env var names (userEnv/passwordEnv, UPPER_SNAKE).
- `pnpm db:seed` deletes all projects. Do not run it against data you want to keep.

## Step 2 — Target app adapter (2026-10-26)
Done: the engine talks to a target application only through an Environment (base URL, sign-in env var names). Simulated target apps live in the private profile (demo-local/apps/*); every page they serve is labelled "Simulated".

## Step 3 — Orchestrator, worker and evidence (2026-10-26)
Done: POST /projects/:id/runs creates a guided Run and enqueues a pg-boss job; the worker opens the environment with Playwright, signs in from env vars named in authConfig, and writes screenshot, dom, console, network and trace files to EVIDENCE_DIR/<projectId>/<runId>/<evidenceId>.<ext> with Evidence rows.

Notes:
- Tracing starts after sign-in, so typed credentials are never in a trace.
- authConfig env var names must also be in CREDENTIAL_ENVS (worker env); credentials are only typed on the environment's own origin.
- SSRF to private hosts is not blocked (targets run on localhost); revisit when QA Studio runs outside a dev machine.

## Step 4 — Knowledge base (2026-10-26)
Done: `callJson` is the single entry point for AI calls and stores every request and response as a recording (live/record write, replay reads; key = hash of system + user prompt). `extractRequirements` keeps only requirements whose verbatim quote is found in the file (source file, line, quote). POST /projects/:id/requirements/import reads a file from the inputs folder and stores results as `observed` + `needs_review`.

## Step 5 — Planner and deterministic selector (2026-10-26)
Done: `planMissions` (requirements sent as R1..Rn, refs mapped back, missions without a valid ref dropped); `selectMissions` is pure with per-factor scores (risk, coverage, authority, cost), weighted total rounded to 3 decimals, ties on title then id. Plan and Select write StageRecords.

Notes: the planner prompt depends on the requirement list, so approving or re-importing changes it and replay needs a new recording.

## Step 6 — Investigator (2026-10-26)
Done: `planSteps` turns a Mission goal and an accessibility snapshot into browser steps (goto, click, fill; max 20). The worker performs them on the environment origin only (5 s per step; a failed step is recorded, not fatal), captures the 5 Evidence kinds and writes an `investigate` StageRecord.

## Step 7 — Judge (2026-10-26)
Done: `judgeInvestigation` returns verdict, title, reasoning and the evidence kinds relied on; `citeEvidence` maps kinds to real Evidence ids and downgrades to `inconclusive` when nothing real is cited; `judgeInfra` builds `infra_failure` without an AI call. Unreachable apps, browser and LLM errors are stored as infraError with whatever Evidence could be captured.

## Step 8 — Validator and regression tests (2026-10-26)
Done: `validateFinding` replays the investigation's steps in a fresh browser and judges again (same verdict: `confirmed`, different: `not_reproduced`, infra failure: stays `potential`). `generateChecks` proposes checks (role + accessible name contains text); RegressionTest.code is a JSON TestSpec the worker interprets (generated code is never executed). Judge prompts serialize step results with sorted keys so recordings stay stable.

## Step 9 — Functional UI (2026-10-26)
Done: API for run detail, Evidence files (project-scoped; dom served as text/plain), job status, inputs list, requirement review, finding dismiss, regression test promote/reject. Pages: projects, project workspace, run page with every stage, Evidence and StageRecords. Next rewrite /api/* to the API (no CORS).

## Step 10 — Apply Claude Design (2026-10-26)
Done: apps/web/app/qs.css holds the design tokens and components (light and dark); AppShell, Panel, Badge, Button, Empty, Json in app/ui.tsx; run page with stage stepper, Received / Decided / Produced panels and an evidence viewer.

Notes: dark tokens exist but there is no theme toggle.

## Step 11 — Demo hardening (2026-10-26)
Done: `authorityGuard` turns a potential_defect with no approved authoritative requirement into observational; validate returns 409 for anything but potential_defect; `credentialPolicyViolation` rejects an environment naming an env var outside CREDENTIAL_ENVS with 403 before queueing; regression test runs take an environmentId (TestResult.environmentId). The replay demo itself lives in the private profile (`pnpm demo`).

## Step 13 — Model picker (2026-10-27)
Done: one adapter per provider (anthropic, openai, google, openai-compatible); a provider is connected when its env var is set; model ids are `provider:model`, `auto` = first connected provider's recommended model. Settings table (default model), per-project override, provider and model on every StageRecord decision. Replay ignores the model and needs no key.

## Step 14 — Requirements assistant (2026-10-27)
Done: `checkRequirement` (pure, no AI): Ready | Needs work | Not testable here, with rules split, vague, observable, concrete, source, out of scope, unknown page (warn), near-duplicate (warn). `assistRequirement` returns at most 3 suggestions and 3 questions; a suggestion inventing a number or formula is dropped. Only the engineer's Accept/Save writes a requirement (authoritative + approved, with history). Projects carry an app map (pages and fields). Knowledge & Config has the write panel and a "How to write requirements" guide.

Notes:
- App maps are set per project; there is no crawler yet.
- The guard is strict: number words are not compared.

## Step 15 — GitHub connection (2026-10-27)
Done: GithubConnection and GithubEvent; run modes `suite` and `release` with a trigger. The worker polls connections (first poll is a baseline), records each event once, supersedes queued runs of older SHAs, runs one job per environment, waits for the environment to be ready (timeout: `infra_failure`, status `error`), runs every promoted RegressionTest and sets commit statuses; a release also runs Plan + Select once and one release run per top-N mission. POST /github/webhook verifies HMAC signatures. Plan, Select and Judge live in packages/db `stages.ts` so the worker can run them. UI: Integrations tab, mode and trigger columns, suite results table.

Notes:
- `WEB_URL` is the link in statuses.
- Release checks in live mode cost Plan + Judge + Investigate calls per mission; there is no project budget yet.
- Multiple workers would each poll; dedupe makes that safe but wasteful.

## Step 16 — Private demo profile (2026-10-27)
Done: `demo-local/` (gitignored, DEMO_DATA_DIR) holds private datasets, model choices and recordings; `demo-local.example/` is the template. DEMO_MODE (default off): demo projects (`isDemo`, migration 0005) are hidden from every API list and lookup; with it on, models.json sets the models (nothing written to the database) and the UI shows a Demo badge and banner. `pnpm check:private` (in `pnpm lint`) fails when anything under demo-local is tracked or a models.json value appears in a tracked file. The openai-compatible adapter strips regex `pattern`/`format` that Ollama rejects.

## Step 17 — Zero-state repository (2026-10-27)
Done:
- Everything app-specific moved (not deleted) into demo-local/: the simulated target apps (demo-local/apps/sim, still a workspace package), their seed and dataset loader, LLM recordings, the demo script, demo docs, specs, design export and the dataset tests.
- `pnpm-workspace.yaml` globs `demo-local/apps/*`; `pnpm test` also runs `demo-local/tests/**`; `pnpm dev` runs `@qa/sim` only when it exists (an unmatched filter is a no-op).
- `pnpm db:seed` creates only Demo Org and Team A. `pnpm demo` and `pnpm demo:seed` run demo-local scripts through scripts/demo-local.ts, or print "demo-local not found" and exit 0.
- Recordings: data/recordings (gitignored) normally, demo-local/recordings in demo mode; replay reads both. Import reads INPUTS_DIR (default docs/inputs).
- `PORTS` has web, api and worker only. .env.example uses APP_USER / APP_PASSWORD. The new-project form has no prefilled target; the empty projects list says "Add your first project". UI copy, comments and test fixtures use a neutral example app.
- `pnpm check:private` also fails when a tracked file contains a term from demo-local/denylist.txt (case-insensitive; skipped when demo-local is absent).
- Branch `public`: one parentless commit "QA Studio: initial public version" with the zero-state tree and a lockfile generated without demo-local.

Verified:
- Clean clone without demo-local, own database: `pnpm install`, typecheck, lint (check:private ok), test (40), db:migrate, db:seed ("Demo Org / Team A") pass; `pnpm demo` and `pnpm demo:seed` print "demo-local not found" and exit 0; `pnpm dev` serves :3000-3002 (the sim filter is a no-op) and the browser shows "Add your first project" with no console errors.
- With the private profile present: typecheck, lint, test (42), and the replay demo twice give the same summary as before the move.

Notes:
- The lockfile on main lists the demo-local workspace package; the one on `public` does not.

## Delete projects (2026-10-28)
Done: DELETE /projects/:id removes a project and everything linked to it in one transaction (every table cascades from projects), then its EVIDENCE_DIR/<projectId> folder; 204, or 404 when missing. Knowledge & Config has a Delete project button with a confirmation. The private demo deletes its helper projects, so a replay demo leaves only its two projects.

## Open items
- The Google provider's recommended model is hardcoded as `google:gemini-2.5-pro` (packages/intelligence/src/providers.ts), which Google no longer offers to new users (404 "no longer available to new users"). Recommend a current model from the list-models response instead of a hardcoded id.
