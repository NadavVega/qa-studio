import Fastify from "fastify";
import { expect, test } from "vitest";
import { ProviderError } from "@qa/intelligence";
import { errorHandler } from "./errors";

// A provider failure inside a stage (e.g. Ollama 402) must reach the UI banner; other 5xx details stay in the log.
test("error bodies carry the message only for client errors and ProviderError", async () => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.post("/plan", async () => {
    throw new ProviderError("402 Payment Required: this model is not included in your free usage");
  });
  app.post("/db", async () => {
    throw new Error('relation "runs" does not exist');
  });
  app.post("/json", async () => ({}));

  const res = await app.inject({ method: "POST", url: "/plan" });
  expect(res.statusCode).toBe(500);
  expect(res.json()).toEqual({ error: "402 Payment Required: this model is not included in your free usage" });

  const db = await app.inject({ method: "POST", url: "/db" });
  expect(db.statusCode).toBe(500);
  expect(db.json()).toEqual({ error: "Internal Server Error" });

  const bad = await app.inject({ method: "POST", url: "/json", headers: { "content-type": "application/json" }, payload: "{" });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/JSON/);
});
