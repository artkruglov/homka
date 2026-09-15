# Video generation foundation

The branch now exposes `generate_video` when `OPENROUTER_VIDEO_API_KEY` is configured.
Interactive and automatic completion paths are deployed (production b14632a, schema 134). One text-to-video job
was delivered through an additional status request on 13 September 2026; photo-to-video
and group revocation acceptance remain open. One existing-image job was automatically delivered
after an agent restart at 19:22 UTC, without a follow-up status message; one delivery receipt and
one USD 0.415160 charge were verified. The 1,006,358-byte H.264/AAC MP4 fully decodes.
The provider returned 640x640 despite an announced 854x480; exact-size communication remains open.

- `openrouter-video-client.ts`: a single paid submission, fixed-origin status/content requests,
  first-frame image input, bounded MP4 downloads, explicit ambiguous-submit errors.
- `video-pricing.ts`: current Seedance 2.5 catalog validation and integer-microdollar quote.
  The reservation uses width × height × (24 × seconds + 1) / 1024, rounded up.
  The endpoint-frame allowance covers the measured 2026-09-13 four-second charge, which exceeded
  the old duration-only estimate. Actual provider cost
  is reconciled separately; a quote is not a contractual guarantee against provider overbilling.
- `video-budget-repository.ts`: PostgreSQL locks serialize a verified Telegram person's
  reservations across chats. The limit is USD 30 per Europe/Moscow calendar month.
  Membership deletion cannot reset it. Unknown charges keep their reservation.
- `video-operation-repository.ts`: the durable start marker and budget reservation commit
  together. Only the creator of a fresh marker may submit. A persisted provider job can be
  polled again; a started/ambiguous marker cannot authorize another paid submit.
- `video-generation-service.ts`: orchestrates start and resume without another paid submit,
  settles only terminal costs, recovers saved files, and supplies one stable delivery key.
  It revalidates the access adapter before submission, after download and before delivery.
  `video-tool-runtime.ts` connects verified Telegram identity, live workspace checks, scoped photo
  reads and the existing durable file sender. Delivery uses one stable key across status calls.

Interactive private/family roots receive the tool; external groups require an explicit live
`generate_video` grant. Subagents, scheduled runs, quiet memory reviews and bot/channel actors
cannot order videos. Missing provider configuration hides both the tool and owner-facing grant;
an old grant remains parseable but inactive. A photo is one PNG/JPEG/WebP of at most 8 MiB,
read from the current workspace or the current group's authorized attachment journal.

`list` returns the latest 20 jobs belonging to the current person, chat/topic and workspace,
including jobs whose reference never reached the user before a cancellation. `start` accepts
text, size/duration and an optional photo; `status` accepts the returned operation
reference, scoped to the same person, chat/topic and workspace; `budget` reads that person's
current monthly totals. The model cannot select the billing person, model, destination or price.
The result is delivered as an MP4 document through `send_workspace_file`.

Waiting uses the public Eve `sleep` tool, exposed with video only. The agent is instructed to wait
30 seconds between checks, up to 10 checks per turn. This is an agent-driven durable continuation alongside the minute completion queue for new orders.
A cancelled/exhausted turn does not cancel queued delivery. Legacy orders without saved origin
can be continued by asking for the existing job reference; never issue another start. A transient poll or
download failure returns the same pending operation rather than poisoning the repeated-tool-call
guard. Unknown paid submissions remain terminal errors.

The live authorization adapter checks the turn's abort signal before and after database access.
Cancellation before submit releases an unspent reservation with a distinct cancellation code;
a job already accepted by the provider stays recorded and charged/reserved for later status.
These checks stop subsequent processing stages; they cannot recall a provider request or
Telegram send that has already started. In a new turn, use `list` then `status`, not another start.

Automatic completion is deployed in b14632a / schema 134; live photo-to-video acceptance remains open:

- Migration 134 stores an immutable backend origin and completion lease in the existing ledger.
- New orders persist verified actor, chat/topic, authorization and workspace with the budget hold.
  Strict parsing and replay matching reject missing, substituted or malformed origin data.
- The bounded dispatcher can only resume an accepted job; `createVideoResumptionService`
  does not receive quote, reservation or submit dependencies.
- Database-origin validation checks current membership/identity, exact group registration,
  video grant and existing space write policy. It does not replace the remaining live
  workspace, lease, Telegram membership and delivery-audience checks.

The runtime adapter and minute handler now use that queue. Interactive status acquires the same
lease as the worker; a concurrent reader returns pending. Completion checks the current author,
exact group, workspace, space write rights, audience proof and lease repeatedly, including just
before Telegram. Current Telegram membership is required for group delivery. Both paths use
workspace-file-sender and its existing durable delivery ledger. Confirmed group files enter the
journal without inventing a live application session. A proven forum topic is stored separately
from Telegram's ordinary reply-branch transport ID.

`cancel_delivery` stops future delivery for the current person's job in the current chat, revokes
its lease, and preserves paid/unknown budget charges. It cannot recall an in-flight external send.
Cancelling a conversation turn alone does not cancel delivery. Older jobs without saved origin
remain on the legacy status path; no origin is guessed or backfilled.

Database-backed tests cover expired-lease recovery, competing dispatchers, one durable delivery
and budget hold, cancellation and terminal ambiguous Telegram sends. Provider and Telegram
responses in these tests are controlled doubles, not a live media acceptance. Canonical CI, migration 134 rehearsal, backup/install and runtime health checks passed.
Existing-image automatic completion after a live agent restart passed. Uploaded-photo and
group revocation acceptance remain open. Do not bypass the monthly ledger with an ad hoc provider request for acceptance.

Official sources checked 13 September 2026:

- [Model catalog and selection](https://openrouter.ai/docs/cookbook/video-generation/choose-video-model)
- [Image to video](https://openrouter.ai/docs/cookbook/video-generation/image-to-video)
- [Seedance 2.5 token pricing](https://openrouter.ai/blog/insights/seedance-2-5-review/)
