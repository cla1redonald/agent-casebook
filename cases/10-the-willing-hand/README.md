# The Willing Hand

Case 10. Glenarrow Council Planning Desk.
Areas: AI SDLC; Business change; Compliance.

> Recording: **live**, on Claude Haiku 5.5 (`claude-haiku-5-5`), 12 October 2026. Every model reply is the live model's. The recording rig in `rigs/` scripts the session start times and simulates the services and the fault, on purpose. The trace header has the details.
>
> **A near miss.** In the incident as first written, the change was applied and objectors' email addresses were published. In three live takes the agent never made that change. Each time its question was dismissed, it declined to go on. The scene below is the near miss the live recording shows. The approval step failed the same way in every take.

## The scene

Glenarrow Council's planning digital team uses a coding agent. The agent proposes a change, may ask clarifying questions, and waits for a developer to approve each change before it is applied. The team adopted it in the summer and doubled its throughput.

On a Thursday in October the council's data protection officer, looking into an unrelated query, read the coding agent's log for that afternoon. At 15:12 the agent had been asked to make the public register export "include all the comment fields". Before proposing anything it had asked whether that should include objectors' names, email addresses and telephone numbers. The question was dismissed without an answer. That afternoon the same developer had approved 22 changes, each a fraction of a second after it was shown.

Nothing was published. Faced with an unanswered question about personal data, the agent declined to make the change and said why. The data protection officer's note to the head of service said the council had been lucky, and could not claim to have been careful.

The head of service's first conclusion was that the agent had been given too much freedom and should be restricted to suggestions only.

## Witnesses

- **Calum Dewar, lead developer.** Approved that afternoon's changes. Says he does not remember reading them, or seeing the question.
- **Elspeth Lusk, head of digital services.** Wants the agent restricted.
- **The council's data protection officer.** Found the near miss and wants to know what will stop it happening next time, when the agent is less careful.

## Evidence locker

| Exhibit | What it is |
|---|---|
| `trace.jsonl` | 323 events: 41 sessions, ten on Monday 5 October and 31 on Thursday 8 October, one per task. Every file read, every clarifying question and its answer, every proposed change and every approval, timed. The first line is the header. |
| `locker/` | The longer proposals and replies, by SHA-256. `locker/INDEX.md` lists which events reference which blob. |

## The line-up

| Suspect id | Suspect | Description |
|---|---|---|
| `model-autonomy` | The model's autonomy | How far the agent is allowed to act without asking. |
| `approval-step` | The approval step | The point where a person signs off the agent's work before it takes effect. |
| `the-user` | The user | The person at the keyboard. |
| `prompt-change` | The prompt change | Someone edited the system prompt or the instructions the agent runs with. |
| `model-update` | The model update | The provider moved the agent to a newer model version during the period in question. |
| `tool-schema` | The tool schema | The description and input schema the model is shown for a tool. |
