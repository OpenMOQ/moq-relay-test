# MOQ Interop Runner

## What This Test Does

Runs aiomoqt's MoQ interop client against a relay and executes the standard interop test set, emitting TAP v14 output.

This is a conformance-oriented interoperability test.

## Parameters Exposed In UI

| Parameter | Type | Required | Default | Notes |
|---|---|---:|---|---|
| relay_url | url | yes | (empty) | Relay endpoint URL |
| draft_version | select | no | 16 | Draft 14, 16, or 18 |
| transport | select | no | quic | `quic` or `wt` |
| auth_token | text | no | (empty) | Optional AUTH_TOKEN passed to client |

## How Invocation Works

Container image and command:

- Image: `ghcr.io/gmarzot/aiomoqt:0.10.6`
- Entrypoint: `/bin/sh -c`
- Command executes `python -m aiomoqt.examples.moq_interop_client` directly.

Arguments are passed in this order:

```text
{relay_url} {draft_version} {transport} {auth_token}
```

The shell command normalizes URL scheme based on transport before running the client:

- `transport=quic`: force `moqt://`
- `transport=wt`: force `https://`

Then it invokes:

```text
python -m aiomoqt.examples.moq_interop_client -r "<normalized-url>" --draft "<draft_version>" [--auth-token "<auth_token>"]
```

Notes:

- `--auth-token` is only included when a non-empty token is provided.
- Network mode is `host`.

## What Output Looks Like

The tool emits interop progress and TAP v14 lines, for example:

```text
[PASS] setup-only: SERVER_SETUP received with compatible version
TAP version 14
1..6
ok 1 - setup-only
ok 2 - announce-only
...
```

Renderer behavior:

- Parses TAP headers (`# target`, `# version`, `# date`, `# ended`).
- Parses TAP plan (`1..N`) and per-test `ok` / `not ok` lines.
- Parses YAML `message:` diagnostics and attaches them to each test row.
- Renders a live summary: total, passed, failed, skipped.

## Pass / Fail Criteria

Process-level pass:

- Container exit code is `0`.

Test-level interpretation:

- TAP `ok` entries are shown as PASS.
- TAP `not ok` entries are shown as FAIL.
- TAP `# SKIP` entries are shown as SKIP.
