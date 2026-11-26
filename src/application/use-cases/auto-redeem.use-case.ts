import type { OpenPosition } from "@lotso-trading/shared";
import type { IApiClientPort } from "../../domain/ports/api-client.port.ts";
import type { IExecutorPort } from "../../domain/ports/executor.port.ts";
import type { INotifierPort } from "../../domain/ports/notifier.port.ts";

export class AutoRedeemUseCase {
    private readonly inFlightRedemptions = new Set<string>();
    private readonly recentlyRedeemed = new Map<string, number>();
    private readonly redeemCooldownMs = 5 * 60 * 1000;

    constructor(
        private readonly apiClient: IApiClientPort,
        private readonly executor: IExecutorPort,
        private readonly notifier?: INotifierPort,
        private readonly isDryRun = false
    ) {}

    private pruneRecentlyRedeemed(now: number): void {
        for (const [key, ts] of this.recentlyRedeemed.entries()) {
            if (now - ts > this.redeemCooldownMs) {
                this.recentlyRedeemed.delete(key);
            }
        }
    }

    async execute(conditionId: string, knownPosition?: OpenPosition): Promise<string | null> {
        if (!conditionId || conditionId === "0x") return null;

        const now = Date.now();
        this.pruneRecentlyRedeemed(now);

        if (this.recentlyRedeemed.has(conditionId)) {
            return null;
        }

        if (this.inFlightRedemptions.has(conditionId)) {
            console.log(
                `[AutoRedeem] Rachat déjà en cours pour conditionId=${conditionId.slice(0, 16)}...`
            );
            return null;
        }

        if (!this.executor.redeemWinningPosition) {
            console.warn("[AutoRedeem] L'exécuteur ne supporte pas le rachat de positions.");
            return null;
        }

        this.inFlightRedemptions.add(conditionId);

        try {
            console.log(
                `\n[AutoRedeem] 🎯 Déclenchement du rachat automatique pour conditionId=${conditionId.slice(0, 16)}...`
            );

            const txHash = await this.executor.redeemWinningPosition(conditionId);
            console.log(`[AutoRedeem] ✅ Rachat validé ! TxHash: ${txHash}`);

            this.recentlyRedeemed.set(conditionId, Date.now());

            // Enregistrement sur l'API (MongoDB)
            const redeemedPosition =
                (await this.apiClient.recordPositionRedeemed?.(conditionId, txHash)) ?? null;

            // Notification Discord (privilégie la position clôturée retournée par l'API ou connue)
            try {
                const position =
                    redeemedPosition ??
                    knownPosition ??
                    (await this.apiClient.getOpenPosition(conditionId));
                if (position) {
                    await this.notifier?.sendRedeemAlert?.(position, txHash, this.isDryRun);
                }
            } catch (_notifyErr: unknown) {
                // Ignorer les erreurs d'alerte secondaire
            }

            return txHash;
        } catch (err: unknown) {
            console.error(
                `[AutoRedeem] ❌ Échec du rachat pour conditionId=${conditionId}:`,
                err instanceof Error ? err.message : err
            );
            return null;
        } finally {
            this.inFlightRedemptions.delete(conditionId);
        }
    }

    async redeemAllPending(): Promise<number> {
        if (!this.apiClient.getUnredeemedWinningPositions) return 0;

        try {
            const unredeemed = await this.apiClient.getUnredeemedWinningPositions();
            if (!unredeemed || unredeemed.length === 0) {
                return 0;
            }

            const now = Date.now();
            this.pruneRecentlyRedeemed(now);
            const eligible = unredeemed.filter(
                (pos) =>
                    !pos.settleTxHash &&
                    !this.inFlightRedemptions.has(pos.conditionId) &&
                    !this.recentlyRedeemed.has(pos.conditionId)
            );
            if (eligible.length === 0) {
                return 0;
            }

            console.log(
                `[AutoRedeem] 🔍 ${eligible.length} position(s) éligible(s) non réclamée(s) trouvée(s). Lancement du rachat...`
            );

            let count = 0;
            for (const pos of eligible) {
                const txHash = await this.execute(pos.conditionId, pos);
                if (txHash) {
                    count++;
                }
            }

            return count;
        } catch (err: unknown) {
            console.warn(
                "[AutoRedeem] Erreur lors de la vérification des positions en attente:",
                err
            );
            return 0;
        }
    }
}
