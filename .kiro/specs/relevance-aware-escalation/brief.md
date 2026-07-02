# Brief: relevance-aware-escalation

## Source
kb-bot 回答劣化診断（2026-07-02）の A軸 follow-on。#39（reduce-dead-ends / 未発見前コード確認）に続く第2弾。#27 マイルストーンの A 軸（見つかる）実装側。関連メモリ: kb-bot-degradation-fix-deferred。GitHub issue 未起票（完了 PR 時に #27 配下の子 issue 起票を検討）。

## Problem
難質問（docs に無くコード探索が要る）で、最安ティア（haiku）が search→read を完走できず「見つからない」で諦める劣化が、本番と eval の両方で再現する（B′ code/drift の run 間フレーク）。事前昇格（A経路）はこれを救えるはずだが発火しない:
- `core.ts` の `startHard = canEscalate && !!github && hits.length === 0`（L202）は **FTS 空振り時のみ**発火。
- しかし `src/kb/db.ts` の `dropWeakHits` は**最上位ヒットを無条件に残す**（L93 `i===0`）。`buildMatchQuery` は内容語の OR 一致なので、無関係な語一致でもほぼ必ず `hits.length>=1` になる。
- 結果、**無関係ヒット1件で `hits.length===0` にならず A経路が発火しない**＝難質問が最安ティアのまま諦める。

## Current State
- 昇格トリガ: `src/chat/core.ts` L202（A経路 startHard）/ L212（B経路 truncated 救済）。A経路は `hits.length===0` 限定。
- 検索: `src/kb/db.ts` `search`（bm25・`dropWeakHits`）。`SearchHit.score` は bm25（負・絶対値大ほど良い）。コメントどおり **bm25 はコーパス非正規化**で絶対しきい値は脆い。
- `buildMatchQuery`（`src/kb/db.ts`）が質問→内容語のフレーズ OR を生成。関連性判定に内容語を再利用できる。

## Desired Outcome
- 「実質空振り（最上位ヒットが質問に実質無関係）」を**コーパス非依存**に検知し、`startHard` を「FTS 空 **または** 実質空振り」で発火させる。
- これにより docs に無い難質問が最初から上位ティアで走り、#39（コード確認必須化）と組んでコードを確実に探索する。
- docs で足りる質問・既存のルーティング・初期コンテキストへの前置き（`formatHits`）・`dropWeakHits` の枝刈り挙動は不変。`KB_MODEL_HARD` 未設定時（`canEscalate=false`）は従来どおり昇格しない（非回帰）。

## Approach
1. 検索側に**コーパス非依存の関連性シグナル**を追加する（案: クエリ内容語のカバレッジ＝質問の内容語が最上位ヒット本文にどれだけ含まれるか。生 bm25 絶対値には依存しない）。判定は純粋関数として `bun test` 可能に。
2. `core.ts` の `startHard` を、このシグナルで「空 or 実質空振り」に拡張する。昇格の可否（`canEscalate`）とフォールバック挙動は現状維持。
3. 関連性シグナルは**昇格判定にのみ**使い、プロンプトへ前置きする内容（`formatHits`）と `dropWeakHits` の枝刈りは変えない（docs/citation ケースの非回帰）。

## Scope
- **In**: `src/kb/db.ts` への関連性シグナル（純粋関数）追加 / `src/chat/core.ts` `startHard` の拡張 / それらの決定的テスト。
- **Out**: 諦め回答の非キャッシュ化（関連性シグナルでも not-found を潔に判定できないため別途）。基本モデル底上げ（`.env`）。B経路（truncated 救済）の変更。`dropWeakHits`/`formatHits`/プロンプトの変更。eval 判定ロジック。

## Boundary Candidates
- 検索側の関連性シグナル（`src/kb/db.ts`・純粋関数）
- 昇格トリガ（`src/chat/core.ts` `startHard`）

## Out of Boundary
- 回答キャッシュ（`cache.ts`・保存条件）＝別 follow-on
- プロンプト（`buildSystem`）＝ #39/#31 が所有
- B経路 truncated 救済・`runAgentWithFallback`・モデル設定
- eval ハーネスの判定ロジック

## Upstream / Downstream
- **Upstream**: #39（コード確認必須化）と協調。`canEscalate`（`KB_MODEL_HARD` 設定）が前提。
- **Downstream**: キャッシュ follow-on（関連性シグナルを保守的キャッシュに再利用しうる）。効果測定は既存 eval（B′ code/drift の安定化）。

## Existing Spec Touchpoints
- **Extends**: なし（新規実装スペック）。
- **Adjacent**: `reduce-dead-ends`（#39・同じ劣化対処の別側面）、`eval-drift-tolerance`（#30・効果測定）。判定ロジックには触れない。

## Constraints
- コーパス非依存（生 bm25 絶対しきい値に依存しない）。
- `KB_MODEL_HARD` 未設定時は非昇格（従来挙動）を保つ。
- 初期コンテキスト前置き・`dropWeakHits`・docs ルーティングを不変に保つ。
- `bun run typecheck` クリーン、既存テスト・既存 eval ケースを壊さない。
