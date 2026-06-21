import { AwsClient } from "aws4fetch";
import type { S3Config } from "./config.ts";

// S3 互換ストレージ（R2 / S3 / GCS）への最小アクセス。
// mdcollab の storage/s3.ts と同じ aws4fetch（Web 標準 fetch）方式だが、
// 取り込みに必要な list を足してある（mdcollab 側には get/put/remove しかない）。

export class S3Client {
  private client: AwsClient;
  constructor(private cfg: S3Config) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: "s3",
    });
  }

  private base(): string {
    return `${this.cfg.endpoint}/${this.cfg.bucket}`;
  }

  /** ListObjectsV2 を継続トークンで辿り、全オブジェクトキーを返す。 */
  async listKeys(prefix = this.cfg.prefix): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const u = new URL(this.base());
      u.searchParams.set("list-type", "2");
      if (prefix) u.searchParams.set("prefix", prefix);
      if (token) u.searchParams.set("continuation-token", token);
      const res = await this.client.fetch(u.toString());
      if (!res.ok) throw new Error(`S3 list failed: ${res.status} ${await res.text()}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
        keys.push(unescapeXml(m[1]!));
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] : undefined;
    } while (token);
    return keys;
  }

  async get(key: string): Promise<string> {
    const res = await this.client.fetch(`${this.base()}/${encodeURI(key)}`);
    if (!res.ok) throw new Error(`S3 get failed: ${res.status} (${key})`);
    return res.text();
  }

  /** オブジェクトを PUT する（issue ナレッジの配置に使う）。 */
  async put(key: string, body: string, contentType = "text/markdown; charset=utf-8"): Promise<void> {
    const res = await this.client.fetch(`${this.base()}/${encodeURI(key)}`, {
      method: "PUT",
      body,
      headers: { "Content-Type": contentType },
    });
    if (!res.ok) throw new Error(`S3 put failed: ${res.status} ${await res.text()} (${key})`);
  }

  /** キーの存在確認（HEAD）。tombstone（_stale への隔離済み）判定に使う。 */
  async exists(key: string): Promise<boolean> {
    const res = await this.client.fetch(`${this.base()}/${encodeURI(key)}`, { method: "HEAD" });
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw new Error(`S3 head failed: ${res.status} (${key})`);
  }
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
