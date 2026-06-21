import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { loadDiscordConfig, dbPath } from "./config.ts";
import { openDb, countChunks } from "./kb/db.ts";
import { ensureCacheTable } from "./cache.ts";
import { ensureUsageTable } from "./usage.ts";
import { answer, type AnswerDeps, type HistoryTurn } from "./chat/core.ts";
import { discordReply } from "./chat/discord.ts";
import { loadGitHub } from "./github.ts";
import { InFlightGuard } from "./inflight.ts";
import { startHeartbeat } from "./heartbeat.ts";

const HISTORY_LIMIT = 12; // 会話メモリに含める直近メッセージ数の上限
const guard = new InFlightGuard(); // 同一ユーザーの多重実行を防ぐ

// Discord エントリ。プラットフォーム依存（discord.js・イベント配線）だけを持ち、
// 回答ロジックは Slack と同じ chat/core の answer() に委譲する（コアは無改修）。

const cfg = loadDiscordConfig();
const db = openDb(dbPath());
ensureCacheTable(db);
ensureUsageTable(db);
const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey });
const github = loadGitHub();
const deps: AnswerDeps = { db, anthropic, model: cfg.model, github };

const client = new Client({
  // メッセージ本文の取得には MessageContent（特権インテント）が必要。
  // DM を受けるには Channel パーシャルも要る。
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// 1 メッセージを履歴ターンへ（bot 自身は assistant・空/プレースホルダは除外）。
function toTurn(m: any): HistoryTurn | null {
  const text = (m.content ?? "").replace(/<@[!&]?\d+>/g, " ").trim();
  if (!text || text === "考え中… ⏳") return null;
  return { role: m.author?.id === client.user?.id ? "assistant" : "user", text };
}

// DM / スレッドの直近メッセージを会話メモリにする（通常チャンネルは雑多なので対象外）。
async function fetchHistory(message: any): Promise<HistoryTurn[]> {
  const ch = message.channel;
  const isThread = typeof ch.isThread === "function" && ch.isThread();
  const eligible = message.guild === null || isThread;
  if (!eligible) return [];
  try {
    const turns: HistoryTurn[] = [];
    // スレッドの「開始メッセージ（元質問）」は親チャンネル側にあり、スレッドの一覧に含まれない。
    // これを先頭に補わないと、スレッド内には bot の回答(assistant)しか無く文脈が空になる。
    if (isThread && typeof ch.fetchStarterMessage === "function") {
      try {
        const starter = await ch.fetchStarterMessage();
        const t = starter ? toTurn(starter) : null;
        if (t) turns.push(t);
      } catch {
        /* スターターメッセージが取得できない場合は無視 */
      }
    }
    const fetched = await ch.messages.fetch({ limit: 30, before: message.id });
    for (const m of [...fetched.values()].reverse()) {
      const t = toTurn(m);
      if (t) turns.push(t);
    }
    return turns.slice(-HISTORY_LIMIT);
  } catch {
    return []; // 権限不足等は単発回答にフォールバック
  }
}

// スレッド名は 1〜100 文字。質問文を短く使い、空なら既定名。
function threadName(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 80);
  return t || "質問";
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return; // bot 自身・他 bot は無視

  const isDM = message.guild === null;
  const mentioned = client.user ? message.mentions.has(client.user) : false;
  // チャンネルではメンション時のみ反応。DM は常に反応。
  if (!isDM && !mentioned) return;

  const text = message.content.replace(/<@[!&]?\d+>/g, " ").trim(); // メンション除去

  const user = message.author.id;
  if (!guard.tryAcquire(user)) return; // 前の質問を処理中なら無視
  try {
    const history = await fetchHistory(message);

    // 返信先を決める。通常チャンネルでは質問ごとにスレッドを作り、その中で回答（Slack 同等）。
    // DM / 既にスレッド内 ならそのまま。スレッド作成不可（権限等）は通常チャンネルにフォールバック。
    let target: any = message.channel;
    const ch: any = message.channel;
    const inThread = typeof ch.isThread === "function" && ch.isThread();
    if (!isDM && !inThread && typeof message.startThread === "function") {
      try {
        target = await message.startThread({ name: threadName(text), autoArchiveDuration: 1440 });
      } catch {
        target = message.channel; // 公開スレッド作成権限が無い等は通常送信に戻す
      }
    }

    await answer(text, discordReply(target), deps, history);
  } finally {
    guard.release(user);
  }
});

client.once(Events.ClientReady, (c) => {
  startHeartbeat(); // 死活監視（Docker HEALTHCHECK 用）
  console.log(
    `⚡️ kb-bot 起動（Discord / ${c.user.tag} / model=${cfg.model} / 索引チャンク=${countChunks(db)} / ` +
      `GitHub=${github ? github.repos.join(",") : "off"}）`,
  );
});

await client.login(cfg.discordBotToken);
