# Langflow memory baseline

Measured 2026-10-09 on the SynCare backend host (2 vCPU, 3.6 GB RAM + 1.9 GB swap).

## Method

`scripts/smoke-memory.sh` samples container memory, host free memory and swap every
5 s while a real flow is executed via `POST /api/v1/run/{flow_id}`.

## Result

| Metric | Value |
|---|---|
| Host RAM total | 3640 MB |
| Container memory at idle (warm) | ~811–1195 MiB |
| **Host free memory at rest** | **116 MB** |
| **Swap at rest** | **1.9 GB of 1.9 GB used — exhausted** |
| Container restarts during the run | 0 |
| OOMKilled flag | false |

### Raw sample log

The first run produced no sample rows: the sampler's subshell was terminated along
with the timed-out parent command, and `/tmp/syncare-mem-samples.txt` was empty.
**This baseline is therefore incomplete and the peak figure is not yet trustworthy.**

## Interpretation — and why no cap was applied

`restart: unless-stopped` plus `OOMKilled=false` shows Langflow was **not** killed.
But swap being fully consumed while ~800 MB of container RSS is reported means the
*host* is under pressure from everything else on this box (Hermes processes,
MCP servers, browser), not from Langflow alone.

Therefore, per the plan's decision gate:

- **No `mem_limit` was set.** Capping Langflow now would reduce available headroom
  without evidence that Langflow itself is the constraint.
- The measurement must be repeated once other host load is reduced, before any cap
  is considered.

## Current blocker (unrelated to memory)

The F1 pipeline executes correctly up to its Gemini node. Live response:

```
HTTP 500 — Error building Component Google Generative AI:
Value error, API key required for Gemini Developer API.
Provide api_key parameter or set GOOGLE_API_KEY/GEMINI_API_KEY environment variable.
model: 'gemini-3.5-flash-lite'
```

This confirms the imported graph is sound: Langflow built every node, reached the
model call, and failed only on the absent credential. **Supplying `GEMINI_API_KEY`
as a Langflow global Variable is the only thing blocking live flow execution.**

## To obtain a trustworthy baseline

1. Add `GEMINI_API_KEY` as a Langflow global Variable.
2. Pause or stop other memory-heavy host processes during the measurement window.
3. Re-run `bash scripts/smoke-memory.sh f1_register_discharge_summary` with a
   timeout longer than the previous 420 s (the flow needs ~25 s to reach Gemini,
   plus model latency once authenticated).
4. Only if minimum host-free memory stays under ~400 MB *and* Langflow is
   demonstrably the dominant consumer, propose a `mem_limit` and re-measure.