import type { DetectedTrade, TargetTrader } from "@polymarket-copy/shared";
import type { ITrackerPort, OnTradeCallback } from "../../domain/ports/tracker.port.ts";
import { Deduplicator } from "../deduplication/deduplicator.ts";
import type { PolygonRpcTrackerAdapter } from "./polygon-rpc-tracker.adapter.ts";
import type { PolymarketApiTrackerAdapter } from "./polymarket-api-tracker.adapter.ts";

export class HybridTrackerAdapter implements ITrackerPort {
  private readonly deduplicator = new Deduplicator();

  constructor(
    private readonly apiTracker: PolymarketApiTrackerAdapter,
    private readonly polygonTracker: PolygonRpcTrackerAdapter
  ) {}

  async start(targets: TargetTrader[], onTrade: OnTradeCallback): Promise<void> {
    const safeCallback: OnTradeCallback = async (trade: DetectedTrade) => {
      // Clé unique de déduplication : hash de transaction ou ID
      const dedupKey = trade.transactionHash || trade.id;
      if (this.deduplicator.isDuplicate(dedupKey)) {
        return;
      }
      this.deduplicator.markProcessed(dedupKey);

      await onTrade(trade);
    };

    await Promise.all([
      this.apiTracker.start(targets, safeCallback),
      this.polygonTracker.start(targets, safeCallback),
    ]);
  }

  updateTargets(targets: TargetTrader[]): void {
    this.apiTracker.updateTargets(targets);
    this.polygonTracker.updateTargets(targets);
  }

  async stop(): Promise<void> {
    await Promise.all([this.apiTracker.stop(), this.polygonTracker.stop()]);
  }
}
