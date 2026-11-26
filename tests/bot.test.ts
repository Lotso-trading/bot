import { assertEquals } from "jsr:@std/assert";
import type {
    DetectedTrade,
    ExecutedTrade,
    OpenPosition,
    RiskConfig,
    TargetTrader,
} from "@lotso-trading/shared";
import axios from "axios";
import { CalculatePositionSizeUseCase } from "../src/application/use-cases/calculate-size.use-case.ts";
import { EvaluateTradeUseCase } from "../src/application/use-cases/evaluate-trade.use-case.ts";
import { HandleExitUseCase } from "../src/application/use-cases/handle-exit.use-case.ts";
import { ReplicateTradeUseCase } from "../src/application/use-cases/replicate-trade.use-case.ts";
import type { IApiClientPort } from "../src/domain/ports/api-client.port.ts";
import type { IExecutorPort } from "../src/domain/ports/executor.port.ts";
import type { INotifierPort } from "../src/domain/ports/notifier.port.ts";
import { ApiBackendClientAdapter } from "../src/infrastructure/adapters/api-backend-client.adapter.ts";
import { ApiWebSocketClientAdapter } from "../src/infrastructure/adapters/api-websocket-client.adapter.ts";
import { DryRunExecutorAdapter } from "../src/infrastructure/adapters/dry-run-executor.adapter.ts";
import { PolymarketApiTrackerAdapter } from "../src/infrastructure/adapters/polymarket-api-tracker.adapter.ts";
import { PolymarketClobAdapter } from "../src/infrastructure/adapters/polymarket-clob.adapter.ts";
import { Deduplicator } from "../src/infrastructure/deduplication/deduplicator.ts";

Deno.test("CalculatePositionSizeUseCase - calcule le pourcentage exact du solde", () => {
    const sizer = new CalculatePositionSizeUseCase();

    // 1 000 $ de solde, 3% par trade, plafond 50 $ -> 30.00 $
    const size1 = sizer.calculate(1000.0, 0.03, 50.0);
    assertEquals(size1, 30.0);

    // 10 000 $ de solde, 3% = 300 $, mais plafonné à 50 $ -> 50.00 $
    const size2 = sizer.calculate(10000.0, 0.03, 50.0);
    assertEquals(size2, 50.0);

    // Solde nul -> 0
    const size3 = sizer.calculate(0, 0.03, 50.0);
    assertEquals(size3, 0);

    // Montant inférieur au minimum de 1 $ -> 0
    const size4 = sizer.calculate(10.0, 0.03, 50.0); // 0.30 $ < 1.0 $
    assertEquals(size4, 0);

    // Multiplicateur de baleine (poids 1.5x)
    const size5 = sizer.calculate(1000.0, 0.03, 100.0, 1.5); // 30 * 1.5 = 45 $
    assertEquals(size5, 45.0);

    // Plancher dynamique pour capital de 50 USDC :
    // Avec 50 $ et 8%, 50 * 0.08 = 4.00 $
    const size6 = sizer.calculate(50.0, 0.08, 50.0, 1.0, undefined, 2.0);
    assertEquals(size6, 4.0);

    // Avec solde diminué à 15 $ et 8% (1.20 $ < plancher 2.00 $), le plancher à 2.00 $ s'applique
    const size7 = sizer.calculate(15.0, 0.08, 50.0, 1.0, undefined, 2.0);
    assertEquals(size7, 2.0);

    // Avec solde très bas (0.80 $ < 1.00 $ Polymarket min) -> rejet
    const size8 = sizer.calculate(0.8, 0.08, 50.0, 1.0, undefined, 2.0);
    assertEquals(size8, 0);
});

Deno.test("EvaluateTradeUseCase - valide le slippage et les bornes de cote", () => {
    const evaluator = new EvaluateTradeUseCase();
    const config: RiskConfig = {
        balancePercentPerTrade: 0.03,
        maxSlippagePercent: 2.0, // 2%
        maxCapPerTradeUsdc: 50.0,
        maxExposurePerMarketUsdc: 150.0,
        maxExposurePerTargetUsdc: 300.0,
        minCashReserveUsdc: 5.0,
        minPrice: 0.05,
        maxPrice: 0.9,
        copySellOrders: true,
        dryRun: true,
        simulatedBalanceUsdc: 1000.0,
        maxAllocatedCapitalUsdc: 0,
        profitReinvestmentPercent: 50.0,
        isBotRunning: true,
        isBotOnline: true,
    };

    const baseTrade: DetectedTrade = {
        id: "trade-1",
        targetAddress: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        marketSlug: "election",
        marketQuestion: "Will Trump Win?",
        conditionId: "cond-1",
        assetAddress: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        outcomeIndex: 0,
        outcomeLabel: "Yes",
        side: "BUY",
        price: 0.5,
        sizeShares: 100,
        sizeUsdc: 50,
        detectedAt: Date.now(),
        source: "POLYMARKET_API",
    };

    // Cas nominal : ask à 0.505 (slippage +1% <= 2%) -> Valide
    const eval1 = evaluator.evaluate(baseTrade, 0.505, config);
    assertEquals(eval1.isValid, true);

    // Slippage excessif : ask à 0.53 (+6% > 2%) -> Rejeté
    const eval2 = evaluator.evaluate(baseTrade, 0.53, config);
    assertEquals(eval2.isValid, false);

    // Cote trop basse (< 0.05) -> Rejeté
    const lowPriceTrade = { ...baseTrade, price: 0.02 };
    const eval3 = evaluator.evaluate(lowPriceTrade, 0.02, config);
    assertEquals(eval3.isValid, false);

    // Cote trop haute (> 0.90) -> Rejeté
    const highPriceTrade = { ...baseTrade, price: 0.95 };
    const eval4 = evaluator.evaluate(highPriceTrade, 0.95, config);
    assertEquals(eval4.isValid, false);

    // ConditionId invalide (adresse Ethereum de contrat, ex: 0xE111...) -> Rejeté
    const contractAddrTrade = {
        ...baseTrade,
        conditionId: "0xE111180000d2663C0091e4f400237545B87B996B",
    };
    const eval5 = evaluator.evaluate(contractAddrTrade, 0.505, config);
    assertEquals(eval5.isValid, false);
    if (!eval5.isValid) {
        assertEquals(eval5.reason.includes("CONDITION_ID_INVALIDE"), true);
    }

    // ConditionId invalide ("0x" ou vide) -> Rejeté
    const emptyConditionTrade = { ...baseTrade, conditionId: "0x" };
    const eval6 = evaluator.evaluate(emptyConditionTrade, 0.505, config);
    assertEquals(eval6.isValid, false);
});

Deno.test("HandleExitUseCase - gère les sorties partielles et totales (ALL)", () => {
    const exitHandler = new HandleExitUseCase();

    const mockPosition: OpenPosition = {
        id: "pos-1",
        conditionId: "cond-1",
        assetAddress: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        marketSlug: "election",
        marketQuestion: "Will Trump Win?",
        outcomeLabel: "Yes",
        status: "OPEN",
        totalShares: 100,
        avgEntryPrice: 0.5,
        totalInvestedUsdc: 50,
        currentMarketPrice: 0.6,
        currentMarketValueUsdc: 60,
        unrealizedPnlUsdc: 10,
        unrealizedPnlPercent: 20,
        targetAddress: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        openedAt: Date.now() - 10000,
        updatedAt: Date.now() - 1000,
    };

    const whaleTrade: DetectedTrade = {
        id: "whale-sell-1",
        targetAddress: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        marketSlug: "election",
        marketQuestion: "Will Trump Win?",
        conditionId: "cond-1",
        assetAddress: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        outcomeIndex: 0,
        outcomeLabel: "Yes",
        side: "SELL",
        price: 0.6,
        sizeShares: 100, // La baleine vend la totalité de ce qu'on détient
        sizeUsdc: 60,
        detectedAt: Date.now(),
        source: "POLYMARKET_API",
    };

    // Sortie totale (100% liquidé)
    const exit1 = exitHandler.decide(whaleTrade, mockPosition);
    assertEquals(exit1.shouldExit, true);
    if (exit1.shouldExit) {
        assertEquals(exit1.sharesToSell, 100);
        assertEquals(exit1.isFullExit, true);
    }

    // Aucune position détenue
    const exit2 = exitHandler.decide(whaleTrade, null);
    assertEquals(exit2.shouldExit, false);
});

Deno.test("Deduplicator - ignore les doublons et respecte la limite de taille", () => {
    const dedup = new Deduplicator(3);

    assertEquals(dedup.isDuplicate("hash-1"), false);
    dedup.markProcessed("hash-1");
    assertEquals(dedup.isDuplicate("hash-1"), true);

    dedup.markProcessed("hash-2");
    dedup.markProcessed("hash-3");
    dedup.markProcessed("hash-4"); // Éjecte hash-1

    assertEquals(dedup.isDuplicate("hash-1"), false);
    assertEquals(dedup.isDuplicate("hash-4"), true);
});

Deno.test("ReplicateTradeUseCase - bloque strictement les achats si le portefeuille est vide", async () => {
    const { ReplicateTradeUseCase } = await import(
        "../src/application/use-cases/replicate-trade.use-case.ts"
    );

    let recordedTrade: ExecutedTrade | null = null;
    const mockApiClient = {
        getActiveTargets: async () => [],
        getBotConfig: async () => ({
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
            maxAllocatedCapitalUsdc: 0,
            profitReinvestmentPercent: 50.0,
            isBotRunning: true,
            isBotOnline: true,
        }),
        getOpenPosition: async () => null,
        getAllOpenPositions: async () => [],
        recordTrade: async (t: ExecutedTrade) => {
            recordedTrade = t;
            return t;
        },
        sendHeartbeat: async () => {},
        sendShutdown: async () => {},
    };

    const mockExecutor = {
        getAvailableBalanceUsdc: async () => 2.5, // Moins que la réserve min (5.0 USDC)
        getCurrentBestPrice: async () => 0.5,
        executeBuy: async () => {
            throw new Error("Ne devrait pas être appelé");
        },
        executeSell: async () => {
            throw new Error("Ne devrait pas être appelé");
        },
    };

    const mockNotifier = {
        sendBuyAlert: async () => {},
        sendSellAlert: async () => {},
        sendRejectionAlert: async () => {},
        sendErrorAlert: async () => {},
    };

    const useCase = new ReplicateTradeUseCase(
        mockApiClient as unknown as IApiClientPort,
        mockExecutor as unknown as IExecutorPort,
        mockNotifier as unknown as INotifierPort
    );
    const target: TargetTrader = {
        id: "target-1",
        address: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        alias: "Baleine1",
        weightMultiplier: 1.0,
        maxUsdcPerTrade: 50,
        enabled: true,
        stats: {
            totalCopiedTrades: 0,
            totalCopiedVolumeUsdc: 0,
            realizedPnlUsdc: 0,
            winRatePercent: 75,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    const buyTrade: DetectedTrade = {
        id: "dt-1",
        targetAddress: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        marketSlug: "test",
        marketQuestion: "Question?",
        conditionId: "cond-1",
        assetAddress: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        outcomeIndex: 0,
        outcomeLabel: "Yes",
        side: "BUY",
        price: 0.5,
        sizeShares: 100,
        sizeUsdc: 50,
        detectedAt: Date.now(),
        source: "POLYMARKET_API",
    };

    const result = await useCase.execute(buyTrade, target);
    assertEquals(result, null);
    const trade = recordedTrade as ExecutedTrade | null;
    assertEquals(trade !== null, true);
    assertEquals(trade?.status, "REJECTED");
    assertEquals(trade?.rejectionReason?.includes("SOLDE_INSUFFISANT"), true);
});

Deno.test("ReplicateTradeUseCase - calcule le capital effectif et le réinvestissement des bénéfices", async () => {
    const mockApiClient = {
        getMetrics: async () => ({
            realizedPnlUsdc: 50.0, // 50 $ de gains réalisés
            availableCashUsdc: 550.0,
            initialCapitalUsdc: 100.0,
        }),
    };

    const useCase = new ReplicateTradeUseCase(
        mockApiClient as unknown as IApiClientPort,
        {} as unknown as IExecutorPort,
        {} as unknown as INotifierPort
    );

    const baseConfig: RiskConfig = {
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
        simulatedBalanceUsdc: 1000.0,
        maxAllocatedCapitalUsdc: 100.0, // 100 $ de base alloués
        profitReinvestmentPercent: 50.0, // 50% des bénéfices réinvestis
        isBotRunning: true,
        isBotOnline: true,
    };

    // Scénario 1 : 500 $ sur le portefeuille, 100 $ alloués, 50 $ de gains à 50% -> 125 $ utilisables
    const res50 = await useCase.calculateEffectiveBalance(550.0, baseConfig, []);
    assertEquals(res50.maxBotBudget, 125.0); // 100 $ + (50 * 50%) = 125 $
    assertEquals(res50.effectiveBalance, 125.0);

    // Scénario 2 : 0% de réinvestissement -> les 50 $ de gains sont sanctuarisés, le bot n'a que 100 $
    const config0Percent: RiskConfig = {
        ...baseConfig,
        profitReinvestmentPercent: 0.0,
    };
    const res0 = await useCase.calculateEffectiveBalance(550.0, config0Percent, []);
    assertEquals(res0.maxBotBudget, 100.0); // 100 $ + 0 $
    assertEquals(res0.effectiveBalance, 100.0);

    // Scénario 3 : 100% de réinvestissement -> 100 $ + 50 $ = 150 $
    const config100Percent: RiskConfig = {
        ...baseConfig,
        profitReinvestmentPercent: 100.0,
    };
    const res100 = await useCase.calculateEffectiveBalance(550.0, config100Percent, []);
    assertEquals(res100.maxBotBudget, 150.0);
    assertEquals(res100.effectiveBalance, 150.0);

    // Scénario 3b : maxAllocatedCapitalUsdc = 0 avec 50% de réinvestissement -> prend initialCapitalUsdc (100 $) en base
    const configZeroAllocated: RiskConfig = {
        ...baseConfig,
        maxAllocatedCapitalUsdc: 0,
        profitReinvestmentPercent: 50.0,
    };
    const resZeroAllocated = await useCase.calculateEffectiveBalance(
        550.0,
        configZeroAllocated,
        []
    );
    assertEquals(resZeroAllocated.maxBotBudget, 125.0); // 100 $ initial + (50 * 50%) = 125 $
    assertEquals(resZeroAllocated.effectiveBalance, 125.0);

    // Scénario 4 : Déjà 122 $ investis sur un budget de 125 $ -> reste 3 $ <= réserve (5 $)
    const positions = [
        {
            id: "pos-1",
            conditionId: "c-1",
            targetAddress: "0x123",
            outcomeLabel: "Yes",
            marketQuestion: "Test",
            totalShares: 200,
            totalInvestedUsdc: 122.0,
            avgEntryPrice: 0.61,
            currentPrice: 0.65,
            currentValueUsdc: 130.0,
            unrealizedPnlUsdc: 8.0,
            openedAt: Date.now(),
            updatedAt: Date.now(),
        },
    ];
    const resInvested = await useCase.calculateEffectiveBalance(
        550.0,
        baseConfig,
        positions as unknown as OpenPosition[]
    );
    assertEquals(resInvested.botRemainingCash, 3.0);
    assertEquals(resInvested.effectiveBalance, 3.0);
    assertEquals(resInvested.isAllocatedLimitHit, true);
});

Deno.test("PolymarketClobAdapter - résout le Token ID ERC1155 plutôt que le conditionId", () => {
    const adapter = new PolymarketClobAdapter(
        "https://clob.polymarket.com",
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    );

    // Cas 1 : assetAddress est un grand token ID décimal (77 chiffres)
    const tokenDecimal =
        "4764842916462157287738418815193165769775706842468360015637456523413749678364";
    const resolved = adapter.resolveTokenId({
        conditionId: "0xb62f71aef4c9972ddb75ec977b48156e1cc72e30f0e36b0f12c14de7fd94c777",
        assetAddress: tokenDecimal,
    });
    assertEquals(resolved, tokenDecimal);

    // Cas 2 : assetAddress est vide -> fallback sur conditionId
    const fallback = adapter.resolveTokenId({
        conditionId: "0xb62f71aef4c9972ddb75ec977b48156e1cc72e30f0e36b0f12c14de7fd94c777",
    });
    assertEquals(fallback, "0xb62f71aef4c9972ddb75ec977b48156e1cc72e30f0e36b0f12c14de7fd94c777");

    // Cas 3 : assetAddress est une adresse de contrat (40 hex chars) -> non valide comme token ID, fallback
    const contractAddrFallback = adapter.resolveTokenId({
        conditionId: "0xb62f71aef4c9972ddb75ec977b48156e1cc72e30f0e36b0f12c14de7fd94c777",
        assetAddress: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
    });
    assertEquals(
        contractAddrFallback,
        "0xb62f71aef4c9972ddb75ec977b48156e1cc72e30f0e36b0f12c14de7fd94c777"
    );
});

Deno.test("DryRunExecutorAdapter - synchronise le solde avec le callback dynamique", async () => {
    let mockLiveBalance = 1250.0;
    const adapter = new DryRunExecutorAdapter(
        "https://clob.polymarket.com",
        1000.0,
        undefined,
        async () => mockLiveBalance
    );

    const bal1 = await adapter.getAvailableBalanceUsdc();
    assertEquals(bal1, 1250.0);

    // Simulation d'un dépôt virtuel de 500 $
    mockLiveBalance = 1750.0;
    const bal2 = await adapter.getAvailableBalanceUsdc();
    assertEquals(bal2, 1750.0);
});

Deno.test("PolymarketApiTrackerAdapter - isole le curseur par cible et conserve tous les trades d'un même tick", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const addrA = "0x1111111111111111111111111111111111111111";
    const addrB = "0x2222222222222222222222222222222222222222";

    const makeTarget = (id: string, address: string): TargetTrader => ({
        id,
        address,
        alias: id,
        weightMultiplier: 1,
        maxUsdcPerTrade: 50,
        enabled: true,
        stats: {
            totalCopiedTrades: 0,
            totalCopiedVolumeUsdc: 0,
            realizedPnlUsdc: 0,
            winRatePercent: 0,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });

    const origGet = axios.get;
    try {
        (axios as unknown as { get: typeof axios.get }).get = (async (
            _url: string,
            cfg?: { params?: { user?: string } }
        ) => {
            if (cfg?.params?.user === addrA) {
                // Retournés du plus récent au plus ancien : 2 trades dans le même tick
                return {
                    data: {
                        data: [
                            {
                                id: "a-new",
                                timestamp: nowSec + 20,
                                side: "BUY",
                                price: 0.5,
                                size: 10,
                                condition_id: "0xcondA2",
                                transaction_hash: "0xtxA2",
                            },
                            {
                                id: "a-old",
                                timestamp: nowSec + 15,
                                side: "BUY",
                                price: 0.4,
                                size: 10,
                                condition_id: "0xcondA1",
                                transaction_hash: "0xtxA1",
                            },
                        ],
                    },
                };
            }
            // Cible B a un trade à nowSec + 10 (antérieur au curseur de A : ne doit PAS être sauté)
            return {
                data: {
                    data: [
                        {
                            id: "b-1",
                            timestamp: nowSec + 10,
                            side: "BUY",
                            price: 0.6,
                            size: 5,
                            condition_id: "0xcondB1",
                            transaction_hash: "0xtxB1",
                        },
                    ],
                },
            };
        }) as unknown as typeof axios.get;

        const tracker = new PolymarketApiTrackerAdapter("https://data-api.polymarket.com", 60_000);
        const received: string[] = [];
        let markDone!: () => void;
        const done = new Promise<void>((resolve) => {
            markDone = resolve;
        });

        await tracker.start([makeTarget("A", addrA), makeTarget("B", addrB)], async (t) => {
            received.push(t.id);
            if (received.length === 3) markDone();
        });
        await done;
        await tracker.stop();

        // Ordre chronologique pour A (a-old puis a-new) + trade de B bien reçu
        assertEquals(received, ["det_a-old", "det_a-new", "det_b-1"]);
    } finally {
        (axios as unknown as { get: typeof axios.get }).get = origGet;
    }
});

Deno.test("ApiBackendClientAdapter - conserve les cibles en cache lors d'une erreur API transitoire", async () => {
    const origGet = axios.get;
    let shouldFail = false;
    try {
        (axios as unknown as { get: typeof axios.get }).get = (async () => {
            if (shouldFail) throw new Error("ECONNREFUSED");
            return {
                data: {
                    success: true,
                    data: [{ id: "t1", address: "0x1", alias: "RN1", enabled: true }],
                },
            };
        }) as unknown as typeof axios.get;

        const client = new ApiBackendClientAdapter("http://api:3000");
        const first = await client.getActiveTargets();
        assertEquals(first.length, 1);

        shouldFail = true;
        const fallback = await client.getActiveTargets();
        assertEquals(fallback.length, 1);
    } finally {
        (axios as unknown as { get: typeof axios.get }).get = origGet;
    }
});

Deno.test("ApiWebSocketClientAdapter - déclenche onConnect à l'ouverture de la connexion", async () => {
    let serverSocket: WebSocket | null = null;
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
        const { socket, response } = Deno.upgradeWebSocket(req);
        serverSocket = socket;
        socket.onmessage = () => {};
        return response;
    });

    const port = (server.addr as Deno.NetAddr).port;
    const wsClient = new ApiWebSocketClientAdapter(`ws://127.0.0.1:${port}`, "1.0.0");

    try {
        let connectCount = 0;
        const connected = new Promise<void>((resolve) => {
            wsClient.onConnect(() => {
                connectCount += 1;
                resolve();
            });
        });

        wsClient.connect();
        await connected;
        assertEquals(connectCount, 1);
    } finally {
        wsClient.disconnect();
        const sock = serverSocket as WebSocket | null;
        if (sock && sock.readyState === WebSocket.OPEN) {
            await new Promise<void>((resolve) => {
                sock.onclose = () => resolve();
                sock.close();
            });
        }
        await server.shutdown();
    }
});

Deno.test("EvaluateTradeUseCase - rejette les parlays / combos sports 0x03...0000", () => {
    const evaluator = new EvaluateTradeUseCase();
    const config: RiskConfig = {
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
        simulatedBalanceUsdc: 1000.0,
        maxAllocatedCapitalUsdc: 0,
        profitReinvestmentPercent: 50.0,
        isBotRunning: true,
        isBotOnline: true,
    };
    const parlayTrade: DetectedTrade = {
        id: "dt-parlay",
        targetAddress: "0x5a218c7ad04135830a45c41aaed7294df7809318",
        marketSlug: "polymarket-market",
        marketQuestion: "Norway vs. Wales: O/U 2.5 AND Will Norway win?",
        conditionId: "0x0340fc04cb93f6c622ac342db7868f08d70000000000000000000000000000",
        assetAddress: "0x0340fc04cb93f6c622ac342db7868f08d70000000000000000000000000000",
        outcomeIndex: 0,
        outcomeLabel: "Yes",
        side: "BUY",
        price: 0.45,
        sizeShares: 10,
        sizeUsdc: 4.5,
        detectedAt: Date.now(),
        source: "POLYMARKET_API",
    };

    const res = evaluator.evaluate(parlayTrade, null, config);
    assertEquals(res.isValid, false);
    if (!res.isValid) {
        assertEquals(res.reason.includes("COMBO_PARLAY_NON_SUPPORTE"), true);
    }
});

Deno.test("PolymarketApiTrackerAdapter - filtre REDEEM/MERGE/CONVERSION/parlays 0x03 et propage token_id", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const addr = "0x5a218c7ad04135830a45c41aaed7294df7809318";
    const expectedTokenId =
        "36846838195353411496324646910705814710168117218429397112990127675877131827213";
    let capturedParams: Record<string, unknown> | undefined;

    const target: TargetTrader = {
        id: "balthazar",
        address: addr,
        alias: "Balthazar",
        weightMultiplier: 1,
        enabled: true,
        stats: {
            totalCopiedTrades: 0,
            totalCopiedVolumeUsdc: 0,
            realizedPnlUsdc: 0,
            winRatePercent: 0,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    const origGet = axios.get;
    try {
        (axios as unknown as { get: typeof axios.get }).get = (async (
            _url: string,
            cfg?: { params?: Record<string, unknown> }
        ) => {
            capturedParams = cfg?.params;
            return {
                data: {
                    data: [
                        // 1. REDEEM -> doit être ignoré
                        {
                            id: "redeem-1",
                            type: "REDEEM",
                            timestamp: nowSec + 30,
                            side: "",
                            price: 0,
                            size: 100,
                            condition_id:
                                "0xe47a88a76e5b61551381de57e7e052f272ab492ef9e96ce505dac9684664d63a",
                            token_id: expectedTokenId,
                            outcome: "Yes",
                        },
                        // 2. CONVERSION NegRisk -> doit être ignoré
                        {
                            id: "conv-1",
                            type: "CONVERSION",
                            timestamp: nowSec + 25,
                            side: "",
                            price: 0,
                            size: 10,
                            condition_id:
                                "0x602b2b425851a3a12b048b59e8192e30afc0ae42d7ea0a5f74038d1cf0426c00",
                            token_id: "",
                            outcome_index: 999,
                            outcome: "",
                        },
                        // 3. Parlay 0x03...0000 -> doit être ignoré
                        {
                            id: "parlay-1",
                            type: "TRADE",
                            timestamp: nowSec + 20,
                            side: "BUY",
                            price: 0.46,
                            size: 10,
                            condition_id:
                                "0x0340fc04cb93f6c622ac342db7868f08d70000000000000000000000000000",
                            token_id: expectedTokenId,
                            outcome: "Yes",
                        },
                        // 4. Vrai TRADE -> doit passer avec assetAddress === token_id
                        {
                            id: "real-trade-1",
                            type: "TRADE",
                            timestamp: nowSec + 15,
                            side: "BUY",
                            price: 0.61,
                            size: 30,
                            condition_id:
                                "0xef4a879c31da19e9ec9959c0de93e5bb65c679d6c55e6e958121af0710125739",
                            token_id: expectedTokenId,
                            outcome: "No",
                            outcome_index: 1,
                        },
                    ],
                },
            };
        }) as unknown as typeof axios.get;

        const tracker = new PolymarketApiTrackerAdapter("https://data-api.polymarket.com", 60_000);
        const received: DetectedTrade[] = [];
        let markDone!: () => void;
        const done = new Promise<void>((resolve) => {
            markDone = resolve;
        });

        await tracker.start([target], async (t) => {
            received.push(t);
            markDone();
        });
        await done;
        await tracker.stop();

        assertEquals(capturedParams?.type, "TRADE");
        assertEquals(received.length, 1);
        assertEquals(received[0]?.id, "det_real-trade-1");
        assertEquals(received[0]?.assetAddress, expectedTokenId);
        assertEquals(received[0]?.outcomeLabel, "No");
    } finally {
        (axios as unknown as { get: typeof axios.get }).get = origGet;
    }
});

Deno.test("ReplicateTradeUseCase - passe token_id au contrôle slippage et throttle les rejets SOLDE_INSUFFISANT", async () => {
    const tokenId = "86238856930269158297633894715344370305155758731248529282208377802102469059377";
    let recordedRejections = 0;
    let priceLookupId = "";

    const mockApiClient = {
        getActiveTargets: async () => [],
        getBotConfig: async () => ({
            balancePercentPerTrade: 0.03,
            maxSlippagePercent: 2.0,
            maxCapPerTradeUsdc: 50.0,
            maxExposurePerMarketUsdc: 150.0,
            maxExposurePerTargetUsdc: 300.0,
            minCashReserveUsdc: 5.0,
            minPrice: 0.05,
            maxPrice: 0.9,
            copySellOrders: true,
            dryRun: false,
            maxAllocatedCapitalUsdc: 0,
            profitReinvestmentPercent: 50.0,
            isBotRunning: true,
            isBotOnline: true,
        }),
        getOpenPosition: async () => null,
        getAllOpenPositions: async () => [],
        recordTrade: async (t: ExecutedTrade) => {
            if (t.status === "REJECTED") {
                recordedRejections++;
                assertEquals(t.isDryRun, false);
            }
            return t;
        },
        sendHeartbeat: async () => {},
        sendShutdown: async () => {},
    };

    let walletBalance = 2.0; // Déclenche SOLDE_INSUFFISANT
    const mockExecutor = {
        getAvailableBalanceUsdc: async () => walletBalance,
        getCurrentBestPrice: async (id: string) => {
            priceLookupId = id;
            return 0.6; // Slippage +20% vs 0.5 -> SLIPPAGE_EXCESSIF
        },
        executeBuy: async () => {
            throw new Error("Ne devrait pas être appelé");
        },
        executeSell: async () => {
            throw new Error("Ne devrait pas être appelé");
        },
    };

    const mockNotifier = {
        sendBuyAlert: async () => {},
        sendSellAlert: async () => {},
        sendRejectionAlert: async () => {},
        sendErrorAlert: async () => {},
    };

    const useCase = new ReplicateTradeUseCase(
        mockApiClient as unknown as IApiClientPort,
        mockExecutor as unknown as IExecutorPort,
        mockNotifier as unknown as INotifierPort
    );

    const target: TargetTrader = {
        id: "t1",
        address: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        alias: "RN1",
        weightMultiplier: 1,
        enabled: true,
        stats: {
            totalCopiedTrades: 0,
            totalCopiedVolumeUsdc: 0,
            realizedPnlUsdc: 0,
            winRatePercent: 0,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    const trade: DetectedTrade = {
        id: "dt-slip-1",
        targetAddress: target.address,
        marketSlug: "test",
        marketQuestion: "Test?",
        conditionId: "0xef4a879c31da19e9ec9959c0de93e5bb65c679d6c55e6e958121af0710125739",
        assetAddress: tokenId,
        outcomeIndex: 0,
        outcomeLabel: "Yes",
        side: "BUY",
        price: 0.5,
        sizeShares: 10,
        sizeUsdc: 5,
        detectedAt: Date.now(),
        source: "POLYMARKET_API",
    };

    // Deux rejets SOLDE_INSUFFISANT consécutifs -> 1 seul persisté grâce au throttle
    await useCase.execute(trade, target);
    await useCase.execute({ ...trade, id: "dt-slip-2" }, target);
    assertEquals(recordedRejections, 1);

    // Avec solde suffisant -> getCurrentBestPrice reçoit bien token_id et rejette sur slippage
    walletBalance = 500;
    await useCase.execute({ ...trade, id: "dt-slip-3" }, target);
    assertEquals(priceLookupId, tokenId);
    assertEquals(recordedRejections, 2);
});
