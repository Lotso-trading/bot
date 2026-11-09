import type {
  ExecutedTrade,
  OpenPosition,
  RiskConfig,
  TargetTrader,
} from "@polymarket-copy/shared";
import axios from "axios";
import type { IApiClientPort } from "../../domain/ports/api-client.port.ts";

export class ApiBackendClientAdapter implements IApiClientPort {
  private lastKnownPositions: OpenPosition[] = [];

  constructor(private readonly baseUrl: string) {}

  async getActiveTargets(): Promise<TargetTrader[]> {
    try {
      const res = await axios.get<{ success: boolean; data: TargetTrader[] }>(
        `${this.baseUrl}/api/targets`,
        { timeout: 5000 }
      );
      if (res.data?.success && Array.isArray(res.data.data)) {
        return res.data.data.filter((t) => t.enabled);
      }
      return [];
    } catch (err: unknown) {
      console.warn("[ApiClient] Impossible de récupérer les cibles depuis l'API:", err);
      return [];
    }
  }

  async getBotConfig(): Promise<RiskConfig & { isBotRunning: boolean }> {
    try {
      const res = await axios.get<{
        success: boolean;
        data: RiskConfig & { isBotRunning: boolean };
      }>(`${this.baseUrl}/api/config`, { timeout: 5000 });
      if (res.data?.success && res.data.data) {
        return res.data.data;
      }
    } catch (err: unknown) {
      console.warn(
        "[ApiClient] Impossible de récupérer la config depuis l'API, utilisation du fallback:",
        err
      );
    }

    return {
      balancePercentPerTrade: 0.03,
      maxSlippagePercent: 2.0,
      maxCapPerTradeUsdc: 50.0,
      maxExposurePerMarketUsdc: 150.0,
      maxExposurePerTargetUsdc: 300.0,
      minCashReserveUsdc: 5.0,
      minPrice: 0.05,
      maxPrice: 0.9,
      copySellOrders: true,
      dryRun: true,
      isBotRunning: true,
    };
  }

  async getAllOpenPositions(): Promise<OpenPosition[]> {
    try {
      const res = await axios.get<{ success: boolean; data: OpenPosition[] }>(
        `${this.baseUrl}/api/positions`,
        { timeout: 5000 }
      );
      if (res.data?.success && Array.isArray(res.data.data)) {
        this.lastKnownPositions = res.data.data;
        return res.data.data;
      }
      return this.lastKnownPositions;
    } catch (err: unknown) {
      console.warn(
        "[ApiClient] Échec de récupération des positions ouvertes (utilisation du cache de sécurité):",
        err instanceof Error ? err.message : String(err)
      );
      return this.lastKnownPositions;
    }
  }

  async getOpenPosition(conditionId: string): Promise<OpenPosition | null> {
    const positions = await this.getAllOpenPositions();
    return positions.find((p) => p.conditionId === conditionId) || null;
  }

  async recordTrade(trade: ExecutedTrade): Promise<ExecutedTrade> {
    try {
      const res = await axios.post<{ success: boolean; data: ExecutedTrade }>(
        `${this.baseUrl}/api/trades`,
        trade,
        { timeout: 5000 }
      );
      if (res.data?.success && res.data.data) {
        return res.data.data;
      }
      return trade;
    } catch (err: unknown) {
      console.warn("[ApiClient] Erreur lors de l'enregistrement du trade sur l'API:", err);
      return trade;
    }
  }
}
