import type { DetectedTrade, RiskConfig } from "@polymarket-copy/shared";

export type EvaluationOutcome =
  | { readonly isValid: true; readonly slippagePercent: number }
  | { readonly isValid: false; readonly reason: string };

export class EvaluateTradeUseCase {
  evaluate(
    trade: DetectedTrade,
    currentMarketPrice: number | null,
    riskConfig: RiskConfig
  ): EvaluationOutcome {
    // 1. Vérification des bornes de cote
    if (trade.price < riskConfig.minPrice) {
      return {
        isValid: false,
        reason: `COTE_TROP_FAIBLE (Cote: ${trade.price.toFixed(3)} < Min: ${riskConfig.minPrice.toFixed(3)})`,
      };
    }

    if (trade.price > riskConfig.maxPrice) {
      return {
        isValid: false,
        reason: `COTE_TROP_ELEVEE (Cote: ${trade.price.toFixed(3)} > Max: ${riskConfig.maxPrice.toFixed(3)})`,
      };
    }

    // 2. Si le prix du carnet n'est pas disponible, on applique une vérification conservatrice
    if (currentMarketPrice === null) {
      return {
        isValid: true,
        slippagePercent: 0,
      };
    }

    // 3. Calcul du slippage pour un BUY
    if (trade.side === "BUY") {
      const slippage = ((currentMarketPrice - trade.price) / trade.price) * 100;
      if (slippage > riskConfig.maxSlippagePercent) {
        return {
          isValid: false,
          reason: `SLIPPAGE_EXCESSIF (Slippage: +${slippage.toFixed(2)}% > Max: +${riskConfig.maxSlippagePercent.toFixed(2)}%)`,
        };
      }
      return {
        isValid: true,
        slippagePercent: Math.max(0, slippage),
      };
    }

    // 4. Calcul du slippage pour un SELL
    const sellSlippage = ((trade.price - currentMarketPrice) / trade.price) * 100;
    if (sellSlippage > riskConfig.maxSlippagePercent) {
      return {
        isValid: false,
        reason: `SLIPPAGE_VENTE_EXCESSIF (Slippage: -${sellSlippage.toFixed(2)}% > Max: ${riskConfig.maxSlippagePercent.toFixed(2)}%)`,
      };
    }

    return {
      isValid: true,
      slippagePercent: Math.max(0, sellSlippage),
    };
  }
}
