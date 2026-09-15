# Contributing

Thanks for helping. Osinara is a Russian-first family Telegram agent; code, comments and commit messages
may be in English or Russian, user-facing text is Russian.

## Before you change code

1. Read [AGENTS.md](AGENTS.md): the boundary between the eve framework and the application, authorization
   rules (identity, family, role and scope never come from model text) and the Telegram update flow.
2. eve is pinned to `0.40.0` and patched after `npm ci` by `scripts/apply-eve-patches.ts`. Do not edit
   `node_modules/eve` by hand; a patch mismatch must stop the build.
3. Find the existing module, repository and test before creating a new file. Keep new source files under
   500 lines. Errors carry a stable `AGENT_*` code and a clear Russian message.

## Checks

```bash
npm ci
npm run typecheck && npm test && npm run build
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
```

Database integration tests run in the Docker suite (`RUN_DATABASE_INTEGRATION_TESTS=true`). Migrations run
only inside the backend or test container (`npm run migrate`). Write the failing test first.

Scripts under `stress/search-evals` and `stress/prompt-evals` call a paid model API: they refuse to run
without `--max-requests`; state the request count and expected cost in your pull request.

## Privacy

Never commit real conversations, Telegram ids, names, memory records, server addresses or credentials,
including in test fixtures. Use obviously fake values such as `-1001000000001`.
