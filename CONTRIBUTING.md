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
