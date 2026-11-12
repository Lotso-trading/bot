export class CalculatePositionSizeUseCase {
  calculate(
    availableBalanceUsdc: number,
    balancePercent: number,
    maxCapUsdc: number,
    weightMultiplier = 1.0,
    targetMaxCap?: number,
    minTradeSizeUsdc?: number
  ): number {
    if (availableBalanceUsdc <= 0 || balancePercent <= 0) {
      return 0;
    }

    const effectiveWeight = Math.max(0.1, weightMultiplier);
    let targetAllocation = availableBalanceUsdc * balancePercent * effectiveWeight;

    // Plancher dynamique pour petits portefeuilles (ex: 50 USDC)
    if (minTradeSizeUsdc !== undefined && minTradeSizeUsdc > 0) {
      if (targetAllocation < minTradeSizeUsdc && availableBalanceUsdc >= minTradeSizeUsdc) {
        targetAllocation = minTradeSizeUsdc;
      }
    }

    let finalAmount = Math.min(targetAllocation, maxCapUsdc);
    if (targetMaxCap !== undefined && targetMaxCap > 0) {
      finalAmount = Math.min(finalAmount, targetMaxCap);
    }

    // Minimum d'ordre sur Polymarket (1.0 USDC)
    if (finalAmount < 1.0) {
      return 0;
    }

    // Arrondi à 2 décimales pour les USDC
    return Math.floor(finalAmount * 100) / 100;
  }
}
