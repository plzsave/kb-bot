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

### Routing eval (when you touch retrieval/routing)

`typecheck` + `test` are pure and credential-free, so CI runs only those. The routing/monorepo
behavior (docs-vs-code, drilling into the right package) depends on a live LLM and GitHub, so it
lives in a separate harness that is **not** in CI (it costs money and needs keys):

```bash
# needs the selected provider's API key + KB_GITHUB_REPOS (the sample cases target plzsave/kb-bot)
bun run kb:ingest          # so the docs cases have something to match
bun run kb:eval            # scores eval/cases.json; exits non-zero on any FAIL
```

Run it before merging changes to `src/chat/core.ts` (system prompt / routing), `src/agent/`,
or `src/github.ts`, and add a case to `eval/cases.json` when you add a routing behavior.

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
