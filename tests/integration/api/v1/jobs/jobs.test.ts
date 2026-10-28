import { beforeAll, expect, test } from "bun:test";
import orchestrator from "tests/orchestrator";
import webserver from "infra/webserver";
beforeAll(() => orchestrator.waitForAllServices());
// Persistent jobs/library must be inaccessible in device-only mode.
test.each([
  "/api/v1/jobs",
  "/api/v1/files",
  "/api/v1/jobs/123",
  "/api/v1/files/123",
])("persistent route %s is disabled", async (endpoint) => {
  const response = await fetch(webserver.origin + endpoint);
  expect(response.status).toBe(404);
});
test("cannot create a persistent download", async () => {
  const response = await orchestrator.postJson("/api/v1/jobs", {
    url: "https://www.youtube.com/watch?v=abc",
    format_id: "137",
  });
  expect(response.status).toBe(404);
});
