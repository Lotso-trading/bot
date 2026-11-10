import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import type { DetectedTrade, ExecutedTrade, OpenPosition } from "@polymarket-copy/shared";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { IExecutorPort } from "../../domain/ports/executor.port.ts";

export class PolymarketClobAdapter implements IExecutorPort {
  private client: ClobClient | null = null;
  private readonly chainId = 137;

  constructor(
    private readonly host: string,
    private readonly privateKey: string,
    private readonly signatureType = 0,
    private readonly funderAddress?: string
  ) {}

  private async getClient(): Promise<ClobClient> {
    if (this.client) return this.client;

    if (!this.privateKey || this.privateKey.startsWith("your_")) {
      throw new Error(
        "Clé privée Polymarket invalide ou non configurée dans .env (POLYMARKET_PRIVATE_KEY)"
      );
    }

    const formattedKey = (
      this.privateKey.startsWith("0x") ? this.privateKey : `0x${this.privateKey}`
    ) as `0x${string}`;

    const account = privateKeyToAccount(formattedKey);
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    const initialClient = new ClobClient(this.host, this.chainId, signer);
    const creds = await initialClient.createOrDeriveApiKey();

    this.client = new ClobClient(
      this.host,
      this.chainId,
      signer,
      creds,
      this.signatureType,
      this.funderAddress
    );

    return this.client;
  }

  resolveTokenId(tradeOrPosition: { assetAddress?: string; conditionId: string }): string {
    // Si assetAddress est défini et correspond à un token ID ERC1155 (entier décimal ou identifiant différent d'une adresse de contrat 40 hex)
    if (
      tradeOrPosition.assetAddress &&
      tradeOrPosition.assetAddress.length > 20 &&
      !/^0x[a-fA-F0-9]{40}$/i.test(tradeOrPosition.assetAddress)
    ) {
      return tradeOrPosition.assetAddress;
    }
    return tradeOrPosition.conditionId;
  }

  private async getRoundedPrice(
    client: ClobClient,
    tokenId: string,
    targetPrice: number
  ): Promise<number> {
    try {
      const tickSizeStr = await client.getTickSize(tokenId);
      const tickSize = Number(tickSizeStr) || 0.01;
      const rounded = Math.round(targetPrice / tickSize) * tickSize;
      return Math.round(rounded * 1000) / 1000;
    } catch (_err: unknown) {
      return Math.round(targetPrice * 100) / 100;
    }
  }

  async getAvailableBalanceUsdc(): Promise<number> {
    try {
      const client = await this.getClient();
      const balanceObj = (await client.getBalanceAllowance()) as {
        balance?: string;
        allowance?: string;
      };

      if (balanceObj && typeof balanceObj.balance === "string") {
        const balanceUsdc = Number(balanceObj.balance) / 1e6;
        const allowanceUsdc = balanceObj.allowance ? Number(balanceObj.allowance) / 1e6 : 0;

        if (allowanceUsdc <= 0 && balanceUsdc > 0) {
          console.warn(
            `[ClobAdapter] ATTENTION : Solde disponible ${balanceUsdc.toFixed(2)} USDC mais ALLOWANCE CLOB = 0 USDC ! Les ordres réels seront rejetés tant que l'allowance n'est pas activée sur Polymarket.`
          );
        }

        return balanceUsdc;
      }
    } catch (err: unknown) {
      console.warn("[ClobAdapter] Impossible de lire le solde CLOB:", err);
    }
    return 0;
  }

  async getCurrentBestPrice(conditionId: string, side: "BUY" | "SELL"): Promise<number | null> {
    try {
      const client = await this.getClient();
      const tokenId = this.resolveTokenId({ conditionId });
      const res = await client.getPrice(tokenId, side === "BUY" ? Side.BUY : Side.SELL);
      if (res?.price) {
        return Number(res.price);
      }
    } catch (_err: unknown) {
      // Ignoré
    }
    return null;
  }

  async executeBuy(trade: DetectedTrade, sizeUsdc: number): Promise<ExecutedTrade> {
    const client = await this.getClient();
    const tokenId = this.resolveTokenId(trade);
    const rawMarketPrice = (await this.getCurrentBestPrice(tokenId, "BUY")) ?? trade.price;
    const marketPrice = await this.getRoundedPrice(client, tokenId, rawMarketPrice);
    const shares = Math.floor((sizeUsdc / marketPrice) * 100) / 100;

    console.log(
      `[ClobAdapter] Soumission ordre ACHAT CLOB : tokenID=${tokenId.slice(0, 16)}... price=${marketPrice} size=${shares}`
    );

    const order = await client.createOrder({
      tokenID: tokenId,
      price: marketPrice,
      side: Side.BUY,
      size: shares,
    });

    const response = (await client.postOrder(order, OrderType.FOK)) as {
      success?: boolean;
      orderID?: string;
      errorMsg?: string;
      status?: string;
    };

    if (response && (response.success === false || response.errorMsg)) {
      throw new Error(
        `CLOB_REJECTION (Achat refusé par Polymarket): ${response.errorMsg || "Ordre FOK non exécuté par le carnet"}`
      );
    }

    if (!response?.orderID && response?.status !== "matched" && response?.status !== "live") {
      throw new Error(`CLOB_ERROR (Aucun orderID retourné par Polymarket pour l'achat)`);
    }

    const orderId = response?.orderID || `order_${Date.now()}`;
    const slippagePercent = ((marketPrice - trade.price) / trade.price) * 100;

    return {
      id: `clob_buy_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      detectedTradeId: trade.id,
      targetAddress: trade.targetAddress,
      conditionId: trade.conditionId,
      assetAddress: trade.assetAddress,
      marketSlug: trade.marketSlug,
      marketQuestion: trade.marketQuestion,
      outcomeLabel: trade.outcomeLabel,
      endDate: trade.endDate,
      side: "BUY",
      targetPrice: trade.price,
      executedPrice: marketPrice,
      slippagePercent,
      shares,
      costUsdc: Math.round(shares * marketPrice * 100) / 100,
      orderId: String(orderId),
      status: "FILLED",
      isDryRun: false,
      executedAt: Date.now(),
    };
  }

  async executeSell(
    position: OpenPosition,
    sharesToSell: number,
    marketPrice: number,
    targetAddress: string
  ): Promise<ExecutedTrade> {
    const client = await this.getClient();
    const tokenId = this.resolveTokenId(position);
    const roundedPrice = await this.getRoundedPrice(client, tokenId, marketPrice);

    console.log(
      `[ClobAdapter] Soumission ordre VENTE CLOB : tokenID=${tokenId.slice(0, 16)}... price=${roundedPrice} size=${sharesToSell}`
    );

    const order = await client.createOrder({
      tokenID: tokenId,
      price: roundedPrice,
      side: Side.SELL,
      size: sharesToSell,
    });

    const response = (await client.postOrder(order, OrderType.FOK)) as {
      success?: boolean;
      orderID?: string;
      errorMsg?: string;
      status?: string;
    };

    if (response && (response.success === false || response.errorMsg)) {
      throw new Error(
        `CLOB_REJECTION (Vente refusée par Polymarket): ${response.errorMsg || "Ordre FOK non exécuté par le carnet"}`
      );
    }

    if (!response?.orderID && response?.status !== "matched" && response?.status !== "live") {
      throw new Error(`CLOB_ERROR (Aucun orderID retourné par Polymarket pour la vente)`);
    }

    const orderId = response?.orderID || `sell_${Date.now()}`;

    return {
      id: `clob_sell_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      detectedTradeId: `exit_${position.conditionId}_${Date.now()}`,
      targetAddress,
      conditionId: position.conditionId,
      assetAddress: position.assetAddress,
      marketSlug: position.marketSlug,
      marketQuestion: position.marketQuestion,
      outcomeLabel: position.outcomeLabel,
      side: "SELL",
      targetPrice: roundedPrice,
      executedPrice: roundedPrice,
      slippagePercent: 0,
      shares: sharesToSell,
      costUsdc: Math.round(sharesToSell * roundedPrice * 100) / 100,
      orderId: String(orderId),
      status: "FILLED",
      isDryRun: false,
      executedAt: Date.now(),
    };
  }
}
