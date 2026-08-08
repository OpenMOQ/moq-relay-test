# Adaptive Bitrate

## What This Test Does

Runs the adaptive bitrate benchmark against a relay and tracks how throughput and latency evolve while the sender adapts.

This is a performance/characterization test, not a strict protocol conformance test.

## Parameters Exposed In UI

| Parameter | Type | Required | Default | Notes |
|---|---|---:|---|---|
| relay_url | url | yes | (empty) | Relay endpoint URL |
| draft | select | no | 16 | Draft 16 or 14 |
| sub_mbps | number | no | 10 | Initial target bandwidth |
| step_mbps | number | no | 10 | Ramp step size |
| max_mbps | number | no | 10000 | Maximum bitrate cap |
| interval | number | no | 5 | Reporting interval (seconds) |
| duration | number | no | 60 | Hard wall-clock cap in seconds |

## How Invocation Works

Container image and entrypoint:

- Image: `ghcr.io/gmarzot/aiomoqt:0.8.2`
- Entrypoint: `python`
- Base command: `/app/aiomoqt/examples/adaptive_bench.py`

Arguments assembled by the runner:

```text
-r {relay_url} --draft {draft} --sub-mbps {sub_mbps} --step-mbps {step_mbps} --max-mbps {max_mbps} --interval {interval} -t {duration}
```

Notes:

- `duration` is passed directly to the tool as `-t/--duration`.
- Network mode is `host`.

## What Output Looks Like

Raw logs include adaptive benchmark table lines and connection/debug output.

Renderer behavior:

- Parses benchmark rows into:
	- target bandwidth
	- actual tx/rx bandwidth
	- mean and p90 latency
	- adaptation action phase
- Renders a live dual-axis chart (Mbps and ms).
- Shows summary text like:

```text
Peak: <value>Mbps (< <threshold>ms latency)
```

## Pass / Fail Criteria

UI run status:

- Run is considered successful when container exit code is `0`.

Metric interpretation:

- Use latency and throughput trends from chart/summary to evaluate quality.
- This tool does not enforce a strict performance threshold in the backend.

