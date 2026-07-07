import type { RawIssue, FullIssue } from "../issues.ts";

// issue → ナレッジ Markdown の純粋変換群（API 呼び出しを含まない＝bun test 対象）。
// frontmatter / タイトル / 関連情報フッターは取得済みデータからここで決定論的に組み、
// LLM には本文3セクション + 末尾の「関連ファイル:」行だけを書かせる（ハルシネーション最小化）。

const EXCLUDE_LABELS = new Set(["duplicate", "wontfix", "invalid"]);
const MIN_BODY_CHARS = 50;
const MAX_INPUT_CHARS = 24_000; // LLM へ渡す入力の文字数バジェット（トークン計測は使わず近似）

/** ルールベースのノイズ除外（LLM 呼び出し前。一覧 payload だけで判定できる）。 */
export function shouldInclude(issue: RawIssue, minComments: number): boolean {
  if (issue.labels.some((l) => EXCLUDE_LABELS.has(l.name.toLowerCase()))) return false;
  if (issue.comments < minComments) return false;
  if ((issue.body ?? "").trim().length < MIN_BODY_CHARS) return false;
  return true;
}

export const SUMMARY_SYSTEM = `あなたは社内ナレッジの整形担当です。GitHub issue の本文とコメントを読み、
日本語で次の3セクションだけを出力してください。指定セクションと末尾の「関連ファイル:」行以外は
一切出力しないこと（前置き・締めの挨拶・全体を \`\`\` で囲うことをしない）。

## 症状
<issue 本文から、何が起きたか/何を求めているかを簡潔に>

## 原因
<コメントから判明した原因。判断できなければ「不明」とだけ書く>

## 解決策
<採用された対応。コードのファイルパスが分かれば本文中に明記。判断できなければ「不明」>

関連ファイル: <解決策で参照されたコードのパスをカンマ区切り。無ければ「なし」>

制約:
- 本文・コメントに無い事実を創作しない。曖昧なら「不明」と書く。
- 個人名・@メンション・bot の定型コメントは含めない。`;

/** issue 本文+コメントを LLM 入力に組む。予算超過時は中間コメントを間引く（解決は終盤に出やすい）。 */
export function buildUserPrompt(full: FullIssue, maxChars = MAX_INPUT_CHARS): string {
  const { issue, comments } = full;
  const head = `# ${issue.title}\n\n${(issue.body ?? "").trim() || "(本文なし)"}`;
  const cs = comments.map((c, i) => `## コメント${i + 1} (@${c.user?.login ?? "unknown"})\n${(c.body ?? "").trim()}`);
  const all = [head, ...cs].join("\n\n");
  if (all.length <= maxChars) return all;

  const keepHead = cs.slice(0, 2);
  const tail: string[] = [];
  let used = head.length + keepHead.join("\n\n").length;
  for (let i = cs.length - 1; i >= keepHead.length; i--) {
    if (used + cs[i]!.length > maxChars) break;
    tail.unshift(cs[i]!);
    used += cs[i]!.length;
  }
  const omitted = cs.length - keepHead.length - tail.length;
  const middle = omitted > 0 ? [`…(中略: コメント ${omitted} 件省略)…`] : [];
  return [head, ...keepHead, ...middle, ...tail].join("\n\n").slice(0, maxChars);
}

/** LLM 出力から本文と related_files を取り出す（前置き・外側フェンス・末尾行に強い）。 */
export function parseSummary(raw: string): { body: string; relatedFiles: string[] } {
  let text = raw.trim();
  // 全体が ``` で囲まれていれば剥がす
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1]!.trim();

  // 末尾の「関連ファイル:」行を抽出して本文から除く
  let relatedFiles: string[] = [];
  text = text.replace(/^関連ファイル[:：]\s*(.*)$/gm, (_m, list: string) => {
    const v = list.trim();
    if (v && !/^なし$/.test(v)) {
      relatedFiles = v
        .split(/[,、]/)
        .map((s) => s.replace(/[`'"]/g, "").trim())
        .filter(Boolean);
    }
    return "";
  });

  // 「## 症状」より前の前置きを捨てる
  const i = text.indexOf("## 症状");
  if (i > 0) text = text.slice(i);

  return { body: text.trim(), relatedFiles: [...new Set(relatedFiles)] };
}

/** frontmatter + タイトル + 本文 + 関連情報フッターを組み立てる（最終 Markdown）。 */
export function assembleMarkdown(args: {
  issue: RawIssue;
  repo: string;
  body: string;
  relatedFiles: string[];
}): string {
  const { issue, repo, body, relatedFiles } = args;
  const labels = issue.labels.map((l) => l.name);
  const yamlList = (xs: string[]) => (xs.length ? `\n${xs.map((x) => `  - ${x}`).join("\n")}` : " []");
  const fm = [
    "---",
    "source: github-issue",
    `issue_number: ${issue.number}`,
    `repo: ${repo}`,
    `closed_at: ${issue.closed_at ?? ""}`,
    `updated_at: ${issue.updated_at}`,
    "reopened: false",
    `related_files:${yamlList(relatedFiles)}`,
    // ラベルは "priority: med" のようにコロンを含みうる。flow 配列だとマッピング誤解釈に
    // なるため各要素を JSON 文字列（= 有効な YAML 二重引用符文字列）でクォートする。
    `labels: [${labels.map((l) => JSON.stringify(l)).join(", ")}]`,
    "---",
  ].join("\n");

  const footer = [
    "## 関連情報",
    `- Source: ${issue.html_url}`,
    `- Repo: ${repo}`,
    `- Closed: ${issue.closed_at ?? "不明"}`,
    `- Labels: ${labels.join(", ") || "なし"}`,
  ].join("\n");

  return `${fm}\n\n# Issue #${issue.number}: ${issue.title}\n\n${body}\n\n${footer}\n`;
}

/** R2/S3 配置キー。S3_PREFIX を前置し、専用プレフィックス配下に置く。 */
export function issueDocKey(prefix: string, repo: string, number: number): string {
  return `${prefix}knowledge/github-issues/${repo.replace("/", "-")}/${number}.md`;
}

/** 隔離（tombstone）先キー。isStaleKey が拾えるよう _stale セグメントを含める。 */
export function staleDocKey(prefix: string, repo: string, number: number): string {
  return staleKeyForKey(prefix, issueDocKey(prefix, repo, number));
}

/**
 * 任意の知識キーを隔離先キーへ写像する（kb-prune の移動先）。
 * `${prefix}knowledge/...` → `${prefix}knowledge/_stale/...`。
 * これにより issue-to-kb の tombstone チェック（staleDocKey）と一致する。
 */
export function staleKeyForKey(prefix: string, key: string): string {
  const head = `${prefix}knowledge/`;
  if (key.startsWith(head)) return `${head}_stale/${key.slice(head.length)}`;
  return `${prefix}_stale/${key.startsWith(prefix) ? key.slice(prefix.length) : key}`;
}

export interface IssueMeta {
  source?: string;
  issue_number?: number;
  repo?: string;
  closed_at?: string;
  updated_at?: string;
  reopened?: boolean;
  related_files: string[];
  labels: string[];
}

/**
 * 先頭 YAML frontmatter を、issue-to-kb が出力する形に限定して読む（汎用 YAML ではない）。
 * frontmatter が無ければ null（= staleness 判定スキップ。手書きナレッジ等の後方互換）。
 */
export function parseFrontmatter(md: string): IssueMeta | null {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const meta: IssueMeta = { related_files: [], labels: [] };
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!.trim();
    if (key === "related_files") {
      meta.related_files = val === "[]" || val === "" ? collectBlockList(lines, i, end) : parseFlowList(val);
    } else if (key === "labels") {
      meta.labels = parseFlowList(val);
    } else if (key === "issue_number") {
      const n = Number(val);
      if (Number.isFinite(n)) meta.issue_number = n;
    } else if (key === "reopened") {
      meta.reopened = val === "true";
    } else if (key === "source") meta.source = val;
    else if (key === "repo") meta.repo = val;
    else if (key === "closed_at") meta.closed_at = val || undefined;
    else if (key === "updated_at") meta.updated_at = val || undefined;
  }
  return meta;
}

// `key:` の直後に続く `  - item` ブロックリストを集める。
function collectBlockList(lines: string[], from: number, end: number): string[] {
  const out: string[] = [];
  for (let i = from + 1; i < end; i++) {
    const m = lines[i]!.match(/^\s+-\s+(.*)$/);
    if (!m) break;
    const v = m[1]!.trim().replace(/^["']|["']$/g, "");
    if (v) out.push(v);
  }
  return out;
}

// `[a, "b: c"]` 形式のフロー配列。JSON で読めれば JSON、ダメなら素朴分割。
function parseFlowList(val: string): string[] {
  const inner = val.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  try {
    const arr = JSON.parse(`[${inner}]`) as unknown[];
    return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    return inner
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
}
