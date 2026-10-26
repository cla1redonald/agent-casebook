# The Empty Cabinet

Case 09. Hepburn Strachan Chartered Surveyors.
Areas: Desktop rollout to non-technical users; Business change.

> Recording: **live**, on Claude Haiku 5.5 (`claude-haiku-5-5`), 12 October 2026. Every model reply is the live model's. The rig scripts the session start times and simulates the services and the fault on purpose. The trace header has the details.

## The scene

In September Hepburn Strachan rolled a desktop assistant out to its office administrators. It came with a file connector so that staff could ask it to find documents in the firm's shared job folders. The pilot, on two machines in the main office, went well.

In the first week of the wider rollout an administrator in the branch office asked the assistant for the previous survey on a house the firm had inspected in 2024. The assistant said it could not find any files in that job's folder. She told the partner the old survey had been lost. The firm booked and carried out a fresh inspection at its own cost, then found the 2024 survey on the shared drive the following week.

The same week the firm's cloud file sync had a two-hour outage. The office manager's report to the partners blamed the sync for "emptying the folders".

## Witnesses

- **Morven Galbraith, office administrator.** Asked the assistant for the survey. Says it "looked in the right folder and said it was empty".
- **Dougie Paterson, IT lead.** Ran the rollout. Installed the connector on each machine from a checklist written after the pilot.
- **Catriona Reid, office manager.** Wrote the report blaming the sync outage.

## Evidence locker

| Exhibit | What it is |
|---|---|
| `trace.jsonl` | 252 events: 47 assistant sessions on five machines from 7 to 25 September 2026 (the pilot week, then the rollout), with every folder listing and file read, the device and the connector's granted folders on each session, the sync service's morning checks and its outage on 15 September. The first line is the header. |
| `locker/` | The longer answers, by SHA-256. `locker/INDEX.md` lists which events reference which blob. |

## The line-up

| Suspect id | Suspect | Description |
|---|---|---|
| `cloud-sync` | Cloud sync | The service that copies files between the office and the cloud. |
| `connector-permission` | The connector permission | What a desktop connector has been allowed to read. |
| `the-user` | The user | The person at the keyboard. |
| `model-update` | The model update | The provider moved the agent to a newer model version during the period in question. |
| `tool-schema` | The tool schema | The description and input schema the model is shown for a tool. |
| `prompt-change` | The prompt change | Someone edited the system prompt or the instructions the agent runs with. |
