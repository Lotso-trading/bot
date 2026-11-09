import type {
  DetectedTrade,
  DiscordWebhookPayload,
  ExecutedTrade,
  OpenPosition,
  TargetTrader,
} from "@polymarket-copy/shared";
import type { INotifierPort } from "../../domain/ports/notifier.port.ts";

export interface DiscordWebhookConfig {
  buyWebhookUrl?: string;
  sellWebhookUrl?: string;
  webhookUrl?: string;
}

export class DiscordWebhookAdapter implements INotifierPort {
  private readonly buyWebhookUrl?: string;
  private readonly sellWebhookUrl?: string;
  private readonly fetcher: typeof fetch;

  constructor(options?: DiscordWebhookConfig | string, fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
    if (typeof options === "string") {
      this.buyWebhookUrl = options;
      this.sellWebhookUrl = options;
    } else if (options) {
      this.buyWebhookUrl = options.buyWebhookUrl || options.webhookUrl;
      this.sellWebhookUrl = options.sellWebhookUrl || options.webhookUrl;
    }
  }

  private getMarketUrl(marketSlug?: string): string {
    if (!marketSlug) return "https://polymarket.com";
    return `https://polymarket.com/event/${marketSlug}`;
  }

  async sendBuyAlert(trade: ExecutedTrade, target: TargetTrader): Promise<void> {
    if (!this.buyWebhookUrl) return;

    const dryRunBadge = trade.isDryRun ? " [SIMULATION]" : " [RÉEL]";
    const marketUrl = this.getMarketUrl(trade.marketSlug);
    const question = trade.marketQuestion || "Marché Polymarket";
    const outcome = trade.outcomeLabel || "YES";

    const payload: DiscordWebhookPayload = {
      username: "Lotso",
      embeds: [
        {
          title: `🟢 Achat Répliqué${dryRunBadge}`,
          url: marketUrl,
          description: `Copie automatique de la baleine **${target.alias}**`,
          color: 0x00c853, // Vert
          fields: [
            {
              name: "Cible Copiée",
              value: `**${target.alias}** (\`${target.address.slice(0, 6)}...${target.address.slice(-4)}\`)`,
              inline: true,
            },
            { name: "Side", value: "**BUY**", inline: true },
            { name: "Choix", value: `**${outcome}**`, inline: true },
            {
              name: "Marché",
              value: `[${question}](${marketUrl})`,
              inline: false,
            },
            {
              name: "Montant Investi",
              value: `**${trade.costUsdc.toFixed(2)} USDC**`,
              inline: true,
            },
            { name: "Parts Détenues", value: `${trade.shares.toFixed(1)} parts`, inline: true },
            {
              name: "Prix Exécuté",
              value: `${trade.executedPrice.toFixed(3)} USDC`,
              inline: true,
            },
            { name: "Slippage", value: `+${trade.slippagePercent.toFixed(2)}%`, inline: true },
            {
              name: "Condition ID",
              value: `\`${trade.conditionId.slice(0, 16)}...\``,
              inline: true,
            },
          ],
          timestamp: new Date(trade.executedAt).toISOString(),
          footer: {
            text: "Copy-Trading Engine • Acheter",
          },
        },
      ],
    };

    await this.dispatch(this.buyWebhookUrl, payload);
  }

  async sendSellAlert(
    trade: ExecutedTrade,
    target: TargetTrader,
    position?: OpenPosition
  ): Promise<void> {
    if (!this.sellWebhookUrl) return;

    const dryRunBadge = trade.isDryRun ? " [SIMULATION]" : " [RÉEL]";
    const marketSlug = trade.marketSlug || position?.marketSlug;
    const marketUrl = this.getMarketUrl(marketSlug);
    const question = trade.marketQuestion || position?.marketQuestion || "Marché Polymarket";
    const outcome = trade.outcomeLabel || position?.outcomeLabel || "YES";
    const pnlUsdc = position ? trade.costUsdc - trade.shares * position.avgEntryPrice : 0;
    const pnlSign = pnlUsdc >= 0 ? "+" : "";

    const payload: DiscordWebhookPayload = {
      username: "Lotso",
      embeds: [
        {
          title: `🔴 Vente / Sortie ALL${dryRunBadge}`,
          url: marketUrl,
          description: `Réplication de sortie intégrale de la baleine **${target.alias}**`,
          color: 0xd50000, // Rouge
          fields: [
            {
              name: "Cible Copiée",
              value: `**${target.alias}** (\`${target.address.slice(0, 6)}...${target.address.slice(-4)}\`)`,
              inline: true,
            },
            { name: "Side", value: "**SELL**", inline: true },
            { name: "Choix", value: `**${outcome}**`, inline: true },
            {
              name: "Marché",
              value: `[${question}](${marketUrl})`,
              inline: false,
            },
            { name: "Parts Vendues", value: `${trade.shares.toFixed(1)} parts`, inline: true },
            {
              name: "Prix de Sortie",
              value: `${trade.executedPrice.toFixed(3)} USDC`,
              inline: true,
            },
            {
              name: "Montant Récupéré",
              value: `**${trade.costUsdc.toFixed(2)} USDC**`,
              inline: true,
            },
            {
              name: "PnL Estimé",
              value: `**${pnlSign}${pnlUsdc.toFixed(2)} USDC**`,
              inline: true,
            },
          ],
          timestamp: new Date(trade.executedAt).toISOString(),
          footer: {
            text: "Copy-Trading Engine • Vendre",
          },
        },
      ],
    };

    await this.dispatch(this.sellWebhookUrl, payload);
  }

  async sendRejectionAlert(
    _trade: DetectedTrade,
    _target: TargetTrader,
    _reason: string
  ): Promise<void> {
    // "pour les rejects pas de webhook" : Strictement aucun webhook émis
    return Promise.resolve();
  }

  async sendErrorAlert(title: string, error: string): Promise<void> {
    const targetUrl = this.buyWebhookUrl || this.sellWebhookUrl;
    if (!targetUrl) return;

    const payload: DiscordWebhookPayload = {
      username: "Lotso",
      embeds: [
        {
          title: `⚠️ Incident Moteur : ${title}`,
          description: `\`\`\`${error.slice(0, 1500)}\`\`\``,
          color: 0x212121,
          fields: [],
          timestamp: new Date().toISOString(),
        },
      ],
    };

    await this.dispatch(targetUrl, payload);
  }

  private async dispatch(url: string, payload: DiscordWebhookPayload): Promise<void> {
    try {
      await this.fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });
    } catch (err: unknown) {
      console.warn("[DiscordWebhook] Échec d'envoi du webhook Discord:", err);
    }
  }
}
