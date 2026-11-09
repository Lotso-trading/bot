import type { DetectedTrade, ExecutedTrade, OpenPosition } from "@polymarket-copy/shared";

export interface IExecutorPort {
  executeBuy(trade: DetectedTrade, sizeUsdc: number): Promise<ExecutedTrade>;
  executeSell(
    position: OpenPosition,
    sharesToSell: number,
    marketPrice: number,
    targetAddress: string
  ): Promise<ExecutedTrade>;
  getAvailableBalanceUsdc(): Promise<number>;
  getCurrentBestPrice(conditionId: string, side: "BUY" | "SELL"): Promise<number | null>;
}
