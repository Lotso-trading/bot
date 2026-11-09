export class CalculatePositionSizeUseCase {
  calculate(
    availableBalanceUsdc: number,
    balancePercent: number,
    maxCapUsdc: number,
    weightMultiplier = 1.0,
    targetMaxCap?: number
  ): number {
    if (availableBalanceUsdc <= 0 || balancePercent <= 0) {
      return 0;
    }

    const effectiveWeight = Math.max(0.1, weightMultiplier);
    const targetAllocation = availableBalanceUsdc * balancePercent * effectiveWeight;

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
