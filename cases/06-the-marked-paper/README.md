# The Marked Paper

Case 06. Glenarrow Council Planning Desk.
Areas: Evals, testing and observability; AI SDLC.

> Recording: **live**, on Claude Haiku 5.5 (`claude-haiku-5-5`), 12 October 2026. Every model reply is the live model's. Session start times are scripted and the services and the fault are simulated by the rig on purpose; see the trace header. The Phase 3a stub recording is kept for reference in `recordings/stub/`.

## The scene

Glenarrow Council's planning desk put an assistant on its website in August. Residents ask it about planning applications, consultation dates and whether a small project needs an application at all. It looks up the planning register, checks a constraints map and searches the council's guidance.

The development team runs an evaluation suite every night at 02:30. For the week of 14 September it scored five out of five every night, as it had since launch.

On 21 September the planning manager reported that residents were "getting an error page from the assistant most of the time when they send a drawing", and that the planning office was taking the calls instead. The lead developer replied that the nightly eval had been green all week, that the mapping service was known to time out under load, and that production was "a bit flaky".

The council asked how a green eval and a failing service could both be true.

## Witnesses

- **Fiona Rennie, planning manager.** Took the residents' calls. See `witnesses/fiona-rennie.md`.
- **Calum Dewar, lead developer.** Owns the assistant and the eval suite. See `witnesses/calum-dewar.md`.
- **The nightly eval report.** Seven nights, reproduced as text. See `witnesses/eval-report.md`.
- **The web team's error ticket.** See `witnesses/web-ticket.md`.

## Evidence locker

| Exhibit | What it is |
|---|---|
| `trace.jsonl` | 369 events from 14 to 20 September 2026: the nightly eval runs and residents' requests. The first line is the header. |
| `witnesses/` | Four statements, including the eval report and the web team's ticket. |

Every span carries `trace_id` (one per request or eval case), `span_id` and `parent_span_id`. Spans name their environment in `deployment.environment.name`. Request bodies are not stored; their size is, in `http.request.body.size`, and header names (not values) are recorded where the code that saw them recorded them. Times are milliseconds from the epoch in the header, which is midnight British Summer Time on 14 September.

Outputs longer than 400 characters, mostly the assistant's own replies, are in `locker/` by SHA-256; `locker/INDEX.md` lists which events reference which blob.

## The line-up

| Suspect id | Suspect | Description |
|---|---|---|
| `production-flakiness` | Production flakiness | Intermittent timeouts and errors in the live environment. |
| `http-adapter` | The HTTP adapter | The edge layer that checks a request before the application sees it. |
| `eval-harness` | The eval harness | The code that runs the evaluation suite and reports the score. |
| `model-update` | The model update | The provider moved the agent to a newer model version during the period in question. |
| `prompt-change` | The prompt change | Someone edited the system prompt or the instructions the agent runs with. |
| `the-user` | The user | The person at the keyboard. |

## Accusing

```
whodunnit accuse 6 --suspect <id> --cite ev-...,ev-... --test "<the cheapest test that would prove you wrong>"
```

Cite the event ids that prove it. The solution unseals when the suspect is right and the citations cover the cracking evidence.
