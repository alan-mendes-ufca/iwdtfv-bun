# Build: docker build -f infra/Dockerfile -t iwdtfv .
# Uso:   docker compose -f infra/compose.yaml up -d --build

ARG BUN_VERSION=1.4.3

# 1. Dependências de produção
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# 2. Imagem final: Bun + ffmpeg + yt-dlp (binário oficial, versão e checksum fixos)
FROM oven/bun:${BUN_VERSION}-slim AS runner
ARG TARGETARCH
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256_AMD64=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
ARG YTDLP_SHA256_ARM64=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ffmpeg ca-certificates curl; \
  case "${TARGETARCH:-amd64}" in \
    amd64) asset=yt-dlp_linux; sum="${YTDLP_SHA256_AMD64}" ;; \
    arm64) asset=yt-dlp_linux_aarch64; sum="${YTDLP_SHA256_ARM64}" ;; \
    *) echo "Arquitetura não suportada: ${TARGETARCH}"; exit 1 ;; \
  esac; \
  curl -fsSL -o /usr/local/bin/yt-dlp \
    "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"; \
  echo "${sum}  /usr/local/bin/yt-dlp" | sha256sum -c -; \
  chmod 0755 /usr/local/bin/yt-dlp; \
  apt-get purge -y curl; \
  apt-get autoremove -y; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    TEMP_DIR=/tmp/iwdtfv \
    YTDLP_JS_RUNTIMES=bun

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun infra ./infra
COPY --chown=bun:bun models ./models
COPY --chown=bun:bun pages ./pages

RUN bun build pages/index.html --outdir /app/dist --minify

USER bun
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/status').then(async r => { const s=await r.json(); process.exit(r.ok && s.dependencies.ytdlp.version && s.dependencies.ffmpeg.version ? 0 : 1); }).catch(() => process.exit(1))"]

CMD ["bun", "infra/server.ts"]
