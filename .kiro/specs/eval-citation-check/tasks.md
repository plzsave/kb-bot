# Implementation Plan

- [ ] 1. 出典判定ロジックの実装と採点への統合
- [x] 1.1 出典判定の純粋関数と「出典必須」期待値を実装
  - 評価ケースの期待値に「出典必須」の観点を追加する
  - 回答本文に出典の体裁（`.md` 資料名、またはコードの `path:line`）が含まれるかを判定する純粋関数を実装する
  - 「出典必須」が未指定なら何も判定せず、既存の採点結果を一切変えない（早期に空の指摘を返す）
  - 「読んだ path の一致検査」が併用されている場合は汎用体裁ではなく、読んだ path を含む `path:line` 形式（行番号付き）の引用が本文にあるかを厳格に判定する
  - 体裁欠如と「読んだ path の行番号付き未引用」は別文言の指摘として返し、既存の指摘と区別できるようにする
  - Observable: `bun run typecheck` が通り、出典必須が未指定の入力では空の指摘・体裁が無い入力では指摘文が返る
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 4.2, 4.4, 4.5_
  - _Boundary: citationFails, Expect.citesSource_

- [x] 1.2 評価採点への統合
  - 1 ケースの採点処理の末尾で出典判定を呼び出し、その指摘を採点結果に連結する
  - 既存の採点項目（本文包含・除外、ツール利用、情報源、引数・読込 path など）は無改変に保つ
  - Observable: 出典必須を指定したケースで出典の指摘が採点結果に現れ、未指定ケースの合否は従来と同一
  - _Depends: 1.1_
  - _Requirements: 1.1, 2.1, 4.3_
  - _Boundary: evalCase_

- [ ] 2. 評価データ（B′ ケース）の追加
- [x] 2.1 (P) B′ 評価ケースと記載例の追加
  - docs 由来の B′ ケースを追加する（評価軸 B、情報源 docs、既知の事実を問い正答の包含を要求し、出典必須で資料名の明示を要求）
  - code 由来の B′ ケースを追加する（評価軸 B、情報源 code、読んだ path の一致検査と出典必須を併用し `path:line` 引用を要求）
  - docs ケースは、回答が資料のファイル名を出す既知題材を選ぶ（見出しのみで答えられる題材を避け、正答が誤って FAIL になるのを防ぐ）
  - サンプルのケース定義集に「出典必須」の記載例を 1 件追従させる
  - Observable: 本番ケース定義集に、評価軸 B かつ出典必須の docs 由来・code 由来ケースが各 1 件以上存在する
  - _Requirements: 3.1, 3.2_
  - _Boundary: eval cases data_

- [ ] 3. テストの追加
- [x] 3.1 出典判定の単体テストと B′ ケースの構造テスト
  - 出典判定関数の単体テストを追加する: 出典必須が未指定なら空、`.md` 資料名がある回答は空、`path:line` がある回答は空、体裁が無い回答は指摘 1 件
  - 併用時のテストを追加する: 読んだ path を含む `path:line` がある回答は空、行番号なしの素の path のみ・または無関係な `path:line` のみの回答は指摘 1 件
  - 本番ケース定義集に評価軸 B かつ出典必須の docs 由来・code 由来ケースが各 1 件以上あることを検証する構造テストを追加する
  - Observable: `bun test` で追加テストがすべてパスする
  - _Depends: 1.1, 2.1_
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 4.2_
  - _Boundary: kb-eval tests_

- [ ] 4. 回帰とライブ検証
- [x] 4.1 後方互換の回帰とライブ実証
  - `bun run typecheck` がエラーなく完了することを確認する
  - 既存 7 ケースを無改修で実行し、全ケースが従来通り PASS すること、GitHub 未設定時の SKIP 挙動が不変なことを確認する
  - 追加した B′ ケースで、出典を満たす回答が PASS・満たさない回答が FAIL になることを実証する
  - Observable: 型チェック 0 エラー、既存 7 ケース PASS、B′ ケースで PASS/FAIL の双方を確認
  - _Depends: 1.2, 2.1, 3.1_
  - _Requirements: 3.3, 3.4, 4.1, 4.5_
  - _Boundary: eval harness integration_
  - _Verified: 静的＝typecheck 0 エラー / 142 テスト PASS / cases.json は validateCases エラー0・B′ 2件 / 既存 7 ケースは main とバイト同一。ライブ `bun run kb:eval`（`KB_GITHUB_REPOS=plzsave/kb-bot`, 上位ティアモデル）＝9/9 PASS・軸 B 2/2 PASS（B′ docs/code とも PASS＝Req 3.3）。Req 3.4（満たさない→FAIL）は haiku 実行で code B′ が citation 欠如により正しく FAIL したこと＋単体テストで実証。_

## Implementation Notes
- 出典判定は純粋関数 `citationFails` に分離し `bun test` で回帰検証（`buildScorecard` 等と同じ既存パターン）。ライブ eval（`bun run kb:eval`）は課金・要認証情報のため CI/autonomous では走らせず、静的検証（typecheck・unit・構造テスト・validateCases dry-run）で品質を担保する方針。
- code B′ の `readPathIncludes:"db.ts"` は実在（`src/kb/db.ts:28` の `tokenize='unicode61'`）と整合。`citationFails` 厳格分岐（読んだ path を含む `path:line`）が要求する引用と一致。
- ライブ eval のモデル感度: 既定 `claude-haiku-4-5` は code B′（db.ts を読んで unicode61 を path:line 引用）で早々に打ち切り db.ts へ到達せずブレて FAIL しうる。上位ティア（sonnet 相当）を `KB_MODEL` で指定すると安定して 9/9 PASS。判定ロジックの欠陥ではなくモデル能力差。code 系ケースの合否を見るときは上位モデル推奨。
