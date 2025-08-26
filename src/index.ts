/**
 * Felicity Worker — Chat + R2 uploads via presigned URLs
 */
import type { Env as BaseEnv, ChatMessage } from "./types";

// ----- Config -----
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct";
const SYSTEM_PROMPT =
  "You are a helpful, friendly personal assistant who replaced my human personal assistant. Your name is Felicity. Provide concise and accurate responses.";

const MAX_FILES_PER_BATCH = 20;
const BYTES_LIMIT = 9.5 * 1024 * 1024 * 1024; // 9.5 GB
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Allowed types (Llama-friendly)
const ALLOWED_MIME = new Set<string>([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "text/html",
  "application/xml",
  "text/xml",
  "application/rtf",
]);
const ALLOWED_EXT = new Set<string>([
  ".txt",
  ".md",
  ".csv",
  ".tsv",
  ".json",
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".html",
  ".xml",
  ".rtf",
]);

// Extend your Env type (ensure types.ts includes FILES + FILES_KV)
export type Env = BaseEnv & {
  FILES: R2Bucket;
  FILES_KV: KVNamespace;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string; // via [vars]
  R2_BUCKET?: string;     // via [vars]
};

// ----- Helpers -----
const nowISO = () => new Date().toISOString();
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isAllowed(type: string | undefined, filename: string | undefined) {
  const t = (type || "").trim();
  if (t && ALLOWED_MIME.has(t)) return true;

  const name = filename || "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0) {
    const ext = name.slice(dot).toLowerCase();
    if (ALLOWED_EXT.has(ext)) return true;
  }

  // Be generous if browser sends octet-stream/empty
  if (!t || t === "application/octet-stream") return true;
  return false;
}

// KV-safe size counter (no .atomic())
async function getUsedBytes(env: Env): Promise<number> {
  try {
    const v = await env.FILES_KV.get("used_bytes");
    if (v) return Number(v);
  } catch {}
  // fallback: sum R2
  try {
    let cursor: string | undefined;
    let total = 0;
    do {
      const list = await env.FILES.list({ cursor });
      for (const o of list.objects) total += o.size;
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    await env.FILES_KV.put("used_bytes", String(total)).catch(() => {});
    return total;
  } catch {
    return 0;
  }
}
async function bumpUsedBytes(env: Env, delta: number) {
  const key = "used_bytes";
  const cur = Number(await env.FILES_KV.get(key)) || 0;
  await env.FILES_KV.put(key, String(cur + delta));
}

// ----- AWS SigV4 presign for R2 -----
function u8ToHex(u8: ArrayBuffer) {
  return [...new Uint8Array(u8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(key: ArrayBuffer | string, msg: string) {
  const enc = new TextEncoder();
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return u8ToHex(d);
}

async function presignPutUrl(opts: {
  accountId: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // "auto"
  expiresSec?: number; // <= 7 days
}) {
  const region = opts.region ?? "auto";
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${opts.bucket}/${encodeURIComponent(opts.key)}`;
  const method = "PUT";

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z"; // yyyymmddThhmmssZ
  const datestamp = amzDate.slice(0, 8);
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${datestamp}/${region}/s3/aws4_request`;

  const qp = new URLSearchParams({
    "X-Amz-Algorithm": algorithm,
    "X-Amz-Credential": `${opts.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(opts.expiresSec ?? 600),
    "X-Amz-SignedHeaders": "host",
  });
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method,
    canonicalUri,
    qp.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac("AWS4" + opts.secretAccessKey, datestamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = u8ToHex(await hmac(kSigning, stringToSign));

  return `https://${host}${canonicalUri}?${qp.toString()}&X-Amz-Signature=${signature}`;
}

// ----- Chat -----
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };

  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: SYSTEM_PROMPT });
  }

  const response = await (env as BaseEnv).AI.run(
    MODEL_ID,
    { messages, max_tokens: 1024 },
    { returnRawResponse: true },
  );
  return response;
}

// ----- Router -----
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // Serve frontend
    if (pathname === "/" || !pathname.startsWith("/api/")) {
      return (env as BaseEnv).ASSETS.fetch(request);
    }

    // Chat
    if (pathname === "/api/chat" && request.method === "POST") {
      return handleChatRequest(request, env);
    }

    // Quota
    if (pathname === "/api/quota" && request.method === "GET") {
      const used = await getUsedBytes(env);
      return json({ usedBytes: used, limitBytes: BYTES_LIMIT, okToUpload: used < BYTES_LIMIT });
    }

    // 1) Presign URLs (client uploads directly to R2)
    // body: { files: [{ name, size, type }], pin?: boolean }
    if (pathname === "/api/upload-urls" && request.method === "POST") {
      const { files = [], pin = false } = (await request.json()) as {
        files: Array<{ name: string; size: number; type?: string }>;
        pin?: boolean;
      };

      if (!Array.isArray(files) || files.length === 0)
        return json({ ok: false, message: "No files." }, 400);
      if (files.length > MAX_FILES_PER_BATCH)
        return json({ ok: false, message: `Max ${MAX_FILES_PER_BATCH} files per upload.` }, 413);

      let total = 0;
      for (const f of files) {
        if (!isAllowed(f.type, f.name)) {
          return json({ ok: false, message: `Unsupported type for ${f.name}` }, 415);
        }
        total += Number(f.size || 0);
      }

      const used = await getUsedBytes(env);
      if (used + total >= BYTES_LIMIT) {
        return json(
          {
            ok: false,
            reason: "quota",
            message:
              "Whoa there, data dragon! Your hoard is full (≥ 9.5 GB). Time to slay some old files before feeding me more. 🐉📦",
            usedBytes: used,
            limitBytes: BYTES_LIMIT,
          },
          413,
        );
      }

      const accessKeyId = env.R2_ACCESS_KEY_ID as string;
      const secretAccessKey = env.R2_SECRET_ACCESS_KEY as string;
      const accountId = env.R2_ACCOUNT_ID as string;
      const bucket = (env.R2_BUCKET as string) || "felicity-files";
      if (!accessKeyId || !secretAccessKey || !accountId) {
        return json({ ok: false, message: "R2 credentials not configured." }, 500);
      }

      const uploads: Array<{ key: string; url: string; name: string; size: number; type?: string }> =
        [];
      for (const f of files) {
        const key = crypto.randomUUID() + "/" + f.name;
        const url = await presignPutUrl({
          accountId,
          bucket,
          key,
          accessKeyId,
          secretAccessKey,
          expiresSec: 600,
        });
        uploads.push({ key, url, name: f.name, size: f.size, type: f.type });
      }

      // Optionally snapshot the expected sizes so we can reconcile later (TTL 1h)
      await env.FILES_KV.put(
        "pending:" + uploads.map((u) => u.key).join(","),
        JSON.stringify({ pin, files: uploads.map((u) => ({ key: u.key, size: u.size })) }),
        { expirationTtl: 3600 },
      ).catch(() => {});

      return json({ ok: true, uploads, pin: Boolean(pin) });
    }

    // 2) Confirm after client PUTs to R2
    // body: { keys: string[], pin?: boolean }
    if (pathname === "/api/confirm" && request.method === "POST") {
      const { keys = [], pin = false } = (await request.json()) as {
        keys: string[];
        pin?: boolean;
      };
      if (!Array.isArray(keys) || keys.length === 0)
        return json({ ok: false, message: "No keys." }, 400);

      let updated = 0;
      let total = 0;

      for (const key of keys) {
        const head = await env.FILES.head(key);
        if (!head) continue; // not uploaded or wrong key
        total += Number(head.size || 0);

        const obj = await env.FILES.get(key);
        if (!obj) continue;

        await env.FILES.put(key, obj.body!, {
          httpMetadata: head.httpMetadata,
          customMetadata: {
            ...(head.customMetadata || {}),
            pinned: String(Boolean(pin)),
            last_accessed: nowISO(),
          },
        });
        updated++;
      }
      if (total) await bumpUsedBytes(env, total);
      return json({ ok: true, updated, totalBytes: total });
    }

    // Manual delete (optional; handy for tests)
    // DELETE /api/files/:key
    if (pathname.startsWith("/api/files/") && request.method === "DELETE") {
      const key = decodeURIComponent(pathname.slice("/api/files/".length));
      const head = await env.FILES.head(key);
      if (!head) return new Response("Not found", { status: 404 });
      await env.FILES.delete(key);
      await bumpUsedBytes(env, -Number(head.size || 0));
      return json({ ok: true });
    }

    // Touch access (update last_accessed)
    if (pathname.startsWith("/api/files/") && request.method === "POST") {
      const rest = decodeURIComponent(pathname.slice("/api/files/".length));
      if (!rest.endsWith("/access")) return new Response("Not found", { status: 404 });
      const key = rest.replace(/\/access$/, "");
      const head = await env.FILES.head(key);
      if (!head) return new Response("Not found", { status: 404 });
      const obj = await env.FILES.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      await env.FILES.put(key, obj.body!, {
        httpMetadata: head.httpMetadata,
        customMetadata: { ...(head.customMetadata || {}), last_accessed: nowISO() },
      });
      return json({ ok: true, key });
    }

    // Cron-like cleanup via HTTP
    if (pathname === "/__scheduled" && request.method === "GET") {
      if (searchParams.get("token") !== "cron") return new Response("forbidden", { status: 403 });
      let cursor: string | undefined;
      let deleted = 0;
      let freed = 0;
      const cutoff = Date.now() - ONE_WEEK_MS;
      do {
        const list = await env.FILES.list({ cursor, include: ["customMetadata"] });
        for (const o of list.objects) {
          const pinned = o.customMetadata?.pinned === "true";
          const last = Date.parse(o.customMetadata?.last_accessed || o.uploaded?.toString() || "");
          if (!pinned && (isFinite(last) ? last < cutoff : true)) {
            await env.FILES.delete(o.key);
            deleted++;
            freed += o.size;
          }
        }
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      if (freed) await bumpUsedBytes(env, -freed);
      return json({ ok: true, deleted, freedBytes: freed });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
