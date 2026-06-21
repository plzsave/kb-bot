import { App } from "@slack/bolt";
import { loadBotConfig, dbPath } from "./config.ts";
import { openDb, countChunks } from "./kb/db.ts";
import { ensureCacheTable } from "./cache.ts";
import { ensureUsageTable } from "./usage.ts";
import { answer, type AnswerDeps, type HistoryTurn } from "./chat/core.ts";
import { slackReply } from "./chat/slack.ts";
import { loadGitHub } from "./github.ts";
import { InFlightGuard } from "./inflight.ts";
import { startHeartbeat } from "./heartbeat.ts";

const HISTORY_LIMIT = 12; // 会話メモリに含める直近メッセージ数の上限
const guard = new InFlightGuard(); // 同一ユーザーの多重実行を防ぐ

// Slack のメッセージ列を会話履歴に変換（プレースホルダ/空/現在の発言は除外）。
function toHistory(messages: any[], botUserId: string | undefined, skipTs?: string): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const m of messages) {
    if (skipTs && m.ts === skipTs) continue; // 今回の発言自体は履歴に入れない
    if (m.subtype) continue;
    const text = (m.text ?? "").replace(/<@[^>]+>/g, " ").trim();
    if (!text || text === "考え中… ⏳") continue;
    const isBot = Boolean(m.bot_id) || (botUserId != null && m.user === botUserId);
    turns.push({ role: isBot ? "assistant" : "user", text });
  }
  return turns.slice(-HISTORY_LIMIT);
}

// Slack エントリ。プラットフォーム依存（Bolt / Socket Mode・イベント配線）だけを持ち、
// 回答ロジックは chat/core の answer() に委譲する。Discord 等は別アダプタを足すだけで済む。

const cfg = loadBotConfig();
const db = openDb(dbPath());
ensureCacheTable(db);
ensureUsageTable(db);
const github = loadGitHub();
const deps: AnswerDeps = { db, provider: cfg.provider, model: cfg.model, github };

const app = new App({
  token: cfg.slackBotToken,
  appToken: cfg.slackAppToken,
  socketMode: true,
});

// メンション（チャンネル）
app.event("app_mention", async ({ event, client, context }) => {
  const text = (event.text ?? "").replace(/<@[^>]+>/g, " "); // メンション除去
  // スレッド内の追撃なら、そのスレッドの過去発言を会話メモリとして読み込む。
  let history: HistoryTurn[] = [];
  if (event.thread_ts) {
    try {
      const res = await client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 30 });
      history = toHistory(res.messages ?? [], context.botUserId, event.ts);
    } catch {
      /* 履歴取得失敗（scope 不足等）は無視して単発回答にフォールバック */
    }
  }
  const user = event.user ?? event.channel;
  if (!guard.tryAcquire(user)) return; // 前の質問を処理中なら無視
  try {
    await answer(text, slackReply(client, event.channel, event.thread_ts ?? event.ts), deps, history);
  } finally {
    guard.release(user);
  }
});

// DM（message.im）。bot 自身や編集イベントは無視。
app.message(async ({ message, client, context }) => {
  const m = message as any;
  if (m.channel_type !== "im" || m.subtype || m.bot_id) return;
  // DM は連続した会話なので直近履歴を会話メモリにする。
  let history: HistoryTurn[] = [];
  try {
    const res = await client.conversations.history({ channel: m.channel, limit: 30 });
    // conversations.history は新しい順なので古い順へ
    history = toHistory((res.messages ?? []).slice().reverse(), context.botUserId, m.ts);
  } catch {
    /* 失敗時は単発回答にフォールバック */
  }
  const user = m.user ?? m.channel;
  if (!guard.tryAcquire(user)) return; // 前の質問を処理中なら無視
  try {
    await answer(m.text ?? "", slackReply(client, m.channel, m.thread_ts), deps, history);
  } finally {
    guard.release(user);
  }
});

await app.start();
startHeartbeat(); // 死活監視（Docker HEALTHCHECK 用）
console.log(
  `⚡️ kb-bot 起動（Slack / Socket Mode / ${cfg.provider.name}:${cfg.model} / 索引チャンク=${countChunks(db)} / ` +
    `GitHub=${github ? github.repos.join(",") : "off"}）`,
);
