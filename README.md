# kb-bot

A low-cost knowledge bot for **Slack and Discord**. It answers from Markdown knowledge stored in
R2/S3, and — because docs go stale — it can **read the actual GitHub source code to explain how an
app behaves and how to use it**, citing file paths and line numbers.

The answer logic (`src/chat/core.ts`) is platform-agnostic; Slack and Discord are just
adapters (`src/chat/slack.ts` / `src/chat/discord.ts`) you swap in.

> 日本語版: [README.ja.md](README.ja.md)

## How it keeps costs low

1. **Answer cache** (SQLite, exact match, default TTL 24h) — a hit skips the LLM entirely (the biggest
   saver). Tune with `KB_CACHE_TTL_HOURS`, `0` = never expire. Entries expire by default so stale docs
   don't get served forever.
2. **FTS5/BM25 search** (`bun:sqlite` + morphological segmentation) — retrieval with zero embedding-API cost.
3. **Prompt caching** — reuses the system prompt / tool definitions. Provider-specific but always on:
   Anthropic uses `cache_control: ephemeral`; Gemini and OpenAI cache automatically.
4. **Model tiering (auto-escalate hard questions)** — defaults to each provider's cheapest tier
   (`KB_MODEL`). Set `KB_MODEL_HARD` to enable escalation: **A** = code questions with no FTS hit start
   on the higher tier; **B** = if the cheap tier gets truncated, retry on the higher tier. Ordinary
   questions stay one cheap call, so cost is unchanged. Unset = escalation off (always the base tier).

> For Japanese knowledge, FTS5 uses **TinySegmenter (morphological segmentation) + unicode61**
> instead of `trigram`. `trigram` could not match 2-character words (e.g. 「認証」) and recall
> dropped once particles were glued to keywords — verified, then switched.

## LLM provider (Anthropic / Gemini / OpenAI)

The answer logic talks to LLMs through a thin provider interface (`src/llm/`), so you can switch
backends with `KB_LLM_PROVIDER` (`anthropic` default, `gemini`, or `openai`). Only the selected
provider's key is required (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY`). The cost
savers are unaffected by the choice: the **answer cache** and **FTS5/BM25 search** never call an LLM
API at all, and **prompt-cache discounts are preserved** on every provider (just expressed
differently — explicit on Anthropic, automatic on Gemini/OpenAI). Default models are the cheapest
tier per provider (`claude-haiku-4-5` / `gemini-3.1-flash-lite` / `gpt-5.4-nano`); set `KB_MODEL` for
the base tier and `KB_MODEL_HARD` for the escalation target (see "How it keeps costs low" #4).

### Model selection and resilience to retirement

Model IDs are human-maintained **config** (pricing isn't exposed via the API, so auto-selection isn't
possible). Two things guard against staleness/retirement:

- **Use aliases**, not dated snapshots (e.g. `claude-haiku-4-5`) — they track minor updates automatically.
- **Runtime fallback**: if a model retires mid-uptime and an LLM call 404s, the bot falls back to the
  provider's default model on the spot and keeps answering (no restart). It's logged as
  `[usage] ... fellBack=true`. Retirement dates are announced ahead of time, so pair this with a planned
  `KB_MODEL` update.

## Setup

```bash
bun install
cp .env.example .env   # fill in the values (S3/R2, Slack/Discord, Anthropic / Gemini / OpenAI)
```

**Slack:** enable Socket Mode → obtain an App-Level Token (`connections:write`) and a Bot Token.
Bot Token Scopes: `app_mentions:read` `chat:write` `im:history` `im:read` `channels:history`
(`channels:history` lets it read a thread's earlier messages for follow-up context; add
`groups:history` / `mpim:history` if you use it in private or group-DM channels).
Subscribe to bot events: `app_mention`, `message.im`.

**Conversation memory:** in a thread, mention the bot again to ask a follow-up — it reads the
thread's earlier messages so "what about the line numbers?" works. DMs are continuous conversations.
New top-level questions stay independent (and cacheable); follow-ups with context skip the cache.

**Discord:** create a Bot in the Developer Portal and obtain its Bot Token.
**Enable the "MESSAGE CONTENT INTENT"** under Privileged Gateway Intents (required to read message text).
Invite the bot with the `bot` scope and these permissions: **Send Messages, Create Public Threads,
Send Messages in Threads, Read Message History** (in a channel the bot opens a thread per question
and answers there; thread/DM follow-ups carry context, like Slack).

**GitHub (optional, "explain specs from real code"):** set `KB_GITHUB_REPOS` to a comma-separated
allowlist (`owner/name`). For private repos or code search, add a `GITHUB_TOKEN` (a fine-grained PAT
with read-only Contents, scoped to those repos). Public repos work without a token (tree + file read).

## Reading code as the source of truth

Documentation drifts; the code does not. When `KB_GITHUB_REPOS` is set, the agent gets three tools —
`list_repo_tree`, `search_repo_code`, `read_repo_file` — and is instructed to treat the **code as the
source of truth** for questions about an app's behavior, spec, or usage. It navigates the repo, reads
the relevant files, and cites paths + line numbers in its answer. Access is restricted to the
allowlisted repos, and secret files (`.env`, `*.pem/key`, `secrets*`) and path traversal are refused.

## Customizing the system prompt (no redeploy)

The built-in base prompt (role, safety, output style) lives in code and answers in **the same language
as the question** (Japanese question → Japanese answer, English → English). To tweak tone or policy
without editing code or redeploying — e.g. "explain things more simply, avoid jargon" — append extra
instructions from outside the image:

- **R2/S3 object (default):** put a Markdown file at `KB_SYSTEM_PROMPT_KEY` (default
  `_config/system-prompt.md`). It is fetched at request time with a short cache (`KB_SYSTEM_PROMPT_TTL_SEC`,
  default 60s), so editing the object takes effect within the TTL **with no restart and no redeploy**.
  Works the same on fly.io / ECS where files and env are awkward to edit in place. The `_config/` prefix
  is excluded from ingest, so it never pollutes search.
- **Inline (local/dev):** set `KB_SYSTEM_PROMPT_EXTRA`; when present it takes precedence and S3 is not read.

The extra text is **appended** to the base prompt — the safety rules (treat retrieved content as
reference, not instructions) always stay in effect.

## Usage

```bash
# 1. Ingest knowledge (R2/S3 .md → chunk → FTS5 index)
bun run kb:ingest

# 2. Inspect search quality (eyeball BM25 results)
bun run kb:search "Where do we deploy?"

# 3. Run the bot (long-running)
bun run start            # Slack (Socket Mode)   or: bun run dev
bun run start:discord    # Discord               or: bun run dev:discord
```

Slack responds to channel mentions and DMs; Discord responds to mentions and DMs.

## Self-hosting (Docker, always-on)

Socket Mode keeps a persistent connection, so the process must stay running. A single container
runs anywhere (VPS / Fly.io / Railway / Render / ECS Fargate / a home server).

Pull the published image (tagged releases are pushed to GHCR), or build locally:

```bash
# Pull a released image
docker pull ghcr.io/plzsave/kb-bot:latest

# Or build & run from source
cp .env.example .env   # fill in the values
docker compose up -d --build
docker compose logs -f # watch startup, ingest, and usage logs
```

On boot, `docker-entrypoint.sh` ingests the knowledge from R2/S3 (`kb:ingest`) and then starts
the bot. The FTS index is derived from R2, so rebuilding it on every boot is fine.

- **Persisting the answer cache:** `compose.yaml` mounts the `kbdata` volume at `/app/data` so the
  cache survives restarts. `KB_DB_PATH` is pinned to `/app/data/kb.sqlite` in compose (overriding `.env`).
- **Skipping boot-time ingest:** set `KB_INGEST_ON_BOOT=false` if you reuse a persisted index.
- **Refreshing knowledge:** after updating the `.md` files in R2, run `docker compose restart`.
- **Choosing the platform:** `KB_PLATFORM=slack` (default) or `discord`. To run Discord, set
  `KB_PLATFORM=discord` and `DISCORD_BOT_TOKEN` in `.env`. To run both at once, define two compose
  services that differ only by `KB_PLATFORM`.

### Provider notes

- **VPS / home server:** the compose file as-is. Simplest.
- **Fly.io:** `fly launch` with the same image (map `[mounts]` to `/app/data` in `fly.toml` to persist the cache).
- **AWS:** for an always-on process, **ECS Fargate (1 task)** is the natural fit. Cheapest is an
  **EC2 t4g.nano**; **Lightsail** is the simplest flat-rate option. **Lambda will not work**
  (it cannot hold a persistent WebSocket). On Fargate's ephemeral FS, persist the answer cache via EFS or re-warm it.

## Layout

```
src/
  config.ts        environment variables
  s3.ts            R2/S3 access (aws4fetch, list/get)
  github.ts        GitHub code access (tree/read/search, allowlist + secret guards)
  kb/
    chunk.ts       heading-aware Markdown chunking
    segment.ts     TinySegmenter morphological segmentation (index/query)
    db.ts          FTS5(unicode61) index + BM25 search
    ingest.ts      ingest job
  cache.ts         answer cache (SQLite)
  agent/
    agent.ts       tool-use loop (streaming, caching, usage)
    tools.ts       search_knowledge tool (FTS over R2/S3 docs)
    githubTools.ts list_repo_tree / read_repo_file / search_repo_code
  chat/
    core.ts        platform-agnostic answer core (answer / ChatReply)
    slack.ts       Slack ChatReply (postMessage / update, mrkdwn)
    discord.ts     Discord ChatReply (send / edit, 2000-char splitting)
  index.ts         Slack (Bolt, Socket Mode) entry — wiring only
  discord.ts       Discord (discord.js) entry — wiring only
scripts/
  kb-ingest.ts / kb-search.ts   CLIs
Dockerfile             bun-based runtime image
docker-entrypoint.sh   ingest on boot, then start the bot
compose.yaml           minimal self-hosting setup (with a persistent volume)
```

## Development

```bash
bun run typecheck   # tsc --noEmit
bun test            # unit tests (pure functions; no credentials needed)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## For end users

A plain-language guide for non-engineers (how to ask, automatic doc-vs-code routing,
reading sources, follow-ups, behavior when nothing is found): **[docs/USAGE.ja.md](docs/USAGE.ja.md)** (Japanese).

## License

[MIT](LICENSE)
