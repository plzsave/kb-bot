import type { ChatReply, ReplyHandle } from "./core.ts";

// Slack 用の ChatReply 実装。core の語彙（send/update）を Slack Web API に対応づける。
// 1 質問 = 1 チャンネル/スレッド宛て。send で postMessage、update で同じ ts を chat.update する。
//
// Slack は標準 Markdown ではなく独自の mrkdwn。コアの回答（GitHub 風 MD）を送信直前に変換する。
// 変換をここに閉じ込めることで、回答キャッシュには中立な標準 MD が残り、Discord 側は無変換で済む。

const HR = "──────────";

/** 標準 Markdown を Slack mrkdwn へ変換する。```fence``` と `inline code` は変換しない。 */
export function toSlackMrkdwn(md: string): string {
  // コードフェンスを温存（奇数番目がフェンス本体）
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : convertSegment(seg)))
    .join("");
}

function convertSegment(s: string): string {
  // ① 行頭記法（水平線・見出し・箇条書き）は行単位で処理
  const lined = s.split("\n").map(convertLine).join("\n");
  // ② インライン記法（太字・リンク・打消し）はセグメント全体で処理＝行をまたぐ太字も拾える
  return convertInline(lined);
}

function convertLine(line: string): string {
  // 水平線（---, ***, ___）は非対応なので区切り線に置換
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return HR;
  // 見出し（# 〜 ######）は太字に倒す（中身のインラインは後段でまとめて変換）
  const h = line.match(/^#{1,6}\s+(.*)$/);
  if (h) return `*${h[1]}*`;
  return line.replace(/^(\s*)[-*]\s+/, "$1• "); // 箇条書きは • に
}

function convertInline(text: string): string {
  // `inline code` を温存しつつ、リンク・太字・打消しを mrkdwn へ
  return text
    .split(/(`[^`]+`)/g)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>") // [t](u) -> <u|t>
            .replace(/\*\*([\s\S]+?)\*\*/g, "*$1*") // **太字** -> *太字*（改行跨ぎ可・最短一致）
            .replace(/__([\s\S]+?)__/g, "*$1*") // __太字__ -> *太字*
            .replace(/~~([\s\S]+?)~~/g, "~$1~"), // ~~打消し~~ -> ~打消し~
    )
    .join("");
}

export function slackReply(client: any, channel: string, thread_ts: string | undefined): ChatReply {
  return {
    async send(text: string): Promise<ReplyHandle> {
      const posted = await client.chat.postMessage({ channel, thread_ts, text: toSlackMrkdwn(text) });
      const ts = posted.ts as string;
      return {
        async update(next: string): Promise<void> {
          await client.chat.update({ channel, ts, text: toSlackMrkdwn(next) });
        },
      };
    },
  };
}
