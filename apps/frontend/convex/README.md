# Preferências Convex cifradas

As funções `preferences.get` e `preferences.save` exigem uma identidade Convex. O proprietário, o produto e o idioma são cifrados juntos com AES-256-GCM antes de serem gravados. O índice contém apenas um HMAC-SHA-256 do proprietário e do produto; não é possível consultar as preferências sem a chave.

Isto prepara e cifra as funções Convex; o frontend ainda não está ligado a um emissor de identidade nem a um deployment Convex.

## Chave

Defina `CONVEX_PREFERENCES_MASTER_KEY_V1` separadamente em cada deployment Convex. Gere 32 bytes aleatórios e codifique-os em Base64:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
pnpm exec convex env set CONVEX_PREFERENCES_MASTER_KEY_V1 "<valor-gerado>"
```

Execute o segundo comando na pasta `apps/frontend`, depois de configurar a CLI para o deployment correto. Use chaves distintas em desenvolvimento e produção. Nunca use o prefixo `VITE_` nem grave a chave no repositório.

A chave é derivada com HKDF para separar os usos de cifragem e indexação. Cada gravação usa um IV de 96 bits gerado pelo PRNG com seed que o runtime Convex disponibiliza como `Math.random()`, preservando a determinância das mutações e a segurança em caso de repetição automática. Os dados cifrados e o IV são autenticados em conjunto. Se a variável estiver ausente, malformada ou corresponder a uma chave incorreta, as funções falham explicitamente.

O campo `keyVersion` identifica a chave usada. Não substitua a chave v1 sem primeiro implementar e executar uma migração que decifre e volte a cifrar todos os registos: perder ou substituir a chave torna os dados existentes irrecuperáveis. A cifragem é feita no backend, portanto protege os valores contra leitura direta da base de dados, mas não é cifragem ponta a ponta: as funções autorizadas do Convex conseguem decifrá-los.
