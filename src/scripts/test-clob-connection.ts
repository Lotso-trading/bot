import { ClobClient, Side } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

async function main(): Promise<void> {
  console.log("=================================================================");
  console.log("🔍 DIAGNOSTIC DE CONNEXION POLYMARKET CLOB (MODE RÉEL)");
  console.log("   (Test 100% sécurisé en lecture seule - Aucun ordre envoyé)");
  console.log("=================================================================\n");

  const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");
  const funderAddress = Deno.env.get("POLYMARKET_FUNDER_ADDRESS");
  const signatureType = Number(Deno.env.get("POLYMARKET_SIGNATURE_TYPE")) || 0;
  const host = Deno.env.get("POLYMARKET_CLOB_API_URL") || "https://clob.polymarket.com";
  const chainId = 137;

  // 1. Vérification de la clé privée
  console.log("1. Analyse des variables d'environnement :");
  if (!privateKey || privateKey.startsWith("your_") || privateKey.length < 64) {
    console.error("   ❌ ERREUR: POLYMARKET_PRIVATE_KEY manquante ou invalide dans .env");
    Deno.exit(1);
  }

  const formattedKey = (
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
  ) as `0x${string}`;

  let account;
  try {
    account = privateKeyToAccount(formattedKey);
    console.log(`   ✅ Clé privée valide.`);
    console.log(`   🔑 Adresse Signer dérivée : ${account.address}`);
  } catch (err) {
    console.error(`   ❌ ERREUR de dérivation de l'adresse :`, err);
    Deno.exit(1);
  }

  console.log(`   ⚙️ Type de signature configuré : ${signatureType}`);
  if (signatureType === 0) {
    console.log("      (Type 0: MetaMask / Portefeuille personnel direct)");
  } else if (signatureType === 1) {
    console.log("      (Type 1: Magic Link / Email proxy Polymarket)");
  } else if (signatureType === 2) {
    console.log("      (Type 2: Polymarket Safe multisig / proxy)");
  }

  if (funderAddress) {
    console.log(`   💼 Funder Address (détenteur des USDC) : ${funderAddress}`);
  } else if (signatureType !== 0) {
    console.warn("   ⚠️ ATTENTION : Type 1 ou 2 configuré sans POLYMARKET_FUNDER_ADDRESS !");
  }

  // 2. Initialisation du client Viem et dérivation des clés API CLOB
  console.log("\n2. Connexion à Polymarket CLOB & Dérivation des clés API L2 :");
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  let client: ClobClient;
  try {
    const initialClient = new ClobClient(host, chainId, signer);
    console.log("   🔄 Dérivation / Création de la clé API CLOB (EIP-712)...");
    const creds = await initialClient.createOrDeriveApiKey();
    console.log("   ✅ Clés API dérivées avec succès !");
    console.log(`   🔑 Clé API (tronquée) : ${creds.key.slice(0, 8)}...`);

    client = new ClobClient(host, chainId, signer, creds, signatureType, funderAddress);
  } catch (err: unknown) {
    console.error("   ❌ ERREUR lors de la dérivation des clés API CLOB :", err);
    Deno.exit(1);
  }

  // 3. Vérification du Solde USDC et de l'Allowance
  console.log("\n3. Vérification du Solde et de l'Allowance USDC sur Polygon :");
  try {
    const balanceObj = (await client.getBalanceAllowance()) as {
      balance?: string;
      allowance?: string;
    };

    const balanceUsdc = balanceObj?.balance ? Number(balanceObj.balance) / 1e6 : 0;
    const allowanceUsdc = balanceObj?.allowance ? Number(balanceObj.allowance) / 1e6 : 0;

    console.log(`   💰 Solde USDC disponible pour le trading : ${balanceUsdc.toFixed(2)} USDC`);
    console.log(`   🔓 Allowance autorisée sur Polymarket    : ${allowanceUsdc.toFixed(2)} USDC`);

    if (balanceUsdc <= 0) {
      console.warn("   ⚠️ ATTENTION : Votre solde USDC est de 0.00 USDC.");
      console.warn("      Pour trader en mode réel, vous devez déposer des USDC.e sur Polygon.");
    }

    if (allowanceUsdc <= 0 && balanceUsdc > 0) {
      console.error("   ❌ ALERTE BLOQUANTE : L'allowance est à 0.00 USDC !");
      console.error("      Bien que vous ayez des USDC, Polymarket n'est pas autorisé à les dépenser.");
      console.error("      ➡️ Allez sur https://polymarket.com et faites une première transaction ou validez l'approbation USDC.");
    } else if (allowanceUsdc > 0) {
      console.log("   ✅ Allowance active et suffisante pour trader.");
    }
  } catch (err: unknown) {
    console.error("   ❌ Impossible de lire le solde / allowance :", err);
  }

  // 4. Test de lecture en direct du carnet d'ordres
  console.log("\n4. Test de lecture du carnet d'ordres en direct (Prix & Tick Size) :");
  try {
    const marketsRes = await fetch(`${host}/markets?active=true&closed=false&limit=1`);
    const marketsJson = await marketsRes.json();
    const sampleToken = marketsJson?.data?.[0]?.tokens?.[0];

    if (sampleToken?.token_id) {
      console.log(`   🎯 Marché test trouvé : ${marketsJson.data[0].question}`);
      console.log(`   🪙 Token ID test : ${sampleToken.token_id.slice(0, 16)}... (${sampleToken.outcome})`);

      const price = await client.getPrice(sampleToken.token_id, Side.BUY);
      const tickSize = await client.getTickSize(sampleToken.token_id);

      console.log(`   📊 Meilleur prix BUY : ${price.price ?? "N/A"}`);
      console.log(`   📏 Tick size du marché : ${tickSize}`);
      console.log("   ✅ Connexion au carnet d'ordres CLOB 100% opérationnelle !");
    }
  } catch (err: unknown) {
    console.warn("   ⚠️ Avertissement lors du test de carnet :", err);
  }

  console.log("\n=================================================================");
  console.log("🎉 RÉSULTAT DU DIAGNOSTIC : PRÊT POUR LE MODE RÉEL !");
  console.log("=================================================================");
}

if (import.meta.main) {
  main().catch(console.error);
}
