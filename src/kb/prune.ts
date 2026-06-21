import type { IssueMeta } from "./issueDoc.ts";

// ナレッジ陳腐化のフラグ判定（純粋関数。DB/GitHub アクセスは呼び出し側が解決して渡す）。
// 自動削除はしない方針なので、ここは「複数フラグを集計してスコアにする」だけ。

const DAY_MS = 86_400_000;

export interface FlagContext {
  now: Date;
  ageYears: number;
  unusedMonths: number;
  /** knowledge_usage に直近 unusedMonths の retrieved 記録があるか（DB から解決して渡す）。 */
  usedRecently: boolean;
  /** related_files のうち対象リポの HEAD に存在しなかったもの（GitHub から解決して渡す）。 */
  missingFiles: string[];
}

export interface FlagResult {
  flags: string[];
  missingFiles: string[];
}

export function computeFlags(meta: IssueMeta, ctx: FlagContext): FlagResult {
  const flags: string[] = [];
  const closed = meta.closed_at ? new Date(meta.closed_at) : null;
  const closedValid = closed != null && !Number.isNaN(closed.getTime());

  // old: closed_at から ageYears 以上経過
  if (closedValid && (ctx.now.getTime() - closed!.getTime()) / (365.25 * DAY_MS) >= ctx.ageYears) {
    flags.push("old");
  }

  // unused: closed_at が unusedMonths より古い（新規ナレッジの誤検知を避ける猶予）かつ
  //         直近 unusedMonths に retrieved 記録が無い
  if (
    closedValid &&
    (ctx.now.getTime() - closed!.getTime()) / (30.44 * DAY_MS) >= ctx.unusedMonths &&
    !ctx.usedRecently
  ) {
    flags.push("unused");
  }

  // code_drift: related_files のいずれかが HEAD に存在しない
  if (ctx.missingFiles.length > 0) flags.push("code_drift");

  // reopened: 再オープン済み
  if (meta.reopened === true) flags.push("reopened");

  return { flags, missingFiles: ctx.missingFiles };
}

/** unused 判定の「直近」境界となる ISO 日時（now から months ヶ月前）。 */
export function monthsAgoIso(now: Date, months: number): string {
  return new Date(now.getTime() - months * 30.44 * DAY_MS).toISOString();
}
