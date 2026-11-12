import type {
  DetectedTrade,
  ExecutedTrade,
  OpenPosition,
  RiskConfig,
  TargetTrader,
} from "@polymarket-copy/shared";
import type { IApiClientPort } from "../../domain/ports/api-client.port.ts";
import type { IExecutorPort } from "../../domain/ports/executor.port.ts";
import type { INotifierPort } from "../../domain/ports/notifier.port.ts";
import { CalculatePositionSizeUseCase } from "./calculate-size.use-case.ts";
import { EvaluateTradeUseCase } from "./evaluate-trade.use-case.ts";
import { HandleExitUseCase } from "./handle-exit.use-case.ts";

export class ReplicateTradeUseCase {
  private readonly calculateSize = new CalculatePositionSizeUseCase();
  private readonly evaluateTrade = new EvaluateTradeUseCase();
  private readonly handleExit = new HandleExitUseCase();
  private readonly lastBuyTimestampByCondition: Map<string, number> = new Map();

  constructor(
    private readonly apiClient: IApiClientPort,
    private readonly executor: IExecutorPort,
    private readonly notifier: INotifierPort
  ) {}

  async execute(trade: DetectedTrade, target: TargetTrader): Promise<ExecutedTrade | null> {
    const config = await this.apiClient.getBotConfig();
    if (!config.isBotRunning) {
      console.log(`[ReplicateTrade] Bot en pause, trade ignoré pour ${target.alias}`);
      return null;
    }

    // --- BRANCHE ACHAT (BUY) ---
    if (trade.side === "BUY") {
      const allPositions = await this.apiClient.getAllOpenPositions();
      const rawWalletBalance = await this.executor.getAvailableBalanceUsdc();
      const minReserve = config.minCashReserveUsdc ?? 5.0;

      // 1. RÈGLE STRICTE : Portefeuille vide ou Capital alloué au bot atteint
      const { effectiveBalance, isAllocatedLimitHit, maxBotBudget, botRemainingCash } =
        await this.calculateEffectiveBalance(rawWalletBalance, config, allPositions);

      if (effectiveBalance <= minReserve) {
        const reason =
          config.maxAllocatedCapitalUsdc > 0 && isAllocatedLimitHit
            ? `SOLDE_INSUFFISANT : Capital alloué au bot atteint (Budget restant: ${botRemainingCash.toFixed(2)} USDC <= Réserve: ${minReserve.toFixed(2)} USDC, Plafond max: ${maxBotBudget.toFixed(2)} USDC)`
            : `SOLDE_INSUFFISANT : Portefeuille vide (Cash disponible: ${effectiveBalance.toFixed(2)} USDC <= Réserve min: ${minReserve.toFixed(2)} USDC)`;
        await this.handleRejection(trade, target, reason);
        return null;
      }

      // 2. RÈGLE COOLDOWN ANTI-RAFALE : Éviter le spam de micro-ordres consécutifs sur le même marché
      const lastBuyTime = this.lastBuyTimestampByCondition.get(trade.conditionId) ?? 0;
      const cooldownMs = 60_000; // 60 secondes de pause entre deux réplications du même marché
      if (Date.now() - lastBuyTime < cooldownMs) {
        const reason = `COOLDOWN_ANTI_RAFALE (Achat déjà répliqué sur ce marché il y a moins de 60s)`;
        await this.handleRejection(trade, target, reason);
        return null;
      }

      // 3. RÈGLE PLAFOND D'EXPOSITION PAR MARCHÉ ET PAR BALEINE
      const existingMarketPosition = allPositions.find((p) => p.conditionId === trade.conditionId);
      const currentMarketExposure = existingMarketPosition?.totalInvestedUsdc ?? 0;
      const maxMarketExposure = config.maxExposurePerMarketUsdc ?? 150.0;

      if (currentMarketExposure >= maxMarketExposure) {
        const reason = `EXPOSITION_MAX_MARCHE_ATTEINTE (Déjà investi: ${currentMarketExposure.toFixed(2)} USDC >= Plafond: ${maxMarketExposure.toFixed(2)} USDC)`;
        await this.handleRejection(trade, target, reason);
        return null;
      }

      const whalePositions = allPositions.filter(
        (p) => p.targetAddress.toLowerCase() === target.address.toLowerCase()
      );
      const currentWhaleExposure = whalePositions.reduce(
        (sum, p) => sum + (p.totalInvestedUsdc || 0),
        0
      );
      const maxWhaleExposure = config.maxExposurePerTargetUsdc ?? 300.0;

      if (currentWhaleExposure >= maxWhaleExposure) {
        const reason = `EXPOSITION_MAX_BALEINE_ATTEINTE (Déjà alloué à ${target.alias}: ${currentWhaleExposure.toFixed(2)} USDC >= Plafond: ${maxWhaleExposure.toFixed(2)} USDC)`;
        await this.handleRejection(trade, target, reason);
        return null;
      }

      // 4. Calcul du dimensionnement avec respect des plafonds et du capital alloué
      let allocatedSizeUsdc = this.calculateSize.calculate(
        effectiveBalance,
        config.balancePercentPerTrade,
        config.maxCapPerTradeUsdc,
        target.weightMultiplier,
        target.maxUsdcPerTrade,
        config.minTradeSizeUsdc ?? 2.0
      );

      // Ajustement au plafond marché restant
      const remainingMarketCapacity = maxMarketExposure - currentMarketExposure;
      allocatedSizeUsdc = Math.min(allocatedSizeUsdc, remainingMarketCapacity);

      // Ajustement au plafond baleine restant
      const remainingWhaleCapacity = maxWhaleExposure - currentWhaleExposure;
      allocatedSizeUsdc = Math.min(allocatedSizeUsdc, remainingWhaleCapacity);

      if (allocatedSizeUsdc < 1.0) {
        const reason = `SOLDE_INSUFFISANT (Taille calculée < 1.0 USDC après application des plafonds de risque)`;
        await this.handleRejection(trade, target, reason);
        return null;
      }

      const currentPrice = await this.executor.getCurrentBestPrice(trade.conditionId, "BUY");
      const evaluation = this.evaluateTrade.evaluate(trade, currentPrice, config);

      if (!evaluation.isValid) {
        await this.handleRejection(trade, target, evaluation.reason);
        return null;
      }

      console.log(
        `[ReplicateTrade] Exécution ACHAT pour ${target.alias} sur ${trade.marketQuestion} (${allocatedSizeUsdc.toFixed(2)} USDC)`
      );

      const executed = await this.executor.executeBuy(trade, allocatedSizeUsdc);
      this.lastBuyTimestampByCondition.set(trade.conditionId, Date.now());
      await this.apiClient.recordTrade(executed);
      await this.notifier.sendBuyAlert(executed, target);
      return executed;
    }

    // --- BRANCHE VENTE (SELL - Gestion ALL) ---
    if (trade.side === "SELL") {
      if (!config.copySellOrders) {
        console.log(`[ReplicateTrade] Copie des ventes désactivée dans la config, trade ignoré`);
        return null;
      }

      const position = await this.apiClient.getOpenPosition(trade.conditionId);
      const exitDecision = this.handleExit.decide(trade, position);

      if (!exitDecision.shouldExit) {
        console.log(`[ReplicateTrade] Vente ignorée pour ${target.alias} : ${exitDecision.reason}`);
        return null;
      }

      const currentPrice =
        (await this.executor.getCurrentBestPrice(trade.conditionId, "SELL")) ?? trade.price;

      console.log(
        `[ReplicateTrade] Exécution VENTE pour ${target.alias} (${exitDecision.sharesToSell} parts vendues)`
      );

      const executed = await this.executor.executeSell(
        exitDecision.position,
        exitDecision.sharesToSell,
        currentPrice,
        target.address
      );

      await this.apiClient.recordTrade(executed);
      await this.notifier.sendSellAlert(executed, target, exitDecision.position);
      return executed;
    }

    return null;
  }

  async calculateEffectiveBalance(
    rawWalletBalance: number,
    config: RiskConfig,
    allPositions: OpenPosition[]
  ): Promise<{
    effectiveBalance: number;
    isAllocatedLimitHit: boolean;
    maxBotBudget: number;
    botRemainingCash: number;
  }> {
    if (!config.maxAllocatedCapitalUsdc || config.maxAllocatedCapitalUsdc <= 0) {
      return {
        effectiveBalance: rawWalletBalance,
        isAllocatedLimitHit: false,
        maxBotBudget: rawWalletBalance,
        botRemainingCash: rawWalletBalance,
      };
    }

    const metrics = (await this.apiClient.getMetrics?.()) ?? null;
    const realizedPnl = metrics?.realizedPnlUsdc ?? 0;
    const reinvestRate = (config.profitReinvestmentPercent ?? 50.0) / 100;
    const allowedGains = realizedPnl > 0 ? realizedPnl * reinvestRate : realizedPnl;
    const maxBotBudget = Math.max(0, config.maxAllocatedCapitalUsdc + allowedGains);

    const totalInvested = allPositions.reduce((sum, p) => sum + (p.totalInvestedUsdc || 0), 0);
    const botRemainingCash = Math.max(0, maxBotBudget - totalInvested);
    const effectiveBalance = Math.min(rawWalletBalance, botRemainingCash);

    return {
      effectiveBalance,
      isAllocatedLimitHit: botRemainingCash < rawWalletBalance,
      maxBotBudget,
      botRemainingCash,
    };
  }

  private async handleRejection(
    trade: DetectedTrade,
    target: TargetTrader,
    reason: string
  ): Promise<void> {
    console.warn(`[ReplicateTrade] REJET pour ${target.alias} : ${reason}`);

    const rejectedTrade: ExecutedTrade = {
      id: `rej_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      detectedTradeId: trade.id,
      targetAddress: target.address,
      conditionId: trade.conditionId,
      marketSlug: trade.marketSlug,
      marketQuestion: trade.marketQuestion,
      outcomeLabel: trade.outcomeLabel,
      side: trade.side,
      targetPrice: trade.price,
      executedPrice: trade.price,
      slippagePercent: 0,
      shares: 0,
      costUsdc: 0,
      status: "REJECTED",
      rejectionReason: reason,
      isDryRun: true,
      executedAt: Date.now(),
    };

    await this.apiClient.recordTrade(rejectedTrade);
    await this.notifier.sendRejectionAlert(trade, target, reason);
  }
}
