import type { AgentTool } from "./agent.ts";
import type { GitHub } from "../github.ts";

// 実コードを読むための tool 群。ドキュメントが陳腐化していても、コードを根拠に仕様を説明させる。
// list_repo_tree で構成把握 → search_repo_code/read_repo_file で該当箇所を読む、という流れを想定。

export function githubTools(gh: GitHub): AgentTool[] {
  const repoProp =
    gh.repos.length > 1
      ? { repo: { type: "string", description: `対象リポジトリ（${gh.repos.join(" / ")} のいずれか）` } }
      : { repo: { type: "string", description: `対象リポジトリ（既定: ${gh.repos[0]}）` } };

  return [
    {
      def: {
        name: "list_repo_tree",
        description:
          "GitHub リポジトリのファイル一覧（パス）を取得する。" +
          "アプリの構成を把握し、どのファイルを読むべきか当たりを付けるのに使う。" +
          "大規模（モノレポ）では全ファイルではなくトップ階層とパッケージの目印（manifest）の概要を返すので、" +
          "そこで対象パッケージに当たりを付け、subdir（例: packages/foo）を指定して深掘りする。",
        parameters: {
          type: "object",
          properties: {
            ...repoProp,
            subdir: { type: "string", description: "絞り込むサブディレクトリ（例: packages/foo・任意）" },
          },
          required: [],
        },
      },
      async run(input) {
        const { repo, subdir } = (input ?? {}) as { repo?: string; subdir?: string };
        const r = gh.resolveRepo(repo);
        if ("error" in r) return `（${r.error}）`;
        return gh.listTree(r.repo, subdir);
      },
    },
    {
      def: {
        name: "read_repo_file",
        description:
          "GitHub リポジトリ内の 1 ファイルを読む（行番号付き）。仕様・挙動・使い方は" +
          "ドキュメントより実コードが真実なので、根拠としてこれで該当箇所を確認する。" +
          "大きいファイルは start_line / end_line で範囲指定するとトークンを節約できる。",
        parameters: {
          type: "object",
          properties: {
            ...repoProp,
            path: { type: "string", description: "リポジトリ内のファイルパス（例: src/index.ts）" },
            start_line: { type: "integer", description: "開始行（1 始まり・任意）" },
            end_line: { type: "integer", description: "終了行（任意）" },
          },
          required: ["path"],
        },
      },
      async run(input) {
        const { repo, path, start_line, end_line } = (input ?? {}) as {
          repo?: string;
          path?: string;
          start_line?: number;
          end_line?: number;
        };
        if (!path) return "（path が空でした）";
        const r = gh.resolveRepo(repo);
        if ("error" in r) return `（${r.error}）`;
        return gh.readFile(r.repo, path, start_line, end_line);
      },
    },
    {
      def: {
        name: "search_repo_code",
        description:
          "GitHub リポジトリ内のコードをキーワード検索し、一致したファイルパスを返す。" +
          "関数名・識別子・文言などから該当箇所を素早く見つけたい時に使う（その後 read_repo_file で読む）。" +
          "モノレポでヒットが散らばる時は path（例: packages/foo）で検索範囲を該当パッケージに絞る。",
        parameters: {
          type: "object",
          properties: {
            ...repoProp,
            query: { type: "string", description: "検索キーワード（関数名・識別子・文言など）" },
            path: { type: "string", description: "検索範囲を絞るサブディレクトリ（例: packages/foo・任意）" },
          },
          required: ["query"],
        },
      },
      async run(input) {
        const { repo, query, path } = (input ?? {}) as { repo?: string; query?: string; path?: string };
        if (!query) return "（検索語が空でした）";
        const r = gh.resolveRepo(repo);
        if ("error" in r) return `（${r.error}）`;
        return gh.searchCode(r.repo, query, path);
      },
    },
  ];
}
