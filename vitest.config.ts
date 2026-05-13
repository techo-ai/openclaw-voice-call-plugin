import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/voice-call": path.join(
        __dirname,
        "test-shims/openclaw-plugin-sdk-voice-call.ts",
      ),
    },
  },
});
