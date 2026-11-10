import type { TargetTrader } from "@polymarket-copy/shared";
import { ethers } from "ethers";
import type { ITrackerPort, OnTradeCallback } from "../../domain/ports/tracker.port.ts";

export class PolygonRpcTrackerAdapter implements ITrackerPort {
  private targetAddresses: Set<string> = new Set();
  private isRunning = false;
  private provider: ethers.JsonRpcProvider | null = null;
  private wsProvider: ethers.WebSocketProvider | null = null;

  // Topic standard de l'événement OrderFilled sur les contrats CTF Polymarket V2
  private readonly orderFilledTopic =
    "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";

  constructor(
    private readonly rpcUrl: string,
    private readonly exchangeAddress: string,
    private readonly wsRpcUrl?: string
  ) {}

  async start(targets: TargetTrader[], onTrade: OnTradeCallback): Promise<void> {
    this.updateTargets(targets);
    this.isRunning = true;

    // Priorité 1 : Connexion WebSocket native (0 latence, 100% push)
    if (
      this.wsRpcUrl &&
      (this.wsRpcUrl.startsWith("ws://") || this.wsRpcUrl.startsWith("wss://"))
    ) {
      try {
        this.wsProvider = new ethers.WebSocketProvider(this.wsRpcUrl);
        console.log(`[PolygonRpcTracker] Connecté au flux WebSocket Polygon (${this.wsRpcUrl})`);

        const filter = {
          address: this.exchangeAddress,
          topics: [this.orderFilledTopic],
        };

        this.wsProvider.on(filter, (log: ethers.Log) => {
          if (!this.isRunning) return;
          this.handleLog(log, onTrade);
        });
        return;
      } catch (err: unknown) {
        console.warn(
          "[PolygonRpcTracker] Échec connexion WebSocket Polygon, bascule sur provider d'événements:",
          err
        );
      }
    }

    // Priorité 2 : Abonnement réactif sur les blocs minés via ethers.on('block') (sans setInterval)
    try {
      this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
      console.log(`[PolygonRpcTracker] Connecté au RPC Polygon (${this.rpcUrl})`);

      let lastBlock = await this.provider.getBlockNumber();

      this.provider.on("block", async (currentBlock: number) => {
        if (!this.isRunning || !this.provider) return;
        try {
          if (currentBlock <= lastBlock) return;

          const logs = await this.provider.getLogs({
            address: this.exchangeAddress,
            topics: [this.orderFilledTopic],
            fromBlock: lastBlock + 1,
            toBlock: currentBlock,
          });

          lastBlock = currentBlock;

          for (const log of logs) {
            this.handleLog(log, onTrade);
          }
        } catch (_err: unknown) {
          // Erreur RPC temporaire ignorée
        }
      });
    } catch (err: unknown) {
      console.warn("[PolygonRpcTracker] Impossible d'initialiser le provider RPC Polygon:", err);
    }
  }

  updateTargets(targets: TargetTrader[]): void {
    this.targetAddresses.clear();
    for (const t of targets) {
      if (t.enabled) {
        this.targetAddresses.add(t.address.toLowerCase());
        if (t.proxyAddress) {
          this.targetAddresses.add(t.proxyAddress.toLowerCase());
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.wsProvider) {
      try {
        await this.wsProvider.destroy();
      } catch (_err: unknown) {
        // Ignoré
      }
      this.wsProvider = null;
    }
    if (this.provider) {
      try {
        this.provider.removeAllListeners();
      } catch (_err: unknown) {
        // Ignoré
      }
      this.provider = null;
    }
    console.log("[PolygonRpcTracker] Arrêt de l'écouteur Polygon RPC");
  }

  private handleLog(log: ethers.Log, _onTrade: OnTradeCallback): void {
    try {
      // Les indexés sont dans topics: topic[1] = maker, topic[2] = taker
      const maker = log.topics[1] ? ethers.dataSlice(log.topics[1], 12).toLowerCase() : "";
      const taker = log.topics[2] ? ethers.dataSlice(log.topics[2], 12).toLowerCase() : "";

      const matchedTarget = this.targetAddresses.has(maker)
        ? maker
        : this.targetAddresses.has(taker)
          ? taker
          : null;

      if (!matchedTarget) return;

      // Note de sécurité : L'événement OrderFilled on-chain nécessite un décodage complet de l'ABI
      // (extraction de makerAssetId / takerAssetId) et une résolution du conditionId via le token ID.
      // Émettre un trade mocké avec log.address comme conditionId crée des positions fantômes corrompues.
      // En attendant le décodeur ABI complet, nous loggons la détection sans émettre d'ordre fictif.
      console.log(
        `[PolygonRpcTracker] Événement on-chain détecté pour ${matchedTarget} (tx: ${log.transactionHash.slice(0, 10)}...) - Décodage ABI en attente`
      );
    } catch (_err: unknown) {
      // Ignoré
    }
  }
}
