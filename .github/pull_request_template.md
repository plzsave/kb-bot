## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes
- [ ] Docker image builds (if the container/runtime changed): `docker build -t kb-bot:dev .`
- [ ] No secrets committed; new env vars documented in `.env.example`
- [ ] Platform-specific behavior stays in `src/chat/<platform>.ts` (core untouched)
