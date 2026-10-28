import config from "infra/config";
import { authenticate } from "infra/access";
import {
  AccessDeniedError,
  InternalServerError,
  LoginRequiredError,
  MethodNotAllowedError,
  ServicesError,
  TooManyRequestsError,
  UnsupportedPlatformError,
  ValidationError,
  VideoUnavailableError,
  YtDlpFailedError,
} from "infra/errors";
import rateLimitStore from "infra/rateLimit";
import logger from "models/logger";

// TS: `export type` exporta um apelido de tipo para o objeto de contexto de cada requisição Web.
export type RequestContext = {
  requestId: string;
  clientIp: string;
  principal?: string;
};

// TS: união para aceitar tanto `Request` padrão da Web (Headers com `.get()`) quanto objetos simples de teste.
export type ClientIpSource = {
  headers: Headers | Record<string, string | string[] | undefined>;
  remoteAddress?: string | null;
  socket?: {
    remoteAddress?: string;
  };
};

type RouteOptions = {
  event: string;
  message: string;
  rateLimit?: "inspect" | "download";
  handler: (
    request: Request,
    context: RequestContext,
  ) => Promise<Response> | Response;
};

const ignoredPaths = ["/api/v1/status"];

const publicErrors = [
  AccessDeniedError,
  ValidationError,
  UnsupportedPlatformError,
  VideoUnavailableError,
  LoginRequiredError,
  TooManyRequestsError,
  YtDlpFailedError,
  ServicesError,
];

function methodNotAllowed(): Response {
  const publicErrorObject = new MethodNotAllowedError();
  return Response.json(publicErrorObject, {
    status: publicErrorObject.statusCode,
  });
}

function handleRoute(options: RouteOptions) {
  return async function routeHandler(
    request: Request,
    remoteAddress?: string | null,
  ): Promise<Response> {
    const requestId = crypto.randomUUID();
    const clientIp = getClientIp({
      headers: request.headers,
      remoteAddress,
    });
    const logReq = {
      method: request.method,
      url: request.url,
      context: { request_id: requestId },
    };
    const extraHeaders = new Headers({ request_id: requestId });

    try {
      const principal = ignoredPaths.includes(new URL(request.url).pathname)
        ? null
        : authenticate(request);
      const allowedHosts = process.env.ALLOWED_HOSTS?.split(",");
      if (
        allowedHosts &&
        !allowedHosts.includes(new URL(request.url).hostname)
      ) {
        throw new ValidationError({
          message: "Host da requisição não permitido.",
        });
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        const origin = request.headers.get("origin");
        if (
          (origin &&
            origin !==
              (process.env.APP_ORIGIN || new URL(request.url).origin)) ||
          request.headers.get("sec-fetch-site") === "cross-site"
        ) {
          throw new ValidationError({
            message: "Origem da requisição não permitida.",
          });
        }
      }
      if (options.rateLimit) {
        checkRateLimit(options.rateLimit, clientIp, extraHeaders);
      }

      const response = await options.handler(request, {
        requestId,
        clientIp,
        principal: principal || undefined,
      });
      const headers = new Headers(response.headers);
      headers.set("request_id", requestId);

      const pathname = new URL(request.url).pathname;
      if (!ignoredPaths.includes(pathname) && response.status < 400) {
        logger.info({
          event: options.event,
          message: options.message,
          request: logReq,
          statusCode: response.status,
        });
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      // TS: `error instanceof type` verifica se o erro é instância da classe. O `some` não estreita o tipo de `error`, por isso usamos `as` abaixo.
      // TS: `InstanceType<T>` é tipo utilitário (tipo da instância de uma classe). `(typeof x)[number]` pega o tipo de um item do array.
      const publicErrorObject = publicErrors.some(
        (type) => error instanceof type,
      )
        ? (error as InstanceType<(typeof publicErrors)[number]>)
        : new InternalServerError({ cause: error });

      logRequestError(logReq, publicErrorObject, error);

      return Response.json(publicErrorObject, {
        status: publicErrorObject.statusCode,
        headers: extraHeaders,
      });
    }
  };
}

function checkRateLimit(
  name: "inspect" | "download",
  clientIp: string,
  headers: Headers,
) {
  const settings = config.get();
  const limit =
    name === "inspect"
      ? settings.rateLimitInspectPerMinute
      : settings.rateLimitDownloadPerMinute;

  const result = rateLimitStore.hit(`${name}:${clientIp}`, limit);
  if (result.allowed) return;

  headers.set("Retry-After", String(result.retryAfterSeconds));
  throw new TooManyRequestsError({
    action: `Aguarde ${result.retryAfterSeconds} segundos e tente novamente.`,
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError({
      message: "Não foi possível interpretar o valor enviado.",
      action: "Verifique se o valor enviado é um JSON válido.",
    });
  }
}

function logRequestError(
  request: { method?: string; url?: string; context?: { request_id?: string } },
  // TS: tipo de objeto escrito direto na anotação: exige essas três propriedades.
  publicError: { name: string; message: string; statusCode: number },
  originalError: unknown,
) {
  const params = {
    event: getEventError(publicError.name),
    message: publicError.message,
    request,
    statusCode: publicError.statusCode,
    error: originalError,
  };

  if (publicError.statusCode >= 500) return logger.error(params);
  if (publicError.statusCode === 404) return logger.info(params);
  return logger.warn(params);

  function getEventError(name: string) {
    if (name === "ValidationError") return "validation.failed";
    if (name === "UnsupportedPlatformError") return "platform.unsupported";
    if (name === "VideoUnavailableError") return "video.unavailable";
    if (name === "LoginRequiredError") return "video.login_required";
    if (name === "TooManyRequestsError") return "rate_limit.exceeded";
    if (name === "YtDlpFailedError") return "ytdlp.failed";
    return "request.failed";
  }
}

function getClientIp(source: ClientIpSource): string {
  if (config.get().trustProxy) {
    const rawHeader =
      source.headers instanceof Headers
        ? source.headers.get("x-forwarded-for")
        : source.headers["x-forwarded-for"];
    // TS: `Array.isArray` estreita o tipo: no ramo verdadeiro, o TS sabe que `rawHeader` é um array.
    const first = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)
      ?.split(",")[0]
      ?.trim();
    if (first) return first;
  }
  return source.remoteAddress || source.socket?.remoteAddress || "unknown";
}

function contentDisposition(filename: string) {
  const asciiFallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "_")
    .trim();
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  const fallback =
    !asciiFallback || asciiFallback.startsWith(".")
      ? `download${asciiFallback}`
      : asciiFallback;

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const controller = {
  handleRoute,
  methodNotAllowed,
  readJsonBody,
  getClientIp,
  contentDisposition,
};

export default controller;
