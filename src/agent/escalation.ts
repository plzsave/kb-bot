import type { LlmMessage, LlmProvider } from "../llm/provider.ts";
import { isModelNotFoundError } from "../llm/errors.ts";
import { runAgent, type AgentTool, type RunAgentOpts, type RunAgentResult } from "./agent.ts";

// モデル昇格(A+B)と 404/退役フォールバックの orchestration。answer()（本番）と kb-eval（評価）が
// 同一ロジックを通るよう共有する。副作用（逐次表示・「考え中」表示・バッファ初期化）は
// onDelta/onEscalate コールバックで呼び出し側に残し、ここは「どのティアで何回 runAgent するか」に集中する。

// runAgent を実行し、指定モデルが 404/退役なら既定モデル（各社エイリアス＝最も生きている可能性が高い）で
// 一度だけ再試行する。常駐中にモデルが退役しても、再起動なしに回答を継続させるための安全網。
// 既定モデル自体が落ちている場合は再試行できないので、そのまま投げて呼び出し側のエラー処理に任せる。
export async function runAgentWithFallback(
  opts: RunAgentOpts,
): Promise<{ result: RunAgentResult; modelUsed: string; fellBack: boolean }> {
  try {
    return { result: await runAgent(opts), modelUsed: opts.model, fellBack: false };
  } catch (e) {
    const fallback = opts.provider.defaultModel;
    if (isModelNotFoundError(e) && opts.model !== fallback) {
      console.warn(
        `[escalation] モデル ${opts.model} が利用不可（退役の可能性）。既定 ${fallback} にフォールバックします。`,
      );
      return { result: await runAgent({ ...opts, model: fallback }), modelUsed: fallback, fellBack: true };
    }
    throw e;
  }
}

export interface RunWithEscalationOpts {
  provider: LlmProvider;
  /** 基本ティア。 */
  model: string;
  /** 難問昇格先。未設定なら昇格無効（canEscalate=false）。 */
  modelHard?: string;
  system: string;
  messages: LlmMessage[];
  tools: AgentTool[];
  maxTurns?: number;
  /** 事前昇格。呼び出し側が算定する（true のとき modelHard は非 undefined であること）。 */
  startHard: boolean;
  /** 逐次出力（ストリーミング表示）。 */
  onDelta?: (text: string) => void;
  /** B経路（truncated 救済）で上位ティア再実行する直前に呼ばれる（表示更新・バッファ初期化用）。 */
  onEscalate?: () => void | Promise<void>;
}

export interface RunWithEscalationResult {
  result: RunAgentResult;
  modelUsed: string;
  fellBack: boolean;
  escalated: boolean;
}

/**
 * A経路（startHard 指定時に上位ティアで開始）と B経路（最安で truncated＝手に負えなかった時だけ
 * 上位ティアで再実行して救済）を行い、404/退役は runAgentWithFallback で吸収する。
 * 昇格の可否は modelHard 有無から内部計算（canEscalate = modelHard 設定済みかつ base と別物）。
 * 入力 opts は変更しない。
 */
export async function runWithEscalation(opts: RunWithEscalationOpts): Promise<RunWithEscalationResult> {
  const canEscalate = !!opts.modelHard && opts.modelHard !== opts.model;

  const runOnce = (m: string) =>
    runAgentWithFallback({
      provider: opts.provider,
      model: m,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      maxTurns: opts.maxTurns,
      onDelta: opts.onDelta,
    });

  // A: 事前昇格。startHard なら最初から上位ティアで（後追い昇格の二重課金を避ける）。
  let { result, modelUsed, fellBack } = await runOnce(opts.startHard ? opts.modelHard! : opts.model);
  let escalated = opts.startHard;

  // B: 最安で打ち切られた（ターン上限到達＝手に負えなかった）時だけ上位ティアで再実行して救済する。
  //    「ナレッジに無い」自己申告では昇格しない（上位でも知識は増えず無駄打ちになるため）。
  if (!opts.startHard && canEscalate && result.truncated) {
    escalated = true;
    await opts.onEscalate?.();
    ({ result, modelUsed, fellBack } = await runOnce(opts.modelHard!));
  }

  return { result, modelUsed, fellBack, escalated };
}
