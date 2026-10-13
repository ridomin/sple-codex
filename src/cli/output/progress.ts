export class Progress {
  private last = -Infinity; private visible = false;
  constructor(private readonly enabled: boolean, private readonly write: (s: string) => void, private readonly now: () => number = Date.now) {}
  update(label: string, count: number, total?: number): void {
    if (!this.enabled || this.now() - this.last < 100) return;
    this.last = this.now(); this.visible = true;
    const fill = total ? Math.min(10, Math.floor(count / total * 10)) : 0;
    this.write(`\r\u001b[2K${label} ${total !== undefined ? `[${'#'.repeat(fill)}${'-'.repeat(10 - fill)}] ${count}/${total}` : `⠋ ${count}`}`);
  }
  clear(): void { if (this.visible) this.write('\r\u001b[2K'); this.visible = false; }
}
