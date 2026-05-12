import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type VoiceCallManifest = {
  name?: string;
  description?: string;
  contracts?: {
    tools?: string[];
  };
};

type VoiceCallPackageJson = {
  name?: string;
  openclaw?: {
    extensions?: string[];
    install?: {
      npmSpec?: string;
      localPath?: string;
      defaultChoice?: string;
      minHostVersion?: string;
    };
  };
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8")) as T;
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(fullPath));
    } else {
      out.push(fullPath);
    }
  }
  return out;
}

describe("voice-call OSS manifest contract", () => {
  it("declares standalone plugin identity and install metadata", () => {
    const manifest = readJson<VoiceCallManifest>("openclaw.plugin.json");
    const packageJson = readJson<VoiceCallPackageJson>("package.json");

    expect(packageJson.name).toBe("@openclaw/voice-call");
    expect(packageJson.openclaw?.extensions).toContain("./index.ts");
    expect(packageJson.openclaw?.install).toMatchObject({
      npmSpec: "@openclaw/voice-call",
      localPath: ".",
      defaultChoice: "npm",
      minHostVersion: ">=2026.3.27",
    });
    expect(manifest.name).toBe("Voice Call");
    expect(manifest.description).toContain("Voice-call plugin");
  });

  it("declares ownership of the voice_call tool", () => {
    const manifest = readJson<VoiceCallManifest>("openclaw.plugin.json");

    expect(manifest.contracts?.tools).toContain("voice_call");
  });

  it("keeps production plugin files free of deployment-specific debug strings", () => {
    const repoRoot = process.cwd();
    const files = [
      ...collectFiles(repoRoot).filter((file) => {
        if (!/\.(ts|json|md)$/.test(file)) return false;
        if (file.includes(`${path.sep}.git${path.sep}`)) return false;
        if (file.includes(`${path.sep}node_modules${path.sep}`)) return false;
        if (file.endsWith(".test.ts")) return false;
        if (file.includes(`${path.sep}CHANGELOG.md`)) return false;
        return true;
      }),
    ];
    const forbidden = [
      "Тем" + "ирлан",
      "770" + "29990503",
      "gpt-" + "5.4",
      "127.0.0.1:" + "7840",
      "emit" + "DebugLog",
    ];

    const matches = files.flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      return forbidden
        .filter((needle) => text.includes(needle))
        .map((needle) => `${path.relative(repoRoot, file)} contains ${needle}`);
    });

    expect(matches).toEqual([]);
  });
});
