import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { loadDiscordConfig, dbPath } from "./config.ts";
import { openDb, countChunks } from "./kb/db.ts";
import { ensureCacheTable } from "./cache.ts";
import { answer, type AnswerDeps, type HistoryTurn } from "./chat/core.ts";
import { discordReply } from "./chat/discord.ts";
import { loadGitHub } from "./github.ts";

const HISTORY_LIMIT = 12; // 会話メモリに含める直近メッセージ数の上限

// Discord エントリ。プラットフォーム依存（discord.js・イベント配線）だけを持ち、
// 回答ロジックは Slack と同じ chat/core の answer() に委譲する（コアは無改修）。

const cfg = loadDiscordConfig();
const db = openDb(dbPath());
ensureCacheTable(db);
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

// DM / スレッドの直近メッセージを会話メモリにする（通常チャンネルは雑多なので対象外）。
async function fetchHistory(message: any): Promise<HistoryTurn[]> {
  const ch = message.channel;
  const eligible = message.guild === null || (typeof ch.isThread === "function" && ch.isThread());
  if (!eligible) return [];
  try {
    const fetched = await ch.messages.fetch({ limit: 30, before: message.id });
    const arr = [...fetched.values()].reverse(); // 古い順
    const turns: HistoryTurn[] = [];
    for (const m of arr) {
      const text = (m.content ?? "").replace(/<@!?\d+>/g, " ").trim();
      if (!text || text === "考え中… ⏳") continue;
      turns.push({ role: m.author.id === client.user?.id ? "assistant" : "user", text });
    }
    return turns.slice(-HISTORY_LIMIT);
  } catch {
    return []; // 権限不足等は単発回答にフォールバック
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return; // bot 自身・他 bot は無視

  const isDM = message.guild === null;
  const mentioned = client.user ? message.mentions.has(client.user) : false;
  // チャンネルではメンション時のみ反応。DM は常に反応。
  if (!isDM && !mentioned) return;

  const text = message.content.replace(/<@!?\d+>/g, " ").trim(); // メンション除去
  const history = await fetchHistory(message);
  await answer(text, discordReply(message.channel), deps, history);
});

client.once(Events.ClientReady, (c) => {
  console.log(
    `⚡️ kb-bot 起動（Discord / ${c.user.tag} / model=${cfg.model} / 索引チャンク=${countChunks(db)} / ` +
      `GitHub=${github ? github.repos.join(",") : "off"}）`,
  );
});

await client.login(cfg.discordBotToken);
