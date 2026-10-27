# Private demo profile

Template for `demo-local/`, the folder that holds everything specific to the applications you demo QA Studio
on: target apps, their specs, datasets, model choices, recordings and demo scripts. `demo-local/` is in
`.gitignore`; `pnpm check:private` (part of `pnpm lint`) fails if any of it is tracked, if a value from
`demo-local/models.json` appears in a tracked file, or if a term from `demo-local/denylist.txt` does.

```
cp -r demo-local.example demo-local     # then edit; DEMO_DATA_DIR points elsewhere if you prefer
DEMO_MODE=on                            # in .env, then restart pnpm dev
```

## Layout

- `NOTES.md`: everything app-specific a future session needs (CLAUDE.md asks to read it when present).
- `denylist.txt`: one term per line (case-insensitive, `#` comments) that must never appear in a tracked file.
- `models.json`: `defaultModel` (`auto` or `provider:model`) and per dataset `model` and `localOnly`
  (only an `openai-compatible:` model may answer). Model ids only, never keys: unknown fields are rejected.
  While demo mode is on it replaces the Settings default and sets each demo project's model.
- `apps/<name>/`: workspace packages (pnpm-workspace.yaml globs `demo-local/apps/*`); `pnpm dev` runs
  `@qa/sim` when it exists.
- `scripts/demo.ts`: run by `pnpm demo`. `apps/sim/src/seed.ts`: run by `pnpm demo:seed`.
- `tests/**/*.test.ts`: picked up by `pnpm test`.
- `recordings/`: LLM recordings; in demo mode live and record write here, replay always reads here too.

## Behavior

- `DEMO_MODE=off` (default): demo projects (`isDemo`) are hidden from every API list and lookup (a direct URL is 404).
- `DEMO_MODE=on`: demo projects show a Demo badge and a banner says "Demo mode · data from demo-local".
- Without `demo-local/`, `pnpm demo` and `pnpm demo:seed` print "demo-local not found" and exit 0.
