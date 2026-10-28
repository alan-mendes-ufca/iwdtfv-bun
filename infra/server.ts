import video from "models/video";
import { validateSecurityConfig } from "infra/access";
import indexHtml from "pages/index.html";
import downloadRoute from "pages/api/v1/download";
import inspectRoute from "pages/api/v1/inspect";
import statusRoute from "pages/api/v1/status";

// idleTimeout máximo do Bun.serve (255s); downloads longos mantêm o stream ativo.
const IDLE_TIMEOUT_SECONDS = 255;

export function startServer(port = Number(process.env.PORT || 3000)) {
  const hostname = process.env.HOSTNAME || "0.0.0.0";
  validateSecurityConfig();

  return Bun.serve({
    port,
    hostname,
    maxRequestBodySize: 16 * 1024,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    development: process.env.NODE_ENV !== "production",
    routes: {
      "/": indexHtml,
      "/api/v1/status": (req, server) =>
        statusRoute(req, server.requestIP(req)?.address),
      "/api/v1/inspect": (req, server) =>
        inspectRoute(req, server.requestIP(req)?.address),
      "/api/v1/download": (req, server) => {
        // yt-dlp has its own deadline; preparing a file may take over 255 seconds.
        server.timeout(req, 0);
        return downloadRoute(req, server.requestIP(req)?.address);
      },
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
  });
}

if (import.meta.main) {
  const server = startServer();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    video.abortOperations();
    await server.stop(true);
    await video.waitForCleanup();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`Server listening on http://${server.hostname}:${server.port}`);
}
