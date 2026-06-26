// Bot 自身が出す“外枠”の文言（プレースホルダ・キャッシュ印・エラー・空回答）。
// 回答本文は LLM が「質問と同じ言語」で書くのに、ここだけ日本語固定だと英語ユーザーに
// 日本語の枠が出てしまう。質問の言語を簡易判定して合わせる（対象は JA/EN の 2 種で十分）。

export type UiLang = "ja" | "en";

export interface UiText {
  /** 起票直後のプレースホルダ。 */
  thinking: string;
  /** 上位ティアへ昇格して再実行する間のプレースホルダ。 */
  thinkingHard: string;
  /** キャッシュ応答に付ける印（Markdown 斜体を含む）。 */
  cacheTag: string;
  /** 生成結果が空だった時の代替文。 */
  empty: string;
  /** 例外時にプレースホルダを置き換えるエラー文。 */
  error: string;
}

const TEXT: Record<UiLang, UiText> = {
  ja: {
    thinking: "考え中… ⏳",
    thinkingHard: "じっくり考え中… ⏳",
    cacheTag: "_（キャッシュ応答）_",
    empty: "（回答を生成できませんでした）",
    error: "⚠️ 回答の生成中にエラーが発生しました。少し時間をおいて、もう一度お試しください。",
  },
  en: {
    thinking: "Thinking… ⏳",
    thinkingHard: "Thinking harder… ⏳",
    cacheTag: "_(cached)_",
    empty: "(could not generate an answer)",
    error: "⚠️ Something went wrong while generating the answer. Please wait a moment and try again.",
  },
};

// ひらがな・カタカナ・CJK 統合漢字を含めば日本語とみなす（含まなければ英語＝既定）。
const JA_CHARS = /[぀-ヿ㐀-䶿一-鿿]/;

/** 質問テキストから UI 言語を判定する（日本語文字を含めば ja、なければ en）。 */
export function detectLang(text: string): UiLang {
  return JA_CHARS.test(text) ? "ja" : "en";
}

/** 質問に合わせた外枠文言一式を返す。 */
export function uiText(question: string): UiText {
  return TEXT[detectLang(question)];
}

// プレースホルダ（thinking 系）の全言語バリアント。会話履歴を組む際に、まだ
// プレースホルダのままの bot 発言を除外するための番兵判定に使う。
const PLACEHOLDERS: ReadonlySet<string> = new Set(
  (Object.keys(TEXT) as UiLang[]).flatMap((l) => [TEXT[l].thinking, TEXT[l].thinkingHard]),
);

/** その文字列が（言語を問わず）思考中プレースホルダなら true。 */
export function isPlaceholder(text: string): boolean {
  return PLACEHOLDERS.has(text);
}
