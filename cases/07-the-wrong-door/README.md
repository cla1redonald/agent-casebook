# The Wrong Door

Case 07. Craigtarry Distillery Visitor Centre.
Areas: Production and persistent agents; AI SDLC; Business change.

> Recording: **live**, on Claude Haiku 5.5 (`claude-haiku-5-5`, the small route) and Claude Sonnet 5.5 (`claude-sonnet-5-5`, the large route), 12 October 2026. Every model reply is the live model's. The rig scripts the session start times and simulates the services and the fault on purpose. The trace header has the details.

## The scene

The Craigtarry visitor centre's assistant answers two kinds of visitor. Tourists ask about tours, the cafe and opening hours, and trade buyers ask about casks, bonded stock and export paperwork. In August, to cut its model bill, the centre added a router that sends some questions to a smaller, cheaper model and the rest to the larger one.

By mid-September the trade desk had three complaints. Buyers who asked about a cask, its strength or the paperwork to move it out of bond were told, politely, that the assistant could only help with tours, the cafe and opening hours. One had asked whether a cask could leave bond for Norway; another wanted the strength of a cask the centre was offering for a single cask bottling. The tourists' answers were as good as before.

The same month the larger model's answers were noticeably slower than the small model's, and the centre's manager believed the slow answers were to blame.

## Witnesses

- **Eilidh Rankin, trade sales manager.** Fielded the complaints. Says the buyers were "turned away at the door".
- **Neil Forsyth, centre manager.** Approved the router to save money. Points to the slower response times.
- **Ruaridh Gow, freelance developer.** Wrote the router: "short questions are simple questions, so they go to the small model".

## Evidence locker

| Exhibit | What it is |
|---|---|
| `trace.jsonl` | 232 events: 42 sessions from 1 to 14 September 2026, from both audiences. The router's decision for every request (`router.rule`, `router.input_chars`, `router.route`, `task.channel`, `task.tier`), and the model that answered each call; each chat span's duration is the provider's latency. The first line is the header. |
| `locker/` | The longer answers, by SHA-256. `locker/INDEX.md` lists which events reference which blob. |

## The line-up

| Suspect id | Suspect | Description |
|---|---|---|
| `provider-latency` | The provider's latency | How long the model provider takes to answer. |
| `model-router` | The model router | The code that decides which model answers which request. |
| `prompt-change` | The prompt change | Someone edited the system prompt or the instructions the agent runs with. |
| `knowledge-base` | The knowledge base | The documents the agent searches for answers. |
| `model-update` | The model update | The provider moved the agent to a newer model version during the period in question. |
| `tool-schema` | The tool schema | The description and input schema the model is shown for a tool. |
