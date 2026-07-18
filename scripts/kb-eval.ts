#!/usr/bin/env bun
// ルーティング（docs vs code）とモノレポ深掘りが「実際に効いているか」を測る eval。
// 単体テストと違い、実 LLM＋実 GitHub に対して走らせる（＝ネットワーク・課金あり）。
//   bun run scripts/kb-eval.ts [ケースJSON]   (既定: ./eval/cases.json)
//
// 各ケースで本番と同じ前処理（FTS 前置き＋buildSystem＋ツール群）を組み立て、ツールを
// ラップして「どのツールを・どんな引数で呼んだか」を記録し、expect と突き合わせて採点する。
// 期待は「指定された項目だけ」検査する（未指定は不問）。全項目 PASS でケース合格。
//
// 採点・集計のロジック本体は src/eval/（score / scorecard / aggregate / fixtures）にあり、
// このスクリプトは引数処理と実行ループ（LLM/GitHub への副作用）に徹する（structure.md の規約）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLlm } from "../src/llm/factory.ts";
import { dbPath } from "../src/config.ts";
import { openDb, search } from "../src/kb/db.ts";
import { loadGitHub } from "../src/github.ts";
import { loadGitHubTokenSource } from "../src/github-app-auth.ts";
import { type AgentTool } from "../src/agent/agent.ts";
import { runWithEscalation } from "../src/agent/escalation.ts";
import { searchKnowledgeTool } from "../src/agent/tools.ts";
import { githubTools } from "../src/agent/githubTools.ts";
import { buildSystem, buildInitialPrompt } from "../src/chat/core.ts";
import type { LlmMessage } from "../src/llm/provider.ts";
import { evalCase, validateCases, GH_TOOLS, type Call, type Case, type RawCase } from "../src/eval/score.ts";
import {
  buildScorecard,
  formatScorecard,
  overallPassed,
  statusLabel,
  type CaseResult,
  type CaseStatus,
} from "../src/eval/scorecard.ts";
import {
  aggregateVerdict,
  caseSetFingerprint,
  evaluatedScoredNames,
  exitPassed,
  formatAggregate,
  parseBaseline,
  type Baseline,
} from "../src/eval/aggregate.ts";
import { buildFixtureDb } from "../src/eval/fixtures.ts";

const TOP_K = 5; // 本番（core.ts）と同じく初期コンテキストに前置きする FTS 件数

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

// FAIL ケースの実体（回答本文・ツール呼び出し）を残す。採点理由 1 行だけでは「なぜ落ちたか」を
// 調査できない観測性ギャップ（2026-07-03 の drift 分析で実害）への対処。run 開始時に前回分を消す。
const FAIL_DUMP_DIR = "./eval/last-run";
function dumpFailCase(
  name: string,
  question: string,
  tier: string,
  calls: Call[],
  fails: string[],
  answer: string,
): void {
  try {
    mkdirSync(FAIL_DUMP_DIR, { recursive: true });
    const slug = name.replace(/[^\w\u3040-\u30ff\u4e00-\u9fff-]+/g, "_").slice(0, 60);
    const callsTxt = calls
      .map((c) => `## ${c.name}\n入力: ${JSON.stringify(c.input)}\n出力(先頭500字): ${c.output.slice(0, 500)}`)
      .join("\n\n");
    writeFileSync(
      `${FAIL_DUMP_DIR}/${slug}.md`,
      `# ${name}\n\n- tier: ${tier}\n- 質問: ${question}\n\n## 採点 FAIL\n${fails.map((f) => `- ${f}`).join("\n")}\n\n## 回答本文\n${answer}\n\n## ツール呼び出し\n${callsTxt || "（なし）"}\n`,
    );
  } catch {
    /* dump 失敗で eval を止めない */
  }
}

// --- main ---
// 実 LLM/GitHub に触れる副作用はすべてこの main() 内に閉じ、直接実行時のみ走らせる。
async function main() {
  // フラグと位置引数を分離（--update-baseline は今回の結果を新基準として記録する）。
  const args = process.argv.slice(2);
  const updateBaseline = args.includes("--update-baseline");
  const casesPath = args.find((a) => !a.startsWith("--")) ?? "./eval/cases.json";
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
  const db = openDb(dbPath());
  const github = loadGitHub(db);
  rmSync(FAIL_DUMP_DIR, { recursive: true, force: true }); // 前回 run の FAIL dump を掃除
  // レート残量ガード: 枯渇状態で走らせると検索が静かに崩れスコアがノイズ化する（2026-07-03 に誤診の実害）。
  if (github) {
    try {
      const token = await loadGitHubTokenSource()?.();
      const res = await fetch("https://api.github.com/rate_limit", {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const remaining = ((await res.json()) as { resources?: { core?: { remaining?: number } } }).resources?.core
        ?.remaining;
      if (remaining != null) {
        console.log(`GitHub core レート残量: ${remaining}`);
        if (remaining < 2000) {
          console.warn(
            "⚠ 残量が少なく、コード検索が途中で枯渇して結果がノイズ化する恐れがあります。リセット後の実行を推奨。",
          );
        }
      }
    } catch (e) {
      // 止めはしないが黙らない: ここでの認証失敗は「以降の検索が全滅する run」の予兆（ノイズ誤診の元）。
      console.warn(`⚠ レート残量確認に失敗（${(e as Error).message}）。GitHub 認証が壊れていると検索が全滅します`);
    }
  }
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
      const initialPrompt = buildInitialPrompt(hits, c.question, !!github);
      const messages: LlmMessage[] = [{ role: "user", content: initialPrompt }];

      try {
        // 本番と同じ orchestration（runWithEscalation）で走らせる＝eval が production を代表する。
        // 基本モデルで開始し、truncated 時のみ B経路で昇格（KB_MODEL_HARD 未設定なら基本モデルのみ）。
        const { result, modelUsed, escalated } = await runWithEscalation({
          provider,
          model,
          modelHard,
          system: buildSystem(github),
          messages,
          tools,
          maxTurns: github ? 8 : 5,
        });
        const fails = evalCase(c.expect, calls, result.text);
        const trace = calls.map((c) => c.name).join(" → ") || "（ツール未使用）";
        const tier = escalated ? `↑${modelUsed}` : modelUsed;
        const status: CaseStatus = fails.length === 0 ? "PASS" : "FAIL";
        if (status === "FAIL") dumpFailCase(c.name, c.question, tier, calls, fails, result.text);
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

  // 集約ゲート: baseline（ケース定義と同じディレクトリの baseline.json）と比較する。
  // band/minN は環境変数で較正可能（band はライブ 2 run の実測分散から決める）。
  // band 既定 0.10 は実測較正値: 60 ケースのライブ 2 run で per-case flip 10/60（17%）・
  // 合格率差 6.7pp を観測（2026-07-02）。10pp はその ~1.5 倍＝ノイズでの偽アラームを抑えつつ
  // 10pp 超の全体劣化（例: コード検索ツールの全損 ≈ -18pp）は捕まえる水準。
  const band = Number(process.env.KB_EVAL_BAND) > 0 ? Number(process.env.KB_EVAL_BAND) : 0.1;
  const minN = Number(process.env.KB_EVAL_MIN_N) > 0 ? Number(process.env.KB_EVAL_MIN_N) : 30;
  const baselinePath = join(dirname(casesPath), "baseline.json");
  let baseline: Baseline | null = null;
  if (existsSync(baselinePath)) {
    try {
      baseline = parseBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));
    } catch {
      baseline = null; // 壊れた baseline は「無い」扱い（情報表示に落ちる。黙って誤比較しない）
    }
  }
  const names = evaluatedScoredNames(results);
  const verdict = aggregateVerdict(sc, names, baseline, { band, minN });

  // 末尾にスコアカード＋集約行を表示。
  console.log(`\n${formatScorecard(sc)}`);
  console.log(formatAggregate(verdict, band));
  console.log(`（所要 ${secs}s）`);

  // --update-baseline: 今回の結果を新基準として記録（十分な N がある時のみ意味を持つ）。
  if (updateBaseline) {
    if (sc.total.evaluated === 0) {
      console.error("基準を記録できません（評価済みケースが 0 件）");
    } else {
      const next: Baseline = {
        passRate: sc.total.pass / sc.total.evaluated,
        evaluated: sc.total.evaluated,
        caseSetHash: caseSetFingerprint(names),
        recordedAt: new Date().toISOString(),
      };
      writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`基準を記録: ${baselinePath}（合格率 ${(next.passRate * 100).toFixed(1)}% / ${next.evaluated} 件）`);
    }
    // 基準更新 run は新基準の宣言なので、旧基準との集約比較では落とさない（安全ゲートのみ）。
    process.exit(overallPassed(sc) ? 0 : 1);
  }

  // 終了コード: 安全ゲート失敗なし かつ 集約が fail でないとき 0。
  process.exit(exitPassed(sc, verdict) ? 0 : 1);
}

if (import.meta.main) await main();
