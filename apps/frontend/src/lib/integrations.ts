export type Integration = {
  id: string
  name: string
  mark: string
  category: 'Cloud' | 'Produtividade' | 'IA' | 'Segurança'
  implementation: 'planned' | 'server'
  text: string
  url: string
  requirements: readonly string[]
}

export const INTEGRATIONS: readonly Integration[] = [
  {
    id: 'onedrive', name: 'OneDrive', mark: 'OD', category: 'Cloud', implementation: 'planned',
    text: 'Acesso a ficheiros através do Microsoft Graph. O conector ainda não está implementado.',
    url: 'https://learn.microsoft.com/en-us/graph/permissions-reference',
    requirements: ['Registar a aplicação e implementar autorização OAuth por utilizador.', 'Pedir apenas as permissões necessárias, começando por leitura.', 'Isolar autorizações por cliente e permitir revogação de acesso.'],
  },
  {
    id: 'dropbox', name: 'Dropbox', mark: 'DB', category: 'Cloud', implementation: 'planned',
    text: 'Seleção e leitura de documentos na cloud. O conector ainda não está implementado.',
    url: 'https://developers.dropbox.com/oauth-guide',
    requirements: ['Criar uma aplicação Dropbox com scopes mínimos.', 'Escolher acesso à pasta da app ou aos ficheiros estritamente necessários.', 'Guardar tokens no servidor e prever revogação e renovação segura.'],
  },
  {
    id: 'word', name: 'Microsoft Word', mark: 'W', category: 'Produtividade', implementation: 'planned',
    text: 'Assistência a documentos através de um Office Add-in. Não existe ainda um suplemento Word.',
    url: 'https://learn.microsoft.com/en-us/office/dev/add-ins/word/word-add-ins-programming-overview',
    requirements: ['Implementar um suplemento Office.js e definir os clientes Word suportados.', 'Pedir autorização antes de enviar conteúdo do documento a um fornecedor externo.', 'Validar o manifesto, as permissões e os requisitos de publicação do suplemento.'],
  },
  {
    id: 'ai', name: 'IA compatível com OpenAI', mark: 'AI', category: 'IA', implementation: 'server',
    text: 'O backend tem funções de melhoria de texto e análise de PDF. A configuração não garante disponibilidade nem identifica o fornecedor como OpenAI.',
    url: 'https://platform.openai.com/docs/api-reference/introduction',
    requirements: ['Definir fornecedor, modelo e credencial apenas no servidor.', 'Confirmar finalidade, dados enviados, retenção e limites de custos.', 'Validar respostas e testar a ligação antes de uso em produção. Uma subscrição ChatGPT não inclui créditos da API.'],
  },
  {
    id: 'antivirus', name: 'Análise antivírus', mark: 'AV', category: 'Segurança', implementation: 'planned',
    text: 'Verificação de ficheiros por um motor dedicado. A app não tem um motor antivírus integrado.',
    url: 'https://docs.clamav.net/',
    requirements: ['Selecionar um motor, licença e política de atualização de assinaturas.', 'Analisar ficheiros em ambiente isolado, com limites de tamanho e tempo.', 'Definir quarentena e política de privacidade. Uma análise sem deteções não garante que o ficheiro é seguro.'],
  },
]

export type AiConfiguration = 'checking' | 'configured' | 'not-configured' | 'sign-in' | 'unavailable'

export function integrationStatus(item: Integration, configuration: AiConfiguration): string {
  if (item.implementation === 'planned') return 'Planeada'
  const labels: Record<AiConfiguration, string> = {
    checking: 'A verificar configuração',
    configured: 'Configurada no servidor',
    'not-configured': 'Não configurada',
    'sign-in': 'Inicia sessão para verificar',
    unavailable: 'Estado indisponível',
  }
  return labels[configuration]
}

export function filterIntegrations(query: string, category: string): readonly Integration[] {
  const normalized = query.trim().toLocaleLowerCase('pt')
  return INTEGRATIONS.filter(item =>
    (category === 'Todas' || item.category === category) &&
    `${item.name} ${item.category} ${item.text}`.toLocaleLowerCase('pt').includes(normalized),
  )
}
