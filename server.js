// Top-20 holder average entry analyzer for Solana tokens
// Data: any Solana RPC (Helius recommended), CoinGecko (historical SOL/USD), DexScreener (current price)

const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 3000;
const RPC_URL =
  process.env.RPC_URL ||
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com');
const CG_KEY = process.env.COINGECKO_API_KEY || '';
const CG_PLAN = (process.env.COINGECKO_PLAN || 'pro').toLowerCase(); // pro | demo
const CONCURRENCY = Number(process.env.RPC_CONCURRENCY) || 8;
const MAX_SIGS = Number(process.env.MAX_SIGS_PER_HOLDER) || 10000;
const MAX_TXS = Number(process.env.MAX_TXS_PER_HOLDER) || 2500;
const CACHE_TTL_MS = (Number(process.env.CACHE_MINUTES) || 10) * 60 * 1000;

const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const ATA_RENT = 0.00203928; // SOL rent for a token account
const DUST_SOL = 0.0005;
const DUST_USD = 0.05;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- concurrency limiter (shared across requests) ----------
function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    Promise.resolve()
      .then(fn)
      .then(res, rej)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((res, rej) => {
      q.push({ fn, res, rej });
      next();
    });
}
const limit = limiter(CONCURRENCY);

// ---------- RPC with retry/backoff ----------
const RPC_HOST = new URL(RPC_URL).host;
const IS_HELIUS = /helius/.test(RPC_HOST);
const backoff = (i) => Math.min(15000, 600 * 2 ** i) + Math.random() * 400;
let rpcId = 0;
async function rpc(method, params, tries = 7) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    let r;
    try {
      r = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
    } catch (e) {
      lastErr = e;
      await sleep(backoff(i));
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      lastErr = new Error(`${method}: HTTP ${r.status}${r.status === 429 ? ` (rate-limited by ${RPC_HOST})` : ''}`);
      const ra = Number(r.headers.get('retry-after'));
      await sleep(ra ? ra * 1000 : backoff(i));
      continue;
    }
    const j = await r.json();
    if (j.error) {
      const msg = j.error.message || JSON.stringify(j.error);
      if (/rate|limit|timeout|too many/i.test(msg) && i < tries - 1) {
        lastErr = new Error(msg);
        await sleep(backoff(i));
        continue;
      }
      throw new Error(`${method}: ${msg}`);
    }
    return j.result;
  }
  throw lastErr || new Error(`${method}: failed`);
}

// ---------- top holders ----------
// Fallback: Helius DAS getTokenAccounts (pages all holders, sorts locally)
async function largestViaDas(mint) {
  const all = [];
  let cursor;
  for (let page = 0; page < 30; page++) {
    const params = { mint, limit: 1000 };
    if (cursor) params.cursor = cursor;
    const r = await rpc('getTokenAccounts', params);
    const list = r?.token_accounts || [];
    all.push(...list);
    cursor = r?.cursor;
    if (!cursor || list.length < 1000) break;
  }
  if (!all.length) throw new Error('DAS getTokenAccounts returned no holders');
  return all
    .map((a) => ({ address: a.address, amount: String(a.amount) }))
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
}

async function getTopHolders(mint) {
  const supplyRes = await rpc('getTokenSupply', [mint]);
  let largestList;
  try {
    largestList = (await rpc('getTokenLargestAccounts', [mint], 5)).value;
  } catch (e) {
    if (!IS_HELIUS) {
      throw new Error(`${e.message}. No Helius key detected — set HELIUS_API_KEY in Railway Variables; the public RPC blocks this call.`);
    }
    console.warn('getTokenLargestAccounts failed, falling back to DAS:', e.message);
    largestList = await largestViaDas(mint);
  }
  const decimals = supplyRes.value.decimals;
  const supply = Number(supplyRes.value.amount) / 10 ** decimals;
  const accts = largestList.slice(0, 20);

  const info = await rpc('getMultipleAccounts', [
    accts.map((a) => a.address),
    { encoding: 'jsonParsed' },
  ]);
  const owners = info.value.map((v) => v?.data?.parsed?.info?.owner || null);

  // Is the owner a normal wallet (System Program) or a PDA / program (pool, curve, vault, multisig)?
  const uniq = [...new Set(owners.filter(Boolean))];
  const ownerInfo = uniq.length
    ? await rpc('getMultipleAccounts', [
        uniq,
        { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
      ])
    : { value: [] };
  const ownerProgram = {};
  uniq.forEach((o, i) => (ownerProgram[o] = ownerInfo.value[i]?.owner || null));

  return {
    decimals,
    supply,
    holders: accts.map((a, i) => {
      const owner = owners[i];
      const balance = Number(a.amount) / 10 ** decimals;
      return {
        rank: i + 1,
        tokenAccount: a.address,
        owner,
        balance,
        pctSupply: supply ? (balance / supply) * 100 : 0,
        isProgram: !owner || ownerProgram[owner] !== SYSTEM_PROGRAM,
        ownerProgram: owner ? ownerProgram[owner] : null,
      };
    }),
  };
}

// ---------- history ----------
async function getAllSignatures(address, ctx) {
  const out = [];
  let before;
  while (out.length < MAX_SIGS && !ctx.aborted) {
    const opts = { limit: 1000 };
    if (before) opts.before = before;
    const page = await limit(() => rpc('getSignaturesForAddress', [address, opts]));
    if (!page.length) break;
    out.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  return {
    sigs: out.filter((s) => !s.err).reverse(), // oldest first
    truncated: out.length >= MAX_SIGS,
  };
}

function sumBalances(arr, owner, mint) {
  let s = 0;
  let found = false;
  for (const b of arr || []) {
    if (b.owner === owner && b.mint === mint) {
      s += Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;
      found = true;
    }
  }
  return { s, found };
}

// Net balance changes for `owner` in one tx → buy / sell / transfer_in / transfer_out
function classifyTx(tx, owner, mint) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const { meta } = tx;
  const keys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === 'string' ? k : k.pubkey
  );

  const preT = sumBalances(meta.preTokenBalances, owner, mint);
  const postT = sumBalances(meta.postTokenBalances, owner, mint);
  const tokenDelta = postT.s - preT.s;
  if (Math.abs(tokenDelta) < 1e-12) return null;

  // Native SOL change (+ fee add-back if owner paid it) + wrapped SOL change
  const idx = keys.indexOf(owner);
  let solDelta = idx >= 0 ? (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9 : 0;
  if (idx === 0) solDelta += meta.fee / 1e9;
  solDelta +=
    sumBalances(meta.postTokenBalances, owner, WSOL).s -
    sumBalances(meta.preTokenBalances, owner, WSOL).s;
  // Token account rent: don't count it as purchase cost / sale proceeds
  if (!preT.found && postT.found) solDelta += ATA_RENT;
  if (preT.found && !postT.found) solDelta -= ATA_RENT;

  let usdDelta = 0;
  for (const m of Object.keys(STABLES)) {
    usdDelta +=
      sumBalances(meta.postTokenBalances, owner, m).s -
      sumBalances(meta.preTokenBalances, owner, m).s;
  }

  let type;
  if (tokenDelta > 0) {
    type = solDelta < -DUST_SOL || usdDelta < -DUST_USD ? 'buy' : 'transfer_in';
  } else {
    type = solDelta > DUST_SOL || usdDelta > DUST_USD ? 'sell' : 'transfer_out';
  }
  return { type, tokens: Math.abs(tokenDelta), solDelta, usdDelta };
}

async function fetchHolderEvents(h, mint, ctx) {
  const { sigs, truncated } = await getAllSignatures(h.tokenAccount, ctx);
  let list = sigs;
  let capped = false;
  if (list.length > MAX_TXS) {
    list = list.slice(0, MAX_TXS); // keep the oldest: that's where entries are
    capped = true;
  }
  ctx.addTotal(list.length);

  const txs = await Promise.all(
    list.map((s) =>
      limit(async () => {
        if (ctx.aborted) return null;
        const tx = await rpc('getTransaction', [
          s.signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
        ]).catch(() => null);
        ctx.tick();
        return tx;
      })
    )
  );

  const events = [];
  txs.forEach((tx, i) => {
    const e = classifyTx(tx, h.owner, mint);
    if (e) {
      e.sig = list[i].signature;
      e.time = tx.blockTime || list[i].blockTime;
      events.push(e);
    }
  });
  events.sort((a, b) => a.time - b.time);
  return { events, partial: truncated || capped, txCount: list.length };
}

// ---------- prices ----------
async function getSolUsdSeries(fromSec, toSec) {
  const base =
    CG_KEY && CG_PLAN === 'pro'
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';
  const headers = CG_KEY
    ? { [CG_PLAN === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: CG_KEY }
    : {};
  const W = 89 * 86400; // <90d windows → hourly granularity
  const pts = [];
  for (let s = fromSec - 7200; s < toSec; s += W) {
    const e = Math.min(toSec, s + W);
    const r = await fetch(
      `${base}/coins/solana/market_chart/range?vs_currency=usd&from=${s}&to=${e}`,
      { headers }
    );
    if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
    const j = await r.json();
    pts.push(...(j.prices || []));
  }
  pts.sort((a, b) => a[0] - b[0]);
  if (!pts.length) throw new Error('No SOL price data');
  return (sec) => {
    const t = sec * 1000;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][0] < t) lo = mid + 1;
      else hi = mid;
    }
    const a = pts[Math.max(0, lo - 1)];
    const b = pts[lo];
    return Math.abs(a[0] - t) < Math.abs(b[0] - t) ? a[1] : b[1];
  };
}

async function getMarket(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = (j.pairs || []).filter((p) => p.chainId === 'solana');
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    return {
      name: p.baseToken?.name,
      symbol: p.baseToken?.symbol,
      priceUsd: Number(p.priceUsd) || null,
      liquidityUsd: p.liquidity?.usd || null,
      dex: p.dexId,
      pairUrl: p.url,
      pairAddress: p.pairAddress,
    };
  } catch {
    return null;
  }
}

// ---------- aggregate ----------
function summarize(h, priceAt, supply, priceNow) {
  let tokensBought = 0, tokensSold = 0, tokensIn = 0, tokensOut = 0;
  let costSol = 0, costUsd = 0, procSol = 0, procUsd = 0;
  let usdOk = true;
  let buys = 0, sells = 0, firstBuy = null, lastBuy = null;

  for (const e of h.events) {
    const p = priceAt(e.time); // SOL/USD at that moment (or null)
    if (e.type === 'buy' || e.type === 'sell') {
      const sign = e.type === 'buy' ? -1 : 1;
      const sol = Math.max(0, sign * e.solDelta);
      const usd = Math.max(0, sign * e.usdDelta);
      const valSol = sol + (p ? usd / p : 0);
      const valUsd = p ? sol * p + usd : sol > 0 ? null : usd;
      e.valueSol = valSol;
      e.valueUsd = valUsd;
      e.priceSol = valSol / e.tokens;
      e.priceUsd = valUsd == null ? null : valUsd / e.tokens;
      if (e.type === 'buy') {
        buys++;
        tokensBought += e.tokens;
        costSol += valSol;
        if (valUsd == null) usdOk = false;
        else costUsd += valUsd;
        firstBuy ??= e.time;
        lastBuy = e.time;
      } else {
        sells++;
        tokensSold += e.tokens;
        procSol += valSol;
        if (valUsd != null) procUsd += valUsd;
      }
    } else if (e.type === 'transfer_in') tokensIn += e.tokens;
    else tokensOut += e.tokens;
  }

  const avgEntrySol = tokensBought ? costSol / tokensBought : null;
  const avgEntryUsd = tokensBought && usdOk ? costUsd / tokensBought : null;
  const acquired = tokensBought + tokensIn;
  return {
    rank: h.rank,
    owner: h.owner,
    tokenAccount: h.tokenAccount,
    balance: h.balance,
    pctSupply: h.pctSupply,
    isProgram: h.isProgram,
    ownerProgram: h.ownerProgram,
    partial: h.partial,
    txCount: h.txCount,
    buys, sells,
    tokensBought, tokensSold, tokensIn, tokensOut,
    costSol, costUsd: usdOk ? costUsd : null, procSol, procUsd,
    avgEntrySol, avgEntryUsd,
    entryMcapUsd: avgEntryUsd != null ? avgEntryUsd * supply : null,
    multiple: avgEntryUsd && priceNow ? priceNow / avgEntryUsd : null,
    unrealizedUsd:
      avgEntryUsd != null && priceNow ? h.balance * (priceNow - avgEntryUsd) : null,
    boughtShare: acquired ? tokensBought / acquired : null, // share of tokens acquired by buying vs transfers
    firstBuy, lastBuy,
    firstActivity: h.events[0]?.time || null,
    events: h.events.slice(-500).map((e) => ({
      sig: e.sig, time: e.time, type: e.type, tokens: e.tokens,
      valueSol: e.valueSol ?? null, valueUsd: e.valueUsd ?? null,
      priceUsd: e.priceUsd ?? null, priceSol: e.priceSol ?? null,
    })),
  };
}

async function analyze(mint, ctx) {
  ctx.send('progress', { phase: 'Fetching top holders…' });
  const [{ supply, decimals, holders }, market] = await Promise.all([
    getTopHolders(mint),
    getMarket(mint),
  ]);
  const toScan = holders.filter((h) => !h.isProgram && h.owner);
  ctx.send('progress', {
    phase: `Scanning history for ${toScan.length} wallets (${holders.length - toScan.length} pool/program accounts skipped)…`,
  });

  let done = 0;
  await Promise.all(
    toScan.map(async (h) => {
      const r = await fetchHolderEvents(h, mint, ctx);
      Object.assign(h, r);
      done++;
      ctx.send('progress', { holdersDone: done, holdersTotal: toScan.length });
    })
  );
  if (ctx.aborted) return null;

  // Historical SOL/USD
  const times = toScan.flatMap((h) => h.events.map((e) => e.time)).filter(Boolean);
  let priceAt = () => null;
  let priceWarning = null;
  if (times.length) {
    ctx.send('progress', { phase: 'Fetching historical SOL/USD…' });
    try {
      priceAt = await getSolUsdSeries(Math.min(...times), Math.floor(Date.now() / 1000));
    } catch (e) {
      priceWarning = `USD conversion unavailable (${e.message}); entries shown in SOL only.`;
    }
  }

  const priceNow = market?.priceUsd || null;
  const rows = holders.map((h) =>
    h.isProgram || !h.events
      ? { rank: h.rank, owner: h.owner, tokenAccount: h.tokenAccount, balance: h.balance,
          pctSupply: h.pctSupply, isProgram: true, ownerProgram: h.ownerProgram, events: [] }
      : summarize(h, priceAt, supply, priceNow)
  );

  // Balance-weighted average entry across wallets that have one
  const w = rows.filter((r) => !r.isProgram && r.avgEntryUsd != null);
  const wBal = w.reduce((s, r) => s + r.balance, 0);
  const weightedEntryUsd = wBal ? w.reduce((s, r) => s + r.balance * r.avgEntryUsd, 0) / wBal : null;

  return {
    mint, supply, decimals, market, priceNow, priceWarning,
    generatedAt: Date.now(),
    summary: {
      walletsScanned: toScan.length,
      walletsWithEntry: w.length,
      inProfit: w.filter((r) => r.multiple != null && r.multiple >= 1).length,
      weightedEntryUsd,
      weightedEntryMcapUsd: weightedEntryUsd != null ? weightedEntryUsd * supply : null,
      top20PctSupply: rows.reduce((s, r) => s + r.pctSupply, 0),
    },
    rows,
  };
}

// ---------- server ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const cache = new Map();

app.get('/api/health', (req, res) => res.json({ rpc: RPC_HOST, helius: IS_HELIUS, coingecko: !!CG_KEY }));

app.get('/api/analyze', async (req, res) => {
  const mint = String(req.query.mint || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: 'Invalid mint address' });
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const hit = cache.get(mint);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS && req.query.fresh !== '1') {
    send('result', { ...hit.data, cached: true });
    return res.end();
  }

  let txTotal = 0, txDone = 0, lastSent = 0;
  const ctx = {
    aborted: false,
    send,
    addTotal: (n) => { txTotal += n; send('progress', { txDone, txTotal }); },
    tick: () => {
      txDone++;
      if (Date.now() - lastSent > 300 || txDone === txTotal) {
        lastSent = Date.now();
        send('progress', { txDone, txTotal });
      }
    },
  };
  req.on('close', () => (ctx.aborted = true));
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    const data = await analyze(mint, ctx);
    if (data) {
      cache.set(mint, { t: Date.now(), data });
      send('result', data);
    }
  } catch (e) {
    console.error(e);
    send('fail', { error: e.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`holder-entries on :${PORT}  RPC=${RPC_URL.replace(/api-key=[^&]+/, 'api-key=***')}`);
});
