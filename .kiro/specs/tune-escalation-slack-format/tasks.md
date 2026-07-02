# Implementation Plan: tune-escalation-slack-format

- [x] 1. 事前昇格しきい値を 0.5→0.34 に下げる
  - `src/kb/db.ts` の `REL_MIN_COVERAGE` を `0.34` に変更し、コメントに根拠（borderline docs≈0.4 は据置・真の空振り≤0.2 は昇格維持）を記す
  - `test/db.test.ts` に、しきい値 0.34 で cov≈0.4 が substantive（据置）・cov≈0.2 が非 substantive（昇格）になる代表確認を追加する（既存の高/低カバレッジ判定は不変）
  - 「権限レベル」相当（0.40）が据置・「低コスト化」相当（0.20）が昇格、という切り分けを観察できる
  - _Requirements: 1.1, 1.2, 1.3, 3.2_
  - _Boundary: src/kb/db.ts, test/db.test.ts_

- [x] 2. Slack で崩れない出力指示を追記
  - `src/chat/core.ts` `buildSystem` の [Output style] に「markdown の表を使わない（Slack/Discord で素のパイプ記号に崩れる）・短い箇条書き等で構造化する」旨を英語で追記する
  - [Safety]・#39 のコード確認・#31 の next-step・出力言語自動判別・既存 [Output style] 文は保持する
  - `test/systemPrompt.test.ts` に、表回避の指示が含まれ既存キーフレーズが保持されることを検証するテストを追加する
  - システムプロンプト出力に表回避の指示が入り既存文言が残ることを観察できる
  - _Requirements: 2.1, 2.2_
  - _Boundary: src/chat/core.ts, test/systemPrompt.test.ts_

- [ ] 3. 検証
  - `bun run typecheck` クリーン、`bun test` 緑
  - （オフライン・API 不要）coverage 判定で「権限レベル」が据置・「低コスト化/トークナイザ」が昇格のままを確認
  - （手動・任意）Slack で表を使わず崩れない出力を確認
  - _Depends: 1, 2_
  - _Requirements: 3.1, 3.2, 3.3_
