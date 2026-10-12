# Infraestrutura Azure

Este diretório define a base de infraestrutura de produção para o monorepo Aegis em Azure, seguindo o padrão de separação por serviço e ambiente já adotado no repositório.

## Recursos provisionados

- Azure Container Registry (ACR) para armazenar as imagens dos serviços
- Azure Container Apps para frontend e API Python
- Azure Log Analytics e Application Insights para observabilidade
- Azure Key Vault para segredos e variáveis sensíveis
- Azure Cache for Redis e Azure Storage para suporte operacional
- Managed Environment para o runtime dos container apps

## Estrutura

- `main.bicep`: template principal da infraestrutura
- `main.parameters.json`: parâmetros de exemplo para deploy

## Deploy

1. Faça login no Azure:

   ```bash
   az login
   ```

2. Crie o resource group do ambiente:

   ```bash
   az group create --name rg-aegis-dev --location eastus
   ```

3. Execute o deploy do template:

   ```bash
   az deployment group create \
     --resource-group rg-aegis-dev \
     --template-file infra/azure/main.bicep \
     --parameters @infra/azure/main.parameters.json
   ```

4. Ajuste os valores de imagem e domínio antes do deploy em produção:

   - `frontendImage`
   - `apiImage`
   - `frontendOrigin`
   - `apiOrigin`

## Observações de segurança

- O template usa Key Vault para armazenamento de segredos e elimina o uso de valores sensíveis hardcoded no código.
- Em produção, os valores reais do app devem ser enviados por GitHub Actions/secretos do ambiente ou via Azure Key Vault.
- `redis` e `storageAccount` são provisionados como suporte operacional inicial; ajuste conforme o cenário real e a política da organização.

## Próximo refinamento recomendado

- separar `dev`, `staging` e `prod` por `resourceGroup` e parameters específicos
- conectar `Key Vault` e `Managed Identity` aos container apps com acesso real aos secretos
- publicar as imagens reais do frontend e da API Python no ACR
- definir domínio e TLS públicos por ambiente
- ajustar a capacidade de CPU/memória e o número de replicas conforme a carga real
