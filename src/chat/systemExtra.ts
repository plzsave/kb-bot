import type { S3Client } from "../s3.ts";

// 追加システムプロンプト（運用者がコード外で与える指示）の解決を担う。
// 狙いは「コードを書き換えず・再デプロイせずにプロンプトを微調整できる」こと。
// fly.io/ECS のようにファイルや env を手で触りにくい環境でも、R2/S3 のオブジェクトを
// 書き換えるだけで反映される。毎リクエストでバケットを叩かないよう TTL でキャッシュする。

export interface SystemExtraOptions {
  /** インライン指定（KB_SYSTEM_PROMPT_EXTRA）。設定時は S3 を見ず最優先で使う＝ローカル/簡易検証向き。 */
  inline?: string;
  /** バケットから取得する場合のクライアント。 */
  s3?: S3Client;
  /** 取得するオブジェクトキー（例 _config/system-prompt.md）。 */
  key?: string;
  /** バケット取得のメモリキャッシュ TTL（ms）。既定 60 秒。0 で毎回取得。 */
  ttlMs?: number;
}

/**
 * 追加システムプロンプトの解決関数を作る。優先順位は inline > S3 オブジェクト > 空文字。
 * S3 取得は TTL キャッシュ越しなので、バケットを書き換えれば最長 ttlMs 後に再起動なしで反映される。
 */
export function createSystemExtraResolver(opts: SystemExtraOptions): () => Promise<string> {
  const inline = opts.inline?.trim();
  if (inline) return async () => inline; // インライン優先：S3 は見ない

  const { s3, key } = opts;
  if (!s3 || !key) return async () => ""; // 取得先が無ければ追加なし（＝内蔵ベースのみ）

  const ttlMs = opts.ttlMs ?? 60_000;
  let cache = "";
  let fetchedAt = 0;
  return async () => {
    const now = Date.now();
    if (fetchedAt && now - fetchedAt < ttlMs) return cache;
    try {
      cache = (await s3.get(key)).trim();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      // 404 = オブジェクト未配置＝「追加指示なし」。その他（ネットワーク等の一時失敗）は
      // 前回値を維持し、取りこぼしで追加指示が突然消える事故を避ける。
      if (/failed:\s*404/.test(msg)) cache = "";
    }
    fetchedAt = now;
    return cache;
  };
}
