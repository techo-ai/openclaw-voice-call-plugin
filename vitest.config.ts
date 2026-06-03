import { defineConfig } from "vitest/config";

// The plugin's tests resolve all `openclaw/plugin-sdk/*` imports directly
// from the installed `openclaw` devDependency (currently 2026.5.x). Earlier
// versions of this config aliased the now-removed `plugin-sdk/voice-call`
// barrel to a local shim; the new individual subpaths
// (plugin-entry, tts-runtime, gateway-runtime, webhook-request-guards,
// ssrf-runtime, session-store-runtime, runtime-env) are all available in
// node_modules and need no shimming.
export default defineConfig({});
