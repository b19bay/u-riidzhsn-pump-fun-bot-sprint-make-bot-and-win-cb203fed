// Dip-buy mean-reversion bot for the pump.fun replay bounty (agent-fun/replay/v2).
//
// Two sleeves, one position per mint:
//   strict - deep dip-buy on mature curves (virtual SOL >= 60, dip 30% off the
//            150-slot rolling peak, bounce confirmation): 0.15 SOL, TP +15%,
//            SL -10%, max hold 1,500 slots.
//   micro  - breadth sleeve that clears the 20-coin guardrail: small 0.01 SOL
//            scalps on looser filters (virtual SOL >= 30, dip 15%), TP +8%,
//            SL -8%, max hold 400 slots, capped at 60 buys per session.
// A strict signal on a micro-held coin upgrades the position: the strict
// tranche is bought and the exit rule switches to the strict sleeve's, with
// the entry price recomputed as the cost-weighted average of the tranches.
//
// Every decision is a deterministic function of the event stream: no clock,
// no environment, no unseeded randomness. Prices are compared as ratios of
// bigints (cross-multiplication), never floats.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState } from './vendor/makefun-bot.ts';
import type { OrderInput } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const WINDOW_SLOTS = 150;
const COOLDOWN_SLOTS = 600;
const BOUNCE_BPS = 102;
const MIN_ROUND_TRIP = 10_000_000n; // 0.01 SOL: the guardrail minimum
const MICRO_CAP = 60;
const SLIPPAGE_BPS = 500;

interface SleeveParams {
  name: 'strict' | 'micro';
  dipPct: number;
  vminLamports: bigint;
  tpPct: number;
  slPct: number;
  maxHoldSlots: number;
  sizeLamports: bigint;
}

const STRICT: SleeveParams = {
  name: 'strict',
  dipPct: 30,
  vminLamports: 60n * LAMPORTS_PER_SOL,
  tpPct: 15,
  slPct: 10,
  maxHoldSlots: 1500,
  sizeLamports: 150_000_000n,
};

const MICRO: SleeveParams = {
  name: 'micro',
  dipPct: 15,
  vminLamports: 30n * LAMPORTS_PER_SOL,
  tpPct: 8,
  slPct: 8,
  maxHoldSlots: 400,
  sizeLamports: 10_000_000n,
};

const REAL_MIN_LAMPORTS = 5n * LAMPORTS_PER_SOL;

interface PricePoint {
  slot: number;
  vs: bigint;
  vt: bigint;
}

interface CoinState {
  hist: PricePoint[];
  peakNum: bigint;
  peakDen: bigint;
  peakSlot: number;
  lowNum: bigint;
  lowDen: bigint;
  lowSlot: number;
  lastBuy: boolean;
  lastExitSlot: number;
}

interface PositionState {
  sleeve: 'strict' | 'micro';
  entryNum: bigint;
  entryDen: bigint;
  entrySlot: number;
  tokens: bigint;
  tpPct: number;
  slPct: number;
  maxHoldSlots: number;
}

// price a <= b for a = aNum/aDen, b = bNum/bDen (positive bigints).
function priceLe(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): boolean {
  return aNum * bDen <= bNum * aDen;
}

// price a >= b.
function priceGe(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): boolean {
  return aNum * bDen >= bNum * aDen;
}

const coins = new Map<string, CoinState>();
const ledger = new Map<string, PositionState>();
const pendingBuys = new Map<string, { mint: string; sleeve: 'strict' | 'micro' }>();
let nextId = 1;
let microBuys = 0;

function coinState(mint: string): CoinState {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      hist: [],
      peakNum: 0n,
      peakDen: 1n,
      peakSlot: -1,
      lowNum: 0n,
      lowDen: 1n,
      lowSlot: -1,
      lastBuy: false,
      lastExitSlot: -1_000_000_000,
    };
    coins.set(mint, c);
  }
  return c;
}

function trackTrade(mint: string, slot: number, vs: bigint, vt: bigint, isBuy: boolean): void {
  const c = coinState(mint);
  c.hist.push({ slot, vs, vt });
  while (c.hist.length > 0 && c.hist[0].slot < slot - WINDOW_SLOTS) c.hist.shift();
  c.lastBuy = isBuy;
  if (vt === 0n) return;
  if (c.peakSlot < slot - WINDOW_SLOTS) {
    // Rolling peak expired: recompute it over the window, reset the dip low.
    let pn = 0n;
    let pd = 1n;
    for (const h of c.hist) {
      if (h.vt > 0n && (pn === 0n || priceGe(h.vs, h.vt, pn, pd))) {
        pn = h.vs;
        pd = h.vt;
      }
    }
    c.peakNum = pn;
    c.peakDen = pd;
    c.peakSlot = slot;
    c.lowNum = vs;
    c.lowDen = vt;
    c.lowSlot = slot;
  } else if (priceGe(vs, vt, c.peakNum, c.peakDen)) {
    // New high: peak moves up and the dip low resets to the current price.
    c.peakNum = vs;
    c.peakDen = vt;
    c.peakSlot = slot;
    c.lowNum = vs;
    c.lowDen = vt;
    c.lowSlot = slot;
  } else if (c.lowSlot < c.peakSlot || priceLe(vs, vt, c.lowNum, c.lowDen)) {
    if (c.lowSlot < c.peakSlot) {
      c.lowNum = vs;
      c.lowDen = vt;
      c.lowSlot = slot;
    } else if (priceLe(vs, vt, c.lowNum, c.lowDen)) {
      c.lowNum = vs;
      c.lowDen = vt;
      c.lowSlot = slot;
    }
  }
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const queuedBuyMints = new Set<string>();
  let queuedQuote = 0n;
  const txFee = state.txFeeLamports();

  // 1. Fold this batch's trades into the per-coin peak / dip-low tracking.
  for (const e of batch.events) {
    if (e.event === 'TradeEvent') {
      trackTrade(e.mint, e.slot, BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves), e.is_buy);
    }
  }

  // 2. Fold this batch's fills into the position ledger. A buy fill either
  // opens a position or upgrades a micro-held one to the strict sleeve.
  for (const f of batch.fills) {
    const pb = pendingBuys.get(f.client_id);
    if (pb === undefined) continue;
    pendingBuys.delete(f.client_id);
    if (f.status !== 'filled' || f.side !== 'buy') continue;
    const curve = state.curves.get(pb.mint);
    if (curve === undefined || curve.complete) continue;
    const fillTokens = BigInt(f.token_amount);
    if (fillTokens === 0n) continue;
    if (pb.sleeve === 'micro') microBuys += 1;
    const existing = ledger.get(pb.mint);
    const sp = pb.sleeve === 'strict' ? STRICT : MICRO;
    if (existing === undefined) {
      ledger.set(pb.mint, {
        sleeve: pb.sleeve,
        entryNum: curve.virtual_quote_reserves,
        entryDen: curve.virtual_token_reserves,
        entrySlot: batch.slot,
        tokens: fillTokens,
        tpPct: sp.tpPct,
        slPct: sp.slPct,
        maxHoldSlots: sp.maxHoldSlots,
      });
    } else {
      // Upgrade: strict tranche joins a micro-held position. The exit rule
      // switches to strict and the entry price becomes the cost-weighted
      // average of the tranches; the hold timer keeps the original entry.
      const oldTokens = existing.tokens;
      const avgNum =
        oldTokens * existing.entryNum * curve.virtual_token_reserves +
        fillTokens * curve.virtual_quote_reserves * existing.entryDen;
      const avgDen = (oldTokens + fillTokens) * existing.entryDen * curve.virtual_token_reserves;
      existing.entryNum = avgNum;
      existing.entryDen = avgDen;
      existing.tokens = oldTokens + fillTokens;
      if (pb.sleeve === 'strict' && existing.sleeve === 'micro') {
        existing.sleeve = 'strict';
        existing.tpPct = STRICT.tpPct;
        existing.slPct = STRICT.slPct;
        existing.maxHoldSlots = STRICT.maxHoldSlots;
      }
    }
  }

  // 3. Reconcile the ledger with the account: a position that is gone was
  // sold, completed, flattened or written off; its cooldown starts now.
  for (const mint of [...ledger.keys()]) {
    if (!state.positions.has(mint)) {
      const c = coinState(mint);
      c.lastExitSlot = batch.slot;
      ledger.delete(mint);
    }
  }

  const hasPendingSell = (mint: string): boolean => {
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell' && p.order.mint === mint) return true;
    }
    return false;
  };
  const hasPendingBuy = (mint: string): boolean => {
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === mint) return true;
    }
    return false;
  };

  // 4. Exits: take profit, stop loss, or time exit, using the owning
  // sleeve's parameters. Sell the full position in one order.
  for (const [mint, pos] of ledger) {
    const holding = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (holding === undefined || curve === undefined || curve.complete) continue;
    if (curve.virtual_token_reserves === 0n) continue;
    if (hasPendingSell(mint)) continue;
    const vs = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    const tpHit = vs * pos.entryDen * 100n >= pos.entryNum * vt * BigInt(100 + pos.tpPct);
    const slHit = vs * pos.entryDen * 100n <= pos.entryNum * vt * BigInt(100 - pos.slPct);
    const timeHit = batch.slot - pos.entrySlot >= pos.maxHoldSlots;
    if (tpHit || slHit || timeHit) {
      orders.push({
        side: 'sell',
        client_id: `s${nextId++}`,
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }
  }

  // 5. Entries: coins that traded on this slot, strict sleeve first.
  const traded: string[] = [];
  const seenTraded = new Set<string>();
  for (const e of batch.events) {
    if (e.event === 'TradeEvent' && !seenTraded.has(e.mint)) {
      seenTraded.add(e.mint);
      traded.push(e.mint);
    }
  }
  const committedMints = (): number => {
    const mints = new Set<string>(state.positions.keys());
    for (const p of state.pending.values()) if (p.order.side === 'buy') mints.add(p.order.mint);
    for (const m of queuedBuyMints) mints.add(m);
    return mints.size;
  };
  const freeAfterQueue = (): bigint => {
    let free = state.freeCashLamports();
    free -= queuedQuote;
    free -= BigInt(orders.length) * txFee;
    return free;
  };

  for (const sleeve of [STRICT, MICRO] as const) {
    if (sleeve.name === 'micro' && microBuys >= MICRO_CAP) continue;
    for (const mint of traded) {
      if (committedMints() >= state.hello.caps.max_open_positions) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n) continue;
      const held = ledger.get(mint);
      if (held !== undefined) {
        // Only the strict sleeve may add to a micro-held position (upgrade).
        if (!(sleeve.name === 'strict' && held.sleeve === 'micro')) continue;
      } else if (state.positions.has(mint)) {
        continue;
      }
      if (hasPendingBuy(mint) || queuedBuyMints.has(mint)) continue;
      if (hasPendingSell(mint)) continue;
      const c = coins.get(mint);
      if (c === undefined) continue;
      if (batch.slot - c.lastExitSlot < COOLDOWN_SLOTS) continue;
      const vs = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (vs < sleeve.vminLamports) continue;
      if (curve.real_quote_reserves < REAL_MIN_LAMPORTS) continue;
      if (c.peakNum === 0n) continue;
      // Dip: price at or below (100 - dip)% of the rolling peak.
      if (!priceLe(vs * 100n, vt, c.peakNum * BigInt(100 - sleeve.dipPct), c.peakDen)) continue;
      // Bounce: price back at least 2% above the dip low, latest trade a buy.
      if (!priceGe(vs * 100n, vt, c.lowNum * BigInt(BOUNCE_BPS), c.lowDen)) continue;
      if (!c.lastBuy) continue;
      // Size: fixed per sleeve, capped at 95% of the 1%-of-real-reserve cap.
      const cap = state.maxBuyLamports(mint);
      let size = sleeve.sizeLamports;
      const capped = (cap * 95n) / 100n;
      if (capped < size) size = capped;
      if (size < MIN_ROUND_TRIP) continue;
      if (freeAfterQueue() < size + txFee) continue;
      const id = `b${nextId++}`;
      pendingBuys.set(id, { mint, sleeve: sleeve.name });
      queuedBuyMints.add(mint);
      queuedQuote += size;
      orders.push({ side: 'buy', client_id: id, mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
    }
  }

  return orders;
}

await runBot({ onBatch });
