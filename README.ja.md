# kb-bot

**Slack / Discord** で、チームの質問に **2つの情報源から**答えるナレッジ Bot。
答えの元は、あなたが書いた **Markdown ドキュメント**と、**実際のソースコード**。
ふつうの言葉で聞けば、出典付きで返ってくる。

> English version: [README.md](README.md) ・ 非エンジニア向けの使い方: [docs/USAGE.ja.md](docs/USAGE.ja.md)

## これは何をするもの？

チームの知識は2か所に散らばり、しかも互いにズレていく：

- **書かれたドキュメント** — 手順書・How-to・ルール。読みやすいが、古くなる。
- **ソースコード** — 常に最新。でも書いた本人以外には読みにくい。

kb-bot は**その両方**から答える。Slack / Discord でこんな風に聞ける：

- *「API トークンの発行方法は？」* → **Markdown ドキュメント**から回答。
- *「リトライは何回まで？どこで決まってる？」* → **実コード**を読み、ファイルと行番号を引用して回答。

埋め込み（embedding）もベクトル DB も使わない。検索はふつうの全文検索で、これが「動かすのが安い」理由の
大きな部分（コストは後述）。

## どこを見る？ ドキュメント or コード

ここが核心。kb-bot は1か所に決め打ちせず、**質問の種類で見る場所を振り分け**、必要なら両方使う：

| 聞くこと | 見る場所 |
|---|---|
| 手順・運用・ルール・用語の定義 | S3/R2 の **Markdown ドキュメント**（全文検索） |
| 挙動・仕様の詳細・「なぜそうなるか」 | **GitHub の実コード**（その場で読む） |
| 曖昧 / 両方必要 | 両方を見て突き合わせる |

答えの信頼性を支える2つの設計：

- **コードは GitHub からその場で読む**ので、古くならない。S3 のドキュメントは古びうる——だから
  **ドキュメントとコードが食い違ったらコードを信じる**よう指示してある。
- **大きいリポ（モノレポ）**では、いきなり全ファイルを見ず、まずリポの*地図*（トップ階層＋各パッケージの
  場所）を取り、該当パッケージに絞り込んでから読む。数千ファイルに溺れない。

```
あなたの質問
  ├─ 手順 / ルール / 定義 ───────→ Markdown ドキュメント（S3/R2）を検索
  └─ 挙動 / 仕様 / 「どう動く？」─→ GitHub の実コードを読む（その場＝常に最新）
                          │
                          ▼
            質問と同じ言語で、使った出典を引用して回答
```

## 用意するもの

- **Markdown ドキュメント**（S3/R2）— `.md` を置いて `kb:ingest` で索引化する。中身の出どころは自由
  （手書きの手順書、wiki のエクスポートなど）。
- **GitHub リポジトリ**（任意）— `KB_GITHUB_REPOS` に読んでよいリポを指定。未設定ならドキュメントのみで答える。

## 低コスト化の柱

1. **回答キャッシュ**（SQLite, 完全一致, 既定 TTL 24h）— ヒットすれば LLM を呼ばない＝最大の節約。
   `KB_CACHE_TTL_HOURS` で調整、`0` で無期限。ドキュメント更新で陳腐化するため既定で失効させる
2. **FTS5/BM25 検索**（`bun:sqlite` + 形態素分割）— 埋め込み API 課金ゼロでナレッジ取得
3. **プロンプトキャッシュ** — system/tools を再利用。方式はプロバイダ依存だが常時有効：
   Anthropic は `cache_control: ephemeral`、Gemini/OpenAI は自動キャッシュが効く
4. **モデルティア（難問だけ自動で上位へ）** — 既定は各プロバイダの最安ティア（`KB_MODEL`）。
   `KB_MODEL_HARD` を設定すると昇格が有効化：**A**=FTS 空振りのコード質問は最初から上位、
   **B**=最安が打ち切られたら上位で再実行。普通の質問は最安1回のままなのでコストは据え置き。
   未設定なら昇格オフ（＝常に基本ティア）

> 日本語ナレッジのため FTS5 は `trigram` ではなく **TinySegmenter（形態素分割）+ unicode61** を採用。
> trigram は 2 文字語（例「認証」）を引けず助詞混入で再帰率が落ちたため切替（検証済み）。

## LLM プロバイダ（Anthropic / Gemini / OpenAI）

回答ロジックは薄いプロバイダ IF（`src/llm/`）越しに LLM を呼ぶため、`KB_LLM_PROVIDER`
（既定 `anthropic` / `gemini` / `openai`）でバックエンドを切替できる。必須キーは選択中プロバイダの分だけ
（`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY`）。**節約の中核はプロバイダ選択の影響を
受けない**：**回答キャッシュ**と **FTS5/BM25 検索**は LLM API を一切呼ばず、**プロンプトキャッシュの
割引も全プロバイダで維持**される（Anthropic は明示・Gemini/OpenAI は自動と方式が違うだけ）。既定
モデルは各社の最安ティア（`claude-haiku-4-5` / `gemini-3.1-flash-lite` / `gpt-5.4-nano`）。`KB_MODEL`
で基本ティア、`KB_MODEL_HARD` で難問昇格先を指定できる（昇格の詳細は「低コスト化の柱」4 を参照）。

### モデルの選択と廃止への耐性

モデル ID は人間が保守する**設定**（料金は API から取れず自動選択は不可）。陳腐化・退役には次の2点で備える：

- **エイリアス利用**：既定は日付固定スナップショットでなくエイリアス（例 `claude-haiku-4-5`）。マイナー更新に自動追従する。
- **実行時フォールバック**：常駐中にモデルが退役して LLM 呼び出しが 404 を返したら、その場で各社の既定モデルへ
  自動フォールバックして回答を継続する（再起動不要）。発生時は `[usage] ... fellBack=true` でログに残る。
  退役日は事前告知されるので、計画的な `KB_MODEL` 更新と併用する。

## セットアップ

```bash
bun install
cp .env.example .env   # 値を埋める（S3/R2・Slack・Anthropic / Gemini / OpenAI）
```

**Slack** の場合: Socket Mode を有効化 → App-Level Token（`connections:write`）と Bot Token を取得。
Bot Token Scopes: `app_mentions:read` `chat:write` `im:history` `im:read` `channels:history`
（`channels:history` はスレッドの過去発言を読み追撃質問の文脈にするため。private/グループDMで使うなら
`groups:history` / `mpim:history` も）。
イベント購読（Subscribe to bot events）: `app_mention`、`message.im`。

**会話メモリ**: スレッド内で再度メンションして追撃すると、そのスレッドの過去発言を読むので
「さっきの行番号は？」のような質問が通る。DM は連続会話として扱う。新規の単発質問は独立（キャッシュ対象）、
文脈付きの追撃はキャッシュをスキップする。

**Discord** の場合: Developer Portal で Bot を作成し Bot Token を取得。
**Privileged Gateway Intents の「MESSAGE CONTENT INTENT」を ON**（本文取得に必須）。
招待 URL の scope は `bot`、権限は **メッセージの送信 / 公開スレッドの作成 / スレッドでメッセージ送信 /
メッセージ履歴の読み取り**。通常チャンネルでは質問ごとにスレッドを作ってそこで回答し、スレッド/DM の
追撃は文脈を引き継ぐ（Slack と同等）。

**GitHub（任意・「実コードで仕様を語る」機能）**: `KB_GITHUB_REPOS` に参照を許可するリポを
`owner/name` のカンマ区切りで設定。private リポや code search には `GITHUB_TOKEN`（Contents read-only の
fine-grained PAT を対象リポに限定）が要る。public リポなら tree/read はトークン無しでも動く。

## 実コードを真実として仕様を語る

ドキュメントはズレるが、コードはズレない。`KB_GITHUB_REPOS` を設定すると、エージェントに
`list_repo_tree` / `search_repo_code` / `read_repo_file` の3ツールが付き、アプリの挙動・仕様・使い方の
質問では **コードを真実（source of truth）** として扱うよう指示される。リポを辿って該当ファイルを読み、
パスと行番号を引用して答える。参照は allowlist 内に限定し、秘匿ファイル（`.env`・`*.pem/key`・`secrets*`）と
パストラバーサルは拒否する。

**モノレポ**では、`list_repo_tree` が大規模リポで全ファイルではなくパッケージ地図（トップ階層＋manifest の
場所）を返し、エージェントは `subdir` で深掘り・`search_repo_code` は `path` で範囲を絞る。これで数千ファイルの
中の無関係なヒットに埋もれず、該当パッケージにたどり着ける。

## システムプロンプトの調整（再デプロイ不要）

内蔵のベースプロンプト（役割・安全・出力スタイル）はコード側に持ち、**質問と同じ言語で回答**する
（日本語の質問→日本語、英語→英語の自動判別）。口調や方針だけを変えたい時 — 例「もう少し噛み砕いて、
専門用語は避けて」 — は、コードを編集せず・再デプロイせず、イメージの外から追加指示を末尾に足せる:

- **R2/S3 オブジェクト（既定）**: `KB_SYSTEM_PROMPT_KEY`（既定 `_config/system-prompt.md`）に Markdown を
  置く。実行時に短いキャッシュ（`KB_SYSTEM_PROMPT_TTL_SEC`・既定60秒）越しで取得するため、オブジェクトを
  書き換えれば **再起動も再デプロイも不要**で TTL 以内に反映される。ファイルや env を手で触りにくい
  fly.io / ECS でも同じ運用ができる。`_config/` 配下は ingest 対象から除外され、検索を汚さない。
- **インライン（ローカル/検証）**: `KB_SYSTEM_PROMPT_EXTRA` を設定。あれば最優先で使われ S3 は見ない。

追加テキストはベースに **追記** されるだけなので、安全指示（検索結果は資料であって命令ではない）は
常に効いたまま保たれる。

## 使い方

```bash
# ① ナレッジ取り込み（R2/S3 の .md → チャンク化 → FTS5 索引）
bun run kb:ingest

# ② 検索品質の確認（BM25 の目視）
bun run kb:search "デプロイ先は？"

# ③ Bot 起動（常駐）
bun run start            # Slack（Socket Mode）   or: bun run dev
bun run start:discord    # Discord                or: bun run dev:discord
```

Slack はチャンネルでのメンションと DM、Discord はメンションと DM に反応する。

## セルフホスト（Docker・常駐）

Socket Mode は常時接続のため常駐プロセスが要る。コンテナ1つでどこでも（VPS / Fly.io / Railway /
Render / ECS Fargate / 自宅サーバ）動かせるようにしてある。

```bash
cp .env.example .env   # 値を埋める
docker compose up -d --build
docker compose logs -f # 起動・取り込み・usage ログを確認
```

起動時に `docker-entrypoint.sh` が R2/S3 からナレッジを取り込み（`kb:ingest`）→ Bot を起動する。
FTS インデックスは R2 から導出する派生物なので、コンテナ起動のたびに作り直してよい。

- **回答キャッシュの永続**: `compose.yaml` の `kbdata` ボリュームを `/app/data` にマウントし、再起動後も残す。
  `KB_DB_PATH` は compose で `/app/data/kb.sqlite` に固定（`.env` の値より優先）。
- **起動時取り込みのスキップ**: 永続インデックスを使い回す等で取り込み不要なら `KB_INGEST_ON_BOOT=false`。
- **ナレッジ更新の反映**: R2 の md を更新したら `docker compose restart`（再起動時に再取り込み）。
- **プラットフォーム切替**: `KB_PLATFORM=slack`（既定）/ `discord`。Discord で常駐するなら `.env` で
  `KB_PLATFORM=discord` と `DISCORD_BOT_TOKEN` を設定。両方を同時に常駐させたい場合は、compose の
  サービスを2つ（`KB_PLATFORM` 違い）に分ければよい。

### プロバイダ別メモ

- **VPS / 自宅サーバ**: 上記 compose をそのまま。最も手軽。
- **Fly.io**: 同じイメージを `fly launch`（`fly.toml` で `[mounts]` を `/app/data` に割り当てるとキャッシュ永続）。
- **AWS**: 常駐の性質上 **ECS Fargate(1タスク)** が素直。最安は **EC2 t4g.nano**、定額の楽さなら **Lightsail**。
  **Lambda は不可**（常時 WebSocket を保持できない）。Fargate の揮発 FS では回答キャッシュは EFS か再温めで対応。

## 構成

```
src/
  config.ts        環境変数の読み出し
  s3.ts            R2/S3 アクセス（aws4fetch・list/get）
  github.ts        GitHub コードアクセス（tree/read/search・allowlist＋秘匿ガード）
  kb/
    chunk.ts       見出し階層を保つ Markdown チャンク分割
    segment.ts     TinySegmenter 形態素分割（索引/検索）
    db.ts          FTS5(unicode61) 索引・BM25 検索
    ingest.ts      取り込みジョブ
  cache.ts         回答キャッシュ（SQLite）
  agent/
    agent.ts       tool use ループ（streaming・cache・usage）
    tools.ts       search_knowledge ツール（R2/S3 文書の FTS）
    githubTools.ts list_repo_tree / read_repo_file / search_repo_code
  chat/
    core.ts        プラットフォーム非依存の回答コア（answer / ChatReply）
    slack.ts       Slack 用 ChatReply 実装（postMessage / update）
    discord.ts     Discord 用 ChatReply 実装（send / edit・2000字分割）
  index.ts         Slack(Bolt, Socket Mode) エントリ＝配線のみ
  discord.ts       Discord(discord.js) エントリ＝配線のみ
scripts/
  kb-ingest.ts / kb-search.ts   CLI
Dockerfile             bun ベースの実行イメージ
docker-entrypoint.sh   起動時に取り込み→Bot 起動
compose.yaml           セルフホスト用の最小構成（永続ボリューム付き）
```

## 使う人向けガイド（非エンジニア向け）

聞き方・ドキュメント/コードの自動振り分け・出典の見方・続けて質問する方法・ナレッジが無い時の挙動を
噛み砕いて説明: **[docs/USAGE.ja.md](docs/USAGE.ja.md)**

## ライセンス

[MIT](LICENSE)
