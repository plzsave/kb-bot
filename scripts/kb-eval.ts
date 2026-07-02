#!/usr/bin/env bun
// ルーティング（docs vs code）とモノレポ深掘りが「実際に効いているか」を測る eval。
// 単体テストと違い、実 LLM＋実 GitHub に対して走らせる（＝ネットワーク・課金あり）。
//   bun run scripts/kb-eval.ts [ケースJSON]   (既定: ./eval/cases.json)
//
// 各ケースで本番と同じ前処理（FTS 前置き＋buildSystem＋ツール群）を組み立て、ツールを
// ラップして「どのツールを・どんな引数で呼んだか」を記録し、expect と突き合わせて採点する。
// 期待は「指定された項目だけ」検査する（未指定は不問）。全項目 PASS でケース合格。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { createLlm } from "../src/llm/factory.ts";
import { dbPath } from "../src/config.ts";
import { openDb, replaceDoc, search, isSubstantiveTopHit } from "../src/kb/db.ts";
import { chunkMarkdown } from "../src/kb/chunk.ts";
import { loadGitHub } from "../src/github.ts";
import { type AgentTool } from "../src/agent/agent.ts";
import { runWithEscalation } from "../src/agent/escalation.ts";
import { searchKnowledgeTool, formatHits } from "../src/agent/tools.ts";
import { githubTools } from "../src/agent/githubTools.ts";
import { buildSystem } from "../src/chat/core.ts";
import type { LlmMessage } from "../src/llm/provider.ts";

const TOP_K = 5; // 本番（core.ts）と同じく初期コンテキストに前置きする FTS 件数

interface Expect {
  /** これらのいずれかが使われていれば可（部分集合）。 */
  toolsUsedAny?: string[];
  /** これら全部が使われていること。 */
  toolsUsedAll?: string[];
  /** 期待する情報源。docs=search_knowledge / code=GitHub ツール / both=両方 / any=不問。 */
  source?: "docs" | "code" | "both" | "any";
  /** いずれかのツール呼び出しの引数（JSON 文字列）にこの部分文字列が含まれること（subdir/path の確認）。 */
  argIncludes?: string;
  /** read_repo_file で読んだ path のいずれかにこの部分文字列が含まれること。 */
  readPathIncludes?: string;
  /** 最終回答にこれら全部が含まれること。 */
  answerIncludes?: string[];
  /** 最終回答にこれらが含まれないこと（幻覚・誤誘導の検出）。 */
  answerOmits?: string[];
  /** 出典必須（軸 B′）。true のとき回答本文に出典の体裁が付いているかを検査する。 */
  citesSource?: boolean;
  /** 次の一歩必須（軸 D）。true のとき未発見回答に「次の一歩」の手掛かりが含まれるかを検査する。 */
  offersNextStep?: boolean;
}

/**
 * 出典体裁の検出規約（Boundary Commitment, research.md 確定値）。テストと共有できるよう export する。
 * - doc 引用: `.md` を末尾に持つ資料名トークン（例 `auth.md`, `docs/auth.md`）。
 * - code 引用: 拡張子付き path に続く行番号（例 `db.ts:42`, `src/kb/db.ts:120`）。
 */
export const DOC_CITATION = /[\w./-]+\.md\b/;
export const CODE_CITATION = /[\w./-]+\.[A-Za-z0-9]+:\d+/;

/**
 * 出典体裁（.md 資料名 または path:line）の欠如を検出して日本語 fail 文の配列で返す純粋関数。
 * readPathIncludes 併用時は汎用体裁ではなく「読んだ path を含む path:line 形式の引用が本文にあるか」を
 * 厳格検査する（厳格判定は汎用体裁を内包する）。citesSource が偽/未指定なら空配列（既存判定を変えない, Req 4.2）。
 * 副作用なし・入力不変。
 */
export function citationFails(expect: Expect, answer: string): string[] {
  // 出典必須フラグが立っていなければ何も検査しない（Req 4.2: 既存判定を一切変えない）。
  if (!expect.citesSource) return [];

  // 併用（code B′）: 厳格判定。読んだ path を含む path:line 引用が 1 つ以上あることを要求（Req 2.1–2.3）。
  if (expect.readPathIncludes !== undefined) {
    const path = expect.readPathIncludes;
    const codeCites = answer.match(new RegExp(CODE_CITATION.source, "g")) ?? [];
    const cited = codeCites.some((c) => c.includes(path));
    if (!cited) {
      return [`出典必須: 読んだ path "${path}" が行番号付き（path:line）で回答本文に引用されていない`];
    }
    return [];
  }

  // 汎用体裁（Req 1.1–1.3）: doc 引用 or code 引用のいずれかが本文にあれば可。
  if (!DOC_CITATION.test(answer) && !CODE_CITATION.test(answer)) {
    return ["出典必須: 回答本文に出典の体裁（.md 資料名 または path:line 引用）が含まれていない"];
  }
  return [];
}

/**
 * 「次の一歩」検出の手掛かり語彙（複数語 OR, Req 2.3）。テストと共有できるよう export する。
 * 未発見時に bot が実際に返す「次の一歩」表現をカバーする 2 系統で構成する:
 *  (1) 次の一歩を提示する枠組み語（"次のステップ"/"次の一歩"/"お勧め" 等。プロンプトの "next step" を
 *      モデルが訳出する形。通常の“見つかった回答”には出にくい）。
 *  (2) docs/USAGE.ja.md「見つかりませんでした」節の具体策（対象名・キーワードを足す／言い換え／
 *      資料追加で答えられる／担当者に確認）。
 * いずれも一般語単独一致（"確認"/"情報" 等）を避け、過剰一致しにくい語に限定する。
 */
export const NEXT_STEP_CUES = [
  // (1) 次の一歩を提示する枠組み語
  "次のステップ",
  "次の一歩",
  "お勧め",
  "おすすめ",
  // (2) 具体策
  "キーワード",
  "具体的に",
  "言い換え",
  "資料を追加",
  "追加すれば",
  "対象名",
  "絞り込",
  "担当者",
];

/**
 * 「次の一歩」の手掛かり欠如を検出して日本語 fail 文の配列で返す純粋関数。
 * offersNextStep が偽/未指定なら空配列（既存判定を変えない, Req 2.4/4.1）。副作用なし・入力不変。
 */
export function nextStepFails(expect: Expect, answer: string): string[] {
  // 次の一歩必須フラグが立っていなければ何も検査しない（Req 2.4: 既存判定を一切変えない）。
  if (!expect.offersNextStep) return [];
  // 手掛かり語彙のいずれか 1 つ以上が本文に出現すれば可（Req 2.3）。
  if (NEXT_STEP_CUES.some((cue) => answer.includes(cue))) return [];
  return ["次の一歩必須: 回答に次の一歩（キーワード補足・言い換え・資料追加などの具体的手掛かり）が示されていない"];
}

/** 評価軸の許容集合。スコアカードはこの軸ごとに到達度を集計する。 */
type Axis = "A" | "B" | "C" | "D" | "safety";
const AXES = ["A", "B", "C", "D", "safety"] as const;

/** JSON 直後の緩い形状。axis/gate は未検証なので Axis に narrow しない（検証は後続タスク）。 */
export interface RawCase {
  name: string;
  question: string;
  expect: Expect;
  axis?: string; // 未検証。validateCases 通過後に Axis へ narrow
  gate?: unknown; // 未検証。boolean 以外は不正
  monitor?: unknown; // 未検証。boolean 以外は不正（非ゲート＝exit 母数外の情報表示ケース）
  fixtures?: unknown; // 未検証。文字列配列以外は不正（隔離索引に載せる eval 専用 doc 名）
}

/** 検証済みケース。axis は有効な Axis、gate は boolean に確定。 */
interface Case {
  name: string;
  question: string;
  expect: Expect;
  axis?: Axis; // 省略時は無タグ（総合のみに数える）
  gate?: boolean; // 省略時は false
  monitor?: boolean; // 省略時は false。true=非ゲート（実行・採点・表示するが exit 母数から除外）
  fixtures?: string[]; // 省略時は本番 db を使用（従来挙動）。非空なら隔離索引に切り替える（buildFixtureDb が消費）
}

interface Call {
  name: string;
  input: unknown;
  output: string;
}

// ツールを包んで呼び出しトレースを記録する（本番コードは無改変のまま引数まで採点できる）。
function recordTool(tool: AgentTool, calls: Call[]): AgentTool {
  return {
    def: tool.def,
    async run(input) {
      const output = await tool.run(input);
      calls.push({ name: tool.def.name, input, output });
      return output;
    },
  };
}

const GH_TOOLS = new Set(["list_repo_tree", "read_repo_file", "search_repo_code"]);

export function evalCase(expect: Expect, calls: Call[], answer: string): string[] {
  const fails: string[] = [];
  const used = new Set(calls.map((c) => c.name));

  if (expect.toolsUsedAny && !expect.toolsUsedAny.some((t) => used.has(t))) {
    fails.push(`toolsUsedAny ${JSON.stringify(expect.toolsUsedAny)} のどれも使われなかった（使用: ${[...used].join(",") || "なし"}）`);
  }
  for (const t of expect.toolsUsedAll ?? []) {
    if (!used.has(t)) fails.push(`必須ツール ${t} が使われなかった`);
  }

  if (expect.source && expect.source !== "any") {
    const usedDocs = used.has("search_knowledge");
    const usedCode = [...used].some((t) => GH_TOOLS.has(t));
    // docs は「コードに行かず docs/前置きで答えた」で判定する。core.ts が FTS 上位を初期コンテキストに
    // 前置きするため、docs で足りる質問は search_knowledge を呼ばず答えうる＝ツール使用での判定は誤検知になる。
    const ok =
      expect.source === "docs" ? !usedCode
      : expect.source === "code" ? usedCode
      : /* both */ usedDocs && usedCode;
    if (!ok) fails.push(`source 期待=${expect.source} だが docs(検索)=${usedDocs} code=${usedCode}`);
  }

  if (expect.argIncludes) {
    const hit = calls.some((c) => JSON.stringify(c.input ?? "").includes(expect.argIncludes!));
    if (!hit) fails.push(`どのツール引数にも "${expect.argIncludes}" が現れなかった（subdir/path 絞り込み未使用）`);
  }

  if (expect.readPathIncludes) {
    const hit = calls.some(
      (c) => c.name === "read_repo_file" && String((c.input as { path?: string })?.path ?? "").includes(expect.readPathIncludes!),
    );
    if (!hit) fails.push(`read_repo_file で "${expect.readPathIncludes}" を含む path を読まなかった`);
  }

  for (const s of expect.answerIncludes ?? []) {
    if (!answer.includes(s)) fails.push(`回答に "${s}" が含まれない`);
  }
  for (const s of expect.answerOmits ?? []) {
    if (answer.includes(s)) fails.push(`回答に含まれてはいけない "${s}" が出た`);
  }

  // 出典体裁の採点を末尾に統合（citesSource 未指定なら空配列＝既存判定は不変, Req 1.1/4.3）。
  fails.push(...citationFails(expect, answer));
  // 「次の一歩」の採点を末尾に統合（offersNextStep 未指定なら空配列＝既存判定は不変, Req 2.1/4.1）。
  fails.push(...nextStepFails(expect, answer));

  return fails;
}

/**
 * 読込直後の生ケース列を検証し、不正な評価軸／ゲート指定のエラー文（日本語）を配列で返す。
 * 副作用なし・入力不変。戻り値が空配列なら呼び出し側は安全に Case[] へ narrow できる。
 * 検証を AXES への narrow より前に置くことで、不正値が黙って集計へ流れ込むのを防ぐ（Req 1.4）。
 */
export function validateCases(cases: RawCase[]): string[] {
  const errors: string[] = [];
  for (const c of cases) {
    // axis は省略可。指定された場合のみ許容集合への所属を検査する。
    if (c.axis !== undefined && !(AXES as readonly string[]).includes(c.axis)) {
      errors.push(`ケース "${c.name}": 不正な評価軸 "${c.axis}"（許容: ${AXES.join("|")}）`);
    }
    // gate は省略時 false 扱い。指定された場合は真偽値であること（防御的・最小）。
    if (c.gate !== undefined && typeof c.gate !== "boolean") {
      errors.push(`ケース "${c.name}": gate は真偽値である必要があります（受領: ${JSON.stringify(c.gate)}）`);
    }
    // monitor は省略時 false 扱い。指定された場合は真偽値であること（gate と同型）。
    if (c.monitor !== undefined && typeof c.monitor !== "boolean") {
      errors.push(`ケース "${c.name}": monitor は真偽値である必要があります（受領: ${JSON.stringify(c.monitor)}）`);
    }
    // fixtures は省略可。指定された場合は「文字列の配列」であること（防御的・最小、実在検査は実行ループ側）。
    if (
      c.fixtures !== undefined &&
      !(Array.isArray(c.fixtures) && c.fixtures.every((f) => typeof f === "string"))
    ) {
      errors.push(`ケース "${c.name}": fixtures は文字列の配列である必要があります（受領: ${JSON.stringify(c.fixtures)}）`);
    }
  }
  return errors;
}

/** ケース実行の結果ステータス。SKIP は合否・集計から除外される。 */
export type CaseStatus = "PASS" | "FAIL" | "SKIP" | "ERROR";

/** 1 ケースの評価結果。実行ループが各ケースにつき 1 件構築する。 */
export interface CaseResult {
  name: string;
  axis?: Axis; // 省略時は無タグ（総合のみに数える）
  gate: boolean; // ゲートケースか（省略時 false 相当）
  monitor?: boolean; // 非ゲート（省略時 false）。true=exit 母数外の情報表示
  status: CaseStatus;
  fails: string[]; // FAIL の内訳（PASS/SKIP/ERROR は空でよい）
}

/** 1 評価軸の集計（pass/total は評価済み＝非 SKIP のみ）。 */
export interface AxisTally {
  axis: Axis;
  pass: number;
  total: number;
}

/** 結果列から一意に導かれる派生状態（永続化なし）。 */
export interface Scorecard {
  perAxis: AxisTally[]; // 出現した軸のみ・SKIP を除外して集計
  gate: { failed: string[]; total: number }; // 評価済みゲートのうち FAIL/ERROR の名前と母数
  monitor: { pass: number; total: number; failed: string[] }; // 非ゲート（exit 対象外）・情報表示
  total: { pass: number; evaluated: number; skipped: number };
}

/**
 * 結果列からスコアカードを集計する純粋関数。
 * - 評価済み（非 SKIP）のみを軸別 pass/total・ゲート・total.evaluated に数える（Req 5.2/5.3）。
 * - 無タグ（axis 未指定）は軸別に含めず総合（evaluated/pass）のみに数える（Req 1.3）。
 * - axis と gate は直交。両方を持つケースは軸別 tally とゲート母数の双方に計上する。
 * - ゲートの失敗一覧は評価済みゲートのうち FAIL/ERROR のケース名（Req 2.1/2.3）。
 * 副作用なし・入力不変（Invariant）。
 */
export function buildScorecard(results: CaseResult[]): Scorecard {
  const axisOrder: Axis[] = [];
  const tallyByAxis = new Map<Axis, AxisTally>();
  const gateFailed: string[] = [];
  let gateTotal = 0;
  const monitorFailed: string[] = [];
  let monitorPass = 0;
  let monitorTotal = 0;
  let pass = 0;
  let evaluated = 0;
  let skipped = 0;

  for (const r of results) {
    // SKIP は軸別・ゲート・evaluated のいずれにも数えない（Req 5.2/5.3）。
    if (r.status === "SKIP") {
      skipped++;
      continue;
    }

    // monitor（非ゲート）は別 tally にのみ計上し、evaluated/pass/perAxis/gate のいずれにも数えない。
    // これで overallPassed（total と gate だけを見る）は monitor を自動的に無視する（非ゲート化）。
    if (r.monitor) {
      monitorTotal++;
      if (r.status === "PASS") monitorPass++;
      else monitorFailed.push(r.name);
      continue;
    }

    evaluated++;
    const isPass = r.status === "PASS";
    if (isPass) pass++;

    // 軸別 tally（無タグは含めない、Req 1.3）。出現順を保ちつつ集計する。
    if (r.axis !== undefined) {
      let tally = tallyByAxis.get(r.axis);
      if (tally === undefined) {
        tally = { axis: r.axis, pass: 0, total: 0 };
        tallyByAxis.set(r.axis, tally);
        axisOrder.push(r.axis);
      }
      tally.total++;
      if (isPass) tally.pass++;
    }

    // ゲート母数（axis と直交）。FAIL/ERROR は失敗一覧へ（Req 2.1/2.3）。
    if (r.gate) {
      gateTotal++;
      if (r.status === "FAIL" || r.status === "ERROR") gateFailed.push(r.name);
    }
  }

  const perAxis = axisOrder.map((axis) => {
    const tally = tallyByAxis.get(axis);
    // axisOrder に積んだ軸は必ず存在するが、noUncheckedIndexedAccess 下で安全に扱う。
    return tally ?? { axis, pass: 0, total: 0 };
  });

  return {
    perAxis,
    gate: { failed: gateFailed, total: gateTotal },
    monitor: { pass: monitorPass, total: monitorTotal, failed: monitorFailed },
    total: { pass, evaluated, skipped },
  };
}

/**
 * ライブ eval の exit 判定。true=合格。
 *
 * 設計方針（レポート専用）: ライブ eval は単発の LLM 実行を自由文で採点するため本質的に
 * 非決定で、scored ケースの pass/fail を run ごとのハード合否にすると必ずどこかが揺れて赤になる。
 * よって exit は **安全ゲート（`gate:true`＝インジェクション/秘密漏洩の拒否）だけ** で判定する。
 * ルーティング・事実・出典・次の一歩・ドリフト等の scored/monitor は **情報表示** であり exit を
 * 左右しない。回帰を止める決定的ゲートは `bun test`（非 LLM の純粋関数検証）側にある。
 * SKIP は元々 `gate` に数えないため影響しない。副作用なし。
 */
export function overallPassed(sc: Scorecard): boolean {
  return sc.gate.failed.length === 0;
}

/**
 * スコアカードを末尾表示用の文字列に整形する純粋関数。
 * 軸別行（各 perAxis の pass/total）＋ゲート行（失敗の有無/件数・失敗ケース名）＋
 * 総合行（評価済み基準で総合 PASS 数と SKIP 数を明示）を含む（Req 3.1/3.2/3.3）。
 * 総合行は既存の総合 PASS 数（`sc.total.pass`）を保持する（Req 3.3）。副作用なし。
 */
export function formatScorecard(sc: Scorecard): string {
  const lines: string[] = ["=== スコアカード ==="];

  // 軸別行: 出現した軸のみ（無タグは含めない）。
  if (sc.perAxis.length > 0) {
    for (const t of sc.perAxis) {
      lines.push(`  軸 ${t.axis}: ${t.pass}/${t.total} PASS`);
    }
  } else {
    lines.push("  軸: （タグ付けケースなし）");
  }

  // ゲート行: スコア軸の FAIL と区別できる形で、失敗の有無/件数・失敗ケース名を示す。
  if (sc.gate.total === 0) {
    lines.push("  ゲート: なし");
  } else if (sc.gate.failed.length === 0) {
    lines.push(`  ゲート: 全 PASS（母数 ${sc.gate.total}）`);
  } else {
    lines.push(`  ゲート: FAIL ${sc.gate.failed.length} 件（${sc.gate.failed.join(", ")}）/ 母数 ${sc.gate.total}`);
  }

  // モニタ行（非ゲート・情報表示）: exit を左右しないが傾向として並走表示する。
  if (sc.monitor.total > 0) {
    const tail = sc.monitor.failed.length > 0 ? `（FAIL: ${sc.monitor.failed.join(", ")}）` : "";
    lines.push(`  モニタ（非ゲート）: ${sc.monitor.pass}/${sc.monitor.total} PASS${tail}`);
  }

  // 総合行（参考）: 評価済み基準の PASS 数。ライブ eval はレポート専用で、この数は exit を左右しない
  // （exit は安全ゲートのみで判定＝overallPassed）。決定的な回帰ゲートは bun test 側。
  lines.push(`  総合（参考）${sc.total.pass}/${sc.total.evaluated} PASS, ${sc.total.skipped} SKIP`);
  lines.push("  ※ exit は安全ゲートのみで判定（scored/monitor は情報表示）。回帰ゲートは bun test。");

  return lines.join("\n");
}

/**
 * 逐次行の先頭ラベルを返す純粋関数。ゲートケースの失敗（FAIL/ERROR）には印（`*`）を付け、
 * スコア軸の FAIL とひと目で区別できるようにする（Req 2.3）。PASS/SKIP は失敗ではないため印を付けない。
 * 副作用なし・入力不変。
 */
export function statusLabel(status: CaseStatus, gate: boolean): string {
  if (gate && (status === "FAIL" || status === "ERROR")) return `${status}*`;
  return status;
}

/**
 * フィクスチャ Markdown 群を本番 KB と分離した in-memory FTS 索引に組み立てて返す（Req 2.1/2.2/2.4）。
 * - `openDb(":memory:")` で空の隔離索引を作る。本番 `dbPath()`/`./kb.sqlite` は一切開かず・変更しない（2.2）。
 * - 各 `fixturePath` は `join(baseDir, fixturePath)` で解決する。基準は呼び出し側が渡す `baseDir`（＝ケース
 *   定義ファイルのディレクトリ）に固定し、実行時の `process.cwd()` に依存しない（設計レビュー Issue 2）。
 * - 解決先が存在しなければ原因パスを添えて即エラー（fail-fast, Error Handling）。
 * - 索引は既存部品（`chunkMarkdown` → `replaceDoc`）を再利用。`docKey` はフィクスチャの相対パス。
 * - 返す db は呼び出し側が `close()` する（ここでは閉じない）。副作用は baseDir 配下の読み取りと in-memory 構築のみ。
 */
export function buildFixtureDb(fixturePaths: string[], baseDir: string): Database {
  const db = openDb(":memory:");
  for (const fixturePath of fixturePaths) {
    const resolved = join(baseDir, fixturePath);
    if (!existsSync(resolved)) {
      db.close();
      throw new Error(`フィクスチャが見つかりません: ${resolved}`);
    }
    const md = readFileSync(resolved, "utf8");
    replaceDoc(db, fixturePath, chunkMarkdown(md));
  }
  return db;
}

// --- main ---
// 実 LLM/GitHub に触れる副作用はすべてこの main() 内に閉じ、直接実行時のみ走らせる。
// これにより test 等が本モジュールを import しても LLM/GitHub 呼び出しは発生しない。
async function main() {
  const casesPath = process.argv[2] ?? "./eval/cases.json";
  let raw: RawCase[];
  try {
    raw = JSON.parse(readFileSync(casesPath, "utf8")) as RawCase[];
  } catch (e) {
    console.error(`ケース読込に失敗: ${casesPath} (${(e as Error).message})`);
    console.error("例は eval/cases.sample.json を参照してください。");
    process.exit(1);
  }

  // 集計へ流す前に軸/ゲートを検証する。不正があれば内容を出力して非ゼロ終了（黙って集計しない、Req 1.4）。
  const validationErrors = validateCases(raw);
  if (validationErrors.length > 0) {
    console.error("ケース定義に不正があります:");
    for (const err of validationErrors) console.error(`  - ${err}`);
    process.exit(1);
  }
  // 検証成功後に Case[] へ narrow（validateCases 通過＝axis は有効値・gate は真偽値）。
  const cases = raw as Case[];

  const { provider, model, modelHard } = createLlm();
  const canEscalate = !!modelHard && modelHard !== model;
  const db = openDb(dbPath());
  const github = loadGitHub();
  console.log(
    `eval: provider=${provider.name} model=${model} modelHard=${modelHard ?? "-"} github=${github ? github.repos.join(",") : "off"} / ${cases.length} ケース\n`,
  );

  // フィクスチャの基準ディレクトリはケース定義ファイルの位置に固定する（cwd 非依存, Req 2.3）。
  const fixturesBaseDir = join(dirname(casesPath), "fixtures");

  const results: CaseResult[] = [];
  const startedAt = Date.now();

  for (const c of cases) {
    const gate = c.gate ?? false;
    const monitor = c.monitor ?? false;
    const tag = monitor ? " (monitor)" : "";
    // GitHub ツールを期待するケースは GitHub 未設定ならスキップ（誤った FAIL を避ける）。
    const needsGh =
      c.expect.source === "code" ||
      c.expect.source === "both" ||
      (c.expect.toolsUsedAny ?? []).some((t) => GH_TOOLS.has(t)) ||
      (c.expect.toolsUsedAll ?? []).some((t) => GH_TOOLS.has(t)) ||
      !!c.expect.readPathIncludes;
    if (needsGh && !github) {
      console.log(`${statusLabel("SKIP", gate)}  ${c.name}${tag} … GitHub 未設定（KB_GITHUB_REPOS）`);
      results.push({ name: c.name, axis: c.axis, gate, monitor, status: "SKIP", fails: [] });
      continue;
    }

    // SKIP 判定後にこのケースの検索源 db を選ぶ。fixtures ありは隔離 in-memory 索引、無しは本番共有 db（Req 2.1/5.1）。
    // 隔離索引の構築は SKIP 判定の後に置く（無駄な構築を避ける, Req 3.1）。
    const caseDb = c.fixtures && c.fixtures.length > 0 ? buildFixtureDb(c.fixtures, fixturesBaseDir) : db;

    try {
      const calls: Call[] = [];
      const tools: AgentTool[] = [
        recordTool(searchKnowledgeTool(caseDb), calls),
        ...(github ? githubTools(github).map((t) => recordTool(t, calls)) : []),
      ];

      // 本番と同じ初期コンテキスト（FTS 上位）＋system を組み立てる。fixtures ありなら stale doc が前置きされる。
      const hits = search(caseDb, c.question, TOP_K);
      const initialPrompt = `# 初期コンテキスト（FTS検索の上位${hits.length}件）\n\n${formatHits(hits)}\n\n# 質問\n${c.question}`;
      const messages: LlmMessage[] = [{ role: "user", content: initialPrompt }];

      try {
        // 本番と同じ基準で事前昇格を判定し、本番と同じ orchestration（runWithEscalation）で走らせる。
        // これで eval が escalation を通り production を代表する（KB_MODEL_HARD 未設定なら基本モデルのみ）。
        const startHard = canEscalate && !!github && !isSubstantiveTopHit(c.question, hits);
        const { result, modelUsed, escalated } = await runWithEscalation({
          provider,
          model,
          modelHard,
          system: buildSystem(github),
          messages,
          tools,
          maxTurns: github ? 8 : 5,
          startHard,
        });
        const fails = evalCase(c.expect, calls, result.text);
        const trace = calls.map((c) => c.name).join(" → ") || "（ツール未使用）";
        const tier = escalated ? `↑${modelUsed}` : modelUsed;
        const status: CaseStatus = fails.length === 0 ? "PASS" : "FAIL";
        console.log(`${statusLabel(status, gate)}  ${c.name}${tag}  [${tier}] [${trace}]`);
        for (const f of fails) console.log(`        - ${f}`);
        results.push({ name: c.name, axis: c.axis, gate, monitor, status, fails });
      } catch (e) {
        const message = (e as Error).message;
        console.log(`${statusLabel("ERROR", gate)} ${c.name}${tag}: ${message}`);
        results.push({ name: c.name, axis: c.axis, gate, monitor, status: "ERROR", fails: [message] });
      }
    } finally {
      // 隔離索引はケース終了時に確実に破棄する。本番共有 db は他ケースが使うため閉じない（Error Handling）。
      if (caseDb !== db) caseDb.close();
    }
  }

  const sc = buildScorecard(results);
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  // 末尾にスコアカードを追加表示（評価済み基準の総合行を含む、Req 3.1/3.3）。
  console.log(`\n${formatScorecard(sc)}`);
  console.log(`（所要 ${secs}s）`);
  // 終了コードは評価済み全 PASS かつゲート失敗なしのみ 0（SKIP を分母に含めない、Req 2.2/2.4/5.2）。
  process.exit(overallPassed(sc) ? 0 : 1);
}

if (import.meta.main) await main();
