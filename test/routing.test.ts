import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, replaceDoc, search } from "../src/kb/db.ts";
import { chunkMarkdown } from "../src/kb/chunk.ts";

// 検索ルーティングの「決定的ゲート」（層1）。
//
// なぜこのファイルがあるか:
//   kb-bot の行き止まり（「見つかりませんでした」で止まる回答劣化）の根本原因は、
//   関連ドキュメントが FTS 上位に来ず初期コンテキストに前置きされないこと。#45 で
//   検索関連度の判定（isSubstantiveTopHit）を撤去した今、行き止まり対策の土台は
//   「検索が当たること」そのものに一本化されている。
//
//   ライブ eval（kb:eval）は LLM 生成を採点するため非決定でゲートにできない（#43）。
//   一方で「正しい doc/コード箇所が上位に来るか」は search() で完全に決定的に測れる。
//   ＝ライブ LLM を通さず、固定コーパスに対する検索順位だけを検証する回帰ゲート。
//   segmenter / BM25 / dropWeakHits が劣化して関連文書が沈めば、ここが赤くなる。
//
//   コーパスは本番の代表 doc（auth/deploy/github-app）＋無関係な妨害 doc（billing/
//   onboarding）で構成する。妨害 doc を混ぜることで「何か返す」ではなく「正しい doc が
//   妨害を退けて最上位に来る」＝判別できていることを保証する。

function memDb(): Database {
  return openDb(":memory:");
}

// 本番 KB の代表的な doc を模した固定コーパス。ルーティングの期待順位はこの内容に対して定義する。
// 内容を変えたらルーティング期待も見直すこと（回答本文の網羅ではなく「どの doc が当たるか」を守る）。
const CORPUS: Record<string, string> = {
  "auth.md": `# 認証と権限

## API トークン
API トークンはユーザ設定画面から発行します。トークンの有効期限は既定で 90 日です。期限切れ後は再発行が必要です。

## 権限レベル
権限レベルには 閲覧者 / 編集者 / 管理者 の 3 種類があります。閲覧者は参照のみ、編集者は変更可能、管理者は全操作が可能です。

## ログイン
ログインは Google OIDC を利用します。`,
  "deploy.md": `# デプロイ運用

## 本番環境
本番は ECS Fargate 上で稼働します。デプロイは CI から自動で行われます。

## ロールバック
ロールバックは以前のタスク定義のリビジョンを指定して行います。マネジメントコンソールから対象リビジョンを選び直します。`,
  "github-app.md": `# GitHub App 運用

## AI レビュー
プルリクエストには AI が自動レビューコメントを付けます。

## レビューのスキップ
緊急時は skip-review ラベルを付与すると AI レビューをスキップできます。`,
  // --- 以下は妨害 doc（判別できていることを示すために必須。安易に消さないこと） ---
  "billing.md": `# 課金とコスト

## 料金プラン
月額プランと従量課金プランがあります。コスト最適化のため未使用リソースは停止してください。`,
  "onboarding.md": `# 入社手続き

## アカウント発行
入社初日に各種アカウントを発行します。人事に連絡してください。`,
};

function buildCorpus(): Database {
  const db = memDb();
  for (const [key, md] of Object.entries(CORPUS)) replaceDoc(db, key, chunkMarkdown(md));
  return db;
}

// ルーティング期待表: 質問 → 最上位に来るべき doc。cases.json の docs ルーティング期待を
// ライブ LLM を通さず決定的に検証する版（ここが層1の中身）。
const ROUTING: { name: string; question: string; expectTop: string }[] = [
  { name: "API トークンの有効期限 → auth.md", question: "API トークンの有効期限は何日ですか？", expectTop: "auth.md" },
  { name: "権限レベルの種類 → auth.md", question: "権限レベルにはどんな種類がありますか？", expectTop: "auth.md" },
  {
    name: "デプロイのロールバック → deploy.md",
    question: "デプロイのロールバックはどうやりますか？",
    expectTop: "deploy.md",
  },
  {
    name: "AI レビューのスキップ → github-app.md",
    question: "緊急時に AI レビューをスキップする方法は？",
    expectTop: "github-app.md",
  },
];

for (const c of ROUTING) {
  test(`ルーティング: ${c.name}`, () => {
    const db = buildCorpus();
    const hits = search(db, c.question, 5);
    expect(hits.length).toBeGreaterThan(0);
    // 最上位 doc が期待通り＝関連文書が妨害 doc を退けて初期コンテキストの先頭に来る。
    expect(hits[0]!.docKey).toBe(c.expectTop);
  });
}

test("コーパスに妨害 doc が含まれている（判別性を保証する構造ガード）", () => {
  // 妨害 doc を消すとルーティング検証が「何か1件返るだけ」に劣化する。存在を明示的に守る。
  expect(Object.keys(CORPUS)).toContain("billing.md");
  expect(Object.keys(CORPUS)).toContain("onboarding.md");
});

test("無関係な質問では妨害 doc が正解 doc を上回らない（誤ルーティングの検出）", () => {
  const db = buildCorpus();
  // 課金の質問には billing.md が最上位（正解 doc が妨害に負けていないことの対称確認）。
  const hits = search(db, "料金プランとコスト最適化について", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.docKey).toBe("billing.md");
});
