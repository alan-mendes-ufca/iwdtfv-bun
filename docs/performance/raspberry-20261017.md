# Experimentos de velocidade no Raspberry Pi 5

## Resultado aplicado

A branch `perf/validated` usa cache de metadados de 60 segundos, quatro fragmentos concorrentes quando o formato permite e a barra pixelada progressiva. Não inclui o cache adicional de autenticação nem o protocolo experimental de download nativo.

No vídeo público de teste de 5 segundos, 360p, a mediana do fluxo no backend caiu de **24,539 s para 13,083 s (46,7%)** com reaproveitamento dos metadados. A preparação após escolher a qualidade caiu de **12,623 s para 1,383 s (89,0%)**. São medidas desse caso, não promessa para qualquer vídeo ou conexão celular.

## Branches e comparação

| Branch                    | Revisão medida | Mediana total | Mediana após escolher qualidade | Observação                                                                  |
| ------------------------- | -------------- | ------------: | ------------------------------: | --------------------------------------------------------------------------- |
| `perf/baseline-20261017`  | `bf53dbe`      |      24,539 s |                        12,623 s | Estado anterior preservado                                                  |
| `perf/auth-hint`          | `f13d33d`      |      19,857 s |                         8,136 s | Evita repetir tentativa anônima para o mesmo usuário/vídeo                  |
| `perf/metadata-cache`     | `4152154`      |      13,083 s |                         1,383 s | Melhor ganho consistente, menos extração remota                             |
| `perf/combined`           | `f0e42a3`      |      13,221 s |                         1,359 s | Os dois caches não somaram ganho nesse fluxo                                |
| `perf/fragments`, N=2     | `f2a4cb4`      |      25,373 s |                        11,741 s | Formato HTTP simples; flag não paraleliza esse arquivo                      |
| `perf/fragments`, N=4     | `f2a4cb4`      |      22,340 s |                        10,416 s | Variação de rede não demonstra ganho de fragmentos HTTP                     |
| `perf/combined-fragments` | `2c53ef5`      |      12,731 s |                         1,247 s | Dois ensaios comparáveis; sem ganho adicional demonstrado sobre o cache     |
| `perf/native-delivery`    | `97ae209`      | Não comparado |                   Não comparado | Download real funcionou, mas automação demorou a retornar; tempo descartado |
| `ui/pixel-progress`       | `832f474`      |             — |                               — | Interface testada e integrada com testes no diretório padrão                |

## Método e controles

- Mesmo Raspberry, mesmo yt-dlp/FFmpeg/Bun e mesmas dependências. Containers descartáveis separados da aplicação, usando sua rede de saída controlada; não substituíram produção durante a matriz.
- Vídeo de teste: https://www.youtube.com/watch?v=gHKT4uU8Zng . Três execuções por variante principal, alternando a ordem. Cada execução começou com processo e caches vazios.
- Medida total: consulta das qualidades + preparação do arquivo + leitura local e limpeza. Não inclui o tempo humano escolhendo qualidade nem transferência pela internet ao celular. A medição usa o mesmo modelo da API com uma identidade sintética, dentro de container administrativo isolado; a autenticação HTTP real foi validada separadamente.
- Os 18 arquivos da matriz 360p tinham 87.816 bytes e SHA-256 `30dc3df6e414498044503c3bf3e1693d5a05ea9ebe1addbdc664df1716640abd`. Todos os jobs temporários terminaram vazios.
- O primeiro ensaio de infraestrutura usou limites padrão incompatíveis com o tmpfs e falhou antes de baixar. Foi descartado; os dados publicados são da execução corrigida com os limites de produção.
- Na combinação com fragmentos, uma execução recebeu outros formatos na consulta anônima e escolheu 144p. Ela foi excluída da comparação 360p; os dados brutos a preservam. O script reproduzível foi corrigido para falhar quando o formato solicitado estiver indisponível, sem substituí-lo silenciosamente.
- Verificação 1080p separada, uma execução por versão: original **22,642 s**, cache **13,516 s**. Ambos geraram 103.427 bytes com SHA-256 `ec17b28a77fca2c41d78e1dea4085a798032092c2ef98e5003b03126aadf5b63`. Não constitui comparação estatística em 1080p.

## Fragmentos HLS

Fixture sintética de 6 segundos, gerada pelo FFmpeg, servidor local com atraso de 120 ms por segmento e container sem rede externa nem cookies. Três rodadas:

| Fragmentos concorrentes | Mediana | Integridade                 |
| ----------------------- | ------: | --------------------------- |
| 1                       | 2,883 s | 81.276 bytes, hash idêntico |
| 2                       | 2,537 s | Idêntica                    |
| 4                       | 2,425 s | Idêntica                    |

Quatro fragmentos foram **15,9% mais rápidos nessa fixture**. A opção [oficial do yt-dlp](https://github.com/yt-dlp/yt-dlp#download-options) se aplica a downloads DASH/HLS nativos fragmentados; não transforma um arquivo HTTP comum em download paralelo. O ganho em vídeos HLS reais das plataformas ainda não foi quantificado. Continua permitido apenas um vídeo por vez.

## Entrega nativa e interface

A branch nativa aceita formulário POST na mesma API, com autenticação e validação de origem. Seus 168 testes passaram. Um download pelo navegador em HTTPS privado 8443 foi salvo no computador e teve os mesmos bytes/hash do fluxo Blob. A automação levou tempo excessivo para retornar; esse tempo não foi tratado como medida de velocidade.

Essa alternativa evita montar Blob no JavaScript, mas a página não recebe confirmação confiável do término do salvamento e perde controle do progresso/cancelamento. Por isso ficou experimental. O endereço 8443 e os containers temporários são removidos ao terminar os testes.

Na versão aplicada, a barra tem blocos e cantos retos, sem animação circular. A preparação usa estimativa visual crescente limitada a 75%, identificada na acessibilidade, sem percentual numérico inventado na tela. A transferência usa os bytes recebidos e `Content-Length`; só completa após receber o corpo inteiro e iniciar o salvamento. Cancelamento, erros e resposta truncada não completam a barra. Redução de movimento preserva a largura real.

## Segurança e operação

O cache é isolado por usuário, URL exata e identidade do arquivo de sessão, tem limite total de 8 MiB e quatro entradas, é consumido uma vez e nunca vai para disco. A identidade da sessão é comparada antes/depois da inspeção. Cookie e cabeçalhos de autorização são removidos do JSON guardado. A sessão só é usada sob a mesma política de acesso autenticado; URLs de mídia assinadas do cache não saem na API nem nos logs.

Uma falha ao reaproveitar metadados permite uma reextração pelo fluxo normal. As duas tentativas compartilham o mesmo prazo total de download; cancelamento encerra o subprocesso e limpa o job. O processamento continua em tmpfs e não grava os vídeos no SD.

Configuração reversível no `.env` do Raspberry:

```dotenv
PERFORMANCE_METADATA_CACHE=1
YTDLP_FRAGMENT_CONCURRENCY=4
```

Para desligar apenas as otimizações, use `0` e `1`, respectivamente, e execute `docker compose up -d --no-deps app`. Os perfis HTTPS e de sessão permanecem separados e inalterados.

## Evidências e reprodução

- [Matriz principal](raspberry-20261017.jsonl), [combinações](combinations-20261017.jsonl), [1080p](quality-1080-20261017.jsonl), [HLS sintético](hls-fixture-20261017.jsonl).
- `scripts/performance/flow.bench.ts` executa o fluxo e registra somente tempos, contagens, protocolos, tamanho e hash. Não imprime metadados privados nem cookies.
- `scripts/performance/run-matrix.py` orquestra Docker no Raspberry e espera fontes de cada branch em `${BENCH_ROOT}/{baseline,auth-hint,metadata-cache,combined,fragments}`, e `flow.bench.ts` copiado como `bench.ts` na raiz desse diretório. Python 3 é apenas o orquestrador de infraestrutura; aplicação, benchmark e testes usam Bun.
- `scripts/performance/fragments.bench.ts` roda isoladamente na imagem com stdin interativo, tmpfs e `--network none`; gera sua própria mídia de teste e remove o container no final.
- Suíte final: **184 testes, zero falhas**, incluindo isolamento, expiração, rotação, sanitização, fallback, prazo total, cancelamento, corpo truncado e progresso. TypeScript, ESLint e Prettier passaram. O boot físico não foi testado e não houve alteração de serviços de outros projetos.

## Validação da publicação

- Imagem reconstruída no ARM64 com lock congelado; `PERFORMANCE_METADATA_CACHE=1` e `YTDLP_FRAGMENT_CONCURRENCY=4` confirmados no container. Imagem anterior preservada em `iwdtfv-personal:pre-perf-20261017` para rollback.
- HTTPS real: inspeção 200 e download 200. O YouTube retornou 360p com ID 134 nessa execução; inspeção 4,885 s, preparação/recebimento 1,641 s, 91.335 bytes e hash `8ebdbf1a80af5b8b9a7dc8f09804f86397545d5ca669ef25ef6d9b572773124b`. Esse formato diferente não foi misturado à matriz controlada de ID 18.
- Uma checagem com ID 18 fixo falhou quando ele deixou de estar disponível. O teste foi repetido com o ID oferecido pela inspeção atual, como faz a interface. Esse erro não foi contado como medição de velocidade.
- Navegador em viewport 390×844: progresso observado de 0 para 47,5; largura da página 390, campo ~350,6, sem overflow horizontal. Screenshot indisponível na ferramenta; a validação visual foi limitada a DOM, CSS e geometria.
- Download concluído pela interface após atualizar as qualidades; arquivo `~/Downloads/dlp test video title primary (en-GB) (5).mp4`, 91.335 bytes e o mesmo hash acima. Tela retornou ao formulário. A observação por evento de download travou a automação e foi descartada; o teste foi concluído com ação simples e conferência do arquivo no cliente.
- O celular físico do proprietário não foi operado pelo agente. Os resultados não medem banda de upload da residência nem velocidade na rede móvel.
- Containers temporários removidos e Serve 8443 desativado; Serve privado 443 preservado. Temporários da aplicação vazios após o teste; todos os três serviços saudáveis.

Para reproduzir a matriz, configure `BENCH_ROOT` no `.env` e execute `bun run bench:matrix`. As branches históricas citadas pertencem aos experimentos originais e podem não existir neste repositório.
