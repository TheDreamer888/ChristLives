# Segurança da Cloudflare como código

`security.json` descreve a proteção da zona e `apply_security.py` aplica-a pela
API da Cloudflare. O workflow **Cloudflare Security** corre isto a partir do GitHub.

## O que é configurado

- **HTTPS:** redirecionar sempre para HTTPS, reescrever ligações `http://`, TLS 1.2
  no mínimo e TLS 1.3 ligado. Modo SSL `full`.
- **Nível de segurança médio** e verificação de integridade do browser.
- **Regras de firewall:** bloqueiam sondagens (`/.env`, `/.git`, `/wp-*`,
  `phpmyadmin`, ficheiros `.php`…) e métodos HTTP que o site não usa.
- **Limite de pedidos:** 50 pedidos a cada 10 s por IP em `/api/`, com bloqueio de
  10 s. É o máximo que o plano gratuito permite.

A proteção contra DDoS da Cloudflare está sempre ligada e não precisa de configuração.

**Atenção:** as regras personalizadas e de rate limiting **substituem** as que
existirem no painel. Faz as alterações aqui, não no painel.

## Pôr a funcionar

1. Cria um token em *My Profile → API Tokens* com **Zone Settings: Edit** e
   **Zone WAF: Edit**, limitado só ao teu domínio.
2. Guarda o token e o Zone ID como segredos do ambiente `infra-production`:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --env infra-production
   gh secret set CLOUDFLARE_ZONE_ID --env infra-production
   ```
3. Em *Actions → Cloudflare Security → Run workflow*, corre primeiro sem
   **Aplicar** para ver a simulação, depois com **Aplicar** ligado.

Testar localmente (sem credenciais, só simula):

```bash
cd infra/cloudflare
python -m pytest -q
python apply_security.py
```

**GitHub Pages:** enquanto o GitHub emite o certificado do domínio, deixa o
registo DNS como *DNS only*. Só depois liga o proxy da Cloudflare (nuvem
laranja). Caso contrário, a emissão do certificado falha.
