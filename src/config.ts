// 環境変数の読み出し（bun は .env を自動ロードする）。
// 値はここでしか読まない＝テスト時に差し替えやすく、未設定を早期に検出する。

import type { LlmProvider } from "./llm/provider.ts";
import { createLlm } from "./llm/factory.ts";
import { S3Client } from "./s3.ts";
import { createSystemExtraResolver } from "./chat/systemExtra.ts";

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadS3Config(): S3Config {
  return {
    endpoint: required("S3_ENDPOINT").replace(/\/+$/, ""),
    bucket: required("S3_BUCKET"),
    region: process.env.S3_REGION ?? "auto",
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    prefix: process.env.S3_PREFIX ?? "",
  };
}

export function dbPath(): string {
  return process.env.KB_DB_PATH ?? "./kb.sqlite";
}

export interface BotConfig {
  slackBotToken: string;
  slackAppToken: string;
  /** 選択中の LLM プロバイダ（KB_LLM_PROVIDER）。 */
  provider: LlmProvider;
  /** 解決済みの基本モデル。コスト優先で各社最安ティア（KB_MODEL）。 */
  model: string;
  /** 難問昇格先モデル（KB_MODEL_HARD）。未設定なら昇格無効。 */
  modelHard: string | undefined;
}

export function loadBotConfig(): BotConfig {
  const { provider, model, modelHard } = createLlm();
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    provider,
    model,
    modelHard,
  };
}

export interface IssueConfig {
  /** issue 収集対象リポジトリ（KB_GITHUB_REPOS とは分離）。 */
  repos: string[];
  /** read-only PAT（Issues:read）。未設定でも public なら動くが推奨。 */
  githubToken: string | undefined;
  /** この件数未満のコメントの issue は除外（既定1）。 */
  minComments: number;
  provider: LlmProvider;
  model: string;
}

export function loadIssueConfig(reposOverride?: string[]): IssueConfig {
  const raw = reposOverride ?? splitCsv(process.env.KB_ISSUE_REPOS);
  const repos = raw.map((r) => r.trim()).filter(Boolean);
  if (repos.length === 0) throw new Error("対象リポジトリが未指定です（--repos か KB_ISSUE_REPOS を設定）");
  const min = Number(process.env.KB_ISSUE_MIN_COMMENTS);
  const { provider, model } = createLlm();
  return {
    repos,
    githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
    minComments: Number.isFinite(min) && min >= 0 ? min : 1,
    provider,
    model,
  };
}

function splitCsv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// 追加システムプロンプトの既定オブジェクトキー。ナレッジと混ざらないよう _config/ 配下に置く
// （ingest はこの接頭辞を索引対象から除外する。isReservedKey 参照）。
export const SYSTEM_PROMPT_KEY_DEFAULT = "_config/system-prompt.md";

export interface SystemPromptConfig {
  /** インライン追加指示（KB_SYSTEM_PROMPT_EXTRA）。最優先。ローカル/簡易検証向け。 */
  inline: string | undefined;
  /** R2/S3 上の追加指示オブジェクトのキー（KB_SYSTEM_PROMPT_KEY）。既定 _config/system-prompt.md。 */
  key: string;
  /** バケット取得のキャッシュ TTL（秒, KB_SYSTEM_PROMPT_TTL_SEC）。既定 60。0 で毎回取得。 */
  ttlSec: number;
}

export function loadSystemPromptConfig(): SystemPromptConfig {
  const ttl = Number(process.env.KB_SYSTEM_PROMPT_TTL_SEC);
  return {
    inline: process.env.KB_SYSTEM_PROMPT_EXTRA?.trim() || undefined,
    key: process.env.KB_SYSTEM_PROMPT_KEY?.trim() || SYSTEM_PROMPT_KEY_DEFAULT,
    ttlSec: Number.isFinite(ttl) && ttl >= 0 ? ttl : 60,
  };
}

/**
 * 追加システムプロンプトの解決関数を作る（各プラットフォームの起動口から AnswerDeps へ渡す）。
 * インライン指定があれば S3 を構成しない。S3 接続情報が無い/不正でも追加なしで動く（追加指示は任意機能のため）。
 */
export function loadSystemExtraResolver(): () => Promise<string> {
  const sp = loadSystemPromptConfig();
  if (sp.inline) return createSystemExtraResolver({ inline: sp.inline });
  let s3: S3Client | undefined;
  try {
    s3 = new S3Client(loadS3Config());
  } catch {
    s3 = undefined; // S3 未設定なら追加プロンプト機能はオフ（必須機能ではない）
  }
  return createSystemExtraResolver({ s3, key: sp.key, ttlMs: sp.ttlSec * 1000 });
}

export interface DiscordConfig {
  discordBotToken: string;
  provider: LlmProvider;
  model: string;
  /** 難問昇格先モデル（KB_MODEL_HARD）。未設定なら昇格無効。 */
  modelHard: string | undefined;
}

export function loadDiscordConfig(): DiscordConfig {
  const { provider, model, modelHard } = createLlm();
  return {
    discordBotToken: required("DISCORD_BOT_TOKEN"),
    provider,
    model,
    modelHard,
  };
}
