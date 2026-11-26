import type { ClosePositionInput, OpenPosition } from "@lotso-trading/shared";
import type { IApiClientPort } from "../../domain/ports/api-client.port.ts";

export interface SettlePositionsResult {
    readonly settledCount: number;
    readonly wonConditionIds: string[];
    readonly redeemableConditionIds: string[];
}

interface MarketResolutionCheck {
    isClosed: boolean;
    resolutionType: "WIN_LOSS" | "CANCELLED" | null;
    winningOutcome: string | null;
    payoutPricePerShare?: number;
    endDate?: string;
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
            return { settledCount: 0, wonConditionIds: [], redeemableConditionIds: [] };
        }

        const openPositions = await this.apiClient.getAllOpenPositions();
        let settledCount = 0;
        const wonConditionIds: string[] = [];
        const redeemableConditionIds: string[] = [];

        for (const pos of openPositions) {
            if (!pos.conditionId || pos.conditionId === "0x") continue;
            if (pos.status === "CLOSED" || pos.totalShares <= 0) continue;

            const resolution = await this.checkMarketResolution(pos);
            if (!resolution.isClosed || !resolution.resolutionType) {
                continue;
            }

            let closeReason: ClosePositionInput["closeReason"];
            let settledPayoutUsdc: number;
            let payoutPricePerShare: number | undefined;
            let isWin = false;

            if (resolution.resolutionType === "CANCELLED") {
                closeReason = "RESOLVED_CANCELLED";
                payoutPricePerShare = resolution.payoutPricePerShare ?? 0.5;
                settledPayoutUsdc = Number((pos.totalShares * payoutPricePerShare).toFixed(2));
            } else {
                if (!resolution.winningOutcome) continue;
                isWin =
                    pos.outcomeLabel.trim().toLowerCase() ===
                    resolution.winningOutcome.trim().toLowerCase();
                closeReason = isWin ? "RESOLVED_WIN" : "RESOLVED_LOSS";
                settledPayoutUsdc = isWin ? Number(pos.totalShares.toFixed(2)) : 0;
            }

            try {
                const closed = await this.apiClient.closePosition(pos.conditionId, {
                    positionId: pos.id,
                    assetAddress: pos.assetAddress,
                    closeReason,
                    ...(resolution.winningOutcome
                        ? { winningOutcome: resolution.winningOutcome }
                        : {}),
                    ...(payoutPricePerShare !== undefined ? { payoutPricePerShare } : {}),
                    endDate: resolution.endDate,
                    settledPayoutUsdc,
                    closedAt: Date.now(),
                });

                if (closed) {
                    settledCount++;
                    if (isWin) {
                        wonConditionIds.push(pos.conditionId);
                    }
                    if (settledPayoutUsdc > 0) {
                        redeemableConditionIds.push(pos.conditionId);
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

        return { settledCount, wonConditionIds, redeemableConditionIds };
    }

    private async checkMarketResolution(pos: OpenPosition): Promise<MarketResolutionCheck> {
        let isClosed = false;
        let resolutionType: "WIN_LOSS" | "CANCELLED" | null = null;
        let winningOutcome: string | null = null;
        let payoutPricePerShare: number | undefined;
        let resolvedEndDate = pos.endDate;
        let clobCancelledCandidate: { payoutPricePerShare: number } | null = null;

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
                    accepting_orders?: boolean;
                    end_date_iso?: string;
                    game_start_time?: string;
                    tokens?: Array<{ outcome?: string; winner?: boolean; price?: number | string }>;
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
                        resolutionType = "WIN_LOSS";
                        winningOutcome = winToken.outcome;
                    } else if (
                        data.accepting_orders === false &&
                        data.tokens.every((t) => t.winner !== true)
                    ) {
                        // Marché fermé sans gagnant (ex: annulé / 50-50 : tokens à price ~0.5)
                        const numericPrices = data.tokens
                            .map((t) => Number(t.price))
                            .filter((p) => Number.isFinite(p));
                        const allMidSplit =
                            numericPrices.length === data.tokens.length &&
                            numericPrices.every((p) => p >= 0.48 && p <= 0.52);

                        if (allMidSplit) {
                            const matched = data.tokens.find(
                                (t) =>
                                    t.outcome?.trim().toLowerCase() ===
                                    pos.outcomeLabel.trim().toLowerCase()
                            );
                            const matchedPrice = matched ? Number(matched.price) : 0.5;
                            clobCancelledCandidate = {
                                payoutPricePerShare:
                                    Number.isFinite(matchedPrice) && matchedPrice > 0
                                        ? matchedPrice
                                        : 0.5,
                            };
                        }
                    }
                }
            }
        } catch (_err: unknown) {
            // Fallback vers Gamma
        }

        // 2. Fallback / Confirmation Gamma API (avec &closed=true pour inclure les marchés clos/annulés)
        if (!resolutionType) {
            try {
                const effectiveTokenId = isTokenIdDecimal
                    ? pos.conditionId
                    : pos.assetAddress && /^\d+$/.test(pos.assetAddress)
                      ? pos.assetAddress
                      : null;

                const gammaUrl = isHexConditionId
                    ? `${this.gammaApiUrl}/markets?condition_ids=${pos.conditionId}&closed=true`
                    : effectiveTokenId
                      ? `${this.gammaApiUrl}/markets?clob_token_ids=${effectiveTokenId}&closed=true`
                      : pos.marketSlug &&
                          pos.marketSlug !== "market" &&
                          pos.marketSlug !== "polymarket-market"
                        ? `${this.gammaApiUrl}/markets?slug=${encodeURIComponent(pos.marketSlug)}&closed=true`
                        : null;

                if (gammaUrl) {
                    const res = await fetch(gammaUrl, { signal: AbortSignal.timeout(4000) });
                    if (res.ok) {
                        const list = (await res.json()) as Array<{
                            conditionId?: string;
                            closed?: boolean;
                            umaResolutionStatus?: string;
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
                            if (market.endDate) {
                                resolvedEndDate = market.endDate;
                            } else if (!resolvedEndDate && market.endDateIso) {
                                resolvedEndDate = market.endDateIso;
                            }
                            if (market.closed === true) {
                                const winToken = market.tokens?.find((t) => t.winner === true);
                                if (winToken?.outcome) {
                                    isClosed = true;
                                    resolutionType = "WIN_LOSS";
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
                                        const numericPrices = prices.map((p: string | number) =>
                                            Number(p)
                                        );
                                        const winIdx = numericPrices.findIndex(
                                            (p: number) => Number.isFinite(p) && p >= 0.99
                                        );
                                        if (winIdx >= 0 && outcomes[winIdx]) {
                                            isClosed = true;
                                            resolutionType = "WIN_LOSS";
                                            winningOutcome = String(outcomes[winIdx]);
                                        } else if (
                                            (market.umaResolutionStatus === "resolved" ||
                                                clobCancelledCandidate !== null) &&
                                            numericPrices.length > 0 &&
                                            numericPrices.every(
                                                (p: number) =>
                                                    Number.isFinite(p) && p >= 0 && p < 0.99
                                            )
                                        ) {
                                            const posIdx = outcomes.findIndex(
                                                (o: unknown) =>
                                                    String(o).trim().toLowerCase() ===
                                                    pos.outcomeLabel.trim().toLowerCase()
                                            );
                                            const matchedPrice =
                                                posIdx >= 0 ? numericPrices[posIdx] : undefined;
                                            isClosed = true;
                                            resolutionType = "CANCELLED";
                                            payoutPricePerShare =
                                                matchedPrice !== undefined &&
                                                Number.isFinite(matchedPrice)
                                                    ? matchedPrice
                                                    : (clobCancelledCandidate?.payoutPricePerShare ??
                                                      0.5);
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

        // Si CLOB a clairement indiqué un marché fermé sans gagnant en 50/50 et Gamma n'a pas répondu
        if (!resolutionType && clobCancelledCandidate) {
            isClosed = true;
            resolutionType = "CANCELLED";
            payoutPricePerShare = clobCancelledCandidate.payoutPricePerShare;
        }

        return {
            isClosed,
            resolutionType,
            winningOutcome,
            payoutPricePerShare,
            endDate: resolvedEndDate,
        };
    }
}
