# Trace format: casebook-trace/1

A trace is a JSONL file with one JSON object per line. The first line is a header. Every other line is one span, written when the span ends and ordered by when it started, so a session reads from top to bottom.

The schema is enforced in `src/trace/schema.ts`. `casebook sweep` accepts files without a header, so you can point it at your own traces as long as the event lines follow the shape below.

## Convention version

Where a convention exists, attribute names follow the **OpenTelemetry semantic conventions, version 1.37.0**, for generative AI, HTTP and errors. When this was written the GenAI conventions were marked **Development** upstream, so their names can still change. If they do, this format will pin the new version and move to `casebook-trace/2`. It will never rename a field quietly.

## Header line

| Field | Meaning |
|---|---|
| `kind` | Always `"header"`. |
| `format` | `"casebook-trace/1"`. |
| `semconv` | `{ name, version, status }` of the conventions above. |
| `case` | Case folder id, or `control/<name>` for the control corpus. |
| `variant` | `incident`, `fixed` or `control`. |
| `recording` | `stub` or `live`. |
| `model` | The model id for live recordings, for example `claude-haiku-5-5`. For stub recordings, says which model the script stands in for. |
| `recorded_on` | Date of the recording. For stub recordings it is fixed, so that recording them again is byte-identical. For live ones it is the day of the take. |
| `rig_version` | Version of `rigs/` that produced the file. |
| `clock` | `simulated` (stub), `wall`, or `mixed`. Live recordings from the rig are `mixed`. Their session start times are scripted and their upstream and tool latencies are simulated, but model call durations are measured on the wall clock. |
| `epoch` | ISO timestamp that `t_ms` counts from. |
| `cost_basis` | How `cost_usd` was computed. For stubs it is notional, because no paid call was made. For live recordings it is the list price, worked out from the response's `usage`. |
| `redactions` | What was removed or replaced, and how. Live recordings also count the em dashes and deny-list words replaced in model output. |
| `note` | A label in plain words. Stub recordings start `STUB RECORDING.`, and live recordings start `LIVE RECORDING.` and give the take number. |

## Event lines

| Field | Source | Meaning |
|---|---|---|
| `ev` | this format | Event id, `ev-001` upwards in line order. Accusations cite these. |
| `t_ms` | this format | Start time, milliseconds after the header's `epoch`. |
| `duration_ms` | this format | Span duration in milliseconds. |
| `trace_id`, `span_id`, `parent_span_id` | OpenTelemetry | One `trace_id` per session or request. Pair a tool span with the HTTP call beneath it through `parent_span_id`. |
| `name` | OpenTelemetry | Span name, for example `chat claude-sonnet-5-5`, `execute_tool check_sailings`, `POST /v1/ask`. |
| `span.kind` | OpenTelemetry | `internal`, `client` or `server`. |
| `gen_ai.operation.name` | GenAI semconv | `chat`, `execute_tool` or `invoke_agent`. |
| `gen_ai.provider.name` | GenAI semconv | `stub` for stub recordings, `anthropic` for live ones. |
| `gen_ai.agent.name` | GenAI semconv | The agent's name. |
| `gen_ai.request.model`, `gen_ai.response.model` | GenAI semconv | Requested and answering model. Stub responses name themselves `stub/<model>`. |
| `gen_ai.response.finish_reasons` | GenAI semconv | The stop reason, for example `["tool_use"]`. |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | GenAI semconv | Token counts. Stub counts are estimates (four characters per token). Live counts are the provider's own, and `input_tokens` counts only the uncached part. |
| `gen_ai.tool.name`, `gen_ai.tool.call.id` | GenAI semconv | On `execute_tool` spans. |
| `deployment.environment.name` | Resource semconv | `production`, `eval` and so on. |
| `http.request.method`, `http.route`, `url.full`, `http.request.body.size` | HTTP semconv | On HTTP client and server spans. |
| `http.status` | this format | HTTP status code. The semconv name is `http.response.status_code`; this format uses the shorter name and maps to it on export. |
| `error.type` | semconv | Present when the span ended in error. Absent means the span claimed success. |
| `cost_usd` | this format | Cost of a `chat` call. It is notional on stub recordings. On live ones it is the list price, including cache reads and writes. |
| `source` | this format | Where a tool's data came from, for example `live`, `snapshot`, `register`. |
| `attributes` | this format | Other attributes, such as `prompt.version`, `input.preview`, `http.request.header_names`, `eval.passed`. Header names are recorded, but their values never are. Live `chat` spans add `anthropic.usage.cache_read_input_tokens` and `anthropic.usage.cache_creation_input_tokens`, and `stop_details.category` on a refusal. |
| `preview` | this format | Up to 220 characters of the span's output. |
| `locker` | this format | `sha256:<hex>` of the full output when it is longer than 400 characters. The blob is `locker/<hex>.json` in the case folder. |

## Evidence locker

Large tool outputs live in `locker/` as `<sha256 of the exact text>.json`, pretty-printed when the text is JSON. `locker/INDEX.md` lists which events reference each blob. Identical outputs share one blob.

## Stub and live recordings

`rigs/` produces a stub recording with a scripted model (`rigs/stub.ts`), whose replies are keyed by turn, and a simulated clock. The result is deterministic, so `npm run record -- --check` and `rigs/rig.test.ts` can record it again and compare byte for byte. Stub recordings are labelled in the header, in `gen_ai.provider.name` and in `gen_ai.response.model`.

A live recording uses the real SDK adapter in `rigs/anthropic.ts` behind the cost ledger (`rigs/ledger.ts`), and says `live` in the same places. Each take also writes a cassette to `recordings/live/<case>/<variant>.cassette.jsonl`. It holds the hash of every request the rig sent, the measured latency and the response that came back. The committed trace is rendered by replaying the cassette through the same rig. That way `npm run record -- --check` can still prove, byte for byte and with no key and no spend, that the trace is what the rig produced. If a replay sends different requests from the recorded ones, it fails.

A call that ended in an API error is kept in the cassette as an error, so the replay fails at the same point. Ids the API issued, such as message ids and `gen_ai.tool.call.id`, are swapped on arrival for an alias made of a prefix and 24 hex characters of the id's SHA-256, so that a random id can never spell a denied term.

When a case has been recorded live, its stub recording moves to `recordings/stub/` for reference, labelled as such.
