# Implementation Plan: relevance-aware-escalation

- [x] 1. 関連性シグナル（純粋関数）を検索側に追加
  - クエリ内容語カバレッジを 0..1 で返す純粋関数を `src/kb/db.ts` に追加する（`queryTerms` の distinct 内容語のうち `indexTokens(text)` のトークン列に含まれる割合。分母0 は 0）
  - 最上位ヒットが実質関連かを返す純粋関数を追加する（`hits` 空なら false、そうでなければ最上位ヒットのカバレッジ ≥ しきい値）。しきい値は名前付き定数（既定 0.5）
  - 生 bm25 の絶対値には依存しない（コーパス非依存）
  - 関連ヒットで true・無関係/空ヒットで false・単一内容語で一致時 true を、関数単体で観察できる
  - _Requirements: 1.3, 1.5, 2.1_
  - _Boundary: src/kb/db.ts（queryCoverage / isSubstantiveTopHit）_

- [x] 2. startHard を「空 or 実質空振り」に差し替え
  - `src/chat/core.ts` の `startHard` を、関連性シグナルを用いて「`canEscalate` かつ GitHub 有効かつ最上位ヒットが実質関連でない」で発火する形に差し替える（空 hits は関連性関数が false を返し従来の空振りを包含）
  - `canEscalate`（`KB_MODEL_HARD` 未設定＝偽）なら従来どおり昇格しない。B経路（truncated 救済）・`runAgentWithFallback`・`formatHits` 前置き・`dropWeakHits` は変更しない
  - 昇格可能かつ無関係トップヒットの難質問で上位ティア開始・関連トップヒットで基本ティア開始、という分岐を観察できる
  - _Depends: 1_
  - _Requirements: 1.1, 1.2, 1.4, 2.2, 2.3, 3.4_
  - _Boundary: src/chat/core.ts（startHard）_

- [x] 3. 関連性関数の単体テストを追加
  - `test/db.test.ts` に、カバレッジ（全語含有で高・1語のみで低）、実質関連（関連=true / 無関係=false / 空=false / 単一内容語=true）、入力不変を検証するテストを追加する
  - `bun test` から緑になることを確認できる
  - _Depends: 1_
  - _Requirements: 1.1, 1.2, 1.3, 1.5_
  - _Boundary: test/db.test.ts_

- [ ] 4. 検証: 型・非回帰・ライブ観測
  - `bun run typecheck` が型エラーなく完了する
  - `bun test` の既存テストが無改修で緑（キャッシュ・buildSystem・eval・`dropWeakHits`/`formatHits` に変更が無いこと＝変更が db.ts/core.ts 限定であることを含む）
  - `KB_MODEL_HARD` 設定時、docs に無い難質問（既存 code / B′ drift ケース）が上位ティアで開始しコード探索を完走する傾向を `bun run kb:eval`（手動・課金あり）で観測する
  - typecheck 緑・既存非回帰・昇格挙動を観察できる
  - _Depends: 1, 2, 3_
  - _Requirements: 3.1, 3.2, 3.3_
