export class Deduplicator {
  private readonly seenIds: Set<string> = new Set();
  private readonly maxEntries: number;

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
  }

  isDuplicate(key: string): boolean {
    return this.seenIds.has(key);
  }

  markProcessed(key: string): void {
    if (this.seenIds.size >= this.maxEntries) {
      // Nettoyage des plus anciennes clés
      const firstEntry = this.seenIds.values().next().value;
      if (firstEntry) {
        this.seenIds.delete(firstEntry);
      }
    }
    this.seenIds.add(key);
  }

  clear(): void {
    this.seenIds.clear();
  }
}
