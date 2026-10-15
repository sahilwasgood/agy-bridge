# agy-bridge

OpenAI-compatible HTTP bridge over persistent `agy` workers, with multi-account quota rotation, tool calls, and vision.

## Give this to your AI agent

Copy-paste to set up the whole thing:

```text
Set up agy-bridge in ~/agy-bridge so I can use my Google Antigravity logins from opencode.

1. Clone https://github.com/sahilwasgood/agy-bridge to ~/agy-bridge. Bun and the `agy` CLI must be installed; I must already be logged in (verify with `agy models`).
2. `cp agy-bridge.example.json agy-bridge.json` and put a long random string in apiKey.
3. Run `bun server.js snapshot acc1` to save my current agy login. For each extra Google account: run `bun server.js onboard`, then ask me to run `agy` and log in, then run `bun server.js snapshot acc<N>`. One slot per Google account, never the same account twice.
4. Start the bridge durably (systemd user unit in agy-bridge.service.example, or the setsid fallback in the README). Verify `GET /v1/models` with the bearer key.
5. Add the `agy-local` provider to my opencode.json pointing at http://127.0.0.1:8766/v1 (wiring is in the README details section), one model entry per effort level. Restart opencode and verify with `opencode models agy-local`.
6. Run `bun test.js` (must be 12/12) and `./examples/quickstart.sh` with AGY_BRIDGE_KEY set (must end in DEMO-OK).

Never commit accounts/, agy-bridge.json, or usage logs. Report what works and what needs my manual action (only the Google OAuth clicks need me).
```

```mermaid
flowchart LR
    OC["opencode / any OpenAI client"] -->|POST /v1/chat/completions<br/>SSE + tools + images| B["agy-bridge :8766"]
    B -->|delta prompts| W1["worker · acc1<br/>agy stream-json"]
    B -->|delta prompts| W2["worker · acc2<br/>agy stream-json"]
    W1 --> G["Antigravity backend"]
    W2 --> G
    B -.->|quota poll · failover| Q["rotation<br/>health + 429 + reset-aware"]
```

![demo](assets/demo.gif)

```bash
git clone https://github.com/sahilwasgood/agy-bridge && cd agy-bridge
cp agy-bridge.example.json agy-bridge.json  # set apiKey
export AGY_BRIDGE_KEY=<apiKey>
./examples/quickstart.sh
```

Endpoints: `GET /v1/models`, `POST /v1/chat/completions` (SSE + tools + images), `GET /v1/quotas`.

<details>
<summary>Setup, wiring, design notes</summary>

Prereqs: [`agy` CLI](https://antigravity.google/download) logged in, [Bun](https://bun.sh) runtime.

```bash
bun server.js snapshot acc1        # saves CURRENT agy login into a slot
bun server.js onboard              # backs up live login, clears it
agy                                # log in as the next Google account
bun server.js snapshot acc2        # saved + quota-verified, picked up with no restart
```

One slot per login: never snapshot the same Google account twice (it would double-spend one quota thinking it's two people).

Opencode wiring:

```jsonc
"provider": { "agy-local": {
  "npm": "@ai-sdk/openai-compatible",
  "options": { "baseURL": "http://127.0.0.1:8766/v1", "apiKey": "<yours>" },
  "models": { "gemini-3.8-flash": {
    "limit": { "context": 239000, "output": 32000 }
  } } }
}}
```
(Register one entry per effort level (e.g. `gemini-3.8-flash-low`) if you want them as separate picker models. Note: opencode ≤2.0.29 does not resolve `#variant` suffixes on custom providers, so variants are documented here for newer versions only.)

The 239k context cap is deliberate: agy checkpoints trajectories at ~239,616 tokens regardless of model window; past it, history is silently truncated. The bridge errors cleanly instead (`/compact`, then retry).

Run durably:

```bash
# systemd user unit (see agy-bridge.service.example) or:
setsid bun server.js >bridge.log 2>&1 < /dev/null &
```

Design notes:

- **Keyring-global platforms** (desktop Linux/macOS/Windows): agy auth ignores `--gemini_dir`, so rotation uses credential **swap**: a slot's blob goes live only for spawn/quota-check seconds, restored in `finally` under a PID-checked file lock (self-heals stale locks, 120s cap instead of hanging forever).
- **Tool fidelity**: streamed `call_start` on name-parse, full args at block close; partial JSON is never emitted. Bare-JSON fallback requires known tool names.
- **Rotation**: health scores (70/+1/-10/-20, floor 50) + worst-family quota + LRU jitter; 429 locks till reset + failover with full re-prefill (trajectories don't transfer across logins); short retry-after retries same account once.
- **Tests**: `bun test.js`: pure-function suite, zero quota. Live paths verified against real agy (completion, tools, image, stream, quotas).

Related work: the worker protocol follows Anubisx404, the HTTP skin follows anyrobert, vision via temp files follows lojik-ng, rotation constants follow opencode-ag-auth, and the credential-swap pattern follows antigravity-swap. MIT, like all of them; credits in code comments.

</details>

MIT. Changes: [CHANGELOG.md](CHANGELOG.md). Releases via `v*` tags.
