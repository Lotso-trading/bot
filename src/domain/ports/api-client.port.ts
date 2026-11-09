import type {
  ExecutedTrade,
  OpenPosition,
  RiskConfig,
  TargetTrader,
} from "@polymarket-copy/shared";

export interface IApiClientPort {
  getActiveTargets(): Promise<TargetTrader[]>;
  getBotConfig(): Promise<RiskConfig & { isBotRunning: boolean }>;
  getOpenPosition(conditionId: string): Promise<OpenPosition | null>;
  getAllOpenPositions(): Promise<OpenPosition[]>;
  recordTrade(trade: ExecutedTrade): Promise<ExecutedTrade>;
}
