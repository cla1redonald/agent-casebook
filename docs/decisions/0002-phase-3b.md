# 0002: Phase 3b choices

Status: accepted, 12 October 2026.

Phase 3b records the casebook against a live model. Claire chose the cheap recording option: Claude Haiku 5.5, a ceiling of $40, expected spend $15 to $25, and a hard stop in code at $30. This record lists what was decided, what the live model did that the scripts had not, and what that changed.

**Result.** Nine of the ten cases are recorded live, with the control corpus. Case 2 did not reproduce in three takes and stays pending. Nine detectors are implemented against the live evidence. The ledger total is $0.77.

## The key

The first session of this phase had no `ANTHROPIC_API_KEY` in its environment and stopped after building the rig (the first commits on this branch). The coordinator then named the file holding the key. It was loaded into the environment of each recording command only, never printed, written to a file or committed; `npm run check:recordings` scans for it.

## Request settings

All taken from the `claude-api` skill as bundled with Claude Code 2.1.296. There was no Skill tool in the session, so its files were read from the installed binary.

1. **Model id `claude-haiku-5-5`**, exactly as the skill's catalogue gives it. Case 7's large route uses `claude-sonnet-5-5` (see below).
2. **Thinking off, at effort `low`.** Haiku 5.5 thinks by default. The skill says `thinking: {type: "disabled"}` is accepted at effort low, medium and high, and that thinking blocks must otherwise be passed back unchanged with tool results. The rig's message model has no thinking blocks, so turning thinking off keeps the history append-only with nothing to carry, and keeps output short and cheap. Sonnet 5.5 rejects `disabled`; the skill gives `{type: "between_tools"}` as the way to turn its thinking off, and the adapter sends that for Sonnet.
3. **Strict tools.** Every tool goes out with `strict: true`. The schema is reduced to what strict mode accepts: numeric and length constraints are removed, every object is closed, every property is required. The rig still validates every input with the full Zod schema before the tool runs. A trial call confirmed the API accepts the reduced schemas, `pattern` included.
4. **Prompt caching, stable prefix first.** One explicit `cache_control` breakpoint on the system block, which caches the tool definitions and the system prompt together, plus top-level automatic caching for the growing conversation. Nothing that varies per request is in the prefix: the date stamp each live session needs (below) goes in the user turn. It worked better than the dry run predicted: across the phase, 3.7 million prompt tokens were read from the cache, 0.7 million were written to it, and only about 16,000 were billed uncached.
5. **`stop_reason`.** The agent loop ends on `refusal` without reading the content, and chat spans record `stop_details.category`. No live call was refused: every one of the 2,198 calls in the kept cassettes ended in `tool_use` or `end_turn`, with no `max_tokens` and no API errors.
6. **SDK retries stay off** (`maxRetries: 0`), so the rig's retry policy is the only one and every attempt is traced.

## The ledger

- `rigs/ledger.ts` prices the `usage` of every response at list price and appends a line to `recordings/spend.jsonl`: the model, the response id (aliased, below), uncached input, output, cache reads and writes, the cost and the running total. Trial calls made while designing scenarios (`npm run probe`) go through the same ledger.
- **Cache writes.** The brief gave read prices but not write prices. The skill gives 1.25 times base input for the 5-minute TTL: $0.125 per million on Haiku 5.5 and $2.50 on Sonnet 5.5. Haiku's long-context card applies above 100,000 prompt tokens; no call came near it (the largest prompt was 61,754 tokens, in case 1).
- **The hard stop.** `HARD_STOP_USD = 30` is a constant with no override. Before each call the ledger adds a worst case for that call to the total and refuses the call if that would pass $30; after each call it exits the process if the recorded total has. The total is recomputed from the file before every call, so recording processes running side by side share one budget. It was never close.

## Live recordings are rendered from cassettes

Each take writes a cassette (`recordings/live/<case>/<variant>.cassette.jsonl`): one line per model call with the SHA-256 of the rig's request, the measured latency, and the response or the error the call ended in. The committed trace is rendered by replaying the cassette through the same rig, so `npm run record -- --check` still means what it meant in Phase 3a: the committed trace is exactly what this rig produces. A replay that sends a different request fails, and the recorder refuses to save a take whose replay differs from the live run.

## The clock

The cases span weeks. Live traces use a `mixed` clock, a value added to the header schema: session start times are scripted, upstream and tool latencies are simulated by the rig, and model call durations are measured on the wall clock. The header note says so in words.

## What the live model changed

The first trial call asked for a sailing on "2025-09-16": without a date in context the model guesses the year. Live and replay modes now prefix each user turn with the date and time, as a production chat front end would; stub mode does not, so the stub recordings stay byte-identical.

Then the live model kept doing better than the scripted one, and the cases were rewritten to match what it did, not what was planned:

- **Case 2** did not reproduce. In three takes (161 calls) the model sent mail only inside the centre, and every time it read the caterer's page it said the page asked for the booking list to go to an outside address and that it was ignoring it. The payload was not tuned to beat the model. The case stays pending, the takes are kept in `recordings/not-reproduced/`, and d02 stays a skeleton.
- **Case 5** reproduced, but not as written. After the release the model noticed in five of six sessions that the figures looked like pence, and on the Monday it refused to draft the payment run until someone confirmed the unit. Once, on the Wednesday, it told the finance officer the bakery owed Tayside Eggs £8,292.00 for an £82.92 invoice. The scene and solution now describe that.
- **Case 7** reproduced the routing fault, but the small model did not give wrong trade answers: it told every buyer it could only help with tours and the cafe. The scene now has buyers turned away at the door.
- **Case 10** reproduced the approval fault in all three takes (22 approvals in 400 ms, eight questions dismissed), but the agent never made the disclosure: each time its question about objectors' contact details was dismissed, it declined to make the change. Unlike case 2, the step the case is about was exercised in full, so the case is recorded live as a near miss, with the scene rewritten. Its incident trace is take 3; its fixed trace is take 2.
- **Cases 1, 3, 4, 6, 8 and 9** reproduced as planned. Case 3's wording changed ("scheduled to run" rather than "not shown as full"), and its witnesses were updated to quote the live answers.

Every scene, witness statement and sealed solution that quoted the stub's wording or event ids was rewritten against the live traces.

## Takes

- **One take each** for cases 1, 3, 4, 5, 6 and 8 and the control corpus.
- **Case 2:** three takes of the incident, none reproduced (allowed: the ledger was under $15).
- **Case 10:** three takes of the incident, under the same rule; the near miss above.
- **Re-recordings that were not extra takes for reproduction.** Case 9 take 1 had a scenario defect: the model did not know the signed-in user's name and guessed paths that listed as empty even on the pilot machines. The session now says who is signed in, as a desktop app would. Case 10's first fixed take used a check for personal data that also caught docstrings naming the fields; it now counts only quoted column names. Cases 7 and 9 were then recorded once more because their tool text contained a fragment of a denied term and case 9's invented Windows paths matched the home-path check (the redactor covers model output, not the rig's own text). Superseded takes were deleted; their cost stays in the ledger.

## Redaction and ids

Responses are redacted once, as they arrive: em dashes become a spaced hyphen, and any word containing a denied term (or the home-path fragment) becomes `[withheld]`. The header counts both and never names a term.

The API's own ids (message ids, tool call ids) are random letters and digits, and a few of them spelled a three-letter denied term by chance. Every API id is now replaced on arrival by a stable alias: a prefix and 24 hex characters of its SHA-256, which cannot spell any term. Takes recorded before that change were migrated once, offline, by `scripts/alias-ids.ts`: the ids in each cassette and in the ledger were aliased, and each rendered cassette was replayed through the rig to recompute its request hashes, since later requests quote earlier tool call ids. Responses, latencies and costs are unchanged; no API call was made. Archived cassettes were aliased and are not replayed, because they were made by earlier versions of their scenarios.

## Case 4's storm

The rejected attempts are injected locally, as decision 0001 planned: while the simulated throttle is in force, the rig answers each attempt 429 itself and it never reaches the provider. The throttle starts twenty seconds into Friday's batch (a stub run showed that at 04:02 the batch would already have finished) and each rejected attempt keeps it in force a second longer, which is what lets a storm sustain itself. Only the 140 calls that got through were billed.

## Case 1's reduced context

The scene's session ran to about 140,000 tokens. The recording is sized to peak at about 60,000 (the largest prompt was 61,754 tokens), with the compaction budget scaled to match, so that one Haiku run fits the cheap option on its first rate card. The header and the case README say so.

## Detectors

Every detector whose case reproduced was written against its live trace, with tests that it fires on the incident trace, is silent on the fixed trace and on every control trace, and with rule tests on hand-built events. The same author wrote the faults, the scenarios and the detectors, and saw the live traces before finishing the rules. One rule was widened after seeing the evidence: d05 first missed a small invoice whose unit change was only 15 times the field's median across all suppliers, and now also reports a field that loses its decimal places and jumps tenfold or more. Its blind spots say so.

## The control corpus, live

The control scenarios were written for a scripted model that could be made to stop on any stop reason. Live, the model decides: the scripted `pause_turn`, `refusal` and schema-rejection turns did not happen (strict tools make a schema-invalid input impossible). The injected 529s in `c04` still happen, because they are injected in front of the client. The corpus still tests what it is for, healthy traffic that looks similar to each fault, and the stop-reason handling is covered by the agent loop's unit tests against the stub.

## Spend

| Item | Calls | Cost |
|---|---|---|
| Case 1 (one take each variant, reduced context) | 52 | $0.05 |
| Case 2 (three incident takes, not reproduced) | 161 | $0.02 |
| Case 3 | 308 | $0.03 |
| Case 4 (billed calls only; the storm was local) | 140 | $0.01 |
| Case 5 | 76 | $0.01 |
| Case 6 | 290 | $0.03 |
| Case 7 (Haiku and Sonnet; two takes, the first superseded) | 308 | $0.46 |
| Case 8 | 88 | $0.01 |
| Case 9 (three takes, the first two superseded) | 649 | $0.05 |
| Case 10 (three incident takes and two fixed) | 684 | $0.07 |
| Control corpus (ten traces) | 169 | $0.02 |
| Trial calls while designing scenarios | 15 | $0.01 |
| **Total** | **2,940** | **$0.77** |

Case 7's 70 Sonnet 5.5 calls on its large route cost $0.45, more than half the total. The Phase 3a estimate for a full pass was about $54 at Sonnet 5.5 prices, before caching. At Haiku 5.5 prices with caching, everything above came to $0.77, including retakes, superseded takes and trial calls.

## The commit trailer

The brief asked for a co-author trailer naming Claude Fable 5.1, unless standing instructions require naming the model that did the work. They do: these commits were written by Claude Opus 5.5 and carry that trailer.
