# Changelog

Releases are cut by pushing a `v*` tag; notes are auto-generated on the
[releases page](https://github.com/sahilwasgood/agy-bridge/releases).
This file tracks user-visible changes between releases.

## [Unreleased]
- Demo GIF (`assets/demo.gif`) + `examples/quickstart.sh`; README demo section
- Issue templates (bug/feature) + security contact; `release.yml` tag automation
- Systemd unit owns the port (stale manual servers removed); quickstart uses
  a fresh `user` session key so the demo answers DEMO-OK

## [1.0.0] - 2026-10-14
- OpenAI-compatible `POST /v1/chat/completions` (SSE + non-stream) over
  persistent `agy stream-json` workers with delta-only prompts
- Multi-account health + quota rotation (70/+1/−10/−20, 70% safety buffer,
  lock-till-reset, 429 failover, short-retry same account)
- Credential-swap auth isolation for keyring-global platforms
- Tool calls via `<tool_call>` text protocol with streamed start/end events
- Vision (`image_url` data:/http:) via temp files; `GET /v1/models` (live),
  `GET /v1/quotas`, per-turn usage ledger (`/v1/stats`)
- 239k trajectory guard; `bun test.js` suite (12 tests, zero quota)
