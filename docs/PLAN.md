# Plan

Goal: a generic engine that runs the Guided-mode loop on any web application, plus suite and release runs from a GitHub connection. Everything specific to one target application lives in the private demo profile (demo-local/).

- [x] **0 Scaffold and memory** — verify: `docker compose up -d && pnpm install && pnpm typecheck`, then `pnpm dev` and every /health (3000, 3001, 3002) returns ok.
- [x] **1 Data model and Projects API** — verify: `pnpm db:migrate && pnpm db:seed`; POST/GET /projects via curl round-trips with zod-validated bodies and projectId on every record.
- [x] **2 Target app adapter** — verify: a target application with a sign-in and an editable form runs on localhost and every page shows "Simulated".
- [x] **3 Orchestrator, worker and evidence** — verify: creating a Run enqueues a pg-boss job; worker opens the target with Playwright and writes screenshot/dom/console/network/trace files to EVIDENCE_DIR, each with an Evidence id.
- [x] **4 Knowledge base** — verify: importing a spec file creates Requirements with source (file, location, quote); AI-extracted ones are `observed` + `needs_review`.
- [x] **5 Planner and deterministic selector** — verify: plan stage yields Missions; same inputs give identical Selection ranking with per-factor scores (unit test).
- [x] **6 Investigator** — verify: a selected Mission runs against the target and produces a StageRecord with input, decision, output and Evidence ids.
- [x] **7 Judge** — verify: seeded defect gets `potential_defect`, ambiguous behavior gets `observational`/`inconclusive`, an unreachable target gives `infra_failure`; each verdict cites Evidence ids.
- [x] **8 Validator and regression tests** — verify: potential Finding is reproduced by a fresh ValidationAttempt and becomes `confirmed`; a RegressionTest is proposed, runs green, becomes `validated`.
- [x] **9 Functional UI** — verify: create a project and complete a guided Run end to end in the browser without the terminal (Scenario 1).
- [x] **10 Apply Claude Design** — verify: UI uses the agreed design system; every page still works; simulated items show the "Simulated" label.
- [x] **11 Demo hardening** — verify: `LLM_MODE=replay` demo runs twice in a row with identical results; acceptance scenarios 1–7 walked through.
- [ ] **12 (optional) Live target environment** — verify: a new Project pointing at a real test environment runs a guided Run with no engine code changes.
- [x] **13 Model picker** — verify: Settings lists connected providers and their models (keys never shown); default model and per-project override are used by every AI call; replay needs no key; `pnpm demo` still passes.
- [x] **14 Requirements assistant** — verify: checker unit tests per rule ("Sales numbers should be correct" Needs work, "Actual Sales is a unit count, not a monetary value" Ready); the AI path stores nothing until Accept; with a live model a vague draft yields questions, not an invented formula; `pnpm demo` still passes in replay.
- [x] **15 GitHub connection** — verify: with the GitHub API mocked, a new PR triggers one suite run and a pending then final status; a new SHA cancels the older queued run; the same event never triggers twice; a release triggers the suite plus 3 release-mode runs; environment timeout ends as infrastructure failure. With a real token, opening a PR on a test repo shows the QA Studio status. `pnpm demo` still passes in replay.
- [x] **16 Private demo profile** — verify: with DEMO_MODE=off no demo project appears in the UI or API; with DEMO_MODE=on dataset projects are created, a guided run works on one and its recordings land in demo-local/recordings; `pnpm check:private` passes and fails on a force-added demo-local file; `pnpm demo` still passes with DEMO_MODE=off.
- [x] **17 Zero-state repository** — verify: git tracks only the generic engine; in a clone without demo-local `pnpm install`, typecheck, lint, test and `pnpm dev` succeed and the UI shows "Add your first project"; with demo-local present `pnpm demo` twice prints "Same as the previous run."; `pnpm check:private` checks demo-local/denylist.txt; branch `public` is one parentless commit of the zero-state tree.
