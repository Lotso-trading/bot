import { assertEquals } from "jsr:@std/assert";
import type { OpenPosition } from "@polymarket-copy/shared";
import { AutoRedeemUseCase } from "../src/application/use-cases/auto-redeem.use-case.ts";
import type { IApiClientPort } from "../src/domain/ports/api-client.port.ts";
import type { IExecutorPort } from "../src/domain/ports/executor.port.ts";
import type { INotifierPort } from "../src/domain/ports/notifier.port.ts";

function createMockPosition(conditionId: string): OpenPosition {
  return {
    id: `pos_${conditionId}`,
    conditionId,
    assetAddress: "0x1111111111111111111111111111111111111111",
    marketSlug: "test-market-slug",
    marketQuestion: "Will Polymarket win?",
    outcomeLabel: "YES",
    status: "CLOSED",
    closeReason: "RESOLVED_WIN",
    settledPayoutUsdc: 10.0,
    realizedPnlUsdc: 4.0,
    totalShares: 10.0,
    avgEntryPrice: 0.6,
    totalInvestedUsdc: 6.0,
    currentMarketPrice: 1.0,
    currentMarketValueUsdc: 10.0,
    unrealizedPnlUsdc: 0,
    unrealizedPnlPercent: 0,
    targetAddress: "0x2222222222222222222222222222222222222222",
    openedAt: Date.now() - 3600000,
    updatedAt: Date.now(),
  };
}

Deno.test("AutoRedeemUseCase - exécute le rachat, enregistre la tx sur l'API et envoie l'alerte", async () => {
  let recordedConditionId = "";
  let recordedTxHash = "";
  let alertSent = false;

  const mockApiClient: IApiClientPort = {
    getActiveTargets: () => Promise.resolve([]),
    getBotConfig: () => Promise.reject(new Error("not implemented")),
    getOpenPosition: (condId: string) => Promise.resolve(createMockPosition(condId)),
    getAllOpenPositions: () => Promise.resolve([]),
    recordTrade: () => Promise.reject(new Error("not implemented")),
    recordPositionRedeemed: (condId: string, tx: string) => {
      recordedConditionId = condId;
      recordedTxHash = tx;
      return Promise.resolve();
    },
    sendHeartbeat: () => Promise.resolve(),
    sendShutdown: () => Promise.resolve(),
  };

  const mockExecutor: IExecutorPort = {
    executeBuy: () => Promise.reject(new Error("not implemented")),
    executeSell: () => Promise.reject(new Error("not implemented")),
    getAvailableBalanceUsdc: () => Promise.resolve(100),
    getCurrentBestPrice: () => Promise.resolve(1),
    redeemWinningPosition: (condId: string) => Promise.resolve(`tx_redeem_success_${condId}`),
  };

  const mockNotifier: INotifierPort = {
    sendBuyAlert: () => Promise.resolve(),
    sendSellAlert: () => Promise.resolve(),
    sendRejectionAlert: () => Promise.resolve(),
    sendErrorAlert: () => Promise.resolve(),
    sendRedeemAlert: (_pos, tx) => {
      if (tx.startsWith("tx_redeem_success_")) {
        alertSent = true;
      }
      return Promise.resolve();
    },
  };

  const useCase = new AutoRedeemUseCase(mockApiClient, mockExecutor, mockNotifier, false);
  const resultTx = await useCase.execute("0xcond_123");

  assertEquals(resultTx, "tx_redeem_success_0xcond_123");
  assertEquals(recordedConditionId, "0xcond_123");
  assertEquals(recordedTxHash, "tx_redeem_success_0xcond_123");
  assertEquals(alertSent, true);
});

Deno.test("AutoRedeemUseCase - bloque les exécutions concurrentes sur la même condition (déduplication)", async () => {
  let redeemCalls = 0;

  const mockApiClient: IApiClientPort = {
    getActiveTargets: () => Promise.resolve([]),
    getBotConfig: () => Promise.reject(new Error("not implemented")),
    getOpenPosition: () => Promise.resolve(null),
    getAllOpenPositions: () => Promise.resolve([]),
    recordTrade: () => Promise.reject(new Error("not implemented")),
    recordPositionRedeemed: () => Promise.resolve(),
    sendHeartbeat: () => Promise.resolve(),
    sendShutdown: () => Promise.resolve(),
  };

  const mockExecutor: IExecutorPort = {
    executeBuy: () => Promise.reject(new Error("not implemented")),
    executeSell: () => Promise.reject(new Error("not implemented")),
    getAvailableBalanceUsdc: () => Promise.resolve(100),
    getCurrentBestPrice: () => Promise.resolve(1),
    redeemWinningPosition: async (condId: string) => {
      redeemCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return `tx_${condId}`;
    },
  };

  const useCase = new AutoRedeemUseCase(mockApiClient, mockExecutor);

  // Deux appels en parallèle sur le même conditionId
  const [res1, res2] = await Promise.all([
    useCase.execute("0xduplicate_check"),
    useCase.execute("0xduplicate_check"),
  ]);

  // Un seul appel doit aboutir, l'autre doit être ignoré
  assertEquals(redeemCalls, 1);
  assertEquals(res1 === "tx_0xduplicate_check" || res2 === "tx_0xduplicate_check", true);
  assertEquals(res1 === null || res2 === null, true);
});

Deno.test("AutoRedeemUseCase - redeemAllPending réclame toutes les positions non réclamées", async () => {
  const redeemedSet = new Set<string>();

  const mockApiClient: IApiClientPort = {
    getActiveTargets: () => Promise.resolve([]),
    getBotConfig: () => Promise.reject(new Error("not implemented")),
    getOpenPosition: (condId: string) => Promise.resolve(createMockPosition(condId)),
    getAllOpenPositions: () => Promise.resolve([]),
    getUnredeemedWinningPositions: () =>
      Promise.resolve([
        createMockPosition("0xpos_alpha"),
        createMockPosition("0xpos_beta"),
      ]),
    recordPositionRedeemed: (condId: string) => {
      redeemedSet.add(condId);
      return Promise.resolve();
    },
    recordTrade: () => Promise.reject(new Error("not implemented")),
    sendHeartbeat: () => Promise.resolve(),
    sendShutdown: () => Promise.resolve(),
  };

  const mockExecutor: IExecutorPort = {
    executeBuy: () => Promise.reject(new Error("not implemented")),
    executeSell: () => Promise.reject(new Error("not implemented")),
    getAvailableBalanceUsdc: () => Promise.resolve(100),
    getCurrentBestPrice: () => Promise.resolve(1),
    redeemWinningPosition: (condId: string) => Promise.resolve(`tx_hash_${condId}`),
  };

  const useCase = new AutoRedeemUseCase(mockApiClient, mockExecutor);
  const count = await useCase.redeemAllPending();

  assertEquals(count, 2);
  assertEquals(redeemedSet.has("0xpos_alpha"), true);
  assertEquals(redeemedSet.has("0xpos_beta"), true);
});
