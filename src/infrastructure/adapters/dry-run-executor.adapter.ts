import type { DetectedTrade, ExecutedTrade, OpenPosition } from "@polymarket-copy/shared";
import axios from "axios";
import type { IExecutorPort } from "../../domain/ports/executor.port.ts";

export class DryRunExecutorAdapter implements IExecutorPort {
  private simulatedBalanceUsdc: number;
  private readonly initialBalance: number;

  constructor(
    private readonly clobApiUrl: string,
    initialBalance = 1000.0,
    private readonly getOpenPositionsCallback?: () => Promise<OpenPosition[]>,
    private readonly getAvailableBalanceCallback?: () => Promise<number | null | undefined>
  ) {
    this.initialBalance = initialBalance;
    this.simulatedBalanceUsdc = initialBalance;
  }

  async getAvailableBalanceUsdc(): Promise<number> {
    if (this.getAvailableBalanceCallback) {
      try {
        const bal = await this.getAvailableBalanceCallback();
        if (typeof bal === "number" && !Number.isNaN(bal) && bal >= 0) {
          this.simulatedBalanceUsdc = bal;
          return bal;
        }
      } catch (_err: unknown) {
        // Fallback sur positions ou mémoire
      }
    }

    if (this.getOpenPositionsCallback) {
      try {
        const positions = await this.getOpenPositionsCallback();
        const totalInvested = positions.reduce((sum, p) => sum + (p.totalInvestedUsdc || 0), 0);
        return Math.max(0, this.initialBalance - totalInvested);
      } catch (_err: unknown) {
        // Fallback sur le solde mémoire
      }
    }
    return this.simulatedBalanceUsdc;
  }

  async getCurrentBestPrice(conditionId: string, side: "BUY" | "SELL"): Promise<number | null> {
    try {
      const res = await axios.get<{ price?: string | number }>(`${this.clobApiUrl}/price`, {
        params: { token_id: conditionId, side: side.toLowerCase() },
        timeout: 3000,
      });
      if (res.data?.price) {
        return Number(res.data.price);
      }
    } catch (_err: unknown) {
      // Si le carnet est momentanément indisponible, on renvoie null
    }
    return null;
  }

  async executeBuy(trade: DetectedTrade, sizeUsdc: number): Promise<ExecutedTrade> {
    const marketPrice = (await this.getCurrentBestPrice(trade.conditionId, "BUY")) ?? trade.price;
    // Simulation d'un micro-slippage de marché (0.2%)
    const executedPrice = Math.min(0.99, marketPrice * 1.002);
    const shares = Math.floor((sizeUsdc / executedPrice) * 100) / 100;
    const actualCost = Math.round(shares * executedPrice * 100) / 100;
    const slippagePercent = ((executedPrice - trade.price) / trade.price) * 100;

    this.simulatedBalanceUsdc = Math.max(0, this.simulatedBalanceUsdc - actualCost);

    return {
      id: `sim_buy_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      detectedTradeId: trade.id,
      targetAddress: trade.targetAddress,
      conditionId: trade.conditionId,
      marketSlug: trade.marketSlug,
      marketQuestion: trade.marketQuestion,
      outcomeLabel: trade.outcomeLabel,
      endDate: trade.endDate,
      side: "BUY",
      targetPrice: trade.price,
      executedPrice,
      slippagePercent,
      shares,
      costUsdc: actualCost,
      status: "FILLED",
      isDryRun: true,
      executedAt: Date.now(),
    };
  }

  async executeSell(
    position: OpenPosition,
    sharesToSell: number,
    marketPrice: number,
    targetAddress: string
  ): Promise<ExecutedTrade> {
    const executedPrice = Math.max(0.01, marketPrice * 0.998); // Micro slippage vente
    const proceeds = Math.round(sharesToSell * executedPrice * 100) / 100;

    this.simulatedBalanceUsdc += proceeds;

    return {
      id: `sim_sell_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      detectedTradeId: `exit_${position.conditionId}_${Date.now()}`,
      targetAddress,
      conditionId: position.conditionId,
      marketSlug: position.marketSlug,
      marketQuestion: position.marketQuestion,
      outcomeLabel: position.outcomeLabel,
      side: "SELL",
      targetPrice: marketPrice,
      executedPrice,
      slippagePercent: 0,
      shares: sharesToSell,
      costUsdc: proceeds,
      status: "FILLED",
      isDryRun: true,
      executedAt: Date.now(),
    };
  }
}
