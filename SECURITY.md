# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, report privately via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's **Security** tab).

We aim to acknowledge reports within a few days and to ship a fix or mitigation as soon as
practical, coordinating disclosure with you.

## Handling secrets

This bot needs several secrets at runtime (Slack/Discord tokens, an Anthropic API key, and
S3/R2 credentials). To keep them safe:

- Secrets are read only from environment variables / `.env`. `.env` is git-ignored and excluded
  from the Docker image via `.dockerignore` — never commit it.
- Grant the **minimum scope**: the R2/S3 credentials only need read access to the knowledge bucket.
- Rotate tokens if they may have been exposed (e.g. pasted into logs or chats).
- The bot logs token usage but never logs secret values.
