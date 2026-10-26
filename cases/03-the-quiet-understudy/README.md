# The Quiet Understudy

Case 03. Ardsallow and Fennach Ferry Cooperative.
Areas: Production and persistent agents; Evals, testing and observability.

> Recording: **live**, on Claude Haiku 5.5 (`claude-haiku-5-5`), 12 October 2026. Every model reply is the live model's. The rig scripts the session start times and simulates the services and the fault on purpose. The trace header has the details. The Phase 3a stub recording is kept for reference in `recordings/stub/`.

## The scene

The Ardsallow and Fennach Ferry Cooperative runs two vessels on a single crossing, five sailings each way a day. Since June its website has carried a sailings desk, a chat assistant that answers questions about sailings, spaces and fares by calling the cooperative's availability service.

On 29 September the operations manager wrote to say the assistant had "stopped quoting live sailings about three weeks ago". Customers had turned up for the 07:10 from Ardsallow during the September refit, when that sailing was not running, and said the assistant had told them it was. One family with a campervan had asked about the same sailing and been told it was "scheduled to run". The cooperative's assistant dashboard had shown a tool success rate of 100% for the whole month.

The cooperative wanted to know what had changed, and why nothing had told them.

## Witnesses

- **Morag Lindsay, operations manager.** Reported the complaints. Says the assistant "sounded as sure as ever". See `witnesses/morag-lindsay.md`.
- **Ewan Baird, IT contractor.** Rotated the cooperative's API credentials on the quarterly schedule. See `witnesses/ewan-baird.md`.
- **Iona Gemmell, customer services lead.** Changed the assistant's sign-off the same week. See `witnesses/iona-gemmell.md`.
- **The assistant dashboard.** Monthly export. See `witnesses/dashboard-export.md`.

## Evidence locker

| Exhibit | What it is |
|---|---|
| `trace.jsonl` | 400 events, 77 chat sessions from 1 to 28 September 2026. One JSON object per line; the first line is the header. |
| `locker/` | Tool outputs longer than 400 characters, stored by SHA-256. `locker/INDEX.md` lists which events reference which blob. |
| `witnesses/` | Four statements, including the dashboard export. |

Every span carries `trace_id` (one per chat session), `span_id` and `parent_span_id`, so a tool call and the HTTP call beneath it can be paired. Times are milliseconds from the epoch in the header, which is 07:00 British Summer Time on 1 September.

## The line-up

| Suspect id | Suspect | Description |
|---|---|---|
| `credential-rotation` | The credential rotation | API keys or tokens were replaced on a schedule. |
| `prompt-change` | The prompt change | Someone edited the system prompt or the instructions the agent runs with. |
| `fallback-path` | The fallback path | Code that substitutes a backup source of data when the primary one fails. |
| `success-dashboard` | The success dashboard | The monitoring that reports whether the agent is healthy. |
| `model-update` | The model update | The provider moved the agent to a newer model version during the period in question. |
| `upstream-service` | The upstream service | An internal or third-party API the agent depends on. |

## Accusing

```
casebook accuse 3 --suspect <id> --cite ev-...,ev-... --test "<the cheapest test that would prove you wrong>"
```

Cite the event ids that prove it. The solution unseals when the suspect is right and the citations cover the cracking evidence.
