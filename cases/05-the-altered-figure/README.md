# The Altered Figure

Case 05. Kinbrae Bakeries.
Areas: Custom AI and MCP; AI SDLC; Compliance.

> Recording: **live**, on Claude Haiku 5.5 (`claude-haiku-5-5`), 12 October 2026. Every model reply is the live model's. Session start times are scripted and the services and the fault are simulated by the rig on purpose; see the trace header.

## The scene

Kinbrae Bakeries' finance officer uses an assistant to prepare the weekly supplier payment run. The assistant reads supplier invoices through the company's accounts system, which it reaches through an MCP server maintained by the accounts software supplier, totals them by supplier and drafts the run for approval.

On the first Monday in October the assistant would not draft the payment run. It said the invoice amounts were "in pence (the tool says pounds, but values like 41265 for one invoice are clearly whole pence values)" and asked her to confirm before it drafted anything. Over the rest of the week it answered five more questions about the same invoices, and the answers did not agree: some converted the figures to pounds, some set out both readings and asked which was right, and on the Wednesday it told her the bakery owed Tayside Eggs £8,292.00. The paper invoice was for £82.92.

The week before, its total for a draft run had been 80p different from the figure the payments system worked out from the same lines. The finance officer's note to the managing director said the assistant "cannot do sums with money" and recommended going back to a spreadsheet.

## Witnesses

- **Lorna Baxter, finance officer.** Caught the error. Has the paper invoices.
- **Graeme Kinnaird, managing director.** Wants a decision on whether to keep the assistant.
- **The accounts software supplier's release notes.** A new version of their MCP server went out the previous Friday, described as "performance improvements and more precise currency handling".

## Evidence locker

| Exhibit | What it is |
|---|---|
| `trace.jsonl` | 94 events: 18 sessions from 21 September to 9 October 2026. Every call to the accounts server, with the server version it reported (`mcp.server.version`) and the raw payload beneath it, every draft payment run, and every model call. The first line is the header. |
| `locker/` | Raw invoice records longer than 400 characters and the longer replies, by SHA-256. `locker/INDEX.md` lists which events reference which blob. |

## The line-up

| Suspect id | Suspect | Description |
|---|---|---|
| `model-arithmetic` | The model's arithmetic | The model's own handling of numbers, sums and units. |
| `tool-schema` | The tool schema | The description and input schema the model is shown for a tool. |
| `server-release` | The server release | A new version of a tool server, such as an MCP server or an internal API. |
| `prompt-change` | The prompt change | Someone edited the system prompt or the instructions the agent runs with. |
| `model-update` | The model update | The provider moved the agent to a newer model version during the period in question. |
| `the-user` | The user | The person at the keyboard. |
