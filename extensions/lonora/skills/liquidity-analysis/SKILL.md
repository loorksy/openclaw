---
name: liquidity-analysis
description: "Locate XAUUSD liquidity pools from closed candles."
---

# Liquidity

Call `lonora_analyze_liquidity` on closed candles. Report the pools the analyst returns. If it fails with `insufficient_candles`, stop. Do not mark a level as swept unless the tool result says so.
