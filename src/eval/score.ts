// per-case 採点の純関数群（eval の中核ロジック）。scripts/kb-eval.ts の実行ループが消費し、
// test/kb-eval.test.ts が直接検証する。ここには副作用（I/O・LLM・GitHub）を置かない。

export interface Expect {
  /** これらのいずれかが使われていれば可（部分集合）。 */
  toolsUsedAny?: string[];
  /** これら全部が使われていること。 */
  toolsUsedAll?: string[];
  /** 期待する情報源。docs=search_knowledge / code=GitHub ツール / both=両方 / any=不問。 */
  source?: "docs" | "code" | "both" | "any";
  /** いずれかのツール呼び出しの引数（JSON 文字列）にこの部分文字列が含まれること（subdir/path の確認）。 */
  argIncludes?: string;
  /** read_repo_file で読んだ path のいずれかにこの部分文字列が含まれること。 */
  readPathIncludes?: string;
  /** 最終回答にこれら全部が含まれること。 */
  answerIncludes?: string[];
  /** 最終回答にこれらが含まれないこと（幻覚・誤誘導の検出）。 */
  answerOmits?: string[];
  /** 出典必須（軸 B′）。true のとき回答本文に出典の体裁が付いているかを検査する。 */
  citesSource?: boolean;
  /** 次の一歩必須（軸 D）。true のとき未発見回答に「次の一歩」の手掛かりが含まれるかを検査する。 */
  offersNextStep?: boolean;
}

/**
 * 出典体裁の検出規約（Boundary Commitment, research.md 確定値）。テストと共有できるよう export する。
 * - doc 引用: `.md` を末尾に持つ資料名トークン（例 `auth.md`, `docs/auth.md`）。
 * - code 引用: 拡張子付き path に続く行番号（例 `db.ts:42`, `src/kb/db.ts:120`）。
 */
export const DOC_CITATION = /[\w./-]+\.md\b/;
export const CODE_CITATION = /[\w./-]+\.[A-Za-z0-9]+:\d+/;

/**
 * 出典体裁（.md 資料名 または path:line）の欠如を検出して日本語 fail 文の配列で返す純粋関数。
 * readPathIncludes 併用時は汎用体裁ではなく「読んだ path を含む path:line 形式の引用が本文にあるか」を
 * 厳格検査する（厳格判定は汎用体裁を内包する）。citesSource が偽/未指定なら空配列（既存判定を変えない, Req 4.2）。
 * 副作用なし・入力不変。
 */
export function citationFails(expect: Expect, answer: string): string[] {
  // 出典必須フラグが立っていなければ何も検査しない（Req 4.2: 既存判定を一切変えない）。
  if (!expect.citesSource) return [];

  // 併用（code B′）: 厳格判定。読んだ path を含む path:line 引用が 1 つ以上あることを要求（Req 2.1–2.3）。
  if (expect.readPathIncludes !== undefined) {
    const path = expect.readPathIncludes;
    const codeCites = answer.match(new RegExp(CODE_CITATION.source, "g")) ?? [];
    const cited = codeCites.some((c) => c.includes(path));
    if (!cited) {
      return [`出典必須: 読んだ path "${path}" が行番号付き（path:line）で回答本文に引用されていない`];
    }
    return [];
  }

  // 汎用体裁（Req 1.1–1.3）: doc 引用 or code 引用のいずれかが本文にあれば可。
  if (!DOC_CITATION.test(answer) && !CODE_CITATION.test(answer)) {
    return ["出典必須: 回答本文に出典の体裁（.md 資料名 または path:line 引用）が含まれていない"];
  }
  return [];
}

/**
 * 「次の一歩」検出の手掛かり語彙（複数語 OR, Req 2.3）。テストと共有できるよう export する。
 * 未発見時に bot が実際に返す「次の一歩」表現をカバーする 2 系統で構成する:
 *  (1) 次の一歩を提示する枠組み語（"次のステップ"/"次の一歩"/"お勧め" 等。プロンプトの "next step" を
 *      モデルが訳出する形。通常の“見つかった回答”には出にくい）。
 *  (2) docs/USAGE.ja.md「見つかりませんでした」節の具体策（対象名・キーワードを足す／言い換え／
 *      資料追加で答えられる／担当者に確認）。
 * いずれも一般語単独一致（"確認"/"情報" 等）を避け、過剰一致しにくい語に限定する。
 */
export const NEXT_STEP_CUES = [
  // (1) 次の一歩を提示する枠組み語
  "次のステップ",
  "次の一歩",
  "お勧め",
  "おすすめ",
  // (2) 具体策
  "キーワード",
  "具体的に",
  "言い換え",
  "資料を追加",
  "追加すれば",
  "対象名",
  "絞り込",
  "担当者",
];

/**
 * 「次の一歩」の手掛かり欠如を検出して日本語 fail 文の配列で返す純粋関数。
 * offersNextStep が偽/未指定なら空配列（既存判定を変えない, Req 2.4/4.1）。副作用なし・入力不変。
 */
export function nextStepFails(expect: Expect, answer: string): string[] {
  // 次の一歩必須フラグが立っていなければ何も検査しない（Req 2.4: 既存判定を一切変えない）。
  if (!expect.offersNextStep) return [];
  // 手掛かり語彙のいずれか 1 つ以上が本文に出現すれば可（Req 2.3）。
  if (NEXT_STEP_CUES.some((cue) => answer.includes(cue))) return [];
  return ["次の一歩必須: 回答に次の一歩（キーワード補足・言い換え・資料追加などの具体的手掛かり）が示されていない"];
}

/** 評価軸の許容集合。スコアカードはこの軸ごとに到達度を集計する。 */
export type Axis = "A" | "B" | "C" | "D" | "safety";
const AXES = ["A", "B", "C", "D", "safety"] as const;

/** JSON 直後の緩い形状。axis/gate は未検証なので Axis に narrow しない（検証は後続タスク）。 */
export interface RawCase {
  name: string;
  question: string;
  expect: Expect;
  axis?: string; // 未検証。validateCases 通過後に Axis へ narrow
  gate?: unknown; // 未検証。boolean 以外は不正
  monitor?: unknown; // 未検証。boolean 以外は不正（非ゲート＝exit 母数外の情報表示ケース）
  fixtures?: unknown; // 未検証。文字列配列以外は不正（隔離索引に載せる eval 専用 doc 名）
}

/** 検証済みケース。axis は有効な Axis、gate は boolean に確定。 */
export interface Case {
  name: string;
  question: string;
  expect: Expect;
  axis?: Axis; // 省略時は無タグ（総合のみに数える）
  gate?: boolean; // 省略時は false
  monitor?: boolean; // 省略時は false。true=非ゲート（実行・採点・表示するが exit 母数から除外）
  fixtures?: string[]; // 省略時は本番 db を使用（従来挙動）。非空なら隔離索引に切り替える（buildFixtureDb が消費）
}

/** ツール呼び出しトレースの 1 件。実行ループの recordTool が構築し、採点が消費する。 */
export interface Call {
  name: string;
  input: unknown;
  output: string;
}

/** GitHub 系ツール名の集合。source 判定（code 側）と実行ループの SKIP 判定が共有する。 */
export const GH_TOOLS = new Set(["list_repo_tree", "read_repo_file", "search_repo_code"]);

export function evalCase(expect: Expect, calls: Call[], answer: string): string[] {
  const fails: string[] = [];
  const used = new Set(calls.map((c) => c.name));

  if (expect.toolsUsedAny && !expect.toolsUsedAny.some((t) => used.has(t))) {
    fails.push(
      `toolsUsedAny ${JSON.stringify(expect.toolsUsedAny)} のどれも使われなかった（使用: ${[...used].join(",") || "なし"}）`,
    );
  }
  for (const t of expect.toolsUsedAll ?? []) {
    if (!used.has(t)) fails.push(`必須ツール ${t} が使われなかった`);
  }

  if (expect.source && expect.source !== "any") {
    const usedDocs = used.has("search_knowledge");
    const usedCode = [...used].some((t) => GH_TOOLS.has(t));
    // docs は「コードに行かず docs/前置きで答えた」で判定する。core.ts が FTS 上位を初期コンテキストに
    // 前置きするため、docs で足りる質問は search_knowledge を呼ばず答えうる＝ツール使用での判定は誤検知になる。
    const ok =
      expect.source === "docs" ? !usedCode : expect.source === "code" ? usedCode : /* both */ usedDocs && usedCode;
    if (!ok) fails.push(`source 期待=${expect.source} だが docs(検索)=${usedDocs} code=${usedCode}`);
  }

  if (expect.argIncludes) {
    const hit = calls.some((c) => JSON.stringify(c.input ?? "").includes(expect.argIncludes!));
    if (!hit) fails.push(`どのツール引数にも "${expect.argIncludes}" が現れなかった（subdir/path 絞り込み未使用）`);
  }

  if (expect.readPathIncludes) {
    const hit = calls.some(
      (c) =>
        c.name === "read_repo_file" &&
        String((c.input as { path?: string })?.path ?? "").includes(expect.readPathIncludes!),
    );
    if (!hit) fails.push(`read_repo_file で "${expect.readPathIncludes}" を含む path を読まなかった`);
  }

  for (const s of expect.answerIncludes ?? []) {
    if (!answer.includes(s)) fails.push(`回答に "${s}" が含まれない`);
  }
  for (const s of expect.answerOmits ?? []) {
    if (answer.includes(s)) fails.push(`回答に含まれてはいけない "${s}" が出た`);
  }

  // 出典体裁の採点を末尾に統合（citesSource 未指定なら空配列＝既存判定は不変, Req 1.1/4.3）。
  fails.push(...citationFails(expect, answer));
  // 「次の一歩」の採点を末尾に統合（offersNextStep 未指定なら空配列＝既存判定は不変, Req 2.1/4.1）。
  fails.push(...nextStepFails(expect, answer));

  return fails;
}

/**
 * 読込直後の生ケース列を検証し、不正な評価軸／ゲート指定のエラー文（日本語）を配列で返す。
 * 副作用なし・入力不変。戻り値が空配列なら呼び出し側は安全に Case[] へ narrow できる。
 * 検証を AXES への narrow より前に置くことで、不正値が黙って集計へ流れ込むのを防ぐ（Req 1.4）。
 */
export function validateCases(cases: RawCase[]): string[] {
  const errors: string[] = [];
  for (const c of cases) {
    // axis は省略可。指定された場合のみ許容集合への所属を検査する。
    if (c.axis !== undefined && !(AXES as readonly string[]).includes(c.axis)) {
      errors.push(`ケース "${c.name}": 不正な評価軸 "${c.axis}"（許容: ${AXES.join("|")}）`);
    }
    // gate は省略時 false 扱い。指定された場合は真偽値であること（防御的・最小）。
    if (c.gate !== undefined && typeof c.gate !== "boolean") {
      errors.push(`ケース "${c.name}": gate は真偽値である必要があります（受領: ${JSON.stringify(c.gate)}）`);
    }
    // monitor は省略時 false 扱い。指定された場合は真偽値であること（gate と同型）。
    if (c.monitor !== undefined && typeof c.monitor !== "boolean") {
      errors.push(`ケース "${c.name}": monitor は真偽値である必要があります（受領: ${JSON.stringify(c.monitor)}）`);
    }
    // fixtures は省略可。指定された場合は「文字列の配列」であること（防御的・最小、実在検査は実行ループ側）。
    if (c.fixtures !== undefined && !(Array.isArray(c.fixtures) && c.fixtures.every((f) => typeof f === "string"))) {
      errors.push(
        `ケース "${c.name}": fixtures は文字列の配列である必要があります（受領: ${JSON.stringify(c.fixtures)}）`,
      );
    }
  }
  return errors;
}
