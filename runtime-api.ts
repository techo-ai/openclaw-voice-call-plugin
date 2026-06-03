// Private runtime barrel for the Voice Call plugin.
// Keep this barrel thin and aligned with the local extension surface.
//
// History: through openclaw 2026.3.27 the gateway exposed a single mega-barrel
// at `openclaw/plugin-sdk/voice-call`. Starting with openclaw 2026.5.12 that
// barrel was removed and the same symbols promoted to individual public SDK
// subpaths. Importing each one explicitly is forward-compatible and matches
// what the upstream bundled voice-call extension does.

export { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-request-guards";
export { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
export type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
export {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "openclaw/plugin-sdk/tts-runtime";
export { sleep } from "openclaw/plugin-sdk/runtime-env";
