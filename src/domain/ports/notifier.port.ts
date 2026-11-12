import type {
  DetectedTrade,
  ExecutedTrade,
  OpenPosition,
  TargetTrader,
} from "@polymarket-copy/shared";

export interface INotifierPort {
  sendBuyAlert(trade: ExecutedTrade, target: TargetTrader): Promise<void>;
  sendSellAlert(trade: ExecutedTrade, target: TargetTrader, position?: OpenPosition): Promise<void>;
  sendRejectionAlert(trade: DetectedTrade, target: TargetTrader, reason: string): Promise<void>;
  sendRedeemAlert?(position: OpenPosition, txHash: string, isDryRun?: boolean): Promise<void>;
  sendErrorAlert(title: string, error: string): Promise<void>;
}
