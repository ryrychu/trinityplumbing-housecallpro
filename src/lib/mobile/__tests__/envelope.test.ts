import { describe, it, expect } from "vitest";
import { appJson, appError } from "../envelope";

describe("appJson", () => {
  // Every screen shows "updated N min ago". That is only possible if freshness
  // is a property of the payload rather than a guess made by the client.
  it("stamps generated_at on every payload", async () => {
    const body = await appJson({ jobs: [] }).json();
    expect(body.data).toEqual({ jobs: [] });
    expect(Date.parse(body.generated_at)).not.toBeNaN();
  });

  // The service worker owns caching. Letting an intermediary cache these would
  // produce stale data the UI cannot detect or date.
  it("forbids HTTP caching so only the service worker caches", () => {
    expect(appJson({}).headers.get("cache-control")).toBe("no-store");
  });
});

describe("appError", () => {
  it("returns the message and status given", async () => {
    const res = appError("Job not found", 404);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Job not found");
  });
});
