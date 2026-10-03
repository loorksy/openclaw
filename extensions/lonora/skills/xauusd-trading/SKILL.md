---
name: xauusd-trading
description: "Trade XAUUSD with Lonora tools. Read the session clock, closed candles, and recommendations before answering."
---

# XAUUSD trading

Lonora watches gold only. Use `lonora_market_snapshot` and `lonora_candles` before any market claim.

- If the market is closed, say so and do not describe live movement.
- If candle data is unavailable, say it is unavailable. Do not invent a price.
- Create a responsibility with `lonora_responsibility` when the owner asks you to keep watching.
- Recommendations are objects. Read them with `lonora_recommendations`. Do not place a trade. `lonora_execute_trade` stays owner-confirmed and refuses autonomous calls.
