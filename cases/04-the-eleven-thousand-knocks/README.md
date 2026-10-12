# The Eleven Thousand Knocks

Case 04. Kinbrae Bakeries.
Areas: Production and persistent agents; Evals, testing and observability; AI SDLC.

> Recording: **live**, on Claude Haiku 5.5 (`claude-haiku-5-5`), 12 October 2026. Every model reply is the live model's. Session start times are scripted and the services and the fault are simulated by the rig on purpose; see the trace header.
>
> **The storm is simulated locally.** While the provider's throttle is in force the rig answers every attempt with a 429 itself, so none of the rejected attempts reached the provider or was billed. Only the attempts recorded with `http.status` 200 are live model calls.

## The scene

Kinbrae Bakeries has eleven branches and one central bakehouse. Each night at 04:00 an assistant reads the branches' orders, checks them against the usual quantities and the day's promotions, and writes the bakehouse's production sheet: one model call per order, about thirty on a normal night, finished in under a minute.

On the Friday of a half-price pie promotion the sheet was not ready until 04:30. Three branches opened without morning rolls. The provider's usage page showed 3,518 requests between 04:00 and 04:30, against 30 the night before. The bakehouse manager, counting the "retrying" lines on his screen, put it nearer eleven thousand.

Orders were up by about thirty per cent for the promotion. The operations director's view was that the promotion had overloaded the system and that next time the batch should start earlier.

## Witnesses

- **Gillian Shand, operations director.** Planned the promotion. Wants the batch moved to 03:00.
- **Hamish Corbett, bakehouse manager.** Waited for the sheet. Says the screen showed "retrying" for most of the night.
- **Anil Mathur, contractor developer.** Wrote the batch. Wrapped each model call in a retry loop "so it never drops an order", and uses the provider's SDK, which also retries.

## Evidence locker

| Exhibit | What it is |
|---|---|
| `trace.jsonl` | 4,904 events: the Thursday batch (30 orders) and the Friday batch (40 orders), one session per order. Every model attempt with its status and timing, and every HTTP attempt beneath it with the request body size and the `retry-after` the provider sent. The first line is the header. |

The rate limit headers are recorded as attributes on the HTTP spans. The batch's own span for each night records its order count and the logical requests it made.

## The line-up

| Suspect id | Suspect | Description |
|---|---|---|
| `traffic-spike` | The traffic spike | An unusual surge in requests. |
| `rate-limit` | The provider rate limit | The ceiling the model provider places on requests and tokens per minute. |
| `retry-policy` | The retry policy | The harness's rules for trying a failed call again. |
| `provider-latency` | The provider's latency | How long the model provider takes to answer. |
| `model-update` | The model update | The provider moved the agent to a newer model version during the period in question. |
| `upstream-service` | The upstream service | An internal or third-party API the agent depends on. |
