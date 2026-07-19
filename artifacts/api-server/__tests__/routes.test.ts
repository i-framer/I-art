import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app";

describe("API server routes", () => {
  it("GET /api/healthz returns ok status", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown API routes", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("parses JSON request bodies without crashing", async () => {
    // Unknown POST route should 404, not 500, proving body parsing works
    const res = await request(app)
      .post("/api/does-not-exist")
      .send({ hello: "world" })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON bodies with a 4xx error", async () => {
    const res = await request(app)
      .post("/api/healthz")
      .set("Content-Type", "application/json")
      .send('{"broken":');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("includes CORS headers", async () => {
    const res = await request(app)
      .get("/api/healthz")
      .set("Origin", "http://example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
