# Requirements Document

## Introduction
kb-bot は「ドキュメントは古くなりうるが、コードは GitHub からライブで読むため常に最新。両者が食い違う場合はコードを優先する」ことを価値の核としており、`buildSystem`（`src/chat/core.ts` L36-39）は GitHub 有効時にこの「prefer the code」規則を bot へ指示している。しかし、この規則が実際に発火するか（＝古い doc と新しいコードが矛盾したとき bot がコードを根拠に正答するか）を評価ハーネスは一度も検証していない。既存の評価ケースはすべて doc かコードの一方が正しい前提で、docs 古 × コード新の「矛盾」を突くケースが無い。

本仕様は、矛盾シナリオ用の eval 専用フィクスチャ doc と、本番 KB から分離した提示手段を用意し、「doc は古い値 X を述べ、実コードは現在値 Y を持つ」矛盾ケースを評価ハーネスに追加する。これにより軸 B′（ドリフト耐性 = 開発・保守が継続するシステムでも正しくあり続ける）を客観採点の対象にし、回帰を検知可能にする。詳細な背景・アプローチ・コードアンカーは `brief.md`（Source: GitHub issue #30）を参照。

## Boundary Context
- **In scope**:
  - 矛盾シナリオ用フィクスチャ doc（古い値 X を述べる、eval 専用）
  - 矛盾状況を bot に提示する eval 専用の索引・提示手段（本番 KB と分離）
  - 矛盾ケースの評価ハーネスへの追加と、コードを正答に採れたかの採点
- **Out of scope**:
  - `buildSystem` のドリフト規則（prefer the code）そのものの文言変更・強化（本仕様では規則は「検証対象」であって改修対象ではない）
  - 本番コード `src/` の変更
  - doc 陳腐化の自動検出・自動退避（`kb-prune`）の改善
  - 出典体裁の検査そのもの（`eval-citation-check` / #29 が所有・`citesSource` 実装済み）
  - 軸タグ・合否ゲート・スコアカードの枠（`eval-scorecard` / #28 が所有・実装済み）
  - 意味的忠実性の LLM ジャッジ導入
- **Adjacent expectations**:
  - `eval-scorecard`（#28）が提供する SKIP の集計除外・軸別集計・合否ゲートの挙動に依存し、それらを変更しない
  - `eval-citation-check`（#29）の `readPathIncludes` / `citesSource` と併用しうるが、出典検査の所有は分離したままにする
  - `buildSystem` の「コード優先」規則は検証対象であり、GitHub 有効時のみ bot に付与される前提（GitHub 未設定時は規則自体が付与されない）

## Requirements

### Requirement 1: ドリフト矛盾ケースの採点（コード優先の検証）
**Objective:** As a 評価基盤の保守者, I want doc 古 × コード新 の矛盾ケースでコードを正答に採れたかを客観採点したい, so that ドリフト耐性（軸 B′）の回帰を検知できる

#### Acceptance Criteria
1. When 矛盾ケース（doc は古い値 X を述べ、コードは現在値 Y を持つ）を実行して最終回答が Y を述べ・かつコードを出典（`path:line` またはコード上の根拠）として提示し・かつ古い値 X を主張しない, the 評価ハーネス shall そのケースを PASS とする
2. If 矛盾ケースの最終回答が古い値 X を述べる, then the 評価ハーネス shall そのケースを FAIL とし、失敗内訳に不一致（X を述べた／Y を欠く）を記録する
3. When 矛盾ケースを実行, the 評価ハーネス shall 最終回答の情報源がコードであること（コードの `path:line` 出典、または読んだコードパスの引用）を採点条件に含める
4. If 最終回答が現在値 Y を述べるがコードを出典として示さない, then the 評価ハーネス shall そのケースを FAIL とする
5. The 評価ハーネス shall 矛盾ケースをドリフト耐性の評価軸（軸 B′ = `axis: "B"`）としてタグ付けし、既存の軸別集計・合否ゲートの枠にそのまま計上する

### Requirement 2: 矛盾状況の再現とフィクスチャ分離
**Objective:** As a 評価基盤の保守者, I want 矛盾シナリオを本番 KB を汚さずに再現したい, so that 実行が本番データへ副作用を与えず、かつ doc とコードの矛盾が bot に実際に提示される

#### Acceptance Criteria
1. When 矛盾ケースを実行, the 評価ハーネス shall 古い値 X を述べるフィクスチャ doc を bot が参照可能な知識コンテキストとして提示し、同時に現在値 Y を持つライブコードも参照可能な状態にする
2. While 矛盾ケースの実行中, the 評価ハーネス shall フィクスチャ doc を本番 KB から分離して扱い、本番 KB の索引および内容を一切変更しない
3. The 評価ハーネス shall 矛盾用フィクスチャを `eval/` 配下に閉じ、本番の知識ベース（取り込み対象の Markdown 群）に混入させない
4. If フィクスチャ doc が bot の知識コンテキストに提示されない, then the 矛盾ケース shall 矛盾を欠き検証として無効になるため、フィクスチャ提示は矛盾ケース成立の必須条件とする

### Requirement 3: GitHub 未設定時の SKIP
**Objective:** As a 評価基盤の保守者, I want GitHub 未設定の環境では矛盾ケースを誤って FAIL させたくない, so that ローカル/CI で GitHub 無効時も評価が誤検知しない

#### Acceptance Criteria
1. If GitHub（`KB_GITHUB_REPOS`）が未設定の状態で矛盾ケースを実行, then the 評価ハーネス shall 既存の `needsGh` 規則に従いそのケースを SKIP とし、FAIL にしない
2. When 矛盾ケースを SKIP, the 評価ハーネス shall その SKIP を合否判定・軸別集計・合否ゲートの母数から除外する（既存の SKIP 挙動と一致させる）

### Requirement 4: 矛盾ペアの妥当性
**Objective:** As a 評価基盤の保守者, I want 矛盾ペアを安定かつ明確に選びたい, so that ケースが偶発的な揺れで壊れず、コード優先を厳密に判定できる

#### Acceptance Criteria
1. The 矛盾ケース shall 古い値 X（doc 側）と現在値 Y（コード側）が明確に異なる事実の対を用いる
2. The 矛盾ケース shall コード側の現在値 Y に安定した実在の事実を用い、コード上に `path:line` の根拠を持たせる
3. The フィクスチャ doc shall 「いかにも本物だが古い」内容として古い値 X を提示し、現在値 Y を含めない

### Requirement 5: 既存資産の非回帰
**Objective:** As a 評価基盤の保守者, I want 矛盾ケース追加が既存の評価・コード・枠を壊さないことを保証したい, so that 変更を安全に取り込める

#### Acceptance Criteria
1. When 矛盾ケース追加後に評価ハーネスを実行, the 評価ハーネス shall 既存ケースを無改修で PASS させる
2. The 変更 shall 本番コード（`src/`）を改変しない
3. When `bun run typecheck` を実行, the プロジェクト shall 型エラーなく完了する
4. The 変更 shall 既存の軸タグ・合否ゲート・スコアカードの枠（`eval-scorecard` 所有）および出典検査（`eval-citation-check` 所有）を改変しない
