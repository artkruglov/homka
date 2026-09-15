---
name: gws-gmail-watch
description: "Gmail: Pull one bounded batch of new emails through an existing or reviewed Pub/Sub watch."
metadata:
  version: "0.22.5"
  openclaw: "category=productivity;requires=bins:gws"
  cliHelp: "gws gmail +watch --help"
---

# gmail +watch

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, stop and report `AGENT_GOOGLE_WORKSPACE_SKILL_PACKAGE_INVALID`; never generate skills at runtime.

Pull one bounded batch of new emails. Osinara runs one-shot commands only.

## Usage

```bash
gws gmail +watch --subscription <SUBSCRIPTION> --once
```

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--project` | — | — | GCP project ID for Pub/Sub resources |
| `--subscription` | — | — | Existing Pub/Sub subscription name (skip setup) |
| `--topic` | — | — | Existing Pub/Sub topic with Gmail push permission already granted |
| `--label-ids` | — | — | Comma-separated Gmail label IDs to filter (e.g., INBOX,UNREAD) |
| `--max-messages` | — | 10 | Max messages per pull batch |
| `--poll-interval` | — | 5 | Seconds between pulls |
| `--msg-format` | — | full | Gmail message format: full, metadata, minimal, raw |
| `--once` | ✔ | — | Pull once and exit (mandatory under Osinara) |
| `--cleanup` | — | — | Delete created Pub/Sub resources on exit |

## Examples

```bash
gws gmail +watch --project my-project --label-ids INBOX --once
gws gmail +watch --subscription projects/p/subscriptions/my-sub --once
```

## Tips

- `--once` is mandatory because the credentialed runner stops commands after 60 seconds.
- A timeout after setup is ambiguous and may leave Pub/Sub resources; never retry blindly.
- Gmail watch expires after 7 days; renew only through another reviewed one-shot command.

## See Also

- [gws-shared](../gws-shared/SKILL.md) — Global flags and auth
- [gws-gmail](../gws-gmail/SKILL.md) — All send, read, and manage email commands
