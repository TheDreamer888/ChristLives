# Base de conhecimento do assistente

O assistente consulta o catálogo fechado em `catalog.json` e as regras em
`assistant_policy.md`. `legal-pt-eu.md` e `security-guidance.md` são as versões
legíveis para revisão humana; o catálogo contém os excertos efetivamente usados
na recuperação. Mantém ambos alinhados ao editar conteúdo.

Cada entrada de documento inclui um ID único, título, URL, autoridade,
`reviewed_at`, palavras-chave e um excerto. A data é de revisão manual do
catálogo, não sincronização automática da fonte. Os URLs externos são limitados
a HTTPS e a domínios aprovados no router; caminhos internos também são
explicitamente limitados. Não alargues a allowlist sem rever a origem.

Rotas:

- `GET /api/assistant/knowledge/sources` lista fontes aprovadas.
- `GET /api/assistant/knowledge/search?q=...&limit=...` pesquisa localmente
  (1–10 resultados); não consulta a web nem faz crawling.
- `POST /api/assistant/chat` responde com até três excertos recuperados e só
  devolve citações que estavam nesses excertos.

Ao rever conteúdo legal ou de segurança, consulta as referências oficiais e
atualiza `reviewed_at`. A base não certifica conformidade nem substitui
aconselhamento profissional. Considera conteúdo externo não confiável e nunca
copies instruções operacionais perigosas para os excertos.
