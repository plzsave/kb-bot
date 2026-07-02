# Requirements Document

## Introduction
kb-bot の北極星は「非エンジニアが、開発・保守が継続するシステムへの疑問を独力で解決する」こと（#27）。この自立が最も崩れるのは**答えが見つからなかった時**で、ただ「ナレッジに見つかりませんでした」で突き放すと利用者は結局エンジニアに聞きに行く＝自立失敗になる。現状 `buildSystem`（`src/chat/core.ts`）の未発見指示は「When you cannot find the fact, do not guess; state that you could not find it ...」（L29）で止まっており、**次の一歩**（対象名・キーワードの補足を促す／言い換え／資料を足せば答えられる旨）を促す指示が無い。さらに、その振る舞いを測る eval も無く、軸 D（行き止まらない）は #27 で「計測なし」と位置づけられている。

本仕様は、(1) 未発見時に「次の一歩」を 1 文添えるよう `buildSystem` を最小追記し、(2) 評価ハーネス（`scripts/kb-eval.ts`）に「次の一歩」の有無を採点する `offersNextStep` を追加し、(3) 突き放せば FAIL・次の一歩を返せば PASS になる軸 D ケースを `eval/cases.json` に追加する。これにより軸 D を客観採点の対象にし回帰検知を可能にする。詳細な背景・アプローチ・コードアンカーは `brief.md`（Source: GitHub issue #31 / 親 #27 / 依存 #28）を参照。「次の一歩」の文言方針は `docs/USAGE.ja.md`「ナレッジに見つかりませんでした」節（聞き方を具体的に／対象名・キーワードを足す／資料追加で答えられる）と一致させる。

## Boundary Context
- **In scope**:
  - `buildSystem` の未発見指示（L29）へ「次の一歩」を 1 文添える**最小限**のプロンプト追記
  - `scripts/kb-eval.ts` の `Expect` 拡張（`offersNextStep`）と `evalCase()` での判定
  - `eval/cases.json` への軸 D ケース追加（`axis: "D"`）
- **Out of scope**:
  - 「近い情報のサジェスト（部分ヒットの提示）」等の retrieval / 検索機能拡張（将来 A 軸）
  - 昇格トリガ・モデル構成・キャッシュ方針の変更
  - 軸タグ・合否ゲート・スコアカードの枠（`eval-scorecard` / #28 が所有・実装済み）の改変
  - 出典必須・忠実性（`eval-citation-check` / #29 の `citesSource`）とドリフト耐性（`eval-drift-tolerance` / #30）の判定ロジック改変
- **Adjacent expectations**:
  - `eval-scorecard`（#28）が提供する軸別集計・合否ゲート・SKIP 除外の挙動に依存し、それらを変更しない（`Axis` 型に `"D"` は既存）
  - 既存の guard ケース（`answerOmits: ["おそらく","推定では","と思われます"]` による無根拠推測の禁止）と整合し、これを壊さない
  - 出力言語自動判別（質問と同じ言語で答える）は既存 `buildSystem` の性質であり、本追記後も保つ

## Requirements

### Requirement 1: 未発見時に「次の一歩」を返す（振る舞い）
**Objective:** As a 非エンジニアの利用者, I want ナレッジにもコードにも答えが無いとき次にどうすれば解決に近づくかを示してほしい, so that エンジニアに聞き直さず独力で次の行動を取れる

#### Acceptance Criteria
1. When ナレッジにもコードにも事実が無い質問を受ける, the kb-bot shall 回答に (a) 見つからない旨 と (b) 具体的な次の一歩（対象名・キーワードの補足を促す／言い換えの提案／資料を追加すれば答えられる旨のいずれか）を含める
2. If 事実が見つからない, then the kb-bot shall 断定的な作り話（推測）をせず、既存 guard の禁止語（「おそらく」「推定では」「と思われます」）を用いない
3. The kb-bot shall 「次の一歩」を質問と同じ言語で提示する（出力言語自動判別を保つ）
4. The プロンプト追記 shall `buildSystem` の [Safety] および [Output style] の規則を弱めない（未発見時の 1 文追加に限定する）

### Requirement 2: 「次の一歩」の採点（offersNextStep）
**Objective:** As a 評価基盤の保守者, I want 未発見回答が「次の一歩」を含むかを客観採点したい, so that 行き止まり（軸 D）の回帰を数字で検知できる

#### Acceptance Criteria
1. Where `expect.offersNextStep: true` が指定される, the 評価ハーネス shall 最終回答に「次の一歩」に相当する手掛かりが含まれることを検査する
2. If `offersNextStep: true` かつ最終回答に「次の一歩」相当の手掛かりが含まれない, then the 評価ハーネス shall そのケースを FAIL とし、失敗内訳に「次の一歩」の欠如を記録する
3. When 「次の一歩」の有無を判定する, the 評価ハーネス shall 過剰一致を避けるため複数語の OR（手掛かり語彙のいずれか一致）で判定する
4. If `offersNextStep` が未指定または偽, then the 評価ハーネス shall この検査を一切行わず、既存ケースの判定結果を変えない

### Requirement 3: 軸 D ケースの追加
**Objective:** As a 評価基盤の保守者, I want 突き放しを FAIL・次の一歩提示を PASS にする客観ケースを持ちたい, so that 軸 D の到達度がスコアカードに現れる

#### Acceptance Criteria
1. The `eval/cases.json` shall ナレッジにもコードにも事実が無い質問について `axis: "D"` かつ `offersNextStep: true` の評価ケースを 1 つ以上含める
2. When 追加した軸 D ケースで回答が「次の一歩」を提示する, the 評価ハーネス shall そのケースを PASS とする
3. If 追加した軸 D ケースで回答が「見つからない」だけで突き放す, then the 評価ハーネス shall そのケースを FAIL とする
4. The 軸 D ケース shall 既存 guard と同じく無根拠推測を禁止する条件（`answerOmits`）と両立し、guard の趣旨を損なわない

### Requirement 4: 既存資産の非回帰
**Objective:** As a 評価基盤の保守者, I want 本変更が既存の評価・プロンプト性質・枠を壊さないことを保証したい, so that 変更を安全に取り込める

#### Acceptance Criteria
1. When 本変更後に評価ハーネスを実行, the 評価ハーネス shall 既存ケースを無改修で PASS させる
2. The 変更 shall 軸タグ・合否ゲート・スコアカードの枠（`eval-scorecard` 所有）および出典検査（`eval-citation-check` 所有）・ドリフト判定（`eval-drift-tolerance` 所有）のロジックを改変しない
3. When `bun run typecheck` を実行, the プロジェクト shall 型エラーなく完了する
4. The 変更 shall `src/chat/core.ts` の `buildSystem` 以外の本番コード（`src/` 配下の他モジュール）を改変しない
