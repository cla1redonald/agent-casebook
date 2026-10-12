# Evidence locker index

Tool outputs longer than 400 characters are stored here by SHA-256 of their exact text (the file is that text, pretty-printed).
Each row lists the events in `trace.jsonl` that reference the blob.

| Blob | Referenced by | Span |
|---|---|---|
| `7ef2d4a7e880` | ev-003, ev-004, ev-010, ev-011, ev-025, ev-026, ev-030, ev-031 | execute_tool get_invoices |
| `fb3be91b9143` | ev-005 | chat claude-haiku-5-5 |
| `73907b23e61c` | ev-033, ev-039 | invoke_agent payments-assistant |
| `8d2f65fb4dab` | ev-035, ev-036, ev-042, ev-043, ev-047, ev-048, ev-052, ev-053, ev-057, ev-058 | execute_tool get_invoices |
| `736234ddb649` | ev-037 | chat claude-haiku-5-5 |
| `bd0fd396e58f` | ev-065, ev-069 | invoke_agent payments-assistant |
| `03cd28a0a0d3` | ev-067, ev-068, ev-072, ev-073, ev-077, ev-078, ev-087, ev-088 | execute_tool get_invoices |
| `7146176d8e1d` | ev-070, ev-074 | invoke_agent payments-assistant |
| `42d2d35597c8` | ev-075, ev-079 | invoke_agent payments-assistant |
| `96b342ffb71a` | ev-085, ev-089 | invoke_agent payments-assistant |
| `c44a6f6d0987` | ev-090, ev-094 | invoke_agent payments-assistant |
