import type { DetectedTrade, OpenPosition } from "@polymarket-copy/shared";

export type ExitDecision =
  | {
      readonly shouldExit: true;
      readonly sharesToSell: number;
      readonly isFullExit: boolean;
      readonly position: OpenPosition;
    }
  | {
      readonly shouldExit: false;
      readonly reason: string;
    };

export class HandleExitUseCase {
  decide(whaleTrade: DetectedTrade, position: OpenPosition | null): ExitDecision {
    if (!position || position.totalShares <= 0) {
      return {
        shouldExit: false,
        reason: "AUCUNE_POSITION_OUVERTE_A_VENDRE",
      };
    }

    // Si la baleine vend un montant très important par rapport à notre position ou si c'est une sortie totale
    // On liquide 100% de notre position
    if (whaleTrade.sizeShares >= position.totalShares * 0.95) {
      return {
        shouldExit: true,
        sharesToSell: position.totalShares,
        isFullExit: true,
        position,
      };
    }

    // Sortie partielle proportionnelle
    const ratio = Math.min(1.0, whaleTrade.sizeShares / (whaleTrade.sizeShares * 1.5));
    const calculatedShares = Math.floor(position.totalShares * ratio);
    const sharesToSell = Math.max(1, Math.min(position.totalShares, calculatedShares));

    return {
      shouldExit: true,
      sharesToSell,
      isFullExit: sharesToSell >= position.totalShares,
      position,
    };
  }
}
