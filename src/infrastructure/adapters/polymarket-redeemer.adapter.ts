import axios from "axios";
import { createWalletClient, encodeFunctionData, http, parseAbi, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const CTF_ABI = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
]);

const PROXY_EXECUTE_ABI = parseAbi([
  "function execute(address dest, uint256 value, bytes calldata data) external returns (bytes memory)",
]);

export interface IRedeemerPort {
  redeemWinningPosition(conditionId: string): Promise<string>;
}

export class PolymarketRedeemerAdapter implements IRedeemerPort {
  private readonly CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
  private readonly USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  private readonly isDryRun: boolean;

  constructor(
    private readonly privateKey: string,
    private readonly funderAddress?: string,
    private readonly signatureType = 0,
    private readonly rpcUrl = "https://polygon-rpc.com",
    private readonly relayerUrl = "https://relayer-v2.polymarket.com",
    isDryRun = false
  ) {
    this.isDryRun = isDryRun;
  }

  async redeemWinningPosition(conditionId: string): Promise<string> {
    if (this.isDryRun) {
      console.log(
        `[AutoRedeem] (Simulation DRY_RUN) Réclamation virtuelle exécutée pour conditionId: ${conditionId}`
      );
      return `sim_tx_redeem_${Date.now()}_${conditionId.slice(0, 10)}`;
    }

    if (!this.privateKey || this.privateKey.startsWith("your_")) {
      throw new Error("[AutoRedeem] Clé privée Polymarket invalide ou non configurée");
    }

    const formattedKey = (
      this.privateKey.startsWith("0x") ? this.privateKey : `0x${this.privateKey}`
    ) as `0x${string}`;

    const account = privateKeyToAccount(formattedKey);
    const client = createWalletClient({
      account,
      chain: polygon,
      transport: http(this.rpcUrl),
    });

    const redeemCalldata = encodeFunctionData({
      abi: CTF_ABI,
      functionName: "redeemPositions",
      args: [
        this.USDC_E_ADDRESS,
        zeroHash,
        conditionId as `0x${string}`,
        [1n, 2n], // Binary outcomes (YES / NO)
      ],
    });

    console.log(
      `[AutoRedeem] Lancement du rachat des parts pour conditionId=${conditionId.slice(0, 16)}...`
    );

    // --- BRANCHE 1 : COMPTE EMAIL / PROXY (Signature Type 1 ou 2) ---
    if (this.funderAddress && (this.signatureType === 1 || this.signatureType === 2)) {
      console.log(
        `[AutoRedeem] Mode Compte Email détecté (Signature Type ${this.signatureType}, Funder: ${this.funderAddress})`
      );

      // 1.1 Tentative via le Relayer Polymarket (Gasless)
      try {
        console.log(
          `[AutoRedeem] Envoi de la transaction au Relayer Polymarket (${this.relayerUrl})...`
        );
        const relayerResponse = await axios.post(
          `${this.relayerUrl}/submit`,
          {
            signer: account.address,
            to: this.CTF_ADDRESS,
            data: redeemCalldata,
            value: "0",
            funder: this.funderAddress,
            signatureType: this.signatureType,
            txType: this.signatureType === 2 ? "SAFE" : "PROXY",
          },
          { timeout: 10000 }
        );

        const txHash =
          relayerResponse.data?.transactionHash ||
          relayerResponse.data?.hash ||
          relayerResponse.data?.orderId;
        if (txHash) {
          console.log(`[AutoRedeem] ✅ Réclamation acceptée par le Relayer ! Hash: ${txHash}`);
          return String(txHash);
        }
      } catch (relayerErr: unknown) {
        console.warn(
          `[AutoRedeem] Relayer indisponible ou refusé, bascule sur l'appel direct Proxy on-chain:`,
          relayerErr instanceof Error ? relayerErr.message : relayerErr
        );
      }

      // 1.2 Fallback : Appel direct on-chain sur le contrat Proxy si le Relayer échoue
      try {
        console.log(`[AutoRedeem] Exécution de proxy.execute() on-chain via le Signer EOA...`);
        const txHash = await client.writeContract({
          address: this.funderAddress as `0x${string}`,
          abi: PROXY_EXECUTE_ABI,
          functionName: "execute",
          args: [this.CTF_ADDRESS, 0n, redeemCalldata],
        });
        console.log(`[AutoRedeem] ✅ Réclamation Proxy confirmée on-chain ! Tx: ${txHash}`);
        return txHash;
      } catch (proxyErr: unknown) {
        console.error(`[AutoRedeem] Échec de l'appel direct Proxy on-chain:`, proxyErr);
        throw proxyErr;
      }
    }

    // --- BRANCHE 2 : COMPTE EOA DIRECT (MetaMask, Signature Type 0) ---
    console.log(
      `[AutoRedeem] Exécution directe on-chain sur ConditionalTokens (${this.CTF_ADDRESS})...`
    );
    const txHash = await client.writeContract({
      address: this.CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: "redeemPositions",
      args: [this.USDC_E_ADDRESS, zeroHash, conditionId as `0x${string}`, [1n, 2n]],
    });

    console.log(`[AutoRedeem] ✅ Réclamation EOA confirmée on-chain ! Tx: ${txHash}`);
    return txHash;
  }
}
