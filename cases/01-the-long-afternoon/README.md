# The Long Afternoon

Case 01. Hepburn Strachan Chartered Surveyors.
Areas: Production and persistent agents; Compliance; Evals, testing and observability.

> Recording: **live**, on Claude Haiku 5.5 (`claude-haiku-5-5`), 12 October 2026. Every model reply is the live model's. The recording rig in `rigs/` scripts the session start times and simulates the services and the fault, on purpose. The trace header has the details.
>
> **Reduced context.** The session in the scene ran to about 140,000 tokens. To keep it within the recording budget on Claude Haiku 5.5, this recording was made smaller. It peaks at about 62,000 tokens (the largest prompt in the trace is 61,754), and the compaction budget was scaled down to match. The trace header says so too.

## The scene

Hepburn Strachan is a firm of chartered surveyors with three offices. In the spring it gave its residential team a drafting assistant that stays open all day on one job, in one long conversation. The surveyor pastes the client's instruction letter at the start of the day, then works through the report section by section.

Every instruction letter for a condition survey carries the same standing line, which says the report must not state a market value, because valuations are issued separately and signed by a registered valuer.

On a Wednesday in October a client telephoned to ask why the summary of their condition report gave the sale prices of two neighbouring houses, £238,000 and £251,500, as "a reference point" when they had been told the survey did not include a valuation. The figures appeared in the summary section, drafted at half past three. The morning's sections had no figure in them. A junior surveyor had sent the draft to the client for comment without noticing.

The provider had moved the firm to a newer model version on the Tuesday. The partner's first message to the IT lead was "Has the new model started making up valuations?"

## Witnesses

- **Alasdair Hepburn, partner.** Responsible for the firm's professional standards. Wants to know whether to switch the assistant off.
- **Kirsty Muir, assistant surveyor.** Drafted the report with the assistant and sent the draft. Says she pasted the instruction letter first thing, as always.
- **Dougie Paterson, IT lead.** Confirms the model version change on Tuesday and that the assistant "manages its own memory" in long sessions.

## Evidence locker

| Exhibit | What it is |
|---|---|
| `trace.jsonl` | 53 events: one drafting session on Wednesday 7 October 2026, from the instruction letter at 08:45 to the summary at 15:30. Every model call, with its token counts and cache reads, every read of the site notes, and the assistant's housekeeping spans. The first line is the header. |
| `locker/` | The site notes as the assistant read them, the longer drafts, and the summary the assistant made of its own conversation. `locker/INDEX.md` lists which events reference which blob. |

The instruction letter is the first user turn, and its standing lines start `Constraint:`. Every chat span names the model that answered it. The Tuesday session, before the version change, is not in the trace.

## The line-up

| Suspect id | Suspect | Description |
|---|---|---|
| `compaction` | The context compaction | The step that summarises a long conversation so it fits in the context window. |
| `model-update` | The model update | The provider moved the agent to a newer model version during the period in question. |
| `prompt-change` | The prompt change | Someone edited the system prompt or the instructions the agent runs with. |
| `knowledge-base` | The knowledge base | The documents the agent searches for answers. |
| `response-cache` | The response cache | A store of earlier answers that is consulted before the model is called. |
| `the-user` | The user | The person at the keyboard. |
