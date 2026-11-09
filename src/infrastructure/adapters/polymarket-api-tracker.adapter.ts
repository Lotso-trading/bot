import {
  type DetectedTrade,
  PolymarketRawActivityTradeSchema,
  type TargetTrader,
} from "@polymarket-copy/shared";
import axios from "axios";
import type { ITrackerPort, OnTradeCallback } from "../../domain/ports/tracker.port.ts";

export class PolymarketApiTrackerAdapter implements ITrackerPort {
  private targets: TargetTrader[] = [];
  private isRunning = false;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCheckedTimestamp = Date.now() - 60000; // 1 minute dans le passé

  constructor(
    private readonly dataApiUrl: string,
    private readonly intervalMs = 500
  ) {}

  async start(targets: TargetTrader[], onTrade: OnTradeCallback): Promise<void> {
    this.targets = targets.filter((t) => t.enabled);
    this.isRunning = true;

    console.log(
      `[ApiTracker] Démarrage du tracking sur ${this.targets.length} cible(s) (polling ${this.intervalMs}ms)`
    );

    this.runLoop(onTrade);
  }

  updateTargets(targets: TargetTrader[]): void {
    this.targets = targets.filter((t) => t.enabled);
    console.log(`[ApiTracker] Liste des cibles mise à jour: ${this.targets.length} active(s)`);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.intervalTimer !== null) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    console.log("[ApiTracker] Arrêt du tracker");
  }

  private async runLoop(onTrade: OnTradeCallback): Promise<void> {
    if (!this.isRunning) return;

    try {
      for (const target of this.targets) {
        await this.checkTargetActivity(target, onTrade);
      }
    } catch (err: unknown) {
      console.warn("[ApiTracker] Erreur dans la boucle de polling:", err);
    }

    if (this.isRunning) {
      this.intervalTimer = setTimeout(() => this.runLoop(onTrade), this.intervalMs);
    }
  }

  private async checkTargetActivity(target: TargetTrader, onTrade: OnTradeCallback): Promise<void> {
    try {
      const address = target.proxyAddress || target.address;
      const baseUrl = this.dataApiUrl.includes("/v2")
        ? this.dataApiUrl
        : `${this.dataApiUrl.replace(/\/$/, "")}/v2`;

      const res = await axios.get<{ data?: unknown[] } | unknown[]>(`${baseUrl}/activity`, {
        params: {
          user: address,
          limit: 10,
        },
        timeout: 4000,
      });

      const rawItems = Array.isArray(res.data)
        ? res.data
        : Array.isArray((res.data as { data?: unknown[] })?.data)
          ? (res.data as { data: unknown[] }).data
          : [];

      if (!rawItems || rawItems.length === 0) return;

      for (const item of rawItems) {
        const parsed = PolymarketRawActivityTradeSchema.safeParse(item);
        if (!parsed.success) continue;

        const raw = parsed.data;
        // Normalisation timestamp secondes -> millisecondes si besoin
        const timestampMs = raw.timestamp < 10000000000 ? raw.timestamp * 1000 : raw.timestamp;
        if (timestampMs <= this.lastCheckedTimestamp) continue;

        const marketSlug = raw.slug || raw.market?.slug || "polymarket-market";
        const marketQuestion = raw.title || raw.market?.question || "Question inconnue";
        const conditionId =
          raw.condition_id || raw.conditionId || raw.asset || raw.token_id || target.address;
        const txHash = raw.transaction_hash || raw.transactionHash;
        const endDate = raw.endDate || raw.end_date_iso || raw.game_start_time;

        const detected: DetectedTrade = {
          id: `det_${raw.id || txHash || `${address}_${timestampMs}`}`,
          targetAddress: target.address,
          marketSlug,
          marketQuestion,
          conditionId,
          endDate,
          assetAddress: raw.asset || target.address,
          outcomeIndex: raw.outcome_index ?? raw.outcomeIndex ?? 0,
          outcomeLabel: raw.outcome || "Yes",
          side: raw.side === "SELL" ? "SELL" : "BUY",
          price: raw.price > 0 && raw.price < 1 ? raw.price : 0.5,
          sizeShares: raw.size > 0 ? raw.size : 10,
          sizeUsdc:
            raw.usdc_size ||
            raw.usdcSize ||
            (raw.size > 0 && raw.price > 0 ? raw.size * raw.price : 5),
          transactionHash: txHash,
          detectedAt: timestampMs,
          source: "POLYMARKET_API",
        };

        this.lastCheckedTimestamp = Math.max(this.lastCheckedTimestamp, timestampMs);
        await onTrade(detected);
      }
    } catch (_err: unknown) {
      // Échec temporaire ignoré (rate limit ou réseau)
    }
  }
}
