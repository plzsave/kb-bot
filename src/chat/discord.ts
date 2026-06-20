import type { ChatReply, ReplyHandle } from "./core.ts";

// Discord 用の ChatReply 実装。core の send/update を discord.js のメッセージ送信/編集に対応づける。
// Slack と違う最大の制約は「1 メッセージ 2000 字上限」。長文は改行境界で分割し、
// 逐次更新（ストリーミング）でもメッセージを増やし過ぎないよう、既存メッセージを編集して追従する。

const MAX = 2000;
const HR = "──────────";

// Discord は標準 Markdown の大半（**太字**・箇条書き・> 引用・コード）をそのまま描画するが、
// 見出しは #〜###（3 段階）まで・水平線やマスクリンクは非対応。効かないものだけ最小限に整形する。
// ```fence``` と `inline code` は変換しない。
export function toDiscordMarkdown(md: string): string {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : convertSegment(seg)))
    .join("");
}

function convertSegment(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      // 水平線（---, ***, ___）はそのまま文字で出てしまうので区切り線に置換
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return HR;
      // Discord の見出しは ### まで。#### 以降は描画されず文字で出るので太字に倒す。
      // 見出し文中に既に ** がある（例: #### 1. **基本的なしくみ**）と二重化で崩れるため、
      // 中のアスタリスクを除去してから一度だけ太字で包む。
      const h = line.match(/^#{4,}\s+(.*)$/);
      if (h) return convertInline(`**${h[1]!.replace(/\*+/g, "").trim()}**`);
      return convertInline(line);
    })
    .join("\n");
}

function convertInline(text: string): string {
  // 通常メッセージはマスクリンク非対応なので [文字](URL) → 文字 (URL)。`inline code` は保護。
  return text
    .split(/(`[^`]+`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")))
    .join("");
}

/** 2000 字以内のチャンク列に分割。なるべく改行で切り、無ければ強制分割。 */
export function splitForDiscord(text: string): string[] {
  if (text.length <= MAX) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf("\n", MAX);
    if (cut < MAX * 0.5) cut = MAX; // 手頃な改行が無ければ MAX で強制分割
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** 送信先チャンネル（テキストチャンネル / DM）に対する ChatReply を作る。 */
export function discordReply(channel: any): ChatReply {
  return {
    async send(text: string): Promise<ReplyHandle> {
      const sent: any[] = []; // 送信済みメッセージ（チャンクごと）
      const shown: string[] = []; // 各メッセージの現在の表示内容（無駄な編集を避ける）

      // 全文を Discord 向けに整形→2000 字チャンクに分け、既存メッセージは編集・足りなければ追加で送る。
      const render = async (full: string): Promise<void> => {
        const chunks = splitForDiscord(toDiscordMarkdown(full) || "…");
        for (let i = 0; i < chunks.length; i++) {
          const body = chunks[i]!;
          if (sent[i]) {
            if (shown[i] !== body) {
              await sent[i].edit(body);
              shown[i] = body;
            }
          } else {
            sent[i] = await channel.send(body);
            shown[i] = body;
          }
        }
      };

      await render(text);
      return {
        async update(next: string): Promise<void> {
          await render(next);
        },
      };
    },
  };
}
