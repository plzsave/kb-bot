// Markdown をチャンク分割する。見出し階層をパンくず（breadcrumb）として各チャンクに残し、
// 大きすぎる節は段落境界でさらに分ける。検索ヒット時に「どの節か」を提示でき、
// LLM に渡す断片も小さく保てる＝トークン節約の土台。

export interface Chunk {
  /** 見出しのパンくず（例: "セットアップ > 認証"）。本文先頭にも前置して文脈を持たせる。 */
  heading: string;
  /** ドキュメント内の通し番号。 */
  ord: number;
  text: string;
}

const MAX_CHARS = 1200; // 1 チャンクの目安上限。日本語/英語混在でも過大にならない程度。

interface Section {
  heading: string;
  lines: string[];
}

export function chunkMarkdown(md: string): Chunk[] {
  const sections = splitByHeadings(md);
  const chunks: Chunk[] = [];
  let ord = 0;
  for (const sec of sections) {
    const body = sec.lines.join("\n").trim();
    if (!body) continue;
    for (const piece of splitByBudget(body)) {
      const text = sec.heading ? `${sec.heading}\n\n${piece}` : piece;
      chunks.push({ heading: sec.heading, ord: ord++, text });
    }
  }
  return chunks;
}

// ATX 見出し（# 〜 ######）でセクション化し、heading にパンくずを積む。
function splitByHeadings(md: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: Section = { heading: "", lines: [] };
  let inFence = false;

  const flush = () => {
    if (current.lines.length || current.heading) sections.push(current);
  };

  for (const line of md.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence; // コードフェンス内の # は見出し扱いしない
    const m = inFence ? null : line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      const level = m[1]!.length;
      const title = m[2]!.trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title });
      current = { heading: stack.map((s) => s.title).join(" > "), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

// 段落（空行区切り）を貪欲に詰め、予算超過で切る。単一段落が予算超なら行単位でさらに割る。
function splitByBudget(body: string): string[] {
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  const push = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  for (const para of paras) {
    if (para.length > MAX_CHARS) {
      push();
      for (const line of hardWrap(para)) out.push(line);
      continue;
    }
    if (buf.length + para.length + 2 > MAX_CHARS) push();
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  push();
  return out;
}

function hardWrap(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_CHARS) out.push(text.slice(i, i + MAX_CHARS));
  return out;
}
