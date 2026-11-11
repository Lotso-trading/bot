import type { DetectedTrade, TargetTrader } from "@polymarket-copy/shared";
import { ReplicateTradeUseCase } from "../application/use-cases/replicate-trade.use-case.ts";
import { type BotRuntimeConfig, loadBotConfig } from "../config/bot.config.ts";
import { ApiBackendClientAdapter } from "../infrastructure/adapters/api-backend-client.adapter.ts";
import { ApiWebSocketClientAdapter } from "../infrastructure/adapters/api-websocket-client.adapter.ts";
import { DiscordWebhookAdapter } from "../infrastructure/adapters/discord-webhook.adapter.ts";
import { DryRunExecutorAdapter } from "../infrastructure/adapters/dry-run-executor.adapter.ts";
import { HybridTrackerAdapter } from "../infrastructure/adapters/hybrid-tracker.adapter.ts";
import { PolygonRpcTrackerAdapter } from "../infrastructure/adapters/polygon-rpc-tracker.adapter.ts";
import { PolymarketApiTrackerAdapter } from "../infrastructure/adapters/polymarket-api-tracker.adapter.ts";
import { PolymarketClobAdapter } from "../infrastructure/adapters/polymarket-clob.adapter.ts";

export class BotRunner {
  private config: BotRuntimeConfig;
  private isRunning = false;
  private tracker: HybridTrackerAdapter | null = null;
  private targetMap: Map<string, TargetTrader> = new Map();
  private wsClient: ApiWebSocketClientAdapter | null = null;

  constructor() {
    this.config = loadBotConfig();
  }

  async start(): Promise<void> {
    console.log("=================================================");
    console.log("🚀 Démarrage de Lotso Copy-Trading Bot");
    console.log(
      `Mode d'exécution : ${this.config.dryRun ? "PAPER TRADING (SIMULATION)" : "LIVE CLOB RÉEL"}`
    );
    console.log("=================================================");

    this.isRunning = true;

    const apiClient = new ApiBackendClientAdapter(this.config.apiInternalUrl);
    const notifier = new DiscordWebhookAdapter({
      buyWebhookUrl: this.config.discordBuyWebhookUrl,
      sellWebhookUrl: this.config.discordSellWebhookUrl,
      closedPositionsWebhookUrl: this.config.discordClosedPositionsWebhookUrl,
    });

    // Connexion WebSocket persistante à l'API pour les événements temps réel & présence
    this.wsClient = new ApiWebSocketClientAdapter(this.config.apiWsUrl);
    this.wsClient.connect();

    // Réaction instantanée (0 ms) dès qu'une cible est créée, modifiée ou supprimée
    this.wsClient.onTargetChange(async () => {
      console.log("[BotRunner] Notification WebSocket de changement de cibles, mise à jour...");
      await this.refreshTargets(apiClient);
      if (this.tracker) {
        this.tracker.updateTargets(Array.from(this.targetMap.values()));
      }
    });

    // Sélection de l'exécuteur selon le mode configuré
    const executor = this.config.dryRun
      ? new DryRunExecutorAdapter(
          this.config.polymarketClobApiUrl,
          this.config.defaultSimulatedBalanceUsdc,
          () => apiClient.getAllOpenPositions(),
          async () => {
            const m = await apiClient.getMetrics();
            return m?.availableCashUsdc;
          }
        )
      : new PolymarketClobAdapter(
          this.config.polymarketClobApiUrl,
          this.config.polymarketPrivateKey,
          this.config.polymarketSignatureType,
          this.config.polymarketFunderAddress
        );

    const replicateUseCase = new ReplicateTradeUseCase(apiClient, executor, notifier);

    // Initialisation des trackers
    const apiTracker = new PolymarketApiTrackerAdapter(
      this.config.polymarketDataApiUrl,
      this.config.pollingIntervalMs
    );
    const polygonTracker = new PolygonRpcTrackerAdapter(
      this.config.polygonRpcUrl,
      this.config.ctfExchangeAddress,
      this.config.polygonWsRpcUrl
    );

    this.tracker = new HybridTrackerAdapter(apiTracker, polygonTracker);

    // Chargement initial des cibles depuis l'API
    await this.refreshTargets(apiClient);

    // Callback déclenché à chaque détection de trade
    const onTradeDetected = async (trade: DetectedTrade): Promise<void> => {
      const target = this.targetMap.get(trade.targetAddress.toLowerCase());
      if (!target?.enabled) return;

      console.log(
        `\n[Signal] Trade détecté pour ${target.alias} sur ${trade.source} : ${trade.side} ${trade.sizeShares} parts @ ${trade.price.toFixed(3)} USDC`
      );

      try {
        await replicateUseCase.execute(trade, target);
      } catch (err: unknown) {
        console.error(`[Signal] Erreur critique lors de la réplication:`, err);
        await notifier.sendErrorAlert(
          "Erreur d'exécution de trade",
          err instanceof Error ? err.stack || err.message : String(err)
        );
      }
    };

    const initialTargets = Array.from(this.targetMap.values());
    await this.tracker.start(initialTargets, onTradeDetected);

    this.setupGracefulShutdown(apiClient);
  }

  private async refreshTargets(apiClient: ApiBackendClientAdapter): Promise<void> {
    const targets = await apiClient.getActiveTargets();
    this.targetMap.clear();
    for (const t of targets) {
      this.targetMap.set(t.address.toLowerCase(), t);
      if (t.proxyAddress) {
        this.targetMap.set(t.proxyAddress.toLowerCase(), t);
      }
    }
  }

  private setupGracefulShutdown(apiClient: ApiBackendClientAdapter): void {
    const shutdown = async () => {
      if (!this.isRunning) return;
      console.log("\n[BotRunner] Signal d'arrêt reçu, fermeture propre...");
      this.isRunning = false;
      if (this.wsClient !== null) {
        this.wsClient.disconnect();
        this.wsClient = null;
      }
      try {
        await apiClient.sendShutdown();
      } catch (_err: unknown) {
        // Ignoré lors de la fermeture
      }
      if (this.tracker) {
        await this.tracker.stop();
      }
      Deno.exit(0);
    };

    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);
  }
}
