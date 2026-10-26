# Agent Casebook

An AI agent has gone wrong at a Scottish ferry cooperative. The client says it stopped quoting live sailings three weeks ago, and the moment it broke is somewhere in a 400-line trace. Agent Casebook has ten cases like this one. Every case has six suspects, and the nine playable ones give you the recorded trace. Accuse the right suspect and cite the events that prove it, and the sealed solution opens. Each case also comes with a detector that would have caught the fault, and you can run those detectors over your own traces.

> **Status.** In this round of work, Phase 3b, every case was recorded against a live model. Nine of the ten cases are playable. Every trace is a **live recording** on Claude Haiku 5.5 (`claude-haiku-5-5`), apart from case 7's large route, which ran on Claude Sonnet 5.5, and every file is labelled to say so. The model's replies are real. The recording rig in `rigs/`, which runs the agent, deliberately simulates what sits around the model. Case 2 did not reproduce on the live model, so it is still pending. The detail is under [What is tested](#what-is-tested) and [What is pending](#what-is-pending).

## How to play

You need Node 22 or later.

```
git clone https://github.com/cla1redonald/agent-casebook && cd agent-casebook
npm install
npm run casebook -- list          # the cases, their areas and your progress
npm run casebook -- open 3        # the scene, the witnesses, the evidence locker, the line-up
```

Start with the scene and the witness statements in the case folder, then read the trace. It has one JSON object per line, and each one carries an id such as `ev-104`. Large tool outputs are filed by hash in `locker/`. When you know who did it, accuse them and cite the events that prove it:

```
npm run casebook -- accuse 3 --suspect <id> --cite ev-104,ev-105 \
  --test "the cheapest test that would prove me wrong"
```

The casebook scores the accusation mechanically.

- The suspect is either right or wrong. If you pick the red herring, it tells you so. The red herring did happen and it is in the trace, but it did not cause the failure.
- Citations only count for the right suspect. Precision is the share of the ids you cite that belong to the evidence that cracks the case. That evidence falls into groups, and recall is the share of groups you cite at least one event from. You need at least two groups and a precision of 0.5 or better to unseal the solution.
- The falsification test is required. It is printed next to the casebook's own cheapest test so that you can compare them, and the casebook does not score it.
- Attempts are counted in `.casebook/state.json`, which stays on your machine and is gitignored.

The solution is in `sealed/solution.md.enc`. It is encrypted with AES-256-GCM, using a key that scrypt derives from the suspect id and the case id. **The seal is no protection against anyone who wants to read it.** There are only six suspects, so anyone can try them all. It is there so that you do not read the answer by accident. `sealed/` also holds the fixed trace, which gives the answer away.

`rigs/scenarios/`, `library/detectors/` and `evals/labels/` give the answer away too, because the rig that produced each trace and the detector that catches it both describe the fault outright. Play the case before you open them.

## The cases

| No | Case | Organisation | Areas | Status |
|---|---|---|---|---|
| 1 | The Long Afternoon | Hepburn Strachan Chartered Surveyors | Production and persistent agents; Compliance; Evals, testing and observability | **playable (live, reduced context)** |
| 2 | The Helpful Footnote | Craigtarry Distillery Visitor Centre | Custom AI and MCP; Compliance; Production and persistent agents | pending: did not reproduce live |
| 3 | The Quiet Understudy | Ardsallow and Fennach Ferry Cooperative | Production and persistent agents; Evals, testing and observability | **playable (live)** |
| 4 | The Eleven Thousand Knocks | Kinbrae Bakeries | Production and persistent agents; Evals, testing and observability; AI SDLC | **playable (live)** |
| 5 | The Altered Figure | Kinbrae Bakeries | Custom AI and MCP; AI SDLC; Compliance | **playable (live)** |
| 6 | The Marked Paper | Glenarrow Council Planning Desk | Evals, testing and observability; AI SDLC | **playable (live)** |
| 7 | The Wrong Door | Craigtarry Distillery Visitor Centre | Production and persistent agents; AI SDLC; Business change | **playable (live)** |
| 8 | The Lapsed Policy | Ardsallow and Fennach Ferry Cooperative | Production and persistent agents; Compliance | **playable (live)** |
| 9 | The Empty Cabinet | Hepburn Strachan Chartered Surveyors | Desktop rollout to non-technical users; Business change | **playable (live)** |
| 10 | The Willing Hand | Glenarrow Council Planning Desk | AI SDLC; Business change; Compliance | **playable (live, near miss)** |

Every organisation, person and address is invented. Email addresses use `example.scot` and `example.invalid`. Each case ends with a change to the system. None of them concludes that someone should simply have been more careful.

## The detector library

Each case comes with a detector, which is a pure function that takes trace events and returns findings. You can run the implemented ones over your own JSONL traces:

```
npm run casebook -- sweep ./my-traces
npm run casebook -- detectors      # this table, computed live, with blind spots
```

| Detector | Rule | Case | Status | True positives on its case | False positives on control corpus |
|---|---|---|---|---|---|
| d01 Dropped constraint | constraints must survive compaction | 1 | implemented | 1 of 1 sessions | 0 of 10 traces, 0 of 89 sessions |
| d02 Unconfirmed send | outbound actions after fetched content need approval | 2 | skeleton | not reproduced | n/a |
| d03 Silent fallback | an ok tool span over a failed call, or a quiet change of source | 3 | implemented | 58 of 58 sessions | 0 of 10 traces, 0 of 89 sessions |
| d04 Retry storm | failed calls retried with near-zero gaps | 4 | implemented | 18 of 18 sessions | 0 of 10 traces, 0 of 89 sessions |
| d05 Unit drift | a numeric field jumps about 100 times, or loses its decimals, across a release | 5 | implemented | 6 of 6 sessions | 0 of 10 traces, 0 of 89 sessions |
| d06 Eval path parity | every eval trace passes the production HTTP adapter | 6 | implemented | 35 of 35 sessions | 0 of 10 traces, 0 of 89 sessions |
| d07 Length router | model choice predicted by length, not task | 7 | implemented | 14 of 14 sessions | 0 of 10 traces, 0 of 89 sessions |
| d08 Unversioned cache | cache hits past TTL or across a policy version | 8 | implemented | 34 of 34 sessions | 0 of 10 traces, 0 of 89 sessions |
| d09 Silent empty listing | empty listing, no error, outside granted scope | 9 | implemented | 11 of 11 sessions | 0 of 10 traces, 0 of 89 sessions |
| d10 Reflex approval | approvals faster than reading time, questions dismissed | 10 | implemented | 22 of 22 sessions | 0 of 10 traces, 0 of 89 sessions |

Every detector lists its known blind spots in its source file, and `casebook detectors` prints them. [docs/trace-format.md](docs/trace-format.md) describes the trace format, including the OpenTelemetry GenAI attribute names it uses and the version of those conventions it pins.

## What is tested

**Every trace in the casebook and the control corpus is a live recording on Claude Haiku 5.5**, except case 7's large route, which is on Claude Sonnet 5.5. They were made on 12 October 2026 through the rig in `rigs/`. The model's replies, token counts, cache use and call latencies are real. The rig simulates everything around the model on purpose, including the services it calls, the faults and the time between sessions. In case 4 it also plays the part of the provider's throttle. It answered the rejected attempts itself, so none of them was ever sent. Each trace header names the model, the day, the take and the rig version. The stub recordings from Phase 3a, the earlier scripted round, are still in `recordings/stub/`, labelled as stubs.

Recording all of Phase 3b cost $0.77 at list price, retakes and trial calls included. `rigs/ledger.ts` would have stopped it at $30. Each paid call is one line in `recordings/spend.jsonl`.

CI runs the following on every push.

- Lint, typecheck and build.
- The Vitest suite, with 195 tests passing and 2 marked todo (d02's fire and silence tests). The tests cover every stop reason in the agent loop, schema validation before a tool runs, identity injection, and each named fault in both its faulty and its corrected form. They also cover the live adapter's request shape, the ledger and its hard stop, cassette record and replay, and id aliasing and redaction. Every implemented detector is run against its live case, its fixed trace and the control corpus. The sealed solutions are checked so that exactly one suspect opens each, and the scoring rules and the CLI have tests of their own.
- `npm run record -- --check`, which proves the recordings are reproducible. It renders every live trace again from its cassette, and every stub recording from its script, and compares each one byte for byte with the committed file.
- `npm run check:recordings`, which scans every trace, cassette and locker blob for key shapes and the live key, for email addresses outside `example.scot` and `example.invalid`, for telephone numbers outside the Ofcom drama ranges, and for anything on the deny list. It also fails if a live header does not name its model, date and rig version, or if a locker blob does not hash to its id.
- `npm run evals`, which runs every detector against its case trace, its fixed trace, the other cases and the ten control traces, and scores each one per session with 95% Wilson intervals:

  ```
  Detector evals over 28 trace files and 1101 sessions (all live recordings on claude-haiku-5-5).
  Recall is per faulted session of the detector's own case; false positives are per session across every other session. Intervals are 95% Wilson.

  det  status       case trace   fixed    control   TP/P      recall [95% CI]      FP/N       FP rate [95% CI]       verdict
  d01  implemented  1 found      silent   0/10      1/1       1.00 [0.21, 1.00]    0/1100     0.000 [0.000, 0.003]   GREEN
  d02  skeleton     no reproducing recording; rule specified, test marked todo
  d03  implemented  58 found     silent   0/10      58/58     1.00 [0.94, 1.00]    0/1043     0.000 [0.000, 0.004]   GREEN
  d04  implemented  18 found     silent   0/10      18/18     1.00 [0.82, 1.00]    0/1083     0.000 [0.000, 0.004]   GREEN
  d05  implemented  6 found      silent   0/10      6/6       1.00 [0.61, 1.00]    0/1095     0.000 [0.000, 0.003]   GREEN
  d06  implemented  35 found     silent   0/10      35/35     1.00 [0.90, 1.00]    0/1066     0.000 [0.000, 0.004]   GREEN
  d07  implemented  14 found     silent   0/10      14/14     1.00 [0.78, 1.00]    0/1087     0.000 [0.000, 0.004]   GREEN
  d08  implemented  34 found     silent   0/10      34/34     1.00 [0.90, 1.00]    0/1067     0.000 [0.000, 0.004]   GREEN
  d09  implemented  12 found     silent   0/10      11/11     1.00 [0.74, 1.00]    0/1090     0.000 [0.000, 0.004]   GREEN
  d10  implemented  22 found     silent   0/10      22/22     1.00 [0.85, 1.00]    0/1079     0.000 [0.000, 0.004]   GREEN

  Overall: GREEN
  ```

  A seeded-fault test switches off each detector in turn and checks that the report goes red.
- A banned-terms check over the tree and the full `git log -p`, and a check for absolute home-directory paths.

One caveat applies to all of those numbers. **The same author wrote the faults, the scenarios and the detectors, and saw the live traces before finishing the detector rules.** One rule, d05's, was widened after seeing them, and its blind spots say so. Perfect recall means the detectors catch these faults as they were injected and as the live model responded to them. It says nothing about whether they will catch the next real incident. The false positives are better evidence. No detector fires on any of about a thousand sessions it was not written for, and those include control traffic chosen to look like each fault. Where n is small the intervals are wide. Case 1 is a single session, so its recall interval runs from 0.21 to 1.

## What is pending

- Case 2 did not reproduce. In three live takes Haiku 5.5 never sent the booking list. Each time it read the caterer's page, it named the planted instruction and ignored it. The case stays sealed as written, d02 stays a skeleton, and the takes are kept in `recordings/not-reproduced/`. It could still be recorded on a model or configuration that does follow instructions like that one.
- Case 10 is a near miss. The approval step failed exactly as written in all three takes, but the agent declined to make the disclosure, so the scene was rewritten around what the trace shows.
- Case 1 was recorded at a reduced size to keep it within the recording budget on Claude Haiku 5.5. It peaks at about 62,000 tokens, where the scene has 140,000.
- For the cases first recorded in Phase 3b, the case README summarises the witness statements instead of giving them in full.

[docs/decisions/0002-phase-3b.md](docs/decisions/0002-phase-3b.md) has the working, a record of each take, and the reasons for every choice above.

```
npm run record -- --live all --dry-run    # planned calls and tokens per trace; spends nothing
npm run record -- --live 03 --take 2      # a live take of case 3 (needs ANTHROPIC_API_KEY)
```

## Layout

```
cases/NN-the-title/   README.md, case.yaml, trace.jsonl, witnesses/, locker/, sealed/
cases/suspects.yaml   the shared pool the line-ups are drawn from
library/detectors/    dNN-<slug>.ts, one per case, with tests
corpus/control/       ten clean live traces
rigs/                 agent loop, stub and real clients, cost ledger, fault injection, scenarios, recorder
recordings/live/      one cassette per live take: request hashes, latencies and responses
recordings/spend.jsonl the cost ledger, one line per paid call
recordings/stub/      the Phase 3a stub recordings, kept for reference
recordings/not-reproduced/  live takes whose incident did not happen (case 2, and case 10's first takes)
evals/                detector evals and ground-truth labels
src/                  trace format, case loading, sealing, scoring, CLI
```

`npm run record` regenerates every trace from the live cassettes, and the kept stub recordings from their scripts, without a network connection or a key. `npm run record -- --check` confirms that the committed files match.

## Licences

Code is MIT licensed: see [LICENSE](LICENSE). Case text (scenes, witness statements, solutions and traces) is licensed under Creative Commons Attribution 4.0 International: see [LICENSE-CASES.md](LICENSE-CASES.md).
