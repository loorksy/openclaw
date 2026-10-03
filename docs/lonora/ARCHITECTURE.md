# Lonora architecture

Lonora is a private, single-owner gold market operator. This repository is a fork of OpenClaw. OpenClaw remains the runtime. Boty is a capability source, not a second product.

## Map

| OpenClaw subsystem                                                        | Decision                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Gateway, sessions, streaming, retries, cancellation, recovery             | KEEP                                                                  |
| Cron / automations scheduler                                              | KEEP. Owner nav calls it Tasks                                        |
| Memory core                                                               | KEEP as conversation memory. Trading memory lives in the Lonora store |
| Plugin SDK, tool registration, approvals                                  | KEEP                                                                  |
| Provider runtime, including Anthropic, OpenAI, Z.AI, OpenRouter           | KEEP                                                                  |
| Telegram channel                                                          | KEEP. Other channels stay installed and are hidden                    |
| Usage and cost accounting                                                 | KEEP and ADAPT. No customer billing                                   |
| Control UI shell                                                          | ADAPT to the Lonora workspace                                         |
| Coding tools, terminal, browser, nodes, git                               | KEEP BUT HIDE. Blocked from the model by the Lonora tool policy       |
| Plugin marketplace, extra channels, meetings, dashboards, apps            | KEEP BUT HIDE from the owner navigation                               |
| CLI, tests, Doctor, migrations                                            | KEEP as developer infrastructure                                      |
| Public registration, orgs, billing, credits                               | REMOVE from the owner experience. No second account path is added     |
| Boty custom gateway, scheduler, and sub-agent framework                   | REMOVE. Not ported                                                    |
| Boty gold detectors, sessions, recommendation grading, execution boundary | REPLACE the missing domain                                            |

## Dependency risks

- The default OpenClaw tool profile stays `full` so existing runtime tests keep their contract. Lonora narrows the model with `before_prompt_build` and blocks coding tools in `before_tool_call`.
- Settings and sidebar lists are pinned by UI tests. Those tests were updated with the owner navigation.
- The Lonora SQLite file is opened by the plugin service. Gateway database rules prefer a worker. This store is plugin-owned state, not the Gateway database.
- Live candles require `OANDA_API_TOKEN`. Without it the market page reports unavailable data and does not invent a price.
- `lonora_execute_trade` never calls a broker. The tool hook ignores model-supplied confirmation. The manual path returns `not_linked` until a real adapter is intentionally added.

## One owner

The Lonora store holds one owner row. A Boty migration with more than one user fails until `--owner` is explicit, and a dry run writes nothing. An automatic local placeholder with no recommendations or memories can be replaced by that explicit owner. Imported plans keep a real created time so historical candles are not graded as if the plan started at epoch. Web, Telegram binding, tasks, memory, and settings use that row.

## Monitoring

The service timer is not an LLM loop. One pass runs at a time. Each pass reads the gold clock, fetches closed candles only when the market is open and OANDA is configured, then runs deterministic structure checks. A specialist run is recorded only after a material change, and only inside the optional daily budget. Usage rows take the provider and model from the model event. An unpriced usage event fails that budget closed. Failed notices wait before the next attempt. A monitor exception is stored as a failed data status. Direct session spawn is blocked. Specialist bursts are capped from recent recorded runs, and the model cannot set its own depth.

A material notice is sent through the gateway message tool to the bound Telegram chat. If Telegram is unbound or the send fails, the notice stays failed with a recorded reason. A morning or daily briefing is registered as a weekday 08:00 America/New_York cron turn when the host scheduler accepts it. Other responsibilities stay on the monitor and record whether the latest check matched the instruction, is still waiting, or is waiting because gold is closed. A scheduled briefing is not rewritten as "still waiting" on every monitor pass.

## Sequence already started

1. Audit and this map.
2. Lonora plugin: owner, tools, recommendations, memory, specialists, migration.
3. Owner navigation, four providers, Telegram-only channel list, trading welcome prompts.
4. Market and recommendation pages bound to gateway methods.
5. Tasks, Agents, and Usage & Cost read Lonora responsibilities, specialists, and cost rollups. Settings opens a four-provider connection page. The older automations, agent, usage, and model-provider screens stay registered for direct links.
6. Tests, docs, and upstream notes.
