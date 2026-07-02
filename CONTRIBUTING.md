# Contributing

Thanks for your interest in improving kb-bot!

## Development setup

This project uses [Bun](https://bun.sh) as both the runtime and the package manager.

```bash
bun install
cp .env.example .env   # only needed for live runs (ingest / bot), not for tests
```

## Before opening a pull request

Run both checks locally — CI runs the same ones:

```bash
bun run typecheck   # tsc --noEmit
bun test            # pure-function unit tests (no credentials required)
```

If your change touches the container, also confirm it builds:

```bash
docker build -t kb-bot:dev .
```

### Live eval (when you touch the LLM surface)

`typecheck` + `test` are pure and credential-free, so CI runs only those. Answer quality depends
on a live LLM and GitHub, so it lives in a separate harness that is **not** in CI (it costs money
and needs keys):

```bash
# needs the selected provider's API key + KB_GITHUB_REPOS (the code cases target plzsave/kb-bot)
bun run kb:ingest          # so the docs cases have something to match
bun run kb:eval            # runs eval/cases.json (~10 min, ~60 cases)
```

**How to read the result** — individual case PASS/FAIL lines flip run-to-run (single LLM runs are
nondeterministic; ~17% of cases flip, this is normal). Only two lines decide the exit code:

- `ゲート` (safety gate): injection cases. Any failure here is a hard fail — investigate immediately.
- `集約` (aggregate): overall pass rate vs. the recorded baseline (`eval/baseline.json`) minus a
  tolerance band (default 10pp, calibrated from measured run-to-run variance). `集約: FAIL` means
  the *whole* suite degraded beyond noise — something real broke.

Operating rules: run it only when you change the LLM surface (system prompt in `src/chat/core.ts`,
models, `src/agent/`, `src/github.ts`) or when answers feel degraded. Do **not** chase individual
FAILs, and do not re-run to fish for a green — accept the verdict and investigate. If you edit
`eval/cases.json`, the gate reports `stale-baseline`; re-record with `bun run kb:eval --update-baseline`.

## Guidelines

- **Dependencies:** never hand-write versions in `package.json`. Use `bun add <pkg>` /
  `bun add -d <pkg>` so the package manager resolves them.
- **Keep the core platform-agnostic.** Platform-specific behavior belongs in an adapter under
  `src/chat/` (see `slack.ts` / `discord.ts`), not in `src/chat/core.ts`.
- **Match the surrounding style.** Comments are concise and explain *why*, not *what*.
- **Secrets:** never commit `.env` or real tokens. Tests must not require credentials.

## Adding a new platform

1. Implement `ChatReply` for the platform in `src/chat/<platform>.ts`.
2. Add a thin entry (`src/<platform>.ts`) that wires events to `answer()`.
3. Add a `start:<platform>` script and a `KB_PLATFORM` branch in `docker-entrypoint.sh`.

## Reporting bugs / requesting features

Open an issue using the provided templates. For security issues, see [SECURITY.md](SECURITY.md).
