import type { QuotaCost, QuotaModel } from '../provider/capabilities.js'
import { QuotaExhaustedError, UsageError } from '../provider/errors.js'

/** Per-process budget accounting. Persistent provider ledgers are introduced with M4. */
export class QuotaLimiter {
  private readonly spent = new Map<string, { day: string, amount: number }>()
  constructor (private readonly model: QuotaModel, private readonly now: () => number = Date.now) {}
  consume (costs: QuotaCost[]): void {
    if (this.model.kind !== 'daily-buckets') return
    const additions = new Map<string, number>()
    for (const cost of costs) {
      if (!Number.isFinite(cost.amount) || cost.amount < 0) throw new UsageError('Quota cost must be non-negative')
      additions.set(cost.bucket, (additions.get(cost.bucket) ?? 0) + cost.amount)
    }
    const updates: Array<[string, { day: string, amount: number }]> = []
    for (const [id, amount] of additions) {
      const bucket = this.model.buckets.find(b => b.id === id)
      if (bucket == null) throw new UsageError(`Unknown quota bucket: ${id}`)
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: bucket.resetTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now())
      const previous = this.spent.get(id)
      const total = (previous?.day === day ? previous.amount : 0) + amount
      if (total > bucket.dailyLimit) throw new QuotaExhaustedError(id)
      updates.push([id, { day, amount: total }])
    }
    // Validate all buckets before debiting any; a refused call consumes nothing.
    for (const [id, value] of updates) this.spent.set(id, value)
  }
}
