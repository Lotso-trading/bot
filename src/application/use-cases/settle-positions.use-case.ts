import type { ClosePositionInput, OpenPosition } from "@lotso-trading/shared";
import type { IApiClientPort } from "../../domain/ports/api-client.port.ts";

export interface SettlePositionsResult {
    readonly settledCount: number;
    readonly wonConditionIds: string[];
}

export class SettlePositionsUseCase {
    private inFlightPromise: Promise<SettlePositionsResult> | null = null;

    constructor(
        private readonly apiClient: IApiClientPort,
        private readonly clobApiUrl = "https://clob.polymarket.com",
        private readonly gammaApiUrl = "https://gamma-api.polymarket.com"
    ) {}

    async execute(): Promise<SettlePositionsResult> {
        if (this.inFlightPromise) {
            return await this.inFlightPromise;
        }

        this.inFlightPromise = this.runCheck().finally(() => {
            this.inFlightPromise = null;
        });

        return await this.inFlightPromise;
    }

    private async runCheck(): Promise<SettlePositionsResult> {
        if (!this.apiClient.closePosition) {
            return { settledCount: 0, wonConditionIds: [] };
        }

        const openPositions = await this.apiClient.getAllOpenPositions();
        let settledCount = 0;
        const wonConditionIds: string[] = [];

        for (const pos of openPositions) {
            if (!pos.conditionId || pos.conditionId === "0x") continue;
            if (pos.status === "CLOSED" || pos.totalShares <= 0) continue;

            const resolution = await this.checkMarketResolution(pos);
            if (!resolution.isClosed || !resolution.winningOutcome) {
                continue;
            }

            const isWin =
                pos.outcomeLabel.trim().toLowerCase() ===
                resolution.winningOutcome.trim().toLowerCase();
            const closeReason: ClosePositionInput["closeReason"] = isWin
                ? "RESOLVED_WIN"
                : "RESOLVED_LOSS";
            const settledPayoutUsdc = isWin ? Number(pos.totalShares.toFixed(2)) : 0;

            try {
                const closed = await this.apiClient.closePosition(pos.conditionId, {
                    closeReason,
                    winningOutcome: resolution.winningOutcome,
                    endDate: resolution.endDate,
                    settledPayoutUsdc,
                    closedAt: Date.now(),
                });

                if (closed) {
                    settledCount++;
                    if (isWin) {
                        wonConditionIds.push(pos.conditionId);
                    }
                    console.log(
                        `[SettlePositions] Position clôturée (${closeReason}) : ${pos.marketQuestion.slice(0, 60)}`
                    );
                }
            } catch (err: unknown) {
                console.warn(
                    `[SettlePositions] Échec persistance clôture pour conditionId=${pos.conditionId}:`,
                    err
                );
            }
        }

        return { settledCount, wonConditionIds };
    }

    private async checkMarketResolution(pos: OpenPosition): Promise<{
        isClosed: boolean;
        winningOutcome: string | null;
        endDate?: string;
    }> {
        let isClosed = false;
        let winningOutcome: string | null = null;
        let resolvedEndDate = pos.endDate;

        const isHexConditionId = pos.conditionId.startsWith("0x") && pos.conditionId.length >= 64;
        const isTokenIdDecimal = !isHexConditionId && /^\d+$/.test(pos.conditionId);

        // 1. Interrogation CLOB API
        try {
            const clobUrl = isTokenIdDecimal
                ? `${this.clobApiUrl}/markets?token_id=${pos.conditionId}`
                : `${this.clobApiUrl}/markets/${pos.conditionId}`;

            const res = await fetch(clobUrl, { signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                const json = await res.json();
                const data = (Array.isArray(json?.data) ? json.data[0] : json?.data || json) as {
                    closed?: boolean;
                    end_date_iso?: string;
                    game_start_time?: string;
                    tokens?: Array<{ outcome?: string; winner?: boolean }>;
                };
                if (!resolvedEndDate) {
                    resolvedEndDate = data?.end_date_iso || data?.game_start_time;
                }
                if (
                    data?.closed === true &&
                    Array.isArray(data?.tokens) &&
                    data.tokens.length > 0
                ) {
                    const winToken = data.tokens.find((t) => t.winner === true);
                    if (winToken?.outcome) {
                        isClosed = true;
                        winningOutcome = winToken.outcome;
                    }
                }
            }
        } catch (_err: unknown) {
            // Fallback vers Gamma
        }

        // 2. Fallback Gamma API
        if (!winningOutcome) {
            try {
                const effectiveTokenId = isTokenIdDecimal
                    ? pos.conditionId
                    : pos.assetAddress && /^\d+$/.test(pos.assetAddress)
                      ? pos.assetAddress
                      : null;

                const gammaUrl = isHexConditionId
                    ? `${this.gammaApiUrl}/markets?condition_ids=${pos.conditionId}`
                    : effectiveTokenId
                      ? `${this.gammaApiUrl}/markets?clob_token_ids=${effectiveTokenId}`
                      : pos.marketSlug &&
                          pos.marketSlug !== "market" &&
                          pos.marketSlug !== "polymarket-market"
                        ? `${this.gammaApiUrl}/markets?slug=${encodeURIComponent(pos.marketSlug)}`
                        : null;

                if (gammaUrl) {
                    const res = await fetch(gammaUrl, { signal: AbortSignal.timeout(4000) });
                    if (res.ok) {
                        const list = (await res.json()) as Array<{
                            conditionId?: string;
                            closed?: boolean;
                            endDate?: string;
                            endDateIso?: string;
                            tokens?: Array<{ outcome?: string; winner?: boolean }>;
                            outcomePrices?: string[] | string;
                            outcomes?: string[] | string;
                        }>;
                        const market = isHexConditionId
                            ? Array.isArray(list)
                                ? list.find(
                                      (m) =>
                                          m?.conditionId?.toLowerCase() ===
                                          pos.conditionId.toLowerCase()
                                  )
                                : undefined
                            : Array.isArray(list)
                              ? list[0]
                              : undefined;

                        if (market) {
                            if (!resolvedEndDate) {
                                resolvedEndDate = market.endDate || market.endDateIso;
                            }
                            if (market.closed === true) {
                                const winToken = market.tokens?.find((t) => t.winner === true);
                                if (winToken?.outcome) {
                                    isClosed = true;
                                    winningOutcome = winToken.outcome;
                                } else {
                                    const prices =
                                        typeof market.outcomePrices === "string"
                                            ? JSON.parse(market.outcomePrices)
                                            : market.outcomePrices;
                                    const outcomes =
                                        typeof market.outcomes === "string"
                                            ? JSON.parse(market.outcomes)
                                            : market.outcomes;

                                    if (Array.isArray(prices) && Array.isArray(outcomes)) {
                                        const winIdx = prices.findIndex(
                                            (p: string | number) => Number(p) >= 0.99
                                        );
                                        if (winIdx >= 0 && outcomes[winIdx]) {
                                            isClosed = true;
                                            winningOutcome = String(outcomes[winIdx]);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (_err: unknown) {
                // Ignorer erreurs réseau temporaires
            }
        }

        return { isClosed, winningOutcome, endDate: resolvedEndDate };
    }
}
