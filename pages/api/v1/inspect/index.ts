import controller from "infra/controller";
import validateRequest from "models/validateRequest";
import video from "models/video";

const postHandler = controller.handleRoute({
  event: "video.inspected",
  message: "Vídeo inspecionado com sucesso.",
  rateLimit: "inspect",
  async handler(request: Request, context) {
    const rawBody = await controller.readJsonBody(request);
    // TS: <{ url: string }> passa um tipo de objeto como argumento do genérico de validateRequest.
    const { url } = validateRequest<{ url: string }>(rawBody, {
      url: "required",
    });

    const videoInfo = await video.inspect(url, {
      signal: request.signal,
      principal: context.principal,
    });

    return Response.json(videoInfo, { status: 200 });
  },
});

export default async function inspectRoute(
  request: Request,
  remoteAddress?: string | null,
): Promise<Response> {
  if (request.method !== "POST") {
    return controller.methodNotAllowed();
  }
  return postHandler(request, remoteAddress);
}
