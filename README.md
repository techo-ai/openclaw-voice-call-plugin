# @openclaw/voice-call

Official Voice Call plugin for **OpenClaw**.

Providers:

- **Twilio** (Programmable Voice + Media Streams)
- **Telnyx** (Call Control v2)
- **Plivo** (Voice API + XML transfer + GetInput speech)
- **Asterisk** (ARI + ExternalMedia RTP + OpenAI Realtime)
- **Mock** (dev/no network)

Docs: `https://docs.openclaw.ai/plugins/voice-call`
Bundled docs in this repo: `docs/voice-call.md`
Plugin system: `https://docs.openclaw.ai/plugin`

## Install (local dev)

### Option A: install via OpenClaw (recommended)

```bash
openclaw plugins install @openclaw/voice-call
```

Restart the Gateway afterwards.

### Option B: copy into your global extensions folder (dev)

```bash
mkdir -p ~/.openclaw/extensions
cp -R . ~/.openclaw/extensions/voice-call
cd ~/.openclaw/extensions/voice-call && pnpm install
```

## Config

Put under `plugins.entries.voice-call.config`:

```json5
{
  provider: "twilio", // or "telnyx" | "plivo" | "asterisk" | "mock"
  fromNumber: "+15550001234",
  toNumber: "+15550005678",

  twilio: {
    accountSid: "ACxxxxxxxx",
    authToken: "your_token",
  },

  telnyx: {
    apiKey: "KEYxxxx",
    connectionId: "CONNxxxx",
    // Telnyx webhook public key from the Telnyx Mission Control Portal
    // (Base64 string; can also be set via TELNYX_PUBLIC_KEY).
    publicKey: "...",
  },

  plivo: {
    authId: "MAxxxxxxxxxxxxxxxxxxxx",
    authToken: "your_token",
  },

  asterisk: {
    ariUrl: "http://asterisk.example.internal:8088",
    ariUsername: "openclaw",
    ariPassword: "change-me",
    stasisApp: "openclaw",
    sipTrunk: "carrier-trunk",
    callerId: "15550001234",
    outboundNumberRewrites: [
      { pattern: "^7(\\d{10})$", replace: "8$1" },
    ],
    realtimeVoice: "marin",
    inboundProfiles: {
      defaultGreeting: "Hello, this is the voice assistant. How can I help?",
      defaultSystemPrompt: "You answer inbound calls briefly and collect the caller's message.",
      overrides: [
        {
          callerNumbers: ["+15550005678"],
          greeting: "Hi, how can I help?",
          systemPrompt: "You are speaking directly with the account owner. Keep it brief.",
        },
      ],
    },
  },

  // Webhook server
  serve: {
    port: 3334,
    path: "/voice/webhook",
  },

  // Public exposure (pick one):
  // publicUrl: "https://example.ngrok.app/voice/webhook",
  // tunnel: { provider: "ngrok" },
  // tailscale: { mode: "funnel", path: "/voice/webhook" }

  outbound: {
    defaultMode: "notify", // or "conversation"
  },

  streaming: {
    enabled: true,
    streamPath: "/voice/stream",
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  },
}
```

Notes:

- Twilio/Telnyx/Plivo require a **publicly reachable** webhook URL.
- Asterisk uses ARI WebSocket events and RTP ExternalMedia; it does not require
  a public webhook, but RTP must be reachable between Asterisk and OpenClaw.
- `mock` is a local dev provider (no network calls).
- Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
- advanced webhook, streaming, and tunnel notes: `https://docs.openclaw.ai/plugins/voice-call`

### Asterisk multi-cluster routing

Use `asterisks[]` when one OpenClaw instance should route calls across several
Asterisk boxes:

```json5
{
  provider: "asterisk",
  asterisks: [
    {
      name: "primary",
      ariUrl: "http://asterisk-primary.example.internal:8088",
      ariUsername: "openclaw",
      ariPassword: "change-me",
      stasisApp: "openclaw",
      sipTrunk: "primary-trunk",
      callerId: "15550001234",
      routePrefixes: ["1"],
      default: true,
    },
    {
      name: "secondary",
      ariUrl: "http://asterisk-secondary.example.internal:8088",
      ariUsername: "openclaw",
      ariPassword: "change-me",
      stasisApp: "openclaw",
      sipTrunk: "secondary-trunk",
      callerId: "442071234567",
      routePrefixes: ["44"],
    },
  ],
}
```

## Stale call reaper

See the plugin docs for recommended ranges and production examples:
`https://docs.openclaw.ai/plugins/voice-call#stale-call-reaper`

## TTS for calls

Voice Call uses the core `messages.tts` configuration for
streaming speech on calls. Override examples and provider caveats live here:
`https://docs.openclaw.ai/plugins/voice-call#tts-for-calls`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Tool

Tool name: `voice_call`

Actions:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

## Gateway RPC

- `voicecall.initiate` (to?, message, mode?)
- `voicecall.continue` (callId, message)
- `voicecall.speak` (callId, message)
- `voicecall.end` (callId)
- `voicecall.status` (callId)

## Notes

- Uses webhook signature verification for Twilio/Telnyx/Plivo.
- Adds replay protection for Twilio and Plivo webhooks (valid duplicate callbacks are ignored safely).
- Twilio speech turns include a per-turn token so stale/replayed callbacks cannot complete a newer turn.
- `responseModel` / `responseSystemPrompt` control AI auto-responses.
- Voice-call auto-responses enforce a spoken JSON contract (`{"spoken":"..."}`) and filter reasoning/meta output before playback.
- While a Twilio stream is active, playback does not fall back to TwiML `<Say>`; stream-TTS failures fail the playback request.
- Outbound conversation calls suppress barge-in only while the initial greeting is actively speaking, then re-enable normal interruption.
- Twilio stream disconnect auto-end uses a short grace window so quick reconnects do not end the call.
- Media streaming requires `ws` and OpenAI Realtime API key.
