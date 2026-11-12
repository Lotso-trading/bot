export class CalculatePositionSizeUseCase {
  calculate(
    availableBalanceUsdc: number,
    balancePercent: number,
    maxCapUsdc: number,
    weightMultiplier = 1.0,
    targetMaxCap?: number,
    minTradeSizeUsdc = 2.0
  ): number {
    if (availableBalanceUsdc <= 0 || balancePercent <= 0) {
      return 0;
    }

    const effectiveWeight = Math.max(0.1, weightMultiplier);
    let targetAllocation = availableBalanceUsdc * balancePercent * effectiveWeight;

    // Plancher dynamique pour petits portefeuilles (ex: 50 USDC)
    // Permet d'éviter le rejet prématuré dès que l'allocation calculée descend sous le plancher
    if (targetAllocation < minTradeSizeUsdc && availableBalanceUsdc >= minTradeSizeUsdc) {
      targetAllocation = minTradeSizeUsdc;
    } else if (targetAllocation < minTradeSizeUsdc && availableBalanceUsdc < minTradeSizeUsdc) {
      targetAllocation = availableBalanceUsdc;
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
