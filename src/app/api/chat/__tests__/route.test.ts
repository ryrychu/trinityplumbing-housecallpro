// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { OPTIONS, POST, dynamic, runtime } from "../route";

afterEach(() => vi.unstubAllEnvs());

function chatRequest(method: "POST" | "OPTIONS", origin: string): Request {
  return new Request("https://ops.trinity.plumbing/api/chat", {
    method,
    headers: { origin, "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}

describe("/api/chat", () => {
  it("runs on Node and is never cached", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
  });

  it("answers 503 {off:true} while CHAT_ENABLED is off, with CORS for a listed origin", async () => {
    vi.stubEnv("CHAT_ENABLED", "");
    vi.stubEnv("CHAT_SITES", "trinity=https://trinity.plumbing");
    vi.stubEnv("CHAT_IP_SALT", "salt");
    const res = await POST(chatRequest("POST", "https://trinity.plumbing"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ off: true });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://trinity.plumbing");
  });

  it("answers the preflight for a listed origin and refuses others", async () => {
    vi.stubEnv("CHAT_SITES", "trinity=https://trinity.plumbing");
    vi.stubEnv("CHAT_IP_SALT", "salt");
    expect((await OPTIONS(chatRequest("OPTIONS", "https://trinity.plumbing"))).status).toBe(204);
    expect((await OPTIONS(chatRequest("OPTIONS", "https://evil.example"))).status).toBe(403);
  });
});
