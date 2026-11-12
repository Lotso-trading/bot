import type { RiskConfig } from "@polymarket-copy/shared";

interface WsEventMessage {
  event?: string;
  data?: unknown;
}

export type TargetChangeCallback = () => void | Promise<void>;
export type ConfigChangeCallback = (config: RiskConfig) => void | Promise<void>;
export type PositionClosedCallback = (data: {
  conditionId: string;
  closeReason?: string;
  settledPayoutUsdc?: number;
}) => void | Promise<void>;

export class ApiWebSocketClientAdapter {
  private socket: WebSocket | null = null;
  private isRunning = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private targetChangeCallbacks: Set<TargetChangeCallback> = new Set();
  private configChangeCallbacks: Set<ConfigChangeCallback> = new Set();
  private positionClosedCallbacks: Set<PositionClosedCallback> = new Set();

  constructor(private readonly wsUrl: string) {}

  connect(): void {
    this.isRunning = true;
    this.initSocket();
  }

  private initSocket(): void {
    if (!this.isRunning) return;

    try {
      // Connexion avec identification role=bot
      const url = this.wsUrl.includes("?") ? `${this.wsUrl}&role=bot` : `${this.wsUrl}?role=bot`;

      this.socket = new WebSocket(url);

      this.socket.onopen = () => {
        console.log(`[BotWsClient] Connecté au flux temps réel de l'API (${url})`);
        // Identification explicite par message
        try {
          this.socket?.send(JSON.stringify({ event: "bot:identify", role: "bot" }));
        } catch (_err: unknown) {
          // Ignoré
        }
      };

      this.socket.onmessage = async (event: MessageEvent) => {
        try {
          const payload = JSON.parse(String(event.data)) as WsEventMessage;
          if (!payload?.event) return;

          if (
            payload.event === "target:created" ||
            payload.event === "target:updated" ||
            payload.event === "target:deleted"
          ) {
            console.log(`[BotWsClient] Événement cibles reçu : ${payload.event}`);
            for (const cb of this.targetChangeCallbacks) {
              await cb();
            }
          } else if (payload.event === "config:updated" && payload.data) {
            for (const cb of this.configChangeCallbacks) {
              await cb(payload.data as RiskConfig);
            }
          } else if (payload.event === "position:closed" && payload.data) {
            const data = payload.data as {
              conditionId: string;
              closeReason?: string;
              settledPayoutUsdc?: number;
            };
            for (const cb of this.positionClosedCallbacks) {
              await cb(data);
            }
          }
        } catch (err: unknown) {
          console.warn("[BotWsClient] Erreur parsing message WebSocket:", err);
        }
      };

      this.socket.onclose = () => {
        this.socket = null;
        if (this.isRunning) {
          console.log("[BotWsClient] Connexion perdue, tentative de reconnexion dans 3s...");
          this.scheduleReconnect();
        }
      };

      this.socket.onerror = () => {
        this.socket?.close();
      };
    } catch (_err: unknown) {
      this.scheduleReconnect();
    }
  }

  onTargetChange(callback: TargetChangeCallback): () => void {
    this.targetChangeCallbacks.add(callback);
    return () => {
      this.targetChangeCallbacks.delete(callback);
    };
  }

  onConfigChange(callback: ConfigChangeCallback): () => void {
    this.configChangeCallbacks.add(callback);
    return () => {
      this.configChangeCallbacks.delete(callback);
    };
  }

  onPositionClosed(callback: PositionClosedCallback): () => void {
    this.positionClosedCallbacks.add(callback);
    return () => {
      this.positionClosedCallbacks.delete(callback);
    };
  }

  disconnect(): void {
    this.isRunning = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_err: unknown) {
        // Ignoré
      }
      this.socket = null;
    }
    console.log("[BotWsClient] Déconnexion du client WebSocket");
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || !this.isRunning) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.initSocket();
    }, 3000);
  }
}
