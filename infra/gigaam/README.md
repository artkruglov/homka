# Local family speech service

GigaAM Multilingual CTC (220M), upstream commit
7447938d791c4f3e643386ee22c33777004293a5, released June 2026.
Source/model license: https://github.com/salute-developers/GigaAM (MIT).

Build only via `.github/workflows/gigaam.yaml`. The image includes verified upstream
weights, so startup does not download anything. Run with no public ports, 3 GiB
memory limit, 2 CPUs, read-only root and a 128 MiB `/tmp` tmpfs. Add the service as
`gigaam` on the private application Docker network; never on sandbox egress.
Only the agent and speech service receive the same random GIGAAM_API_KEY (32+ chars).
Set agent NO_PROXY to include gigaam when using an outgoing Telegram proxy.

Voice configuration: `{"enabled":true,"provider":"gigaam","transcriptionModelId":"multilingual_ctc"}`.
Legacy enabled voice with no provider remains Groq. No automatic provider fallback.
The same Telegram download, verified authorization and durable ingress route is used.

`POST /transcribe`, Content-Type audio/ogg, Bearer token, raw Telegram Opus bytes.
Max 20 MiB / 180 seconds, one inference at a time (503 busy without retry).
Long recordings split at low-energy frames between 15 and 23 seconds, respecting
upstream's 25 second cap. This simple CPU segmentation is not speaker diarization;
words across boundaries can be less accurate. No forced punctuation/LLM rewrite.
Audio is deleted after the request; logs contain only duration and byte/character counts.

Search investigation: the same DeepSeek key/model returned actual server_tool_use
and web_search_tool_result through Anthropic Messages while Responses returned no
native search execution. Family deployment therefore uses its existing
anthropic-messages transport. This is an installation setting, not a global default
change for upstream users.
