import { assertEquals } from "jsr:@std/assert";
import type {
  DetectedTrade,
  DiscordWebhookPayload,
  ExecutedTrade,
  OpenPosition,
  TargetTrader,
} from "@polymarket-copy/shared";
import { DiscordWebhookAdapter } from "../src/infrastructure/adapters/discord-webhook.adapter.ts";

Deno.test("DiscordWebhookAdapter - route les alertes BUY sur l'URL d'achat dédiée", async () => {
  let postedUrl = "";
  let postedPayload: DiscordWebhookPayload | null = null;

  const mockFetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    postedUrl = String(input);
    if (init?.body) {
      postedPayload = JSON.parse(String(init.body)) as DiscordWebhookPayload;
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  const adapter = new DiscordWebhookAdapter(
    {
      buyWebhookUrl: "https://discord.com/api/webhooks/test/buy",
      sellWebhookUrl: "https://discord.com/api/webhooks/test/sell",
    },
    mockFetcher as unknown as typeof fetch
  );

  const target: TargetTrader = {
    id: "tgt-1",
    address: "0x2005d16a84ceefa912d4e380c2f1f422847cbbdb",
    alias: "WhaleAlpha",
    weightMultiplier: 1.0,
    maxUsdcPerTrade: 100,
    enabled: true,
    stats: {
      totalCopiedTrades: 1,
      totalCopiedVolumeUsdc: 50,
      realizedPnlUsdc: 0,
      winRatePercent: 80,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const trade: ExecutedTrade = {
    id: "exec-1",
    detectedTradeId: "det-1",
    targetAddress: target.address,
    conditionId: "0x1234567890abcdef1234567890abcdef12345678",
    marketSlug: "fed-rate-cut-2026",
    marketQuestion: "Will Fed cut rates in 2026?",
    outcomeLabel: "Yes",
    side: "BUY",
    targetPrice: 0.65,
    executedPrice: 0.652,
    slippagePercent: 0.31,
    shares: 76.6,
    costUsdc: 50.0,
    status: "FILLED",
    isDryRun: true,
    executedAt: 1731110000000,
  };

  await adapter.sendBuyAlert(trade, target);

  assertEquals(postedUrl, "https://discord.com/api/webhooks/test/buy");
  const payload = postedPayload as DiscordWebhookPayload | null;
  assertEquals(payload !== null, true);
  assertEquals(payload?.embeds?.[0]?.title?.includes("Achat Répliqué"), true);
  assertEquals(payload?.embeds?.[0]?.url, "https://polymarket.com/event/fed-rate-cut-2026");
});

Deno.test("DiscordWebhookAdapter - route les alertes SELL sur l'URL de vente dédiée avec PnL", async () => {
  let postedUrl = "";
  let postedPayload: DiscordWebhookPayload | null = null;

  const mockFetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    postedUrl = String(input);
    if (init?.body) {
      postedPayload = JSON.parse(String(init.body)) as DiscordWebhookPayload;
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  const adapter = new DiscordWebhookAdapter(
    {
      buyWebhookUrl: "https://discord.com/api/webhooks/test/buy",
      sellWebhookUrl: "https://discord.com/api/webhooks/test/sell",
    },
    mockFetcher as unknown as typeof fetch
  );

  const target: TargetTrader = {
    id: "tgt-1",
    address: "0x2005d16a84ceefa912d4e380c2f1f422847cbbdb",
    alias: "WhaleAlpha",
    weightMultiplier: 1.0,
    maxUsdcPerTrade: 100,
    enabled: true,
    stats: {
      totalCopiedTrades: 1,
      totalCopiedVolumeUsdc: 50,
      realizedPnlUsdc: 0,
      winRatePercent: 80,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const position: OpenPosition = {
    id: "pos-1",
    conditionId: "0x1234567890abcdef1234567890abcdef12345678",
    assetAddress: "0x2005d16a84ceefa912d4e380c2f1f422847cbbdb",
    marketSlug: "fed-rate-cut-2026",
    marketQuestion: "Will Fed cut rates in 2026?",
    outcomeLabel: "Yes",
    status: "OPEN",
    totalShares: 76.6,
    avgEntryPrice: 0.652,
    totalInvestedUsdc: 50.0,
    currentMarketPrice: 0.85,
    currentMarketValueUsdc: 65.11,
    unrealizedPnlUsdc: 15.11,
    unrealizedPnlPercent: 30.22,
    targetAddress: target.address,
    openedAt: Date.now() - 3600000,
    updatedAt: Date.now(),
  };

  const trade: ExecutedTrade = {
    id: "exec-sell-1",
    detectedTradeId: "det-sell-1",
    targetAddress: target.address,
    conditionId: "0x1234567890abcdef1234567890abcdef12345678",
    marketSlug: "fed-rate-cut-2026",
    marketQuestion: "Will Fed cut rates in 2026?",
    outcomeLabel: "Yes",
    side: "SELL",
    targetPrice: 0.85,
    executedPrice: 0.85,
    slippagePercent: 0,
    shares: 76.6,
    costUsdc: 65.11,
    status: "FILLED",
    isDryRun: true,
    executedAt: 1731113600000,
  };

  await adapter.sendSellAlert(trade, target, position);

  assertEquals(postedUrl, "https://discord.com/api/webhooks/test/sell");
  const payload = postedPayload as DiscordWebhookPayload | null;
  assertEquals(payload !== null, true);
  assertEquals(payload?.embeds?.[0]?.title?.includes("Vente / Sortie ALL"), true);
});

Deno.test("DiscordWebhookAdapter - ne déclenche AUCUN appel HTTP pour les rejets", async () => {
  let callCount = 0;

  const mockFetcher = (): Promise<Response> => {
    callCount++;
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  const adapter = new DiscordWebhookAdapter(
    {
      buyWebhookUrl: "https://discord.com/api/webhooks/test/buy",
      sellWebhookUrl: "https://discord.com/api/webhooks/test/sell",
    },
    mockFetcher as unknown as typeof fetch
  );

  const target: TargetTrader = {
    id: "tgt-1",
    address: "0x2005d16a84ceefa912d4e380c2f1f422847cbbdb",
    alias: "WhaleAlpha",
    weightMultiplier: 1.0,
    maxUsdcPerTrade: 100,
    enabled: true,
    stats: {
      totalCopiedTrades: 0,
      totalCopiedVolumeUsdc: 0,
      realizedPnlUsdc: 0,
      winRatePercent: 0,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const detectedTrade: DetectedTrade = {
    id: "det-rej-1",
    targetAddress: target.address,
    marketSlug: "test",
    marketQuestion: "Test?",
    conditionId: "cond-1",
    assetAddress: "0x123",
    outcomeIndex: 0,
    outcomeLabel: "Yes",
    side: "BUY",
    price: 0.95,
    sizeShares: 100,
    sizeUsdc: 95,
    detectedAt: Date.now(),
    source: "POLYMARKET_API",
  };

  await adapter.sendRejectionAlert(detectedTrade, target, "COTE_TROP_ELEVEE");

  // Strictement 0 appel réseau effectué !
  assertEquals(callCount, 0);
});
