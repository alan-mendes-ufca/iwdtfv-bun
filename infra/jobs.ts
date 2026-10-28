import video from "models/video";
import provider from "models/provider";
import config from "infra/config";
import controller from "infra/controller";
import validateRequest from "models/validateRequest";
import { ServicesError } from "infra/errors";
import {
  ensureSpace,
  saveFile,
  listFiles,
  getFile,
  filePath,
  type SavedFile,
} from "infra/library";

type Job = {
  id: string;
  status: "preparing" | "downloading" | "completed" | "failed" | "cancelled";
  file?: SavedFile;
  message?: string;
};
const jobs = new Map<
  string,
  { job: Job; abort: AbortController; task?: Promise<void> }
>();
let stopping = false;
export async function stopJobs() {
  stopping = true;
  for (const entry of jobs.values()) entry.abort.abort();
  await Promise.allSettled([...jobs.values()].map((entry) => entry.task));
}
const create = controller.handleRoute({
  event: "job.created",
  message: "Download iniciado.",
  rateLimit: "download",
  async handler(request) {
    const { url, format_id } = validateRequest<{
      url: string;
      format_id: string;
    }>(await controller.readJsonBody(request), {
      url: "required",
      format_id: "required",
    });
    provider.findByUrl(url);
    const running = [...jobs.values()].filter((entry) =>
      ["preparing", "downloading"].includes(entry.job.status),
    ).length;
    if (stopping || running >= config.get().maxConcurrentDownloads)
      throw new ServicesError({
        message: "Já há downloads demais em andamento.",
      });
    const job: Job = { id: crypto.randomUUID(), status: "preparing" };
    const entry: { job: Job; abort: AbortController; task?: Promise<void> } = {
      job,
      abort: new AbortController(),
    };
    // Reserve the slot before the first await.
    jobs.set(job.id, entry);
    entry.task = (async () => {
      try {
        await ensureSpace();
        entry.abort.signal.throwIfAborted();
        job.status = "downloading";
        const result = await video.download(url, format_id, {
          signal: entry.abort.signal,
        });
        try {
          entry.abort.signal.throwIfAborted();
          job.file = await saveFile(result);
          job.status = "completed";
        } finally {
          await result.cleanup();
        }
      } catch (error) {
        job.status = entry.abort.signal.aborted ? "cancelled" : "failed";
        job.message =
          error instanceof Error ? error.message : "Falha no download.";
        console.error(
          JSON.stringify({
            event: "job.failed",
            id: job.id,
            message: job.message,
          }),
        );
      } finally {
        // Retain recent status, bound memory. Completed files live independently on disk.
        const timer = setTimeout(() => jobs.delete(job.id), 60 * 60_000);
        timer.unref();
      }
    })();
    return Response.json(job, { status: 202 });
  },
});
const read = controller.handleRoute({
  event: "library.read",
  message: "Biblioteca consultada.",
  async handler(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/v1/files" && request.method === "GET")
      return Response.json(await listFiles());
    const jobId = pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/)?.[1];
    if (jobId) {
      const entry = jobs.get(jobId);
      if (!entry) return new Response("Not Found", { status: 404 });
      if (request.method === "DELETE") entry.abort.abort();
      else if (request.method !== "GET") return controller.methodNotAllowed();
      return Response.json(entry.job);
    }
    const id = pathname.match(/^\/api\/v1\/files\/([^/]+)$/)?.[1];
    if (id && request.method === "GET") {
      const file = await getFile(id);
      if (!file) return new Response("Not Found", { status: 404 });
      return new Response(Bun.file(filePath(id)), {
        headers: {
          "Content-Type": file.contentType,
          "Content-Disposition": controller.contentDisposition(file.filename),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }
    return controller.methodNotAllowed();
  },
});
export default function jobsRoute(
  request: Request,
  remoteAddress?: string | null,
) {
  if (new URL(request.url).pathname === "/api/v1/jobs")
    return request.method === "POST"
      ? create(request, remoteAddress)
      : Promise.resolve(controller.methodNotAllowed());
  return read(request, remoteAddress);
}
