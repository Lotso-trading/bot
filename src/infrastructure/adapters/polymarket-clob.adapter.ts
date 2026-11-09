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

  async getAvailableBalanceUsdc(): Promise<number> {
    try {
      const client = await this.getClient();
      const balanceObj = await client.getBalanceAllowance();
      if (balanceObj && typeof balanceObj.balance === "string") {
        return Number(balanceObj.balance) / 1e6;
      }
    } catch (err: unknown) {
      console.warn("[ClobAdapter] Impossible de lire le solde CLOB:", err);
    }
    return 0;
  }

  async getCurrentBestPrice(conditionId: string, side: "BUY" | "SELL"): Promise<number | null> {
    try {
      const client = await this.getClient();
      const res = await client.getPrice(conditionId, side === "BUY" ? Side.BUY : Side.SELL);
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
    const marketPrice = (await this.getCurrentBestPrice(trade.conditionId, "BUY")) ?? trade.price;
    const shares = Math.floor((sizeUsdc / marketPrice) * 100) / 100;

    const order = await client.createOrder({
      tokenID: trade.conditionId,
      price: marketPrice,
      side: Side.BUY,
      size: shares,
    });

    const response = await client.postOrder(order, OrderType.FOK);
    const orderId = response?.orderID || `order_${Date.now()}`;
    const slippagePercent = ((marketPrice - trade.price) / trade.price) * 100;

    return {
      id: `clob_buy_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      detectedTradeId: trade.id,
      targetAddress: trade.targetAddress,
      conditionId: trade.conditionId,
      marketSlug: trade.marketSlug,
      marketQuestion: trade.marketQuestion,
      outcomeLabel: trade.outcomeLabel,
      endDate: trade.endDate,
      side: "BUY",
      targetPrice: trade.price,
      executedPrice: marketPrice,
      slippagePercent,
      shares,
      costUsdc: shares * marketPrice,
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

    const order = await client.createOrder({
      tokenID: position.conditionId,
      price: marketPrice,
      side: Side.SELL,
      size: sharesToSell,
    });

    const response = await client.postOrder(order, OrderType.FOK);
    const orderId = response?.orderID || `sell_${Date.now()}`;

    return {
      id: `clob_sell_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      detectedTradeId: `exit_${position.conditionId}_${Date.now()}`,
      targetAddress,
      conditionId: position.conditionId,
      marketSlug: position.marketSlug,
      marketQuestion: position.marketQuestion,
      outcomeLabel: position.outcomeLabel,
      side: "SELL",
      targetPrice: marketPrice,
      executedPrice: marketPrice,
      slippagePercent: 0,
      shares: sharesToSell,
      costUsdc: sharesToSell * marketPrice,
      orderId: String(orderId),
      status: "FILLED",
      isDryRun: false,
      executedAt: Date.now(),
    };
  }
}
