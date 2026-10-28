import { expect, test } from "bun:test";
import {
  monotonicProgress,
  preparationProgress,
  readDownloadResponse,
} from "../../../pages/downloadProgress";

test("preparation rises in steps and remains below completion", () => {
  expect(preparationProgress(0)).toBe(0);
  expect(preparationProgress(1000)).toBeGreaterThan(0);
  expect(preparationProgress(1_000_000)).toBe(75);
  expect(monotonicProgress(82, 78)).toBe(82);
  expect(monotonicProgress(98, 120)).toBe(99);
});

test("reads chunks and reports real length without completing early", async () => {
  const values: number[] = [];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }),
    { headers: { "Content-Length": "4" } },
  );
  const blob = await readDownloadResponse(
    response,
    new AbortController().signal,
    (value) => values.push(value),
  );
  expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([
    1, 2, 3, 4,
  ]);
  expect(values.at(-1)).toBe(99);
});

test("unknown length stays below completion", async () => {
  const values: number[] = [];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }),
  );
  await readDownloadResponse(response, new AbortController().signal, (value) =>
    values.push(value),
  );
  expect(values[0]).toBeLessThan(95);
});

test("truncated body rejects before completion", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }),
    { headers: { "Content-Length": "2" } },
  );
  await expect(
    readDownloadResponse(response, new AbortController().signal, () => {}),
  ).rejects.toThrow("Incomplete download");
});

test("abort rejects without reporting completion", async () => {
  const abort = new AbortController();
  const values: number[] = [];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    }),
  );
  const reading = readDownloadResponse(response, abort.signal, (value) => {
    values.push(value);
    abort.abort();
  });
  await expect(reading).rejects.toThrow();
  expect(values.every((value) => value < 100)).toBe(true);
});

test("stream failure rejects without reporting completion", async () => {
  const values: number[] = [];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error("stream failed"));
      },
    }),
  );
  await expect(
    readDownloadResponse(response, new AbortController().signal, (value) =>
      values.push(value),
    ),
  ).rejects.toThrow("stream failed");
  expect(values.every((value) => value < 100)).toBe(true);
});
