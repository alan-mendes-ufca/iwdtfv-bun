import controller from "infra/controller";
import ytdlp from "infra/ytdlp";

const getHandler = controller.handleRoute({
  event: "status.fetched",
  message: "Status consultado com sucesso.",
  async handler() {
    const versions = await ytdlp.versions();

    const statusObject = {
      updated_at: new Date().toISOString(),
      dependencies: {
        ytdlp: {
          version: versions.ytdlp,
        },
        ffmpeg: {
          version: versions.ffmpeg,
        },
      },
    };

    return Response.json(statusObject, { status: 200 });
  },
});

export default async function statusRoute(
  request: Request,
  remoteAddress?: string | null,
): Promise<Response> {
  if (request.method !== "GET") {
    return controller.methodNotAllowed();
  }
  return getHandler(request, remoteAddress);
}
