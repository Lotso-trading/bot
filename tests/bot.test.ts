import { assertEquals } from "jsr:@std/assert";
import type {
  DetectedTrade,
  ExecutedTrade,
  OpenPosition,
  RiskConfig,
  TargetTrader,
} from "@polymarket-copy/shared";
import { CalculatePositionSizeUseCase } from "../src/application/use-cases/calculate-size.use-case.ts";
import { EvaluateTradeUseCase } from "../src/application/use-cases/evaluate-trade.use-case.ts";
import { HandleExitUseCase } from "../src/application/use-cases/handle-exit.use-case.ts";
import { ReplicateTradeUseCase } from "../src/application/use-cases/replicate-trade.use-case.ts";
import type { IApiClientPort } from "../src/domain/ports/api-client.port.ts";
import type { IExecutorPort } from "../src/domain/ports/executor.port.ts";
import type { INotifierPort } from "../src/domain/ports/notifier.port.ts";
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
    maxAllocatedCapitalUsdc: 0,
    profitReinvestmentPercent: 50.0,
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
    }),
    getOpenPosition: async () => null,
    getAllOpenPositions: async () => [],
    recordTrade: async (t: ExecutedTrade) => {
      recordedTrade = t;
      return t;
    },
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
    maxAllocatedCapitalUsdc: 100.0, // 100 $ de base alloués
    profitReinvestmentPercent: 50.0, // 50% des bénéfices réinvestis
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
