---
name: recommendation-review
description: "Review XAUUSD recommendation lifecycle, activation, invalidation, targets, and outcome."
---

# Recommendation review

List plans with `lonora_recommendations` action `list`. Grade them with action `grade` only when closed candles are available.

State direction, entry, stop, targets, status, and outcome from the stored object. A pending plan is not a filled trade. Never call `lonora_execute_trade` from a review.
