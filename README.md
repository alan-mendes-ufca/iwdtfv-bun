# iwdtfv-bun

**I want to download this fucking video**, versão self-hosted em Bun e React para consultar formatos e baixar vídeos do YouTube, X, TikTok e Instagram. Cole uma URL, escolha a qualidade disponível ou áudio MP3 e receba o arquivo no navegador.

Este projeto deriva da versão [iwdtfv](https://github.com/alan-mendes-ufca/iwdtfv). A implementação atual usa o servidor, subprocessos, arquivos, bundler e test runner do Bun. O destino de implantação é um Raspberry Pi 5 com Linux ARM64, Docker Compose e acesso privado por Tailscale Serve. Também é possível executar em Linux com Bun ou Docker compatível com a arquitetura.

## Tecnologias

| Camada           | Tecnologia e finalidade                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| Runtime e HTTP   | Bun 1.4.3 na imagem; `Bun.serve` e Web `Request`/`Response`                   |
| Interface        | React 19, TypeScript, CSS, canvas e fonte Silkscreen incluída com licença OFL |
| Build            | Bundler HTML do Bun, sem Next.js no runtime                                   |
| Validação        | Joi; TypeScript em modo estrito                                               |
| Download         | yt-dlp 2026.08.19 fixado com SHA-256 no Dockerfile                            |
| Mídia            | FFmpeg instalado pela distribuição Debian da imagem                           |
| Proxy de entrada | Nginx, com transferência sem buffering de mídia                               |
| Saída de rede    | Squid, com bloqueio de destinos internos                                      |
| Acesso privado   | Tailscale Serve no host, HTTPS e identidade por cabeçalho verificado          |
| Testes           | `bun test`, fixtures e executável falso do yt-dlp                             |
| Qualidade        | ESLint, Prettier, TypeScript, Secretlint, Husky e Conventional Commits        |
| Automação        | GitHub Actions para testes e qualidade em pull requests                       |

As versões das dependências JavaScript estão fixadas em `package.json` e `bun.lock`. Nginx e pacotes do sistema usam as versões resolvidas durante o build/pull; a imagem completa não é imutável apenas por fixar o lock JavaScript.

## Como funciona

```text
Navegador → Nginx → Bun → yt-dlp / FFmpeg → arquivo temporário → navegador
                         └→ Squid → plataformas de vídeo
```

No perfil privado, Tailscale Serve recebe o HTTPS e encaminha ao Nginx por socket Unix. A aplicação valida a identidade autorizada antes de inspecionar ou baixar. No perfil local, o gateway publica somente `127.0.0.1:8080` por padrão.

1. A inspeção valida a URL e retorna título, duração, thumbnail e formatos disponíveis.
2. A seleção envia `{ url, format_id }` à API. O servidor baixa e, quando necessário, mescla ou converte com FFmpeg.
3. O arquivo pronto é transmitido com `Content-Disposition: attachment`. A interface usa os bytes recebidos para mostrar o progresso da transferência e inicia o salvamento via Blob.
4. Conclusão, erro e cancelamento acionam a limpeza dos temporários. Mantenha a página aberta durante o fluxo.

A etapa de preparação usa uma estimativa visual; ela não mede o percentual real do yt-dlp. O navegador recebe o arquivo antes de iniciar seu salvamento, portanto arquivos maiores também consomem recursos do cliente.

## Decisões de arquitetura

- **Bun em lugar de Next.js/Node:** a implementação concentra HTTP, empacotamento HTML, subprocessos e testes no mesmo runtime. Este repositório preserva o fluxo de domínio da versão original, com APIs nativas do Bun.
- **Servidor próprio e processo único:** yt-dlp e FFmpeg exigem processos externos, tempo de preparação e armazenamento temporário. Contadores de concorrência, rate limit e cache ficam na memória deste processo; múltiplas réplicas exigiriam coordenação externa.
- **Preparar antes de transmitir:** permite verificar erros e produzir o arquivo final antes da resposta de download. Proxies precisam tolerar o tempo de preparação sem receber o corpo.
- **RAM para mídia no Docker:** `/tmp` é um tmpfs de 2 GiB e a aplicação tem rootfs somente leitura. Não há volume de biblioteca montado. Fora do Docker, `TEMP_DIR` usa o armazenamento configurado no host.
- **Um download por vez e 256 MiB por arquivo:** padrões do Compose adequados ao perfil pessoal no Raspberry, com verificação de espaço livre e timeouts. O valor máximo de arquivo não equivale ao pico de RAM: mesclagem, processos e cópias temporárias também consomem memória.
- **Redes separadas:** a aplicação está em rede Docker interna; Nginx recebe requisições e Squid controla a saída do downloader. Validação de URLs e bloqueio de destinos privados são camadas complementares.
- **Acesso privado por identidade:** o perfil Tailscale confia nos cabeçalhos apenas dentro da fronteira Serve → socket privado → gateway. Expor diretamente esse gateway permitiria falsificar a identidade.
- **Sem sessão por padrão:** cookies opcionais pertencem a uma conta dedicada do YouTube. A primeira tentativa é anônima; só um erro de login permite uma repetição autenticada, para um usuário autorizado. Outras plataformas não recebem esse arquivo.
- **Cache curto:** quando habilitado e com sessão dedicada configurada, metadados do YouTube ficam até 60 segundos em RAM, isolados por usuário, URL e identidade do arquivo de sessão. Limites: quatro entradas e 8 MiB; consumo único.
- **Até quatro fragmentos concorrentes:** melhora potencialmente formatos DASH/HLS fragmentados, sem paralelizar arquivos HTTP simples. Não aumenta o limite de vídeos simultâneos.

O código legado de biblioteca/jobs ainda existe em módulos auxiliares, mas suas rotas não são registradas. A versão atual não oferece biblioteca persistente, fila durável ou retomada de downloads após reinício.

## Configuração privada em `.env`

```sh
cp .env.example .env
chmod 600 .env
```

Edite **somente `.env`** com os endereços, usuários e caminhos reais. Bun o carrega ao iniciar na raiz do projeto; Docker Compose o usa para interpolar a configuração. O Compose encaminha explicitamente as variáveis necessárias ao contêiner, sem montar ou copiar todo o `.env`.

`.env*` está ignorado pelo Git, com exceção de `.env.example`. O contexto Docker também exclui arquivos `.env*`, cookies e segredos. O repositório contém somente valores genéricos. Cookies continuam em arquivo externo: `.env` guarda o caminho, nunca o conteúdo da sessão.

| Variável                                                          | Finalidade                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `COMPOSE_FILE`                                                    | Seleção dos perfis Docker                                                                    |
| `BIND_ADDRESS`, `PORT`                                            | Endereço publicado e porta do gateway; em Bun direto, `PORT` é a porta HTTP                  |
| `HOSTNAME`                                                        | Interface do servidor Bun direto; no contêiner é fixada em `0.0.0.0`                         |
| `ALLOWED_HOSTS`                                                   | Hosts permitidos, separados por vírgula                                                      |
| `APP_AUTH_MODE`                                                   | `none` ou `tailscale`; override autenticado exige `tailscale`                                |
| `APP_ALLOWED_USERS`, `APP_ORIGIN`                                 | Identidades autorizadas e origem HTTPS privada                                               |
| `SERVE_SOCKET_DIRECTORY`                                          | Diretório privado do socket do gateway                                                       |
| `YOUTUBE_COOKIES_FILE`                                            | Caminho externo do secret de sessão, usado pelo Compose opcional                             |
| `YTDLP_COOKIES_MODE`, `YTDLP_COOKIES_FILE`                        | Política e caminho interno da sessão para execução direta; definidos pelo override no Docker |
| `YTDLP_BINARY`, `YTDLP_JS_RUNTIMES`, `YTDLP_PROXY`                | Executável, runtime JS e proxy do downloader; o Docker usa seu binário e proxy internos      |
| `TEMP_DIR`, `TRUST_PROXY`                                         | Temporários e confiança em proxy; Docker fixa `/tmp/iwdtfv` e `1`                            |
| `MAX_DURATION_SECONDS`                                            | Duração máxima, padrão 7200 segundos                                                         |
| `MAX_FILESIZE_BYTES`, `MIN_FREE_BYTES`                            | Limite por arquivo e reserva mínima de espaço; modelo: 256 MiB cada                          |
| `MAX_CONCURRENT_DOWNLOADS`                                        | Downloads simultâneos; modelo: 1                                                             |
| `INSPECT_TIMEOUT_MS`, `DOWNLOAD_TIMEOUT_MS`                       | Prazos de inspeção e download; 30000 e 900000 ms                                             |
| `RATE_LIMIT_INSPECT_PER_MINUTE`, `RATE_LIMIT_DOWNLOAD_PER_MINUTE` | Limites por IP; 20 e 5                                                                       |
| `PERFORMANCE_METADATA_CACHE`, `YTDLP_FRAGMENT_CONCURRENCY`        | Cache opcional e fragmentos concorrentes                                                     |
| `BENCH_ROOT`                                                      | Diretório local de fontes para a matriz histórica de benchmarks                              |

O modelo escolhe limites conservadores. Sem variáveis explícitas, alguns padrões de `infra/config.ts` diferem: dois downloads simultâneos e 2 GiB por arquivo. Use o `.env` para obter uma configuração explícita. Limites físicos de tmpfs, CPU e memória estão no Compose e devem acompanhar a capacidade da máquina.

## Desenvolvimento local

Requisitos: Bun 1.4+, yt-dlp e FFmpeg disponíveis no `PATH`. O Python 3 só é necessário para a matriz opcional de benchmarks.

```sh
bun install --frozen-lockfile
cp .env.example .env
chmod 600 .env
bun run dev
```

Abra **http://localhost:8080** usando o `.env.example`. Sem `PORT`, o servidor usa 3000. O comando `bun run build` gera o frontend em `dist`; `bun run start` inicia o servidor em modo produção. O servidor usa seu entrypoint HTML com o bundler nativo do Bun.

## Docker Compose

Requer Docker Engine e Compose com suporte a `!override` (Compose 2.24.4 ou superior). Execute na raiz:

```sh
cp .env.example .env
chmod 600 .env
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Abra **http://localhost:8080**. São três serviços: `gateway`, `app` e `egress`. A base é anônima e restrita ao loopback do host; não a exponha diretamente como se fosse o perfil autenticado.

```sh
docker compose logs -f --tail=100
docker compose stop
docker compose up -d
docker compose up -d --build
```

`restart: unless-stopped` reativa contêineres após reinício do Docker, exceto os parados intencionalmente. O Docker precisa estar habilitado no boot. O volume `data` é legado e não está montado pela aplicação; removê-lo pode apagar dados de instalações anteriores.

### Raspberry Pi e HTTPS privado

Siga [o guia de implantação](docs/raspberry-deploy.md). Ele cobre o `.env`, o diretório de socket, Tailscale Serve e o perfil opcional de sessão dedicada. Nenhum hostname, login, IP ou caminho pessoal é necessário no código versionado.

O ambiente alvo usa Raspberry Pi 5/Linux ARM64. O Dockerfile seleciona o binário yt-dlp por arquitetura AMD64/ARM64. Não há garantia de execução nas demais arquiteturas. Verifique suporte real do kernel aos limites de cgroup e à configuração de swap: tmpfs pode ser paginado, portanto evitar gravações de mídia no SD também depende de não haver swap em disco. Código, imagens Docker e logs continuam usando disco.

## API

| Método | Rota               | Resposta                                                          |
| ------ | ------------------ | ----------------------------------------------------------------- |
| GET    | `/api/v1/status`   | Estado das dependências yt-dlp e FFmpeg                           |
| POST   | `/api/v1/inspect`  | `{ url }` → metadados e formatos                                  |
| POST   | `/api/v1/download` | `{ url, format_id }` → arquivo; `format_id: "audio"` solicita MP3 |

Erros usam `{ name, message, action, status_code }`. Rotas antigas de jobs e arquivos retornam 404. O healthcheck interno é independente da identidade usada nas operações de vídeo.

## Segurança e limites funcionais

URLs usam uma lista de plataformas permitidas; IPs e destinos locais são recusados. O subprocesso recebe argumentos separados, sem shell. A aplicação verifica Host/origem, formato, duração, tamanho, espaço livre, prazos e concorrência. Nginx não armazena a resposta de mídia em arquivos temporários.

A disponibilidade depende da plataforma, da rede de saída e do yt-dlp. Vídeos privados, removidos, com DRM ou exigências de login podem falhar. Uma rede residencial não garante acesso. A sessão dedicada pode expirar ou ser revogada; o secret do Compose não criptografa seu arquivo no host. Permitir mais usuários compartilha essa sessão entre eles.

Publicar o **código** não publica o serviço: a implantação privada continua dependendo de configuração local. Este perfil pessoal não implementa cotas por identidade, isolamento de sessão por usuário, fila distribuída ou operação pública multiusuário.

## Testes e manutenção

```sh
bun run test
bun run typecheck
bun run lint:eslint:check-dir
bun run lint:prettier:check
bunx secretlint '**/*'
```

A suíte padrão usa um yt-dlp falso e fixtures, sem baixar vídeos reais. `bun run test:real` acessa plataformas e depende da disponibilidade externa. Execute testes em uma configuração local própria, sem reutilizar o `.env` privado de produção.

Atualizações do yt-dlp exigem revisar `YTDLP_VERSION` e os checksums por arquitetura em `infra/Dockerfile`, reconstruir a imagem e validar inspeção, transferência, cancelamento e limpeza. Não atualize apenas o número da versão mantendo hashes antigos.

[O relatório de desempenho](docs/performance/raspberry-20261017.md) preserva resultados históricos e suas limitações. Ele não substitui uma execução atual da suíte nem promete o mesmo tempo para outros vídeos, redes ou máquinas.

## Estrutura

```text
infra/                 HTTP, acesso, proxies, downloader, temporários e Docker
models/                Domínio, formatos, plataformas, validação e logs
pages/                 Interface React, assets locais e rotas da API
tests/                 Testes unitários, integração, fixtures e use cases
scripts/performance/   Benchmarks e matriz experimental
.env.example           Modelo público de configuração
```

## Licença

MIT, conforme [LICENSE](LICENSE). A fonte Silkscreen tem sua [licença OFL](pages/assets/Silkscreen-OFL.txt).
