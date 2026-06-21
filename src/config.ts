// 環境変数の読み出し（bun は .env を自動ロードする）。
// 値はここでしか読まない＝テスト時に差し替えやすく、未設定を早期に検出する。

import type { LlmProvider } from "./llm/provider.ts";
import { createLlm } from "./llm/factory.ts";

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
