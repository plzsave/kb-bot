#!/usr/bin/env bun
// GitHub closed issue → 正規化 Markdown を R2/S3 に配置するバッチ。
// 配置後は `bun run kb:ingest` で FTS に取り込む（自動連結はしない）。
//   bun run scripts/issue-to-kb.ts [--repos a,b] [--since ISO] [--dry-run] [--model X] [--max-issues N]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadS3Config, loadIssueConfig } from "../src/config.ts";
import { S3Client } from "../src/s3.ts";
import { listClosedIssues, fetchComments } from "../src/issues.ts";
import {
  shouldInclude,
  buildUserPrompt,
  parseSummary,
  assembleMarkdown,
  issueDocKey,
  staleDocKey,
  SUMMARY_SYSTEM,
} from "../src/kb/issueDoc.ts";

// --- 引数パース ---
function parseArgs(argv: string[]) {
  const a: { repos?: string[]; since?: string; dryRun: boolean; model?: string; maxIssues?: number } = {
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--dry-run") a.dryRun = true;
    else if (v === "--repos") a.repos = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "--since") a.since = argv[++i];
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--max-issues") a.maxIssues = Number(argv[++i]);
  }
  return a;
}

// --- state（per-issue updated_at。再要約スキップ＋since カーソルに使う）---
type State = Record<string, Record<string, string>>; // repo -> { issueNumber: updated_at }
const STATE_FILE = process.env.KB_ISSUE_STATE_FILE ?? "./data/issue-kb-state.json";

function loadState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}
function saveState(s: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
// 記録済み issue の updated_at 最大値を since カーソルにする（増分取得）。
function cursorFor(repoState: Record<string, string> | undefined): string | undefined {
  const vals = Object.values(repoState ?? {});
  return vals.length ? vals.reduce((a, b) => (a > b ? a : b)) : undefined;
}

// --- main ---
const args = parseArgs(process.argv.slice(2));
const cfg = loadIssueConfig(args.repos);
const s3cfg = loadS3Config();
const s3 = new S3Client(s3cfg);
const model = args.model ?? cfg.model;
const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
const state = loadState();

let written = 0;
let filtered = 0;
let skippedUnchanged = 0;
let skippedStale = 0;
let failed = 0;
let budget = args.maxIssues ?? Infinity;

for (const repo of cfg.repos) {
  if (budget <= 0) break;
  const since = args.since ?? cursorFor(state[repo]);
  console.log(`\n=== ${repo} ===（since=${since ?? "全件"}）`);
  const issues = await listClosedIssues(repo, cfg.githubToken, { since, log: (m) => console.log(m) });
  console.log(`closed issue: ${issues.length} 件`);
  state[repo] ??= {};

  for (const issue of issues) {
    if (budget <= 0) break;
    if (!shouldInclude(issue, cfg.minComments)) {
      filtered++;
      continue;
    }
    if (state[repo]![String(issue.number)] === issue.updated_at) {
      skippedUnchanged++;
      continue;
    }
    // tombstone: 隔離済み（_stale）なら復活させない
    if (!args.dryRun && (await s3.exists(staleDocKey(s3cfg.prefix, repo, issue.number)))) {
      skippedStale++;
      console.log(`  ⏭️  #${issue.number} は隔離済み（_stale）。スキップ`);
      continue;
    }

    budget--;
    try {
      const comments = await fetchComments(repo, issue.number, cfg.githubToken, (m) => console.log(m));
      const prompt = buildUserPrompt({ issue, comments });
      const msg = await client.messages.create({
        model,
        max_tokens: 1500,
        temperature: 0,
        system: SUMMARY_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const { body, relatedFiles } = parseSummary(text);
      const md = assembleMarkdown({ issue, repo, body, relatedFiles });
      const key = issueDocKey(s3cfg.prefix, repo, issue.number);

      if (args.dryRun) {
        console.log(`\n----- ${key} -----\n${md}`);
      } else {
        await s3.put(key, md);
        console.log(`  ✓ #${issue.number} → ${key}`);
      }
      state[repo]![String(issue.number)] = issue.updated_at; // 成功時のみ記録
      written++;
    } catch (e) {
      failed++;
      console.error(`  ✗ #${issue.number}: ${(e as Error).message}`);
      // state は更新しない＝次回リトライ対象に残す
    }
  }
}

if (!args.dryRun) saveState(state);

console.log("\n=== 完了 ===");
console.log(
  `生成 ${written} / フィルタ除外 ${filtered} / 未変更スキップ ${skippedUnchanged} / ` +
    `隔離スキップ ${skippedStale} / 失敗 ${failed}`,
);
if (args.dryRun) console.log("（--dry-run のため R2 へは未配置・state も未更新）");
else if (written > 0) console.log("→ `bun run kb:ingest` を実行して FTS に取り込んでください。");
