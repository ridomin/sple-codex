import type { ProviderId } from './capabilities.js'
import type { Provider } from './provider.js'
import { UsageError } from './errors.js'

export interface ProviderRegistration { id: ProviderId, displayName: string, create: () => Provider }
export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderRegistration>()
  register (entry: ProviderRegistration): void {
    if (this.entries.has(entry.id)) throw new UsageError(`Provider already registered: ${entry.id}`)
    this.entries.set(entry.id, entry)
  }

  list (): ProviderRegistration[] { return [...this.entries.values()] }
  get (id: string): ProviderRegistration {
    const entry = this.entries.get(id)
    if (entry == null) throw new UsageError(`Unknown provider '${id}'. Valid providers: ${this.list().map(e => e.id).join(', ')}`)
    return entry
  }
}
