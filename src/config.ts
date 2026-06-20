// 環境変数の読み出し（bun は .env を自動ロードする）。
// 値はここでしか読まない＝テスト時に差し替えやすく、未設定を早期に検出する。

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
  anthropicApiKey: string;
  /** 既定モデル。コスト優先で Haiku。難問だけ上位へエスカレーションする想定。 */
  model: string;
}

export function loadBotConfig(): BotConfig {
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    model: process.env.KB_MODEL ?? "claude-haiku-4-5",
  };
}

export interface DiscordConfig {
  discordBotToken: string;
  anthropicApiKey: string;
  model: string;
}

export function loadDiscordConfig(): DiscordConfig {
  return {
    discordBotToken: required("DISCORD_BOT_TOKEN"),
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    model: process.env.KB_MODEL ?? "claude-haiku-4-5",
  };
}
