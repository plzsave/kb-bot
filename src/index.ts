import { App } from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";
import { loadBotConfig, dbPath } from "./config.ts";
import { openDb, countChunks } from "./kb/db.ts";
import { ensureCacheTable } from "./cache.ts";
import { answer, type AnswerDeps } from "./chat/core.ts";
import { slackReply } from "./chat/slack.ts";

// Slack エントリ。プラットフォーム依存（Bolt / Socket Mode・イベント配線）だけを持ち、
// 回答ロジックは chat/core の answer() に委譲する。Discord 等は別アダプタを足すだけで済む。

const cfg = loadBotConfig();
const db = openDb(dbPath());
ensureCacheTable(db);
const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey });
const deps: AnswerDeps = { db, anthropic, model: cfg.model };

const app = new App({
  token: cfg.slackBotToken,
  appToken: cfg.slackAppToken,
  socketMode: true,
});

// メンション（チャンネル）
app.event("app_mention", async ({ event, client }) => {
  const text = (event.text ?? "").replace(/<@[^>]+>/g, " "); // メンション除去
  await answer(text, slackReply(client, event.channel, event.thread_ts ?? event.ts), deps);
});

// DM（message.im）。bot 自身や編集イベントは無視。
app.message(async ({ message, client }) => {
  const m = message as any;
  if (m.channel_type !== "im" || m.subtype || m.bot_id) return;
  await answer(m.text ?? "", slackReply(client, m.channel, m.thread_ts), deps);
});

await app.start();
console.log(`⚡️ kb-bot 起動（Slack / Socket Mode / model=${cfg.model} / 索引チャンク=${countChunks(db)}）`);
