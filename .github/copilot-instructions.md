# Polymarket Copy-Trading — `services/bot` GitHub Copilot Instructions

## Repository Overview

`services/bot` is the **autonomous high-frequency copy-trading execution engine** of the Polymarket Copy-Trading ecosystem (`Lotso-trading`):
- Runs under **Deno 2** with pure **Clean Architecture / Hexagonal Architecture**.
- Detects target whale activity in real-time via hybrid tracking (Polymarket Data API + Polygon RPC event streaming) with LRU deduplication.
- Filters and sizes orders via an institutional **RiskManager** (slippage guard, price bounds [0.05 - 0.95], dynamic USDC balance sizing, max capital allocation & profit reinvestment).
- Implements the **`ALL` exit rule**: automatically mirrors `SELL` orders to liquidate or reduce positions alongside the target whale.
- Executes orders either in **Dry-Run simulation** or on live **Polymarket CLOB** via non-custodial **EIP-712 cryptographic signatures**.
- Dispatches rich Markdown alerts to Discord webhooks with PolygonScan transaction links and financial telemetry.

---

## 🏛️ Clean Architecture & Engineering Standards

1. **Hexagonal Architecture Layer Separation**:
   - `domain/`: Pure business logic (entities, value objects, ports). **Zero external dependencies** (no Deno/Node I/O, no network, no database).
   - `application/`: Orchestration use cases (`replicate-trade`, `evaluate-trade`, `calculate-position-size`, `handle-all-exits`). Only depends on domain ports and entities.
   - `infrastructure/`: Adapters implementing domain ports (Polygon RPC tracker, Polymarket CLOB executor, Dry-Run executor, Discord notifier, API HTTP client).
2. **Strict Typing & Zero `any`**:
   - TypeScript strict mode permanent (`noImplicitAny: true`, `noUncheckedIndexedAccess: true`).
   - Every on-chain or external payload enters as `unknown` and must be parsed with Zod or strongly typed value objects.
3. **Single Biome Standard**:
   - Format and lint exclusively with Biome (`biome check .`).
4. **Resilience & Idempotency**:
   - Orders must be protected against duplicate execution (deduplication cache on transaction hashes / condition IDs).
   - Single-replica deployment constraint in production (Docker Swarm).

---

## Commit Message Guidelines (Conventional Commits v1.0.0)

- Always follow `<type>(<scope>): <subject>` in imperative present mood (e.g. `feat(risk): validate conditionId to prevent Ethereum contract address execution`).
- Primary scopes: `tracker`, `evaluator`, `risk`, `executor`, `clob`, `polygon`, `sizing`, `discord`, `dryrun`, `use-case`, `deps`, `docker`, `ci`.
- Detailed commit instructions: See `.github/copilot-commit-instructions.md`.
