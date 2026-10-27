# holder-entries

Paste a Solana mint → get the top 20 holders with each wallet's **average entry price**, entry market cap, current multiple, unrealized PnL, first/last buy time, and how much of the bag was bought vs transferred in. Click a row for the full buy/sell/transfer log with Solscan links.

## How it works
1. `getTokenLargestAccounts` → top 20 token accounts → resolve owners. Owners that aren't normal wallets (pump.fun curve, Raydium/Meteora/PumpSwap vaults, multisigs) are flagged and skipped.
2. For each holder, pulls every signature on **their token account** (not the whole wallet — far fewer txs, only ones touching this token) and parses each tx.
3. Per tx, net balance changes for the owner: token Δ, native SOL Δ (fee added back, token-account rent excluded), WSOL Δ, USDC/USDT Δ.
   - tokens ↑ + SOL/stable ↓ → **buy** · tokens ↓ + SOL/stable ↑ → **sell** · otherwise **transfer in/out** (no cost basis)
   - Works for pump.fun, PumpSwap, Raydium, Meteora, Jupiter routes, bots — anything, since it reads balance deltas instead of decoding programs.
4. SOL → USD at the hourly SOL price of each buy (CoinGecko). Current price from DexScreener.
5. **Avg entry** = total spent on buys ÷ tokens bought.

## Env vars
| Var | |
|---|---|
| `HELIUS_API_KEY` | Recommended. Public RPC will rate-limit hard. (Or set `RPC_URL` to any RPC.) |
| `COINGECKO_API_KEY` | Your Pro key, for historical SOL/USD. Without it, falls back to the public API. |
| `COINGECKO_PLAN` | `pro` (default) or `demo` |
| `RPC_CONCURRENCY` | Parallel RPC calls, default 8. Raise on paid Helius plans. |
| `MAX_TXS_PER_HOLDER` | Default 2500 (oldest kept). Holders over the cap are tagged "partial history". |
| `CACHE_MINUTES` | Result cache per mint, default 10. |

## Run
```bash
npm install
HELIUS_API_KEY=xxx COINGECKO_API_KEY=xxx npm start   # http://localhost:3000
```
Railway: push to GitHub, new service from repo, add the env vars. `?mint=<address>` in the URL auto-runs.

## Caveats
- Tokens received by transfer have no cost basis — wallets fed by another wallet (dev splits, insiders, CEX withdrawals) show "mostly transfers" / "no buys". Trace the sender for their real entry.
- Only the holder's current largest token account is scanned; history in an older, closed account for the same mint is missed.
- Entry MC uses total supply (FDV-style).
- Market-maker / bot wallets with thousands of txs take longest; Helius credits ≈ 1 per tx fetched.
