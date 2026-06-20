import { writeFileSync } from "node:fs";

// 死活監視用ハートビート。一定間隔でファイルの mtime を更新する。
// Docker の HEALTHCHECK がこの鮮度を見て「プロセスは生きているが固まっている」状態を検知できる
// （クラッシュは exit → restart で拾えるが、ハングはイベントループが止まりこの更新も止まる）。
export function startHeartbeat(
  path = process.env.KB_HEARTBEAT_FILE ?? "/tmp/kb-bot.heartbeat",
  intervalMs = 30_000,
): void {
  const beat = () => {
    try {
      writeFileSync(path, String(Date.now()));
    } catch {
      /* 書けない環境でも本体は止めない */
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  if (typeof timer.unref === "function") timer.unref(); // プロセス終了を妨げない
}
