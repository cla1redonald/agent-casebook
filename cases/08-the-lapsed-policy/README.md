# The Lapsed Policy

Case 08. Ardsallow and Fennach Ferry Cooperative.
Areas: Production and persistent agents; Compliance.

> Recording: **live**, on Claude Haiku 5.5 (`claude-haiku-5-5`), 12 October 2026. Every model reply is the live model's. The recording rig in `rigs/` scripts the session start times and simulates the services and the fault, on purpose. The trace header has the details.

## The scene

On 1 August the Ardsallow and Fennach Ferry Cooperative changed its cancellation terms for vehicle bookings. A full refund now needs 24 hours' notice instead of 48. The new terms went onto the website and into the document collection the sailings desk searches.

In late August a customer cancelled 30 hours before sailing, expecting no refund because the assistant had told her the cut-off was 48 hours. She found the new terms on the website afterwards and complained. The cooperative checked and found the assistant giving the old answer to some customers and the new answer to others, sometimes on the same day.

The cooperative's first thought was that the document collection had not been updated properly and still held the old terms somewhere.

## Witnesses

- **Morag Lindsay, operations manager.** Handled the complaint. Says the new terms were published "properly, the same day".
- **Iona Gemmell, customer services lead.** Uploaded the new terms to the assistant's documents and deleted the old file.
- **Ewan Baird, IT contractor.** Added a cache in front of the assistant in July to cut costs, "so the common questions don't hit the model every time".

## Evidence locker

| Exhibit | What it is |
|---|---|
| `trace.jsonl` | 240 events: 97 customer sessions from 15 July to 31 August 2026, each with its cache lookup (hit or miss, entry age, the policy version the entry was written under), and on a miss the document search and the model calls. The document collection's change on 1 August is in the trace as its own span. The first line is the header. |
| `locker/` | The longer answers, by SHA-256. `locker/INDEX.md` lists which events reference which blob. |

The cache's configuration is recorded on every lookup: whether the key includes the policy version, and the TTL if there is one.

## The line-up

| Suspect id | Suspect | Description |
|---|---|---|
| `knowledge-base` | The knowledge base | The documents the agent searches for answers. |
| `response-cache` | The response cache | A store of earlier answers that is consulted before the model is called. |
| `prompt-change` | The prompt change | Someone edited the system prompt or the instructions the agent runs with. |
| `model-update` | The model update | The provider moved the agent to a newer model version during the period in question. |
| `fallback-path` | The fallback path | Code that substitutes a backup source of data when the primary one fails. |
| `the-user` | The user | The person at the keyboard. |
