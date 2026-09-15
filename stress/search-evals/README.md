# Search-only evaluation

**Cost first.** Every probe here is paid with the same DeepSeek key as the production bot. Before a
run, state the number of requests and the estimated dollars and get the owner's consent; check
`GET https://api.deepseek.com/user/balance`; use one sample per cell, one request at a time (shared
cached prefix) and off-peak hours (peak 01–04 and 06–10 UTC on weekdays). `freshness.ts` and
`../prompt-evals/review-requests.ts` refuse to run without `--max-requests` and above it. On
14 September 2026 unbounded parallel probes sent ~7.4M tokens and drained the balance.

`npm run eval:search -- --out .tmp/evals/search-v2 --samples 1`

For one diagnostic case use a fresh directory and `--scenario weekend` (or another scenario ID).
Report version 3 records allowlisted provider error codes, maps other payloads to `unknown_error`,
and explicitly tells the model about the three-search budget. It rejects version 2 report reuse.

Uses `MODEL_API_KEY` and the configured Anthropic Messages transport/model. The system rule
imports the same `WEB_SEARCH_RULES` as trusted chats. This is one bounded paid request per
cell with native provider search, **not an Eve/Telegram conversation**. No local `web_fetch`,
private memory, file tools or browser session is supplied. A case requiring those capabilities
still needs live agent acceptance; this probe must not be used to close W14 alone.

`--dry` lists scenarios without a key or network. Reports include prompt/transport/model
fingerprint, start time, provider search calls and provider source URLs. Authored URLs not
present in provider sources are flagged for review; a difference can be a redirect and does
not prove fabrication. The runner no longer sends HEAD requests to arbitrary model URLs.
Neither successful HTTP nor a matching URL proves the answer's factual accuracy.

The output directory is locked exclusively. Before every request its cell is saved as
`started`; automatic resume skips every existing cell, including started and failed ones.
An ambiguous request is never repeated automatically. A crash may leave `run.lock`: inspect
the actual process first; remove the lock manually only after confirming it stopped.
Changing prompt/model/scenarios/configuration requires a new report directory. Old reports
without metadata are rejected. A deliberate repeat uses a new directory, making the paid
repeat explicit. Reports contain only public test questions/results; never put family data in them.

Tests: `npx vitest run stress/search-evals/model-run.test.ts`. The repository's default
typecheck excludes `stress`; typecheck this directory with an extending tsconfig that includes
`stress/search-evals/**/*.ts` when editing it. Eight tests cover missing search evidence,
source provenance, incomplete responses, safe failure codes, no retry and report fingerprints.
