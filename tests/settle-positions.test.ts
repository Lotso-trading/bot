import { assertEquals } from "jsr:@std/assert";
import type { ClosePositionInput, OpenPosition } from "@lotso-trading/shared";
import { SettlePositionsUseCase } from "../src/application/use-cases/settle-positions.use-case.ts";
import type { IApiClientPort } from "../src/domain/ports/api-client.port.ts";

function createOpenPosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
    return {
        id: "pos_open_1",
        conditionId: "0x9876543210abcdef9876543210abcdef9876543210abcdef9876543210abcdef",
        assetAddress: "0x1111111111111111111111111111111111111111",
        marketSlug: "france-vs-brazil",
        marketQuestion: "France vs Brazil?",
        outcomeLabel: "France",
        status: "OPEN",
        totalShares: 100,
        avgEntryPrice: 0.5,
        totalInvestedUsdc: 50,
        currentMarketPrice: 0.5,
        currentMarketValueUsdc: 50,
        unrealizedPnlUsdc: 0,
        unrealizedPnlPercent: 0,
        targetAddress: "0x2222222222222222222222222222222222222222",
        openedAt: Date.now() - 3600_000,
        updatedAt: Date.now(),
        ...overrides,
    };
}

Deno.test("SettlePositionsUseCase - clôture via Gamma API fallback quand CLOB ne renvoie pas de gagnant", async () => {
    const originalFetch = globalThis.fetch;
    const openPos = createOpenPosition();
    let capturedClose: { conditionId: string; payload: ClosePositionInput } | null = null;

    const mockApiClient: IApiClientPort = {
        getActiveTargets: () => Promise.resolve([]),
        getBotConfig: () => Promise.reject(new Error("not used")),
        getOpenPosition: () => Promise.resolve(null),
        getAllOpenPositions: () => Promise.resolve([openPos]),
        recordTrade: () => Promise.reject(new Error("not used")),
        closePosition: (conditionId: string, payload: ClosePositionInput) => {
            capturedClose = { conditionId, payload };
            return Promise.resolve({
                ...openPos,
                status: "CLOSED",
                closeReason: payload.closeReason,
                settledPayoutUsdc: payload.settledPayoutUsdc,
            });
        },
        sendHeartbeat: () => Promise.resolve(),
        sendShutdown: () => Promise.resolve(),
    };

    globalThis.fetch = ((url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("clob.polymarket.com")) {
            return Promise.resolve(
                new Response(JSON.stringify({ closed: true, tokens: [] }), { status: 200 })
            );
        }
        if (urlStr.includes("gamma-api.polymarket.com")) {
            return Promise.resolve(
                new Response(
                    JSON.stringify([
                        {
                            conditionId: openPos.conditionId,
                            closed: true,
                            endDate: "2026-11-15T20:00:00Z",
                            outcomes: JSON.stringify(["France", "Brazil"]),
                            outcomePrices: JSON.stringify(["1", "0"]),
                        },
                    ]),
                    { status: 200 }
                )
            );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
    }) as typeof fetch;

    try {
        const useCase = new SettlePositionsUseCase(mockApiClient);
        const result = await useCase.execute();

        assertEquals(result.settledCount, 1);
        assertEquals(result.wonConditionIds, [openPos.conditionId]);
        assertEquals(capturedClose !== null, true);
        const closeCall = capturedClose as unknown as {
            conditionId: string;
            payload: ClosePositionInput;
        };
        assertEquals(closeCall.conditionId, openPos.conditionId);
        assertEquals(closeCall.payload.closeReason, "RESOLVED_WIN");
        assertEquals(closeCall.payload.settledPayoutUsdc, 100);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test("SettlePositionsUseCase - mutex single-flight mutualise les appels concurrents", async () => {
    let apiCalls = 0;
    const mockApiClient: IApiClientPort = {
        getActiveTargets: () => Promise.resolve([]),
        getBotConfig: () => Promise.reject(new Error("not used")),
        getOpenPosition: () => Promise.resolve(null),
        getAllOpenPositions: async () => {
            apiCalls++;
            await new Promise((r) => setTimeout(r, 20));
            return [];
        },
        recordTrade: () => Promise.reject(new Error("not used")),
        closePosition: () => Promise.resolve(null),
        sendHeartbeat: () => Promise.resolve(),
        sendShutdown: () => Promise.resolve(),
    };

    const useCase = new SettlePositionsUseCase(mockApiClient);
    const results = await Promise.all([useCase.execute(), useCase.execute(), useCase.execute()]);

    assertEquals(apiCalls, 1);
    assertEquals(results.length, 3);
    assertEquals(results[0]?.settledCount, 0);
});

Deno.test("SettlePositionsUseCase - clôture un marché annulé 50/50 en RESOLVED_CANCELLED avec payout 0.50/part", async () => {
    const originalFetch = globalThis.fetch;
    const openPos = createOpenPosition({
        conditionId: "0xe4701628a8a5a26993f4949c5e74712be1dba01793d3cd0eb7006c3c9dadf38c",
        marketQuestion: "UFC 334: Kevin Holland vs. Uroš Medic",
        outcomeLabel: "Uroš Medic",
        totalShares: 20.92,
        avgEntryPrice: 0.5813,
        totalInvestedUsdc: 12.16,
    });
    let capturedClose: { conditionId: string; payload: ClosePositionInput } | null = null;
    let gammaRequestedUrl = "";

    const mockApiClient: IApiClientPort = {
        getActiveTargets: () => Promise.resolve([]),
        getBotConfig: () => Promise.reject(new Error("not used")),
        getOpenPosition: () => Promise.resolve(null),
        getAllOpenPositions: () => Promise.resolve([openPos]),
        recordTrade: () => Promise.reject(new Error("not used")),
        closePosition: (conditionId: string, payload: ClosePositionInput) => {
            capturedClose = { conditionId, payload };
            return Promise.resolve({
                ...openPos,
                status: "CLOSED",
                closeReason: payload.closeReason,
                settledPayoutUsdc: payload.settledPayoutUsdc,
            });
        },
        sendHeartbeat: () => Promise.resolve(),
        sendShutdown: () => Promise.resolve(),
    };

    globalThis.fetch = ((url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("clob.polymarket.com")) {
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        closed: true,
                        accepting_orders: false,
                        end_date_iso: "2026-11-15T00:00:00Z",
                        tokens: [
                            { outcome: "Kevin Holland", winner: false, price: 0.5 },
                            { outcome: "Uroš Medic", winner: false, price: 0.5 },
                        ],
                    }),
                    { status: 200 }
                )
            );
        }
        if (urlStr.includes("gamma-api.polymarket.com")) {
            gammaRequestedUrl = urlStr;
            return Promise.resolve(
                new Response(
                    JSON.stringify([
                        {
                            conditionId: openPos.conditionId,
                            closed: true,
                            umaResolutionStatus: "resolved",
                            endDate: "2026-11-15T04:59:59.999Z",
                            outcomes: JSON.stringify(["Kevin Holland", "Uroš Medic"]),
                            outcomePrices: JSON.stringify(["0.5", "0.5"]),
                        },
                    ]),
                    { status: 200 }
                )
            );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
    }) as typeof fetch;

    try {
        const useCase = new SettlePositionsUseCase(mockApiClient);
        const result = await useCase.execute();

        assertEquals(gammaRequestedUrl.includes("closed=true"), true);
        assertEquals(result.settledCount, 1);
        assertEquals(result.wonConditionIds, []);
        assertEquals(result.redeemableConditionIds, [openPos.conditionId]);
        const closeCall = capturedClose as unknown as {
            conditionId: string;
            payload: ClosePositionInput;
        };
        assertEquals(closeCall.payload.closeReason, "RESOLVED_CANCELLED");
        assertEquals(closeCall.payload.payoutPricePerShare, 0.5);
        assertEquals(closeCall.payload.settledPayoutUsdc, 10.46);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
