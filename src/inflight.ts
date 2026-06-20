// 同一ユーザーの多重実行ガード（メモリ内）。コード読解は高コストなので、ある利用者の質問を
// 処理中に、その人の次の質問を弾く（イベント二重配信・連投の暴発を防ぐ）。プロセス内のみ・常駐前提。

export class InFlightGuard {
  private active = new Set<string>();

  /** key（利用者ID等）を確保できれば true。既に処理中なら false。 */
  tryAcquire(key: string): boolean {
    if (this.active.has(key)) return false;
    this.active.add(key);
    return true;
  }

  release(key: string): void {
    this.active.delete(key);
  }
}
