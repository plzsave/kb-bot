# Implementation Plan: reduce-dead-ends

- [x] 1. buildSystem に「未発見宣言前のコード確認」を追記
  - `buildSystem` の GitHub 有効時ブロック（`withGh`）に、実装・挙動・仕様・コスト系の質問で docs だけでは答えられない場合、not-found と結論する前に実コード（search_repo_code / read_repo_file）を確認し、docs とコードの両方に無いと確認できたときのみ「見つからない」と述べる旨を英語で 1 文追記する
  - `base`（not-found 文・#31 next-step・[Safety]・[Output style]・[Routing]・[Audience]・出力言語自動判別）と合成順・関数シグネチャは変更しない
  - GitHub 有効時の生成文字列に当該指示が含まれ、GitHub 無効時には含まれない状態を観察できる
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.5_
  - _Boundary: buildSystem_

- [x] 2. systemPrompt 回帰テストを追加
  - GitHub 有効時の出力に「未発見前のコード確認」を促す文言が含まれることを検証する
  - GitHub 無効時の出力に当該文言が含まれないことを検証する（無効時は不適用）
  - 既存キーフレーズ（[Safety] の REFERENCE MATERIAL・[Output style] の conclusion first・#31 の next step・言語自動判別の SAME language）が保持されることを検証する
  - `bun test` から緑になることを確認できる
  - _Depends: 1_
  - _Requirements: 1.1, 1.4, 1.5, 2.2_
  - _Boundary: test/systemPrompt.test.ts_

- [ ] 3. 検証: 型・非回帰・ライブ観測
  - `bun run typecheck` が型エラーなく完了する
  - `bun test` の既存テストが無改修で緑（キャッシュ・エスカレーション・eval 判定に変更が無いこと＝ buildSystem 以外の src 不変を含む）
  - 既存の code / B′ drift ケース（`bun run kb:eval`, 手動・課金あり）で、docs に無い挙動質問がコードを確認して答える挙動を観測する（新規 eval ケースは追加しない）
  - typecheck 緑・既存非回帰・ライブでのコード確認挙動を観察できる
  - _Depends: 1, 2_
  - _Requirements: 2.1, 2.2, 2.3, 2.4_
