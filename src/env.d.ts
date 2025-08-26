// src/env.d.ts
// Extends the generated Env with our bindings, vars, and secrets
declare global {
  interface Env {
    // Bindings
    FILES: R2Bucket;
    FILES_KV: KVNamespace;

    // Vars (set in wrangler.jsonc [vars])
    R2_ACCOUNT_ID: string;
    R2_BUCKET: string;

    // Secrets (set via `wrangler secret put ... --name felicity`)
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
  }
}

export {};
