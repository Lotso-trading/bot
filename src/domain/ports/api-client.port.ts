import type {
    ClosePositionInput,
    ExecutedTrade,
    OpenPosition,
    RiskConfig,
    TargetTrader,
} from "@lotso-trading/shared";

export interface IApiClientPort {
    getActiveTargets(): Promise<TargetTrader[]>;
    getBotConfig(): Promise<RiskConfig>;
    getOpenPosition(conditionId: string): Promise<OpenPosition | null>;
    getAllOpenPositions(): Promise<OpenPosition[]>;
    getMetrics?(): Promise<{
        realizedPnlUsdc: number;
        availableCashUsdc?: number;
        initialCapitalUsdc?: number;
        totalSettledPayoutUsdc?: number;
    } | null>;
    recordTrade(trade: ExecutedTrade): Promise<ExecutedTrade>;
    getUnredeemedWinningPositions?(): Promise<OpenPosition[]>;
    recordPositionRedeemed?(conditionId: string, txHash: string): Promise<void>;
    closePosition?(conditionId: string, payload: ClosePositionInput): Promise<OpenPosition | null>;
    sendHeartbeat(version?: string): Promise<void>;
    sendShutdown(): Promise<void>;
}
