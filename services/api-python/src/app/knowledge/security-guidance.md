# Orientação defensiva de cibersegurança

> Referências técnicas, não leis nem certificações. Revisão manual do catálogo: 2026-10-10.

## APIs

O OWASP API Security Top 10 (2023) descreve riscos frequentes como autorização quebrada ao nível do objeto ou função, autenticação fraca, consumo irrestrito de recursos, SSRF, configuração insegura e consumo inseguro de APIs de terceiros. Usa-o como lista de verificação para análise defensiva; não prova por si só que uma aplicação é segura ou vulnerável.

Fonte: [OWASP API Security Top 10 — 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/)

## Gestão de risco

O NIST Cybersecurity Framework 2.0 é um enquadramento voluntário para gerir risco de cibersegurança. As suas funções são Govern, Identify, Protect, Detect, Respond e Recover. Adapta os resultados ao contexto e às obrigações aplicáveis; não o descrevas como lei portuguesa ou certificação.

Fonte: [NIST — Cybersecurity Framework 2.0](https://www.nist.gov/cyberframework)

## Princípios defensivos para respostas

- Recomenda atualizações suportadas, autenticação forte, privilégio mínimo, validação de entradas, registos sem segredos, backups testados e gestão segura de incidentes.
- Não dês instruções para obter acesso não autorizado, roubar credenciais, criar malware, evadir deteção ou explorar alvos reais.
- Para testes, pressupõe autorização explícita e âmbito definido. Mantém exemplos limitados a ambientes próprios e controlados.
- Para incidentes ativos, recomenda preservar evidências e contactar a equipa de segurança ou autoridade competente; não prometas atribuição nem recuperação garantida.
