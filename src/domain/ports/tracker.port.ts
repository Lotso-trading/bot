import type { DetectedTrade, TargetTrader } from "@polymarket-copy/shared";

export type OnTradeCallback = (trade: DetectedTrade) => Promise<void>;

export interface ITrackerPort {
  start(targets: TargetTrader[], onTrade: OnTradeCallback): Promise<void>;
  updateTargets(targets: TargetTrader[]): void;
  stop(): Promise<void>;
}
