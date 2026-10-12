# 0001: Phase 3a choices

Status: accepted, 11 October 2026.

Phase 3a builds everything that needs no paid model call. This record lists where the brief pulled in two directions and what was chosen.

## Contradictions in the brief

1. **The banned-terms list has to exist for CI to check it, and the list itself is banned.** The list is not in the repository in any form. `scripts/check-terms.ts` reads it from the `DENY_LIST` environment variable, which CI sets from a repository secret, and falls back to a gitignored `.denylist` file for local runs. An empty list fails the check, so a missing secret cannot let CI pass. The em dash and home-path checks are built in and constructed from character codes and parts, so the script does not contain those strings either. Sealed solutions are stored as hex rather than base64, because base64 could spell a short denied term by chance and hex, with only the letters a to f, cannot spell any of them.
2. **Several banned terms occur inside common English words** (a past tense, two plurals, and a preposition followed by a digit). The check is a case-insensitive substring match, the same as `grep -i`, which is stricter than a word match. The copy avoids the longer words rather than weakening the check.
3. **`case.yaml` is meant to list the red herring, but a plain red herring hands the reader a free elimination.** It is stored as a salted SHA-256 hash, like the verdict. The CLI can still tell a reader they accused the red herring.
4. **The brief names `http.status`; OpenTelemetry names it `http.response.status_code`.** The trace uses `http.status` as asked and `docs/trace-format.md` records the mapping.
5. **The fixed trace is needed for every detector test but would spoil the case if left beside the incident trace.** It lives at `cases/NN/sealed/trace.fixed.jsonl`. It is not encrypted; `sealed/` is the folder readers are asked not to open.
6. **"A failing-until-implemented test marked todo."** Vitest's `it.todo` accepts a body without running it. Each skeleton's test has the real assertions in a todo body, and a passing test that pins the skeleton status, so implementing a detector means deleting `.todo` and the status test together.
7. **The commit trailer.** The brief asked for a co-author trailer naming a different model from the one that wrote these commits. The commits carry a trailer naming the model that did the work.

## Choices the brief left open

- **Scoring.** The cracking evidence for a case is a set of groups of equivalent event ids (for example, every 503 beneath an ok tool span is one group). Recall is groups touched over groups; precision is cited ids that fall in any group over cited ids. A correct accusation needs the right suspect, at least two groups, and precision of 0.5 or better. Citations are only scored against the right suspect, because the cracking groups are inside the sealed file. `--test` is required (15 characters or more) and echoed beside the casebook's own cheapest test; it is not machine-scored.
- **Where the answers live.** Plaintext solutions are authored in `authoring/`, which is gitignored. The sealed files are the only committed copy. `npm run unseal -- <case> <suspect>` recovers one. Tests check that exactly one suspect opens each sealed file without the test code naming any answer.
- **Spoilers.** `rigs/scenarios/`, `library/detectors/` and `evals/labels/` describe the faults directly. The README says so. The casebook is a game for readers who choose to play it and a library for everyone else.
- **Pending cases.** Cases 1, 2, 4, 5 and 7 to 10 have a scene, witnesses, planned exhibits, a line-up, a red herring and sealed cracking evidence written as planned descriptions (no event ids yet). `whodunnit accuse` refuses them until they have a trace.
- **Evals score per session, not per file.** Each recorded case trace carries ground truth from the rig (`evals/labels/`): which sessions the fault shaped. Every other session in the corpus is a negative, including the other case's sessions. This gives n large enough for a Wilson interval to mean something, though it is still the same author's faults and detectors. The README says so plainly.
- **Input previews.** OpenTelemetry's `gen_ai.input.messages` is opt-in and structured. The rig records a 220-character `input.preview` attribute on `invoke_agent` spans so a reader can see what was asked without storing whole conversations.
- **Dependencies.** Beyond the brief's `@anthropic-ai/sdk` and `zod`: `yaml` to read `case.yaml` and solution front matter, and `tsx` (dev only) to run TypeScript scripts. Scripts use `node --import tsx` rather than the `tsx` binary, which opens an IPC socket that some sandboxes refuse.
- **The model id.** Scripts stand in for `claude-sonnet-5-5`, priced at $2 per million input tokens and $10 per million output tokens. Phase 3b should confirm the exact model id before recording.
- **The SDK's own retries** are switched off in the real adapter (`maxRetries: 0`) so the rig's retry policy is the only one and every attempt is traced. Case 4 will switch them back on deliberately.

## Phase 3b cost estimate

Stub token counts understate live ones because the stub's system prompts and tool schemas are short. The estimate assumes an ordinary live call is 3,000 input and 250 output tokens ($0.0085 at $2 and $10 per million).

| Item | Calls | Assumption | Estimate |
|---|---|---|---|
| Cases 3 and 6, incident and fixed | 661 | ordinary calls | $5.60 |
| Control corpus, ten traces | 203 | ordinary calls | $1.70 |
| Cases 2, 5, 7, 8, 9, 10, incident and fixed | about 1,800 | about 300 per case | $15.30 |
| Case 1, long-context compaction | about 120 | 80,000 input, 400 output | $19.70 |
| Case 4, retry storm | about 600 billed | 8,000 input, 300 output; the storm's rejected attempts are injected locally and never reach the provider | $11.40 |
| **One full pass** | | | **about $54** |
| **Budget with three takes per recording** | | | **about $160** |

No prompt caching is assumed; caching the system prompt and tool schemas would cut the input share substantially.

## Addendum: the licence text

The standard MIT licence text contains one denied term, in the line granting the right to let others use the software. A licence should not be reworded, so the check exempts that one exact line and nothing else. The script stores only the SHA-256 of the trimmed, lower-cased line, not the line or any reversible encoding of it. Any other occurrence anywhere, including elsewhere in `LICENSE`, still fails the build.

## Addendum: history

An earlier draft kept the list in the script, hex-encoded. That is reversible in seconds, so it would have published the terms the check exists to keep out. The list moved to a secret and the repository history was squashed to one commit before anything was published.
