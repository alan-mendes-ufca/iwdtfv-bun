import controller from "infra/controller";
import validateRequest from "models/validateRequest";
import video from "models/video";

const postHandler = controller.handleRoute({
  event: "video.downloaded",
  message: "Vídeo baixado com sucesso.",
  rateLimit: "download",
  async handler(request: Request, context) {
    const rawBody = await controller.readJsonBody(request);
    // TS: <{ url: string; format_id: string }> passa um tipo de objeto como argumento do genérico de validateRequest.
    const { url, format_id } = validateRequest<{
      url: string;
      format_id: string;
    }>(rawBody, {
      url: "required",
      format_id: "required",
    });

    // Se o cliente fechar a conexão durante o download, request.signal dispara abort,
    // o yt-dlp é encerrado e o temporário é apagado.
    const result = await video.download(url, format_id, {
      signal: request.signal,
      principal: context.principal,
    });

    const stream = streamFileWithCleanup(
      result.filePath,
      request.signal,
      result.cleanup,
    );

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Length": String(result.size),
        "Content-Disposition": controller.contentDisposition(result.filename),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
});

function streamFileWithCleanup(
  filePath: string,
  signal: AbortSignal,
  cleanup: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = Bun.file(filePath).stream().getReader();
  let cleaned = false;

  async function finish() {
    if (cleaned) return;
    cleaned = true;
    signal.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // Ignora erro ao cancelar reader já fechado.
    }
    await cleanup();
  }

  function onAbort() {
    void finish();
  }

  signal.addEventListener("abort", onAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finish();
          streamController.close();
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        await finish();
        streamController.error(error);
      }
    },
    async cancel() {
      await finish();
    },
  });
}

export default async function downloadRoute(
  request: Request,
  remoteAddress?: string | null,
): Promise<Response> {
  if (request.method !== "POST") {
    return controller.methodNotAllowed();
  }
  return postHandler(request, remoteAddress);
}
