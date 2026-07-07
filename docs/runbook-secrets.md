# 秘密情報の管理 runbook

kb-bot が実行時に必要とする秘密の一覧、AI API キーの無停止ローテーション手順、他の秘密の失効要点、
`.env` の衛生管理をまとめる。GitHub 認証（PAT → GitHub App への無期限化）は対象外（別途 issue #59 で対応済み）。

## 保有する秘密の一覧

| 種別 | 環境変数 | 期限 | 漏洩時の影響範囲 | 失効方法 |
|---|---|---|---|---|
| AI API キー | `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` | 無期限（静的） | 選択プロバイダの課金を第三者が消費できる。専用ワークスペース＋支出上限で被害を頭打ちにする（下記） | 各社 Console でキーを Delete/Revoke |
| GitHub 認証 | `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` / `GITHUB_APP_INSTALLATION_ID`（推奨）または `GITHUB_TOKEN`（PAT） | App: 秘密鍵は無期限だが installation token は約1h自動更新／PAT: 有効期限あり・手動失効も可 | 対象リポの Contents（+ Issues）read-only。allowlist（`KB_GITHUB_REPOS`）外には及ばない | App: [github.com/settings/apps](https://github.com/settings/apps) で秘密鍵を Delete/再発行、または Install を解除／PAT: [github.com/settings/tokens](https://github.com/settings/tokens) で Delete |
| Slack | `SLACK_BOT_TOKEN`（`xoxb-`） / `SLACK_APP_TOKEN`（`xapp-`） | 無期限（アプリ削除まで） | 招待済みワークスペース内で bot 権限の範囲まで操作可能 | Slack App 管理画面（OAuth & Permissions / Basic Information → App-Level Tokens）で Revoke → 再生成 |
| Discord | `DISCORD_BOT_TOKEN` | 無期限（Reset するまで） | bot が参加しているサーバで bot 権限の範囲まで操作可能 | Discord Developer Portal → Bot → **Reset Token** |
| S3/R2 | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 無期限（発行元次第） | ナレッジバケットへの読み書き（最小権限は read-only を推奨） | ストレージ提供元（Cloudflare R2 等）の管理画面でキーを削除・再発行 |

## AI キーのローテーション手順（無停止・二重キー方式）

**鉄則: 先に新キーを有効にしてから、旧キーを消す。逆順（先に旧キーを消す）にすると、差し替えが失敗した場合に
bot が完全に応答不能になる。**

1. **Console で新キーを発行する**（旧キーはまだ消さない）。専用ワークスペースが未作成なら先に「Console 側の設定」節を参照。
2. `.env` の該当キー（`ANTHROPIC_API_KEY` 等）を新キーに書き換え、`docker compose up -d` で再起動する。
   Socket Mode のため断は数秒程度。回答キャッシュは `kbdata` ボリュームに残るため再起動による実害はない。
3. bot に1問投げて、回答が正常に返ることを確認する。
4. 確認できたら Console で**旧キーを無効化（Delete/Revoke）**する。

## Console 側の設定（ワークスペース分離・支出上限）

初回設定、または新キー発行のたびに以下を確認する。

**Anthropic（既定プロバイダ）:**

1. [console.anthropic.com](https://console.anthropic.com) → Settings → **Workspaces** で bot 専用ワークスペース
   （例 `kb-bot`）を作成する。デフォルトワークスペースと混在させない。
2. そのワークスペースで **Spend limit（支出上限）** を設定する。月額は Console の **Usage** で直近の実績を確認し、
   余裕を見て設定する。漏洩時もこの上限で課金が頭打ちになる。
3. そのワークスペース配下で API キーを新規発行し、上記のローテーション手順で `.env` に反映する。

**Gemini / OpenAI を使う場合:** 同じ考え方（専用プロジェクト分離＋ budget/limit 設定）を各社 Console で行う。

- Gemini: [Google AI Studio](https://aistudio.google.com/) / [Google Cloud Console](https://console.cloud.google.com/)
  の課金アラート・予算設定
- OpenAI: [platform.openai.com](https://platform.openai.com/) → Settings → **Billing → Limits**

## Slack / Discord / S3 キーの失効・再発行の要点

- **Slack**: [api.slack.com/apps](https://api.slack.com/apps) → 対象アプリ → **OAuth & Permissions**
  でBot Token を Revoke・再生成。App-Level Token は **Basic Information → App-Level Tokens** で管理。
  再生成後は `.env` を差し替えて再起動するだけでよい（スコープ設定はアプリ側に残る）。
- **Discord**: [Developer Portal](https://discord.com/developers/applications) → 対象アプリ → **Bot** →
  **Reset Token**。旧トークンは即座に無効になるため、`.env` 差し替え → 再起動をリセット直後に行う
  （AI キーと違い二重キー期間を作れない＝この操作自体に短い断が伴う）。
- **S3/R2**: ストレージ提供元の管理画面（例 Cloudflare R2 の **Manage API Tokens**）でアクセスキーを削除・再発行。
  読み取り専用スコープのキーを別途発行しておくと、書き込み権限キーの漏洩リスクと切り離せる。

## `.env` の衛生

- `chmod 600 .env` — 所有者以外の読み取りを禁止する。
- `.env` は `.gitignore` 済み（確認: `git check-ignore -v .env` がヒットを返せばよい）。**リポジトリへは絶対にコミットしない。**
- クラウド同期フォルダ（Dropbox / Google Drive / iCloud 等）の配下に置かない。バックアップが必要なら、
  パスワードマネージャーや暗号化ストレージなど秘密情報向けの手段を使う。
- GitHub App の秘密鍵（`.pem`）も同様の扱い。`chmod 600` し、`.gitignore` の `*.pem` で追跡対象外にしている
  （詳細は README の GitHub 節を参照）。
