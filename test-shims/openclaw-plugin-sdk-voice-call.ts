import { z } from "openclaw/plugin-sdk/zod";

export function definePluginEntry<T>(entry: T): T {
  return entry;
}

export const TtsAutoSchema = z.enum(["off", "always", "inbound", "tagged"]);
export const TtsConfigSchema = z
  .object({
    auto: TtsAutoSchema.optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(["final", "all"]).optional(),
    provider: z.string().min(1).optional(),
    summaryModel: z.string().optional(),
    providers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    prefsPath: z.string().optional(),
    maxTextLength: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  })
  .passthrough()
  .optional();
export const TtsModeSchema = z.enum(["final", "all"]);
export const TtsProviderSchema = z.string().min(1);

export function isRequestBodyLimitError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "REQUEST_BODY_LIMIT",
  );
}

export async function readRequestBodyWithLimit(
  req: AsyncIterable<Buffer | string>,
  opts?: { maxBytes?: number },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (opts?.maxBytes !== undefined && total > opts.maxBytes) {
      const err = new Error("Request body exceeds configured limit") as Error & {
        code?: string;
      };
      err.code = "REQUEST_BODY_LIMIT";
      throw err;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function requestBodyErrorToText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchWithSsrFGuard(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  return fetch(input, init);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GatewayRequestHandlerOptions = unknown;
export type SessionEntry = unknown;
export type OpenClawPluginApi = unknown;
