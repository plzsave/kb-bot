# Brief: tune-escalation-slack-format

## Source
実物確認（2026-07-02）で見つかった 2 つの小さな品質改善。ユーザー承認済み。関連メモリ: kb-bot-degradation-fix-deferred。

## Problem
1. **過剰昇格**: #40 の事前昇格しきい値 `REL_MIN_COVERAGE=0.5` がやや高く、答えが docs にある質問まで昇格する。実測: 「権限レベルの種類」は答えが `auth.md` にあるのに coverage 0.40 で上位モデルへ昇格＝無駄なコスト。一方コード質問（低コスト化 0.20 / トークナイザ 0.00）は昇格が妥当。
2. **Slack 表崩れ**: bot が markdown の表（`| … |`）を出すが Slack は表を描画しないため、素のパイプ記号で崩れて表示される。

## Desired Outcome
1. しきい値を 0.34 程度に下げ、borderline な docs 質問（cov≈0.4）は基本モデルに戻し、真の空振り（cov≤0.2）は昇格を維持する。＝無駄な昇格だけ削る。
2. bot が Slack で崩れる markdown 表を使わず箇条書きで答えるよう `buildSystem` の出力スタイルに一言追加する。

## Approach
1. `src/kb/db.ts` の `REL_MIN_COVERAGE` を 0.5→0.34 に変更。
2. `src/chat/core.ts` `buildSystem` の [Output style] に「markdown の表は使わない（Slack 等で崩れる）・箇条書きで」を追記。
- 検証: `bun test` 回帰＋オフラインで coverage 判定の変化を確認。

## Scope
- **In**: `REL_MIN_COVERAGE` の値変更 / `buildSystem` の出力スタイル 1 文追記 / 関連テスト。
- **Out**: coverage 指標のロジック（`queryCoverage`/`isSubstantiveTopHit`）・A経路の設計（#40）・eval・キャッシュ。

## Existing Spec Touchpoints
- **Adjacent**: `relevance-aware-escalation`（#40・しきい値の値のみ変更、判定ロジックは不変）、`reduce-dead-ends`/`eval-next-step`（#39/#31・buildSystem に追記するが既存文言は保持）。

## Constraints
- しきい値変更でコード質問（低カバレッジ）の昇格は維持する（信頼性を落とさない）。
- [Safety]・#39 のコード確認・#31 の next-step・出力言語自動判別を弱めない。`bun test` 緑・typecheck クリーン。
