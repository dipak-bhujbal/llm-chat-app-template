/**
 * LLM Chat Application Template + R2 uploads/memory
 *
 * Adds ChatGPT-style file uploads backed by R2 with quota checks and auto-cleanup.
 * Bindings used: AI (Workers AI), ASSETS (static), FILES (R2), FILES_KV (KV).
 *
 * @license MIT
 */
import { ChatMessage } from "./types";

// ---------- Config ----------
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct";
const SYSTEM_PROMPT =
  "You are a helpful, friendly personal assistant who replaced my human personal assistant. Your name is Felicity. Provide concise and accurate responses.";

const MAX_FILES_PER_BATCH = 20;
const BYTES_LIMIT = 9.5 * 1024 * 1024 * 1024; // 9.5 GB
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Llama-friendly MIME allowlist (covers common textual/docs)
// If your browser sends empty MIME, we fall back to extension allowlist below.
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

// ---------- Bindings ----------
export interface Env {
  AI: any;
  ASSETS: Fetcher;
  FILES: R2Bucket;      // R2 bucket binding name from your setup (felicity-files)
  FILES_KV: KVNamespace; // create with `wrangler kv namespace create FILES_KV`
}

// ---------- Helpers ----------
const nowISO = () => new Date().toISOString();

async function getUsedBytes(env: Env): Promise<number> {
  // Fast path: KV counter
  const v = await env.FILES_KV.get("used_bytes");
  if (v) return Number(v);

  // Fallback: sum R2 sizes (first run / reconciliation)
  let cursor: string | undefined;
  let total = 0;
  do {
    const list = await env.FILES.list({ cursor, include: ["customMetadata"] });
    for (const o of list.objects) total += o.size;
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  await env.FILES_KV.put("used_bytes", String(total));
  return total;
}

async function bumpUsedBytes(env: Env, delta: number) {
  await env.FILES_KV.atomic()
    .get("used_bytes")
    .mutate((v) => String((Number(v) || 0) + delta))
    .commit();
}

function isAllowed(type: string, filename: string): boolean {
  if (type && ALLOWED_MIME.has(type)) return true;
  const dot = filename.lastIndexOf(".");
  if (dot >= 0) return ALLOWED_EXT.has(filename.slice(dot).toLowerCase());
  return false;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------- Upload & File APIs ----------
async function handleQuota(_req: Request, env: Env) {
  const used = await getUsedBytes(env);
  return json({
    usedBytes: used,
    limitBytes: BYTES_LIMIT,
    okToUpload: used < BYTES_LIMIT,
  });
}

async function handleUpload(request: Request, env: Env) {
  const form = await request.formData();
  const files = form.getAll("files");
  const pin = form.get("pin") === "true";

  if (files.length === 0) return new Response("No files.", { status: 400 });
  if (files.length > MAX_FILES_PER_BATCH)
    return new Response(`Max ${MAX_FILES_PER_BATCH} files per upload.`, {
      status: 413,
    });

  let batchBytes = 0;
  for (const entry of files) {
    if (!(entry instanceof File))
      return new Response("Malformed form data.", { status: 400 });
    if (!isAllowed(entry.type || "", entry.name || ""))
      return new Response(
        `Unsupported type: ${entry.type || "unknown"} (${entry.name})`,
        { status: 415 },
      );
    batchBytes += entry.size;
  }

  const used = await getUsedBytes(env);
  if (used + batchBytes >= BYTES_LIMIT) {
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

  const results: Array<{
    key: string;
    name: string;
    size: number;
    type: string;
    pinned: boolean;
  }> = [];

  for (const entry of files as File[]) {
    const key = crypto.randomUUID() + "/" + (entry.name || "file");
    const customMetadata: Record<string, string> = {
      pinned: String(pin),
      last_accessed: nowISO(),
    };

    await env.FILES.put(key, await entry.arrayBuffer(), {
      httpMetadata: {
        contentType: entry.type,
        contentDisposition: `inline; filename="${entry.name}"`,
      },
      customMetadata,
    });

    results.push({
      key,
      name: entry.name,
      size: entry.size,
      type: entry.type,
      pinned: pin,
    });

    await bumpUsedBytes(env, entry.size);
  }

  return json({ ok: true, files: results }, 200);
}

async function handleTouchAccess(_request: Request, env: Env, key: string) {
  const head = await env.FILES.head(key);
  if (!head) return new Response("Not found", { status: 404 });

  const meta = {
    ...(head.customMetadata || {}),
    last_accessed: nowISO(),
  } as Record<string, string>;

  const obj = await env.FILES.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  await env.FILES.put(key, obj.body!, {
    httpMetadata: head.httpMetadata,
    customMetadata: meta,
  });

  return json({ ok: true, key, last_accessed: meta.last_accessed });
}

async function handlePin(_request: Request, env: Env, key: string) {
  const body = (await _request.json()) as { pinned: boolean };
  const head = await env.FILES.head(key);
  if (!head) return new Response("Not found", { status: 404 });

  const meta = {
    ...(head.customMetadata || {}),
    pinned: String(Boolean(body.pinned)),
  } as Record<string, string>;

  const obj = await env.FILES.get(key);
  await env.FILES.put(key, obj!.body!, {
    httpMetadata: head.httpMetadata,
    customMetadata: meta,
  });

  return json({ ok: true, key, pinned: body.pinned });
}

async function handleDelete(_request: Request, env: Env, key: string) {
  const head = await env.FILES.head(key);
  if (!head) return new Response("Not found", { status: 404 });

  await env.FILES.delete(key);
  await bumpUsedBytes(env, -Number(head.size || 0));

  return json({ ok: true });
}

async function handleCleanup(_request: Request, env: Env, token: string | null) {
  // Basic guard if you hit this over HTTP via a cron URL
  if (token !== "cron") return new Response("forbidden", { status: 403 });

  let cursor: string | undefined;
  let deleted = 0;
  let freed = 0;
  const cutoff = Date.now() - ONE_WEEK_MS;

  do {
    const list = await env.FILES.list({ cursor, include: ["customMetadata"] });
    for (const o of list.objects) {
      const pinned = o.customMetadata?.pinned === "true";
      const last = Date.parse(
        o.customMetadata?.last_accessed || o.uploaded?.toString() || "",
      );
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

// ---------- Chat API ----------
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };

  if (!messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: SYSTEM_PROMPT });
  }

  const response = await env.AI.run(
    MODEL_ID,
    { messages, max_tokens: 1024 },
    { returnRawResponse: true },
  );

  return response;
}

// ---------- Router ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // Serve frontend assets (root or anything not under /api/)
    if (pathname === "/" || !pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // Chat
    if (pathname === "/api/chat") {
      if (request.method === "POST") return handleChatRequest(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    // Quota
    if (pathname === "/api/quota" && request.method === "GET") {
      return handleQuota(request, env);
    }

    // Upload
    if (pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    // File ops: /api/files/:key/*
    if (pathname.startsWith("/api/files/")) {
      // key may contain slashes; everything after /api/files/ is the key or key + subroute
      const rest = decodeURIComponent(pathname.slice("/api/files/".length));
      const parts = rest.split("/");
      const sub = parts[parts.length - 1];
      const key =
        sub === "access" || sub === "pin"
          ? rest.slice(0, rest.lastIndexOf("/"))
          : rest;

      if (sub === "access" && request.method === "POST") {
        return handleTouchAccess(request, env, key);
      }
      if (sub === "pin" && request.method === "POST") {
        return handlePin(request, env, key);
      }
      if (request.method === "DELETE") {
        return handleDelete(request, env, key);
      }
    }

    // HTTP-invoked cleanup (pair with a Cron Trigger that hits this URL)
    if (pathname === "/__scheduled" && request.method === "GET") {
      return handleCleanup(request, env, searchParams.get("token"));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
