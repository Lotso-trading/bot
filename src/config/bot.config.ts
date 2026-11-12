export interface BotRuntimeConfig {
  readonly polymarketPrivateKey: string;
  readonly polymarketFunderAddress?: string;
  readonly polymarketSignatureType: number;
  readonly polymarketRelayerUrl: string;
  readonly polymarketClobApiUrl: string;
  readonly polymarketDataApiUrl: string;
  readonly polygonRpcUrl: string;
  readonly polygonWsRpcUrl: string;
  readonly ctfExchangeAddress: string;
  readonly negRiskExchangeAddress: string;
  readonly apiInternalUrl: string;
  readonly apiWsUrl: string;
  readonly discordBuyWebhookUrl?: string;
  readonly discordSellWebhookUrl?: string;
  readonly discordClosedPositionsWebhookUrl?: string;
  readonly discordWebhookUrl?: string;
  readonly dryRun: boolean;
  readonly defaultSimulatedBalanceUsdc: number;
  readonly pollingIntervalMs: number;
}

export function loadBotConfig(): BotRuntimeConfig {
  return {
    polymarketPrivateKey: Deno.env.get("POLYMARKET_PRIVATE_KEY") || "",
    polymarketFunderAddress: Deno.env.get("POLYMARKET_FUNDER_ADDRESS") || undefined,
    polymarketSignatureType: Number(Deno.env.get("POLYMARKET_SIGNATURE_TYPE")) || 0,
    polymarketRelayerUrl:
      Deno.env.get("POLYMARKET_RELAYER_URL") || "https://relayer-v2.polymarket.com",
    polymarketClobApiUrl: Deno.env.get("POLYMARKET_CLOB_API_URL") || "https://clob.polymarket.com",
    polymarketDataApiUrl:
      Deno.env.get("POLYMARKET_DATA_API_URL") || "https://data-api.polymarket.com",
    polygonRpcUrl: Deno.env.get("POLYGON_RPC_URL") || "https://polygon-rpc.com",
    polygonWsRpcUrl: Deno.env.get("POLYGON_WS_RPC_URL") || "",
    ctfExchangeAddress:
      Deno.env.get("CTF_EXCHANGE_ADDRESS") || "0xE111180000d2663C0091e4f400237545B87B996B",
    negRiskExchangeAddress:
      Deno.env.get("NEG_RISK_EXCHANGE_ADDRESS") || "0xe2222d279d744050d28e00520010520000310F59",
    apiInternalUrl: Deno.env.get("API_INTERNAL_URL") || "http://localhost:3000",
    apiWsUrl:
      Deno.env.get("API_WS_URL") ||
      (Deno.env.get("API_INTERNAL_URL")
        ? (Deno.env.get("API_INTERNAL_URL") ?? "").replace(/^http/, "ws").replace(/:3000$/, ":3001")
        : "ws://localhost:3001"),
    discordBuyWebhookUrl:
      Deno.env.get("DISCORD_BUY_WEBHOOK_URL") || Deno.env.get("DISCORD_WEBHOOK_URL") || undefined,
    discordSellWebhookUrl:
      Deno.env.get("DISCORD_SELL_WEBHOOK_URL") || Deno.env.get("DISCORD_WEBHOOK_URL") || undefined,
    discordClosedPositionsWebhookUrl:
      Deno.env.get("DISCORD_CLOSED_POSITIONS_WEBHOOK_URL") ||
      Deno.env.get("DISCORD_SELL_WEBHOOK_URL") ||
      Deno.env.get("DISCORD_WEBHOOK_URL") ||
      undefined,
    discordWebhookUrl: Deno.env.get("DISCORD_WEBHOOK_URL") || undefined,
    dryRun: Deno.env.get("DRY_RUN") !== "false",
    defaultSimulatedBalanceUsdc: Number(Deno.env.get("SIMULATED_BALANCE_USDC")) || 1000.0,
    pollingIntervalMs: Number(Deno.env.get("POLLING_INTERVAL_MS")) || 500,
  };
}
