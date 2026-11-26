// Loads a site's /chat-knowledge.json, checks it against the version 1 schema
// and keeps it in memory for an hour per serverless instance. A failed refresh
// keeps the last good copy and tries again in 5 minutes rather than on every
// message. With no good copy at all it returns null, and the route answers
// with the fallback message. Never throws. Logs only an error code.
import { parseKnowledge, type ChatKnowledge } from "./schema";

export const KNOWLEDGE_TTL_MS = 60 * 60_000;
export const KNOWLEDGE_RETRY_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;
// Trinity's file is about 25 KB. Anything near this is a mistake, not a price list.
const MAX_BYTES = 256 * 1024;

// The URL must come from the CHAT_SITES config, never from request data.
export type KnowledgeSource = { key: string; knowledgeUrl: string };
export type KnowledgeLoader = (site: KnowledgeSource) => Promise<ChatKnowledge | null>;

type Entry = { knowledge: ChatKnowledge; fetchedAt: number };

export function createKnowledgeLoader(opts: { fetch?: typeof fetch; now?: () => number } = {}): KnowledgeLoader {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Entry>();

  /** Reads the body up to MAX_BYTES, cancelling the stream once the limit is passed. */
  async function readBody(res: Response): Promise<{ text: string } | { error: string }> {
    const header = res.headers.get("content-length");
    if (header !== null && Number.isFinite(Number(header)) && Number(header) > MAX_BYTES) {
      return { error: "too_large" };
    }
    if (!res.body) return { error: "bad_response" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          return { error: "too_large" };
        }
        chunks.push(value);
      }
    } catch (err) {
      return { error: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "bad_response" };
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(bytes) };
  }

  /** The checked file, or an error code. */
  async function fetchKnowledge(site: KnowledgeSource): Promise<ChatKnowledge | string> {
    let res: Response;
    try {
      res = await doFetch(site.knowledgeUrl, {
        headers: { Accept: "application/json" },
        // This module is the cache; Next's fetch cache must not add a second one.
        cache: "no-store",
        // A redirect could send the request to another host. Treat it as a failure.
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      return err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
    }
    if (!res.ok) return `http_${res.status}`;
    const body = await readBody(res);
    if ("error" in body) return body.error;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return "bad_json";
    }
    return parseKnowledge(parsed) ?? "schema_mismatch";
  }

  return async (site) => {
    const cached = cache.get(site.key);
    const t = now();
    if (cached && t - cached.fetchedAt < KNOWLEDGE_TTL_MS) return cached.knowledge;

    const result = await fetchKnowledge(site);
    if (typeof result !== "string") {
      cache.set(site.key, { knowledge: result, fetchedAt: t });
      return result;
    }
    console.warn(`[chat] knowledge for ${site.key} not loaded: ${result}`);
    if (!cached) return null;
    // Pretend the copy was fetched so it expires KNOWLEDGE_RETRY_MS from now.
    cache.set(site.key, { knowledge: cached.knowledge, fetchedAt: t - KNOWLEDGE_TTL_MS + KNOWLEDGE_RETRY_MS });
    return cached.knowledge;
  };
}

/** The route's loader. Its cache lasts as long as the serverless instance. */
export const loadKnowledge: KnowledgeLoader = createKnowledgeLoader();
