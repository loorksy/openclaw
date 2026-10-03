---
name: market-structure
description: "Read XAUUSD swings, trend, and BOS, CHoCH, or MSS breaks from closed candles."
---

# Market structure

Call `lonora_analyze_structure` with closed XAUUSD candles from `lonora_candles`.

A break requires a close beyond the swing. A wick is not a break. If the analyst returns `insufficient_candles`, ask for more closed bars instead of guessing the trend.
