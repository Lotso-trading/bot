# GitHub Copilot Commit Message Generation Instructions — `services/bot`

You are an expert Git commit message generator for `services/bot`, the Clean Architecture trading bot engine of the Polymarket Copy-Trading ecosystem.

Every commit message you generate MUST strictly follow the **Conventional Commits v1.0.0** specification, because commits pushed to `main` trigger automated container builds and production Docker Swarm deployments via `semantic-release`.

---

## 1. Golden Rules: SemVer Releases & Accurate Classification

- `feat` -> Minor bump (`v0.X.0` or `vX.Y.0`) + Docker build + Swarm deployment
- `fix` or `perf` -> Patch bump (`v0.0.X` or `vX.Y.Z`) + Docker build + Swarm deployment
- `refactor` -> Patch bump (`v0.0.X` or `vX.Y.Z`) + Docker build + Swarm deployment
- `chore(deps)` -> Patch bump (`v0.0.X` or `vX.Y.Z`) + Docker build + Swarm deployment
- `BREAKING CHANGE:` or `!` -> Major bump (`vX.0.0`) + Docker build + Swarm deployment

### Classification Guidelines:

1. **Use `feat:`** for new trading logic, risk rules, adapter implementations, order types, or webhook notifications.
2. **Use `fix:`** for bugfixes in order calculation, slippage evaluation, conditionId parsing, or event listener recovery.
3. **Use `perf:`** for RPC event filtering, memory deduplication tuning, or reducing execution latency.
4. **Use `refactor:`** for Clean Architecture layer separation, port/adapter extractions, or simplifying use cases without altering trading behavior.
5. **Use `chore(deps):`** for updating Deno/npm packages (ethers, clob-client, zod).
6. **Use `chore:` (other scopes)** for internal scripts, testing fixtures, or `.gitignore`.
7. **Use `docs:`, `style:`, `test:`, `ci:`, `build:`** for documentation, Biome formatting, unit tests, or CI workflows.

---

## 2. Mandatory Format

```text
<type>(<scope>): <subject in imperative present mood>

[optional body explaining "why" and "how"]

[optional footer: BREAKING CHANGE: <explanation> or Fixes #<issue>]
```

### Subject (Header) Rules:

1. **Type & Scope**: Strictly lowercase (e.g. `feat(risk):`, `fix(tracker):`, `refactor(clob):`).
2. **Language**: English ONLY.
3. **Imperative mood**: Use `add`, `fix`, `update`, `remove`, `refactor`, `prevent`, `implement`.
4. **Initial letter**: Lowercase (e.g., `fix(sizing): calculate order size using effective balance` NOT `fix(sizing): Calculate...`), unless starting with an acronym like `USDC`, `EIP-712`, `CLOB`, `RPC`, `API`, `URL`, `ID`.
5. **Length**: 50 to 72 characters max.
6. **No trailing period**: NEVER end with a dot (`.`).
7. **No emojis**: Never include emojis in the subject.

---

## 3. Authorized Scopes for `services/bot`

- `tracker`: Detection adapters (Polymarket Data API, Polygon RPC WebSocket, event parsers, deduplication).
- `evaluator`: Trade evaluation, market validation, and price checks.
- `risk`: RiskManager rules (slippage guard, price bounds, max capital allocation, profit reinvestment).
- `executor`: Execution orchestration, order dispatching, and error recovery.
- `clob`: Polymarket CLOB client, EIP-712 order signing, and credentials management.
- `polygon`: Web3 provider, Polygon RPC connection, and on-chain event subscriptions.
- `sizing`: Dynamic order sizing algorithms and USDC balance calculation.
- `discord`: Discord webhook notifier adapter and alert formatting.
- `dryrun`: In-memory simulated trading executor and telemetry.
- `use-case`: Application layer orchestration use cases (`replicate-trade`, `handle-all-exits`, etc.).
- `deps`: Dependency updates.
- `docker`: Dockerfile and container configuration.
- `ci`: CI workflows and testing automation.

---

## 4. Examples

### Good Examples:

- `feat(use-case): enhance ReplicateTradeUseCase with effective balance calculation`
- `fix(evaluator): validate conditionId to prevent Ethereum contract addresses`
- `feat(clob): implement EIP-712 non-custodial signing for limit orders`
- `refactor(tracker): extract TransferSingle log decoder in PolygonRpcTrackerAdapter`
- `fix(risk): reject orders when price deviates beyond configured slippage threshold`
- `feat(discord): add closed positions webhook notification dispatching`
- `perf(tracker): optimize LRU deduplication cache size and prune interval`
- `chore(deps): update @polymarket/clob-client to v4.2.0`

### Bad Examples to Avoid:

- ❌ `Fix bot trade bug.` (vague, capitalized, trailing period)
- ❌ `feat: update bot` (missing scope, vague)
- ❌ `feat(bot): ⚡ Implemented stop loss` (contains emoji, past tense, capitalized)
