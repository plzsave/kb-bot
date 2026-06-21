// LLM プロバイダ非依存の中立レイヤ。ここに Anthropic/Gemini など特定 SDK の型を持ち込まない。
// agent ループ・chat コアはこの中立型だけに依存し、プロバイダ差は各アダプタが吸収する。
//
// 設計の肝:
// - 回答キャッシュ(src/cache.ts)・FTS5 検索(src/kb/db.ts)は LLM API を触らないのでこの層の外。
//   プロバイダを変えても節約の中核は不変。
// - プロンプトキャッシュは Anthropic 固有の概念なので cacheHint という「任意ヒント」に抽象化し、
//   非対応プロバイダ（Gemini の暗黙キャッシュ等）では no-op にする＝割引自体は各社方式で維持。

/** ツール定義（JSON Schema）。Anthropic の input_schema / OpenAI の parameters に相当。 */
export interface LlmToolDef {
  name: string;
  description: string;
  /** 引数の JSON Schema（object 型）。中身は各社共通で、包み方だけアダプタが変える。 */
  parameters: Record<string, unknown>;
}

export interface LlmTextBlock {
  type: "text";
  text: string;
}

export interface LlmToolUseBlock {
  type: "tool_use";
  /** ツール呼び出しの相関 id。Gemini には無いのでアダプタが合成する。 */
  id: string;
  name: string;
  input: unknown;
  /**
   * プロバイダ固有の不透明データ。次ターンの履歴へ「そのまま返さないと壊れる」もの専用。
   * 例: Gemini 3.x は functionCall に紐づく thoughtSignature の再送を必須にする。
   * 他プロバイダは無視する（中身に依存しない）。
   */
  providerMeta?: Record<string, unknown>;
}

export interface LlmToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  /** ツール名。Gemini の functionResponse は名前キーを要求するため持たせる（Anthropic では無視）。 */
  name: string;
}

/** assistant ターンが返しうるブロック（テキスト＋ツール呼び出し）。 */
export type LlmAssistantBlock = LlmTextBlock | LlmToolUseBlock;

/** メッセージ内容。単純な文字列か、ブロック配列（tool 往復時）。 */
export type LlmContent = string | Array<LlmTextBlock | LlmToolUseBlock | LlmToolResultBlock>;

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContent;
}

/** トークン使用量。cache の概念が無いプロバイダは 0 埋め。 */
export interface LlmUsage {
  input: number; // キャッシュ未ヒットの新規入力
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface StreamTurnParams {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  maxTokens: number;
  /** プロンプトキャッシュのヒント。対応プロバイダのみ適用し、非対応は無視。 */
  cacheHint?: boolean;
  /** ストリーミングの逐次テキスト。 */
  onText?: (delta: string) => void;
}

export interface StreamTurnResult {
  /** この assistant ターンの内容（次ターンへ履歴として積み直すのに使う）。 */
  blocks: LlmAssistantBlock[];
  /** tool_use を含むなら "tool_use"、最終回答なら "stop"。 */
  stopReason: "tool_use" | "stop";
  usage: LlmUsage;
}

export interface CompleteParams {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
}

/** プロバイダ抽象。agent ループは streamTurn、一発要約バッチは complete を使う。 */
export interface LlmProvider {
  readonly name: string;
  /** KB_MODEL 未指定時に使う既定モデル（プロバイダ別）。 */
  readonly defaultModel: string;
  /** ツール往復ありの 1 ターンを実行（ストリーミング）。 */
  streamTurn(params: StreamTurnParams): Promise<StreamTurnResult>;
  /** ツール無し・非ストリームの単発生成（要約用）。テキストを返す。 */
  complete(params: CompleteParams): Promise<string>;
}
