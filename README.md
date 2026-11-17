# 🤖 Lotso Trading — Bot (`services/bot`)

[![Deno 2.0+](https://img.shields.io/badge/Runtime-Deno_2.0+-black?logo=deno&logoColor=white)](https://deno.com/)
[![TypeScript Strict](https://img.shields.io/badge/TypeScript-Strict_Z%C3%A9ro_Any-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Polygon](https://img.shields.io/badge/Network-Polygon_PoS-8247E5?logo=polygon&logoColor=white)](https://polygon.technology/)
[![Polymarket](https://img.shields.io/badge/Exchange-Polymarket_CLOB-0052FF?logo=target&logoColor=white)](https://polymarket.com/)
[![Architecture](https://img.shields.io/badge/Architecture-Clean_Hexagonal-blueviolet)](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)

Le micro-service `bot` est le **moteur d'exécution autonome haute fréquence** de l'écosystème Lotso Trading. Il surveille en continu l'activité des portefeuilles cibles (baleines), filtre et valide chaque opportunité avec un moteur de risque rigoureux, et exécute les ordres de réplication directement sur le CLOB de Polymarket via signature cryptographique EIP-712 non-custodiale.

---

## ⚡ Fonctionnalités Clés

- **Écoute Hybride Dédupliquée** : Surveillance en quasi temps-réel via la Data API Polymarket couplée au streaming d'événements on-chain Polygon RPC (`TransferSingle`, `OrderFill`). Un cache LRU de déduplication élimine les doublons.
- **RiskManager Institutionnel** :
  - _Slippage Guard_ : Rejet automatique des ordres si l'écart de prix dépasse le seuil paramétré (ex: 3%).
  - _Bornes de Cote (Min/Max Price)_ : Refus des positions aux cotes extrêmes (ex: < 0.05 ou > 0.95).
  - _Dimensionnement Dynamique_ : Calcul de la taille de l'ordre en pourcentage fixe du solde USDC disponible sur Polygon.
- **Règle de Sortie Intégrale (`ALL`)** : Détection et réplication immédiate des ordres `SELL` pour liquider ou réduire l'exposition au même rythme que la baleine.
- **Exécution Double Mode** :
  - `Dry-Run` : Simulation intégrale en mémoire pour tester stratégies et alertes sans risquer de capital réel.
  - `Live CLOB` : Signature EIP-712 et passage d'ordres authentifiés sur le carnet d'ordres Polymarket.
- **Alertes Enrichies Discord Webhook** : Notifications instantanées au format Markdown avec détails du marché, lien PolygonScan et métriques du trade.

---

## 🏛️ Architecture Hexagonale (Clean Code)

Le code est structuré selon les principes stricts de la Clean Architecture pour découpler la logique financière des protocoles réseau et dépendances externes :

```text
src/
├── domain/                         # Cœur métier pur (zéro dépendance externe)
│   ├── entities/                   # Entités Trade, Target, Position
│   ├── value-objects/              # Objets de valeur immuables (UsdcAmount, Price, Slippage)
│   └── ports/                      # Interfaces (Tracker, Executor, ApiClient, Notifier)
├── application/                    # Cas d'usage applicatifs
│   ├── use-cases/                  # EvaluateTrade, CalculateSize, ReplicateTrade, HandleExits...
│   └── services/                   # RiskManagerService
├── infrastructure/                 # Adaptateurs techniques (Détails d'implémentation)
│   ├── adapters/                   # PolymarketApiTracker, PolygonRpcTracker, ClobExecutor, Discord...
│   └── cache/                      # Déduplicateur en mémoire
├── interfaces/                     # Orchestrateur principal
└── main.ts                         # Point d'entrée du service
```

---

## ⚙️ Configuration & Variables d'Environnement

Créez un fichier `.env` ou configurez les variables d'environnement suivantes :

```bash
# Configuration Blockchain & CLOB
POLYGON_RPC_URL="https://polygon-rpc.com"
POLYGON_PRIVATE_KEY="0x..."
CLOB_API_URL="https://clob.polymarket.com"
CLOB_API_KEY="..."
CLOB_API_SECRET="..."
CLOB_API_PASSPHRASE="..."

# Mode d'exécution
BOT_DRY_RUN=true                    # true = simulation, false = exécution réelle

# Paramètres de Risque par Défaut
RISK_MAX_SLIPPAGE_PERCENT=3.0
RISK_MIN_PRICE=0.05
RISK_MAX_PRICE=0.95
RISK_BALANCE_PERCENT_PER_TRADE=5.0

# Alertes
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
DISCORD_CLOSED_POSITIONS_WEBHOOK_URL="https://discord.com/api/webhooks/..."

# Synchronisation API Core
BACKEND_API_URL="http://localhost:3000"
```

---

## 🚀 Commandes Rapides

Le projet utilise le runtime natif **Deno 2** :

```bash
# Démarrer le bot en mode développement (avec rechargement à chaud)
deno task dev

# Démarrer en production
deno task start

# Exécuter les tests unitaires et d'intégration
deno task test

# Vérifier le typage strict TypeScript
deno check src/main.ts
```

---

<div align="center">
  <sub>Composant officiel de l'écosystème <b><a href="https://github.com/Lotso-trading">Lotso Trading</a></b></sub>
</div>
