# Implantação privada no Raspberry Pi

Este guia é um modelo reproduzível; os endereços, usuários e caminhos da instalação devem ficar no `.env` ignorado pelo Git. Execute os comandos na raiz do checkout. Requisitos: Raspberry Pi 5 com Linux ARM64, Docker/Compose com `!override` e Tailscale conectado à sua rede privada.

## Perfil local

Copie `.env.example` para `.env`, restrinja suas permissões a `0600` e execute `docker compose up -d --build`. A base publica o gateway somente no loopback, em `http://localhost:8080`.

## Perfil HTTPS com identidade Tailscale

No `.env`, selecione:

```dotenv
COMPOSE_FILE=infra/compose.yaml:infra/compose.authenticated.yaml
APP_AUTH_MODE=tailscale
ALLOWED_HOSTS=localhost,127.0.0.1,seu-no.sua-tailnet.ts.net
APP_ALLOWED_USERS=seu-login-exato
APP_ORIGIN=https://seu-no.sua-tailnet.ts.net
SERVE_SOCKET_DIRECTORY=/caminho/privado/serve
```

Substitua os exemplos somente no `.env`. O nome deve corresponder ao nó Tailscale e a identidade deve corresponder ao login fornecido pelo Serve. Para mais de uma identidade, use uma lista separada por vírgula.

Prepare o diretório de socket como UID/GID `101:101` (Nginx da imagem utilizada), modo `0700`; confirme o UID ao atualizar a imagem. O diretório precisa ser persistente e acessível pelo daemon Tailscale, mas não por usuários comuns. Não inclua o override `compose.tailnet.yaml` neste perfil.

Carregue os valores do seu próprio `.env` no shell para executar os comandos administrativos:

```sh
set -a
. ./.env
set +a
sudo install -d -o 101 -g 101 -m 0700 "$SERVE_SOCKET_DIRECTORY"
docker compose config --quiet
docker compose up -d --build
sudo tailscale serve --bg --https=443 --yes "unix:$SERVE_SOCKET_DIRECTORY/http.sock"
tailscale serve status
```

Use um `.env` com sintaxe compatível com shell para esse procedimento e carregue apenas arquivos confiáveis. O Tailscale Serve faz o HTTPS e fornece a identidade ao gateway por socket Unix; o perfil não publica portas TCP. Não conceda acesso ao socket a usuários não confiáveis nem publique o gateway fora dessa fronteira. O frontend e o healthcheck têm comportamento diferente das rotas de inspeção/download, que exigem identidade autorizada.

## Sessão dedicada opcional do YouTube

Sem sessão é o padrão. Para permitir uma repetição autenticada após erro de login, use arquivo Netscape de uma conta dedicada contendo somente cookies de `youtube.com` e subdomínios. Mantenha esse arquivo fora do checkout, com modo `0600`, legível pelo UID 1000 do app. O diretório pai deve ser privado.

No `.env`:

```dotenv
COMPOSE_FILE=infra/compose.yaml:infra/compose.authenticated.yaml:infra/compose.youtube-session.yaml
YOUTUBE_COOKIES_FILE=/caminho/privado/youtube-cookies.txt
```

Recrie com `docker compose up -d`. O secret é montado somente no app, como `/run/secrets/youtube_cookies`. O conteúdo não vai para `.env`, imagem ou Git. Compose não criptografa o arquivo do host. A aplicação valida formato/domínio/permissões e usa uma cópia temporária; somente o YouTube recebe a sessão, após falha anônima e com identidade autorizada. Vários logins autorizados compartilham essa conta; não há isolamento de sessão por usuário.

## Recursos e operação

O Compose usa um download por vez, limite de 256 MiB por arquivo, `/tmp` em tmpfs de 2 GiB, rootfs somente leitura e nenhum volume de vídeos montado. Valide memória disponível, cgroups e swap na sua máquina. tmpfs pode usar swap; para evitar mídia no SD, não use swap em disco. Imagens, código e logs continuam ocupando disco.

```sh
docker compose ps
docker compose logs -f --tail=100
docker compose stop
docker compose up -d
docker compose up -d --build
```

Habilite Docker e Tailscale no boot conforme o sistema operacional. `unless-stopped` não reativa serviços parados intencionalmente. Teste um reboot controlado antes de depender da recuperação automática.

## Verificação após implantar

Confira saúde dos três serviços, resposta da interface por HTTPS e inspeção/download com identidade autorizada. Teste rejeição de identidade ausente ou não permitida e de URLs internas. Confirme que as APIs antigas de jobs/arquivos retornam 404, que temporários desaparecem após sucesso/erro/cancelamento e que nenhum gateway TCP foi publicado no perfil autenticado.

Os testes e medições históricos não comprovam a configuração de uma nova instalação. Cookies podem expirar e mudanças das plataformas podem exigir atualização do yt-dlp.
