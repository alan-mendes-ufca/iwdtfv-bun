const MAX_BYTES = 256 * 1024 * 1024;

export function monotonicProgress(current: number, next: number): number {
  return Math.max(current, Math.min(99, Math.max(0, next)));
}

export function preparationProgress(elapsedMs: number): number {
  return Math.min(
    75,
    Math.floor((75 * (1 - Math.exp(-Math.max(0, elapsedMs) / 9000))) / 2.5) *
      2.5,
  );
}

export async function readDownloadResponse(
  response: Response,
  signal: AbortSignal,
  onProgress: (progress: number, knownLength: boolean) => void,
): Promise<Blob> {
  const rawLength = response.headers.get("Content-Length");
  const length = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : 0;
  const knownLength = Number.isSafeInteger(length) && length > 0;
  if (knownLength && length > MAX_BYTES)
    throw new Error("Download exceeds memory limit");
  if (!response.body) throw new Error("Download response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  let completed = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted)
        throw new DOMException("Download canceled", "AbortError");
      const { done, value } = await reader.read();
      if (signal.aborted)
        throw new DOMException("Download canceled", "AbortError");
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES || (knownLength && received > length))
        throw new Error("Download size mismatch");
      chunks.push(value.slice());
      onProgress(
        knownLength
          ? 75 + 24 * (received / length)
          : Math.min(
              95,
              75 + 20 * (1 - Math.exp(-received / (8 * 1024 * 1024))),
            ),
        knownLength,
      );
    }
    if (knownLength && received !== length)
      throw new Error("Incomplete download");
    if (signal.aborted)
      throw new DOMException("Download canceled", "AbortError");
    completed = true;
    return new Blob(chunks, {
      type: response.headers.get("Content-Type") || "application/octet-stream",
    });
  } finally {
    signal.removeEventListener("abort", abort);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
