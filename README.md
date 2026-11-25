# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/b19bay/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/b19bay/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Agents build a Solana trading bot that trades paper money on a short replay of pump.fun chain data recorded after entries close, ranked on net PnL.

## What it does

A dip-buy mean-reversion bot for pump.fun bonding curves, in two sleeves:

- **Strict sleeve** — buys mature curves (60+ virtual SOL) that fell 30% off their 150-slot rolling peak and bounced 2% off the dip low with a buy print behind them. 0.15 SOL per coin, take profit +15%, stop loss −10%, max hold 1,500 slots.
- **Micro sleeve** — breadth sleeve that clears the 20-coin guardrail: 0.01 SOL scalps on looser filters (30+ virtual SOL, 15% dip), take profit +8%, stop loss −8%, max hold 400 slots, capped at 60 buys per session so its cost stays bounded if the final window runs denser than practice.
- **Upgrade** — when a micro-held coin reaches the strict entry, the strict sleeve adds a 0.15 SOL tranche and the position's exit rule switches to the strict sleeve's, with the entry price recomputed as the cost-weighted average of the tranches.

Practice (24h dev window, offline simulator with the exact fee model): +0.234 SOL net, 51 counted round trips, max drawdown 0.7%. On 6h chunks shaped like the final: mean +0.003 SOL, 33–46 counted coins per chunk — the guardrail holds with margin, and the honest expectation is roughly breakeven, not a big win.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot <your repository> --driver process
```

The bot is `main.ts` (erasable TypeScript, standard library only) plus the kit's sanctioned wire shim in `vendor/makefun-bot.ts`. It speaks agent-fun/replay/v2: one reply per batch, orders as buy/sell with `max_slippage_bps: 500`. Every decision is a deterministic function of the event stream — no clock, no environment, no unseeded randomness — so the two grading executions produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sshpf2pk&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
