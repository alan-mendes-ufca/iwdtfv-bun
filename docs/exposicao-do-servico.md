# Formas de acesso

O perfil padrão publica apenas `127.0.0.1:8080`. Os valores reais de endereço, origem e identidades pertencem ao `.env`, conforme [README](../README.md).

Para acesso pessoal remoto, o perfil implementado é Tailscale Serve com HTTPS e gateway por socket privado. Siga [o guia do Raspberry](raspberry-deploy.md). A autenticação depende dessa fronteira de rede; configurar `APP_AUTH_MODE=tailscale` em um backend exposto diretamente não torna os cabeçalhos confiáveis.

O override `compose.tailnet.yaml` permite publicar HTTP no IP Tailscale definido por `TAILSCALE_ADDRESS`; ele não implementa por si só a identidade HTTPS do perfil autenticado e não deve ser combinado com `compose.authenticated.yaml`.

Para experimentar acesso LAN anônimo, configure `BIND_ADDRESS` e `ALLOWED_HOSTS` no `.env`, considerando que os dispositivos com acesso poderão consumir CPU, memória e banda. Não compartilhe sessão privada nesse perfil.

A implantação atual foi desenhada para um servidor próprio com processos yt-dlp/FFmpeg e armazenamento temporário. Outros proxies e hospedagens exigem verificar suporte ao runtime, subprocessos, limites de recursos, prazo de preparação e tamanho das respostas. Esta versão não inclui integração pronta para plataformas serverless ou serviço público multiusuário.

Publicar o repositório não altera a exposição da instância instalada.
