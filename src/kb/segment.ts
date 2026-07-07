import TinySegmenter from "tiny-segmenter";

// 和文の形態素分割。FTS5(unicode61) は空白区切りで単語をトークン化するので、
// 分割結果を空白連結して索引/検索すれば、2 文字語(「認証」など)も助詞に邪魔されず一致する。
// 形態素辞書を持たない軽量実装＝API 課金ゼロ・即時・依存も小さい。英語は元々空白区切りなので素通し。

const seg = new TinySegmenter();

// 検索ノイズになりやすい機能語・助詞（OR 検索の精度を下げるので問い合わせ側で落とす）。
const STOP = new Set([
  "は",
  "が",
  "を",
  "に",
  "へ",
  "と",
  "で",
  "も",
  "や",
  "の",
  "か",
  "ね",
  "よ",
  "さ",
  "し",
  "て",
  "た",
  "だ",
  "な",
  "する",
  "なる",
  "ある",
  "いる",
  "れる",
  "られる",
  "です",
  "ます",
  "ますか",
  "でしょ",
  "だろ",
  "ください",
  "下さい",
  "から",
  "まで",
  "より",
  "など",
  "けど",
  "ので",
  "のに",
  "って",
  "という",
  "これ",
  "それ",
  "あれ",
  "どれ",
  "この",
  "その",
  "あの",
  "どの",
  "こと",
  "もの",
  "について",
  "教え",
  "知り",
  "たい",
  "どう",
  "やっ",
  "ましょ",
]);

/** 索引用: 全トークンを空白連結（小文字化）。原文ではなくこの文字列を FTS の対象にする。 */
export function indexTokens(text: string): string {
  return seg
    .segment(text)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

/** 検索用: 内容語だけ取り出す（機能語・1 文字ひらがなを除去）。 */
export function queryTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of seg.segment(text)) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (STOP.has(t)) continue;
    if (t.length === 1 && /[ぁ-ゟ]/.test(t)) continue; // 単独ひらがな = ほぼ助詞
    if (/^[!-/:-@[-`{-~、-〕！-･\s]+$/.test(t)) continue; // 記号のみ
    out.push(t);
  }
  return out;
}
