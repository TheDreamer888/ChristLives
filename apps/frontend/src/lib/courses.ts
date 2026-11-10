import type { IndicatorId } from './aiApi.ts'

/**
 * Cursos de economia: texto original do Aegis + dados reais do Banco Mundial (via API)
 * em cada lição + tutor IA. O progresso é uma conveniência local deste browser.
 */
export type Quiz = { question: string; options: string[]; answer: number; explanation: string }
export type Lesson = {
  id: string
  title: string
  minutes: number
  summary: string
  concepts: string[]
  indicator?: IndicatorId
  quiz: Quiz
}
export type Course = { id: string; title: string; level: 'Básico' | 'Intermédio' | 'Avançado'; description: string; lessons: Lesson[] }

export const COURSES: readonly Course[] = [
  {
    id: 'fundamentos',
    title: 'Fundamentos de economia',
    level: 'Básico',
    description: 'Escassez, escolhas, oferta e procura e como se mede uma economia.',
    lessons: [
      {
        id: 'escassez', title: 'Escassez e custo de oportunidade', minutes: 8,
        summary: 'Os recursos são limitados e cada escolha implica abdicar da melhor alternativa. Esse valor perdido é o custo de oportunidade — e existe mesmo quando não há dinheiro envolvido.',
        concepts: ['Escassez', 'Custo de oportunidade', 'Trade-off', 'Incentivos'],
        quiz: { question: 'Estudas 2 horas em vez de trabalhar a 10 €/h. Qual é o custo de oportunidade?', options: ['0 €, porque não gastaste dinheiro', '20 € de rendimento que deixaste de ganhar', 'O preço dos livros'], answer: 1, explanation: 'O custo de oportunidade é o valor da melhor alternativa abandonada: 2 h × 10 €.' },
      },
      {
        id: 'oferta-procura', title: 'Oferta, procura e preços', minutes: 10,
        summary: 'O preço de equilíbrio surge onde a quantidade que os compradores querem iguala a que os vendedores oferecem. Choques de oferta ou de procura deslocam as curvas e mudam preços e quantidades.',
        concepts: ['Curva da procura', 'Curva da oferta', 'Equilíbrio', 'Elasticidade'],
        quiz: { question: 'Uma seca reduz a colheita de café. O que tende a acontecer ao preço?', options: ['Sobe', 'Desce', 'Fica igual'], answer: 0, explanation: 'Menos oferta com a mesma procura desloca o equilíbrio para um preço mais alto.' },
      },
      {
        id: 'pib', title: 'PIB e crescimento', minutes: 9, indicator: 'gdp_growth',
        summary: 'O PIB mede o valor de bens e serviços finais produzidos num período. O crescimento real desconta a inflação; o PIB per capita divide pela população e aproxima o nível de vida médio.',
        concepts: ['PIB nominal vs real', 'Crescimento', 'PIB per capita', 'Ciclo económico'],
        quiz: { question: 'Porque se usa o PIB real para medir crescimento?', options: ['Porque inclui impostos', 'Porque remove o efeito da subida de preços', 'Porque conta só exportações'], answer: 1, explanation: 'O PIB real compara quantidades a preços constantes, isolando o crescimento da produção.' },
      },
    ],
  },
  {
    id: 'inflacao-juros',
    title: 'Inflação, juros e bancos centrais',
    level: 'Intermédio',
    description: 'Porque sobem os preços, como reagem os bancos centrais e o que isso faz ao teu dinheiro.',
    lessons: [
      {
        id: 'inflacao', title: 'O que é a inflação', minutes: 10, indicator: 'inflation',
        summary: 'Inflação é a subida generalizada e persistente dos preços. Reduz o poder de compra do dinheiro parado; uma inflação baixa e estável (cerca de 2% na zona euro) é o objetivo da maioria dos bancos centrais.',
        concepts: ['Índice de preços (IPC)', 'Poder de compra', 'Inflação vs deflação', 'Expectativas'],
        quiz: { question: 'Com inflação de 5% e depósito a 1%, o que acontece ao poder de compra?', options: ['Aumenta 4%', 'Cai cerca de 4%', 'Mantém-se'], answer: 1, explanation: 'O rendimento real é aproximadamente 1% − 5% = −4%.' },
      },
      {
        id: 'juros', title: 'Juros nominais e reais', minutes: 9, indicator: 'real_interest',
        summary: 'O juro nominal é o que o banco anuncia; o juro real desconta a inflação. É o juro real que diz se a poupança cresce de facto e quão caro é, na prática, pedir emprestado.',
        concepts: ['Taxa nominal', 'Taxa real', 'Equação de Fisher', 'Euribor'],
        quiz: { question: 'Juro nominal 4% e inflação 3%. Qual é o juro real aproximado?', options: ['7%', '1%', '-1%'], answer: 1, explanation: 'Juro real ≈ nominal − inflação = 4% − 3%.' },
      },
      {
        id: 'banco-central', title: 'Política monetária', minutes: 11,
        summary: 'Para travar a inflação, os bancos centrais sobem as taxas de referência, encarecendo o crédito e arrefecendo a procura. Para estimular a economia, descem-nas. Os efeitos chegam com atraso de vários meses.',
        concepts: ['Taxa de referência', 'Transmissão monetária', 'Quantitative easing', 'Desfasamentos'],
        quiz: { question: 'O que faz normalmente um banco central perante inflação alta?', options: ['Desce as taxas de juro', 'Sobe as taxas de juro', 'Imprime mais moeda'], answer: 1, explanation: 'Taxas mais altas reduzem crédito e procura, aliviando a pressão sobre os preços.' },
      },
    ],
  },
  {
    id: 'mercados',
    title: 'Mercados financeiros e trading',
    level: 'Avançado',
    description: 'Ações, obrigações, risco, diversificação e como funcionam as análises técnica e fundamental.',
    lessons: [
      {
        id: 'ativos', title: 'Ações, obrigações e ETFs', minutes: 10,
        summary: 'Ações são partes de empresas (maior risco e potencial); obrigações são empréstimos com juro (mais previsíveis); ETFs agregam muitos ativos num só produto, com custos normalmente baixos.',
        concepts: ['Ação', 'Obrigação', 'ETF', 'Dividendos', 'Liquidez'],
        quiz: { question: 'Qual destes reduz o risco de depender de uma só empresa?', options: ['Comprar uma ação', 'Um ETF de índice amplo', 'Alavancagem'], answer: 1, explanation: 'Um ETF de índice distribui o investimento por muitas empresas (diversificação).' },
      },
      {
        id: 'risco', title: 'Risco, volatilidade e gestão de posição', minutes: 12,
        summary: 'Antes do retorno vem o risco: define quanto aceitas perder por operação (muitos usam 1–2% do capital), onde sais se estiveres errado (stop) e o tamanho da posição que respeita esse limite.',
        concepts: ['Volatilidade', 'Stop-loss', 'Dimensionamento de posição', 'Relação ganho/risco', 'Drawdown'],
        quiz: { question: 'Capital 10 000 €, risco 1%, entrada 50 €, stop 48 €. Quantas ações?', options: ['50', '100', '200'], answer: 0, explanation: 'Risco = 100 €; risco por ação = 2 €; 100 / 2 = 50 ações.' },
      },
      {
        id: 'analise', title: 'Análise técnica vs fundamental', minutes: 11, indicator: 'gdp_per_capita',
        summary: 'A análise fundamental estima o valor de um ativo a partir de lucros, dívida e contexto económico; a técnica estuda preços e volume. Nenhuma garante resultados — combinam-se com gestão de risco.',
        concepts: ['P/L (preço/lucro)', 'Médias móveis', 'RSI', 'Suportes e resistências', 'Viés de confirmação'],
        quiz: { question: 'Qual afirmação é verdadeira?', options: ['Um padrão gráfico garante a próxima subida', 'Lucros e dívida são dados de análise fundamental', 'A IA elimina o risco de perder'], answer: 1, explanation: 'Os fundamentos usam dados da empresa; nenhuma técnica ou IA elimina o risco.' },
      },
    ],
  },
  {
    id: 'financas-pessoais',
    title: 'Finanças pessoais',
    level: 'Básico',
    description: 'Orçamento, fundo de emergência, dívida e investimento a longo prazo.',
    lessons: [
      {
        id: 'orcamento', title: 'Orçamento que funciona', minutes: 7,
        summary: 'Um orçamento simples separa necessidades, objetivos e lazer (por exemplo 50/30/20). O primeiro objetivo é um fundo de emergência de 3 a 6 meses de despesas.',
        concepts: ['Regra 50/30/20', 'Fundo de emergência', 'Despesas fixas e variáveis'],
        quiz: { question: 'Qual deve ser normalmente a primeira meta?', options: ['Investir tudo em ações', 'Criar um fundo de emergência', 'Pedir crédito pessoal'], answer: 1, explanation: 'O fundo de emergência evita vender investimentos ou endividar-se em imprevistos.' },
      },
      {
        id: 'juros-compostos', title: 'Juros compostos e longo prazo', minutes: 8, indicator: 'inflation',
        summary: 'Com juros compostos, os rendimentos geram novos rendimentos. O tempo é o maior aliado — mas compara sempre com a inflação e os custos, que corroem o retorno.',
        concepts: ['Juro composto', 'Custos e comissões', 'Retorno real', 'Horizonte temporal'],
        quiz: { question: '1 000 € a 5% ao ano durante 2 anos, com juro composto, dão cerca de…', options: ['1 100 €', '1 102,50 €', '1 050 €'], answer: 1, explanation: '1 000 × 1,05 × 1,05 = 1 102,50 €.' },
      },
      {
        id: 'divida', title: 'Dívida boa e dívida cara', minutes: 7, indicator: 'debt',
        summary: 'Cartões de crédito e créditos rápidos têm TAEG elevada: paga-os primeiro. Compara a TAEG, não só a prestação, e evita prazos longos para bens que perdem valor depressa.',
        concepts: ['TAEG', 'Método avalanche', 'Método bola de neve', 'Taxa de esforço'],
        quiz: { question: 'Que dívida deves amortizar primeiro, em geral?', options: ['A de TAEG mais alta', 'A de prestação mais baixa', 'A mais recente'], answer: 0, explanation: 'Atacar a TAEG mais alta (avalanche) minimiza os juros totais.' },
      },
    ],
  },
]

export const LEARNING_RESOURCES = [
  { label: 'Khan Academy — Economia', href: 'https://www.khanacademy.org/economics-finance-domain' },
  { label: 'OpenStax — Principles of Economics (grátis)', href: 'https://openstax.org/details/books/principles-economics-3e' },
  { label: 'Banco de Portugal — Todos Contam', href: 'https://www.todoscontam.pt/' },
  { label: 'BCE — Explicadores', href: 'https://www.ecb.europa.eu/ecb-and-you/explainers/html/index.pt.html' },
] as const

const PROGRESS_KEY = 'aegis-course-progress'

export function allLessonIds(): string[] {
  return COURSES.flatMap(course => course.lessons.map(lesson => `${course.id}/${lesson.id}`))
}

export function courseProgress(course: Course, done: readonly string[]): number {
  const ids = course.lessons.map(lesson => `${course.id}/${lesson.id}`)
  return Math.round((ids.filter(id => done.includes(id)).length / ids.length) * 100)
}

export function readProgress(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) ?? '[]')
    const valid = new Set(allLessonIds())
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && valid.has(id)) : []
  } catch {
    return []
  }
}

export function writeProgress(done: readonly string[]): void {
  try {
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify([...new Set(done)]))
  } catch {
    // Armazenamento bloqueado: o progresso fica só nesta visita.
  }
}
