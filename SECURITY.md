# Security policy

Osinara stores private family conversations, memory and files, so authorization bugs are security bugs:
a model, message or tool result that gains access to another person's, family's or group's data, a
bypass of owner-only operations or approvals, credential or prompt exposure, or a sandbox escape.

Please report vulnerabilities privately through GitHub Security Advisories ("Report a vulnerability" on
the repository's Security tab). Do not open a public issue. Include the affected version or commit,
reproduction steps and impact. We aim to acknowledge reports within a week.

Self-hosted installations are operated by their owners: keep `.env` secrets private, restrict SSH, keep
PostgreSQL and the agent container off the public network, and apply updates.
