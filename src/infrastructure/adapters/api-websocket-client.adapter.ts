import type { RiskConfig } from "@lotso-trading/shared";

interface WsEventMessage {
    event?: string;
    data?: unknown;
}

export type ConnectCallback = () => void | Promise<void>;
export type TargetChangeCallback = () => void | Promise<void>;
export type ConfigChangeCallback = (config: RiskConfig) => void | Promise<void>;
export type PositionClosedCallback = (data: {
    conditionId: string;
    closeReason?: string;
    settledPayoutUsdc?: number;
}) => void | Promise<void>;
export type CheckResolutionsCallback = () => void | Promise<void>;

export class ApiWebSocketClientAdapter {
    private socket: WebSocket | null = null;
    private isRunning = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private connectCallbacks: Set<ConnectCallback> = new Set();
    private targetChangeCallbacks: Set<TargetChangeCallback> = new Set();
    private configChangeCallbacks: Set<ConfigChangeCallback> = new Set();
    private positionClosedCallbacks: Set<PositionClosedCallback> = new Set();
    private checkResolutionsCallbacks: Set<CheckResolutionsCallback> = new Set();

    constructor(
        private readonly wsUrl: string,
        private readonly botVersion?: string
    ) {}

    connect(): void {
        this.isRunning = true;
        this.initSocket();
    }

    private initSocket(): void {
        if (!this.isRunning) return;

        try {
            // Connexion avec identification role=bot & version
            const versionParam = this.botVersion
                ? `&version=${encodeURIComponent(this.botVersion)}`
                : "";
            const url = this.wsUrl.includes("?")
                ? `${this.wsUrl}&role=bot${versionParam}`
                : `${this.wsUrl}?role=bot${versionParam}`;

            this.socket = new WebSocket(url);

            this.socket.onopen = () => {
                console.log(`[BotWsClient] Connecté au flux temps réel de l'API (${url})`);
                try {
                    this.socket?.send(
                        JSON.stringify({
                            event: "bot:identify",
                            role: "bot",
                            version: this.botVersion,
                        })
                    );
                } catch (_err: unknown) {
                    // Ignoré
                }
                for (const cb of this.connectCallbacks) {
                    Promise.resolve(cb()).catch((err: unknown) => {
                        console.warn("[BotWsClient] Erreur callback onConnect:", err);
                    });
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
                    } else if (payload.event === "bot:check-resolutions") {
                        console.log(
                            "[BotWsClient] Demande manuelle de vérification des résolutions reçue"
                        );
                        for (const cb of this.checkResolutionsCallbacks) {
                            await cb();
                        }
                    }
                } catch (err: unknown) {
                    console.warn("[BotWsClient] Erreur parsing message WebSocket:", err);
                }
            };

            this.socket.onclose = () => {
                this.socket = null;
                if (this.isRunning) {
                    console.log(
                        "[BotWsClient] Connexion perdue, tentative de reconnexion dans 3s..."
                    );
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

    onConnect(callback: ConnectCallback): () => void {
        this.connectCallbacks.add(callback);
        return () => {
            this.connectCallbacks.delete(callback);
        };
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

    onCheckResolutionsRequested(callback: CheckResolutionsCallback): () => void {
        this.checkResolutionsCallbacks.add(callback);
        return () => {
            this.checkResolutionsCallbacks.delete(callback);
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
