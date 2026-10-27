# QA Studio

AI-powered quality engineering for web applications (Guided mode). Product spec: docs/PRODUCT.md.

## Quickstart

```
cp .env.example .env
docker compose up -d     # Postgres on 5433
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev                 # web :3000, api :3001, worker :3002
```

Open http://localhost:3000 and add your first project: a name and the base URL of one test environment.
If the app needs a sign-in, put the credentials in `.env` (e.g. `APP_USER`, `APP_PASSWORD`), list them in
`CREDENTIAL_ENVS`, and enter only the variable names in the project form. Spec files to import go in `docs/inputs/`.

### Choosing a model

Set any of these in `.env` (all optional), then restart `pnpm dev` or press "Re-detect providers" in Settings:

| Provider | Env var |
|---|---|
| anthropic | `ANTHROPIC_API_KEY` |
| openai | `OPENAI_API_KEY` |
| google (Gemini) | `GEMINI_API_KEY` |
| openai-compatible (Ollama, LM Studio, vLLM) | `OLLAMA_BASE_URL`, e.g. `http://localhost:11434` |

Settings shows which providers are connected and their models. The default model is `auto`
(the first connected provider's recommended model); a project can override it in Knowledge & Config.
Model ids are `provider:model`, e.g. `anthropic:claude-sonnet-5-5`. Keys are never shown, logged or stored.

`LLM_MODE=live` calls the chosen model and records each call in data/recordings; `LLM_MODE=replay` answers
from those recordings, needs no key and ignores the model setting.

### Private demo profile

Anything specific to one application (a simulated target app, its specs, recordings and demo scripts) lives in
`demo-local/`, which is gitignored; see `demo-local.example/README.md`. Without it, `pnpm demo` and `pnpm demo:seed`
print "demo-local not found" and do nothing.
