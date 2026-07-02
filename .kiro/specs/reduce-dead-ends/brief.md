# Brief: reduce-dead-ends

## Source
kb-bot 回答劣化の診断（2026-07-02, 本セッション）に起因。#27 マイルストーンが「A 見つかる／本番自立度＝future」とした実装側の対処。GitHub issue は未起票（完了 PR で `Closes` を付けられるよう、着手時に #27 配下の子 issue を起票することを推奨）。関連メモリ: kb-bot-degradation-fix-deferred。

## Problem
kb-bot が「知識ベースに見つかりませんでした」で行き止まり、実コードを見に行かない回答劣化が報告された。ライブ eval でも haiku が KB/初期コンテキストだけで“諦め回答”を即答する挙動が再現する。原因の一部は本番プロンプトと回答キャッシュの挙動にある:
- `buildSystem`（`src/chat/core.ts`）の未発見指示は「推測せず見つからない旨を述べる（+#31 で次の一歩を添える）」までで、**GitHub 有効時に “not found” を宣言する前に実コードを確認することを必須化していない**。振る舞い/仕組み/仕様/コスト系の質問でもコードを見ずに諦めうる。
- 回答キャッシュは `!hasContext && !result.truncated && result.text.trim()` で保存するため（L222）、**“諦め回答”もキャッシュされる**。悪い回答が配信され続け、改善しても再訪で見えない（テスト時にキャッシュ削除が必要になる）。

## Current State
- 未発見指示: `src/chat/core.ts` `buildSystem` の not-found 文（#31 の next-step が同じ文に同居）。GitHub ブロックには「コード優先／実コードで仕様を語る」旨はあるが、not-found 宣言前のコード確認を必須化する文言はない。
- キャッシュ保存: `src/chat/core.ts` L222、`src/cache.ts` の `putCachedAnswer`。諦め/未発見の区別なく保存する。
- 参考: `docs/USAGE.ja.md`「見つかりませんでした」節、既存 eval の B′ drift（#30）と D（#31）が近接軸を測定済み。

## Desired Outcome
- GitHub 有効時、振る舞い/仕組み/仕様/コスト系の質問では、"not found" を述べる前に実コード（search_repo_code / read_repo_file）を確認する。両方（KB とコード）で見つからないときのみ「見つからない＋次の一歩」を返す。
- 未発見/諦め回答はキャッシュに保存しない（悪い回答の配信継続と、改善の不可視化を防ぐ）。
- [Safety]／[Output style]／#31 の next-step／出力言語自動判別は不変。既存テスト・eval を壊さない。

## Approach
最小介入 1 点に絞る（再スコープ）:
1. `buildSystem` の not-found 指示を、GitHub 有効時に「"見つからない" と宣言する前に実コードを確認する」ことを要求する形へ最小追記（[Safety]/[Output style]/next-step は保持）。

（当初案の「諦め回答を非キャッシュ化」は、頑健にやるには retrieval 関連性スコアに依存する ―― `dropWeakHits` が無関係ヒットを残し FTS 件数では実質空振りを判定できない ―― ため、**A経路スコア化 follow-on スペックへ移管**した。そこで関連性スコアを使えば「実質空振り＝非キャッシュ」を決定的に判定できる。）

## Scope
- **In**: `src/chat/core.ts` `buildSystem` の not-found 前コード確認の追記 / その決定的テスト。
- **Out**: 未発見/諦め回答の非キャッシュ化（A経路スコア化 follow-on へ移管）。A経路のスコア化エスカレーション（`dropWeakHits`/`startHard`/retrieval 関連性）＝A 軸の別スペック。基本モデル底上げ（`.env`）。eval ケースの新規追加（既存 B′/#30・D/#31 で近接軸は測定済み）。

## Boundary Candidates
- プロンプト側（`buildSystem` の not-found 前コード確認）
- キャッシュ側（`putCachedAnswer` 呼び出し条件／`cache.ts`）

## Out of Boundary
- 昇格トリガ（`startHard`/truncated）と retrieval 関連性しきい値（A 軸 follow-on スペックが所有）
- モデル構成・`.env`（コード外）
- eval ハーネス（`scripts/kb-eval.ts`）の判定ロジック（`eval-scorecard`/`eval-citation-check`/`eval-drift-tolerance`/`eval-next-step` が所有）

## Upstream / Downstream
- **Upstream**: なし（本番挙動の局所変更）。#31 の next-step 文言と同居するため整合させる。
- **Downstream**: A 軸スコア化エスカレーション（follow-on）。基本モデル設定判断。効果測定は既存 eval（B′ drift / D）。

## Existing Spec Touchpoints
- **Extends**: なし（新規実装スペック）。
- **Adjacent**: `eval-next-step`（#31・同じ not-found 文を共有）、`eval-drift-tolerance`（#30・コード優先を測定）。判定ロジックには触れない。

## Constraints
- [Safety]／[Output style]／#31 next-step／出力言語自動判別を弱めない。
- キャッシュ変更は既存の完全一致キャッシュ挙動（namespace・文脈ありは非キャッシュ）を壊さない。
- `bun run typecheck` クリーン、既存テスト・既存 eval ケースを壊さない。
