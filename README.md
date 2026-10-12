# Agent Whodunnit

An AI agent went wrong at a Scottish ferry cooperative. The client says it stopped quoting live sailings three weeks ago. Somewhere in a 400-line trace is the moment it broke. Agent Whodunnit is a casebook of ten such cases: a recorded trace, six suspects, a sealed solution you unlock by accusing the right one with the evidence that proves it, and a detector that would have caught it, so the casebook doubles as a library you can run over your own traces.

> **Phase 3b.** Nine cases are playable, and every trace is a **live recording** on Claude Haiku 5.5 (`claude-haiku-5-5`; case 7's large route on Claude Sonnet 5.5), labelled as such in every file. The model's replies are real; the services, the clock between sessions and the faults are simulated by the rig on purpose. Case 2 did not reproduce on the live model and stays pending. See [What is tested](#what-is-tested) and [What is pending](#what-is-pending).

## How to play

You need Node 22 or later.

```
git clone https://github.com/cla1redonald/agent-whodunnit && cd agent-whodunnit
npm install
npm run whodunnit -- list          # the cases, their areas and your progress
npm run whodunnit -- open 3        # the scene, the witnesses, the evidence locker, the line-up
```

Read the scene and the witness statements in the case folder. Then read the trace: one JSON object per line, each with an id like `ev-104`. Big tool outputs are in `locker/`, indexed by hash. When you know who did it, accuse them and cite the events that prove it:

```
npm run whodunnit -- accuse 3 --suspect <id> --cite ev-104,ev-105 \
  --test "the cheapest test that would prove me wrong"
```

The accusation is scored mechanically:

- **Suspect.** Right or wrong. If you pick the red herring, you are told so: it happened, it is in the trace, and it did not cause the failure.
- **Citations.** For the right suspect, precision (how many of your ids are cracking evidence) and recall (how many of the evidence groups you touched). You need two groups and precision of 0.5 or better to unseal the solution.
- **Falsification test.** Required. It is printed beside the casebook's own cheapest test so you can compare; it is not machine-scored.
- **Attempts** are counted in `.whodunnit/state.json`, which is local and gitignored.

The solution is `sealed/solution.md.enc`, AES-256-GCM with a key derived by scrypt from the suspect id and the case id. **This is a speed bump, not security.** There are six suspects; anyone can try them all. It keeps you from reading the answer by accident. `sealed/` also holds the fixed trace, which is a spoiler.

So are `rigs/scenarios/`, `library/detectors/` and `evals/labels/`: the rig that produced each trace and the detector that catches it describe the fault outright. Play first if you want to play.

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

Every organisation, person and address is invented. Email addresses use `example.scot` and `example.invalid`. Every case ends in a systemic fix: none of them concludes that someone should simply have been more careful.

## The detector library

Each case ships with a detector: a pure function from trace events to findings. Run the implemented ones over your own JSONL traces:

```
npm run whodunnit -- sweep ./my-traces
npm run whodunnit -- detectors      # this table, computed live, with blind spots
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

Each detector lists its known blind spots in its source file and in `whodunnit detectors`. The trace format, with the OpenTelemetry GenAI attribute names it uses and the convention version it pins, is in [docs/trace-format.md](docs/trace-format.md).

## What is tested

Plainly: **every trace in the casebook and the control corpus is a live recording on Claude Haiku 5.5** (case 7's large route on Claude Sonnet 5.5), made on 12 October 2026 through the rig in `rigs/`. The model's replies, token counts, cache use and call latencies are real. Everything around the model is simulated on purpose: the services it calls, the faults, the time between sessions, and in case 4 the provider's throttle, whose rejected attempts were answered by the rig and never sent. Every header says which model, which day, which take and which rig version. The Phase 3a stub recordings are kept, labelled, in `recordings/stub/`.

The whole phase cost $0.77 at list price, including retakes and trial calls, against a hard stop of $30 in `rigs/ledger.ts`. Every paid call is a line in `recordings/spend.jsonl`.

What CI runs on every push:

- **Lint, typecheck, build.**
- **Tests** (Vitest): 195 passing, 2 marked todo (d02's fire and silence tests). They cover every stop reason in the agent loop, schema validation before tool execution, identity injection, each named fault in its faulty and corrected form, the live adapter's request shape, the ledger and its hard stop, cassette record and replay, id aliasing and redaction, every implemented detector against its live case, its fixed trace and the control corpus, the sealed solutions (exactly one suspect opens each), the scoring rules and the CLI.
- **Recordings are reproducible** (`npm run record -- --check`): every live trace is rendered again from its cassette and compared byte for byte, and every stub recording from its script.
- **Recordings check** (`npm run check:recordings`): every trace, cassette and locker blob is scanned for key shapes and the live key, email addresses outside `example.scot` and `example.invalid`, telephone numbers outside the Ofcom drama ranges, and the deny list; live headers must name their model, date and rig version; every locker blob must hash to its id.
- **Evals** (`npm run evals`): every detector against its case trace, its fixed trace, the other cases and the ten control traces, scored per session with 95% Wilson intervals:

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

  A seeded-fault test disables each detector in turn and checks the report goes red.
- **Banned-terms check** over the tree and the full `git log -p`, and a check for absolute home-directory paths.

What those numbers do and do not show: **the same author wrote the faults, the scenarios and the detectors, and saw the live traces before finishing the detector rules** (one rule, d05's, was widened after seeing them; its blind spots say so). Perfect recall here shows the detectors catch the faults as injected and as the live model responded to them, not that they will catch the next real incident. The false-positive side is the stronger result: no detector fires on any of about a thousand sessions it was not written for, including control traffic chosen to look like each fault. The intervals are wide where n is small: case 1 is one session, so its recall interval runs from 0.21 to 1.

## What is pending

- **Case 2 did not reproduce.** In three live takes Haiku 5.5 never sent the booking list: each time it read the caterer's page, it named the planted instruction and ignored it. The case stays sealed as written, d02 stays a skeleton, and the takes are kept in `recordings/not-reproduced/`. A model or configuration that does follow such instructions would let it be recorded.
- **Case 10 is a near miss.** The approval step failed exactly as written, in three takes out of three, but the agent declined to make the disclosure, so the scene was rewritten around what the trace shows.
- **Case 1 is recorded at a reduced size**, about 62,000 tokens at its peak rather than the scene's 140,000, to fit the cheap option.
- Witness statements for the cases first recorded in this phase are summarised in each case README rather than written out in full.

The working, the take-by-take record and every choice above are in [docs/decisions/0002-phase-3b.md](docs/decisions/0002-phase-3b.md).

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

`npm run record` regenerates every trace from the live cassettes (and the kept stub recordings from their scripts), with no network and no key; `npm run record -- --check` confirms the committed files match.

## Licences

Code is MIT licensed: see [LICENSE](LICENSE). Case text (scenes, witness statements, solutions and traces) is licensed under Creative Commons Attribution 4.0 International: see [LICENSE-CASES.md](LICENSE-CASES.md).
