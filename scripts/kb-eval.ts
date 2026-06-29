#!/usr/bin/env bun
// ルーティング（docs vs code）とモノレポ深掘りが「実際に効いているか」を測る eval。
// 単体テストと違い、実 LLM＋実 GitHub に対して走らせる（＝ネットワーク・課金あり）。
//   bun run scripts/kb-eval.ts [ケースJSON]   (既定: ./eval/cases.json)
//
// 各ケースで本番と同じ前処理（FTS 前置き＋buildSystem＋ツール群）を組み立て、ツールを
// ラップして「どのツールを・どんな引数で呼んだか」を記録し、expect と突き合わせて採点する。
// 期待は「指定された項目だけ」検査する（未指定は不問）。全項目 PASS でケース合格。
import { readFileSync } from "node:fs";
import { createLlm } from "../src/llm/factory.ts";
import { dbPath } from "../src/config.ts";
import { openDb, search } from "../src/kb/db.ts";
import { loadGitHub } from "../src/github.ts";
import { runAgent, type AgentTool } from "../src/agent/agent.ts";
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
}

/** 検証済みケース。axis は有効な Axis、gate は boolean に確定。 */
interface Case {
  name: string;
  question: string;
  expect: Expect;
  axis?: Axis; // 省略時は無タグ（総合のみに数える）
  gate?: boolean; // 省略時は false
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

function evalCase(expect: Expect, calls: Call[], answer: string): string[] {
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
  }
  return errors;
}

// --- main ---
// 実 LLM/GitHub に触れる副作用はすべてこの main() 内に閉じ、直接実行時のみ走らせる。
// これにより test 等が本モジュールを import しても LLM/GitHub 呼び出しは発生しない。
async function main() {
  const casesPath = process.argv[2] ?? "./eval/cases.json";
  let cases: Case[];
  try {
    cases = JSON.parse(readFileSync(casesPath, "utf8")) as Case[];
  } catch (e) {
    console.error(`ケース読込に失敗: ${casesPath} (${(e as Error).message})`);
    console.error("例は eval/cases.sample.json を参照してください。");
    process.exit(1);
  }

  const { provider, model } = createLlm();
  const db = openDb(dbPath());
  const github = loadGitHub();
  console.log(
    `eval: provider=${provider.name} model=${model} github=${github ? github.repos.join(",") : "off"} / ${cases.length} ケース\n`,
  );

  let passed = 0;
  const startedAt = Date.now();

  for (const c of cases) {
    // GitHub ツールを期待するケースは GitHub 未設定ならスキップ（誤った FAIL を避ける）。
    const needsGh =
      c.expect.source === "code" ||
      c.expect.source === "both" ||
      (c.expect.toolsUsedAny ?? []).some((t) => GH_TOOLS.has(t)) ||
      (c.expect.toolsUsedAll ?? []).some((t) => GH_TOOLS.has(t)) ||
      !!c.expect.readPathIncludes;
    if (needsGh && !github) {
      console.log(`SKIP  ${c.name} … GitHub 未設定（KB_GITHUB_REPOS）`);
      continue;
    }

    const calls: Call[] = [];
    const tools: AgentTool[] = [
      recordTool(searchKnowledgeTool(db), calls),
      ...(github ? githubTools(github).map((t) => recordTool(t, calls)) : []),
    ];

    // 本番と同じ初期コンテキスト（FTS 上位）＋system を組み立てる。
    const hits = search(db, c.question, TOP_K);
    const initialPrompt = `# 初期コンテキスト（FTS検索の上位${hits.length}件）\n\n${formatHits(hits)}\n\n# 質問\n${c.question}`;
    const messages: LlmMessage[] = [{ role: "user", content: initialPrompt }];

    try {
      const result = await runAgent({
        provider,
        model,
        system: buildSystem(github),
        messages,
        tools,
        maxTurns: github ? 8 : 5,
      });
      const fails = evalCase(c.expect, calls, result.text);
      const trace = calls.map((c) => c.name).join(" → ") || "（ツール未使用）";
      if (fails.length === 0) {
        passed++;
        console.log(`PASS  ${c.name}  [${trace}]`);
      } else {
        console.log(`FAIL  ${c.name}  [${trace}]`);
        for (const f of fails) console.log(`        - ${f}`);
      }
    } catch (e) {
      console.log(`ERROR ${c.name}: ${(e as Error).message}`);
    }
  }

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== ${passed}/${cases.length} PASS (${secs}s) ===`);
  process.exit(passed === cases.length ? 0 : 1);
}

if (import.meta.main) await main();
