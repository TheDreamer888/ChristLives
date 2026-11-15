import { lazy, Suspense, useState } from 'react'
import './App.css'

const LoginTab = lazy(() => import('./components/LoginTab'))

type ScanState = 'ready' | 'scanning' | 'complete'
type EducationTrack = '5-7' | '7-9' | '9-12' | 'college'

const initialThreats = [
  { file: 'Downloads/update-check.ps1', rule: 'Execucao remota suspeita', risk: 'Alto', action: 'Em quarentena' },
  { file: 'Projetos/install-tools.sh', rule: 'Download sem verificacao', risk: 'Medio', action: 'Bloqueado' },
  { file: 'Temp/cleanup.vbs', rule: 'Ofuscacao detectada', risk: 'Alto', action: 'Em quarentena' },
]

const tracks: { id: EducationTrack; label: string; title: string; detail: string; progress: number }[] = [
  { id: '5-7', label: '5.º ao 7.º ano', title: 'Fundamentos', detail: 'Matemática, ciências, leitura e cidadania digital.', progress: 68 },
  { id: '7-9', label: '7.º ao 9.º ano', title: 'Descoberta', detail: 'Raciocínio, tecnologia, línguas e escolhas financeiras.', progress: 42 },
  { id: '9-12', label: '9.º ao 12.º ano', title: 'Preparação', detail: 'Exames, projetos, carreira e literacia financeira.', progress: 24 },
  { id: 'college', label: 'Faculdade', title: 'Especialização', detail: 'Competências profissionais e aprendizagem autónoma.', progress: 12 },
]

const financeLessons = [
  { title: 'Orçamento sem complicação', detail: 'Distingue necessidades, desejos e objetivos.', value: '15 min' },
  { title: 'Juros e crescimento', detail: 'Aprende por que o tempo importa ao poupar.', value: '12 min' },
  { title: 'Segurança online', detail: 'Reconhece burlas, phishing e promessas impossíveis.', value: '10 min' },
]

function App() {
  const [activeView, setActiveView] = useState<'protection' | 'education' | 'login'>('protection')
  const [educationTrack, setEducationTrack] = useState<EducationTrack>('5-7')
  const [financeComplete, setFinanceComplete] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('Olá. Sou o tutor BaseGuard. Escolhe um percurso e pergunta-me sobre uma matéria.')
  const [scanState, setScanState] = useState<ScanState>('ready')
  const [protectedRealtime, setProtectedRealtime] = useState(true)
  const [threats, setThreats] = useState(initialThreats)

  const startScan = () => {
    setScanState('scanning')
    window.setTimeout(() => setScanState('complete'), 1600)
  }

  if (activeView === 'login') return <main className="login-shell"><button className="back-button" type="button" onClick={() => setActiveView('protection')}>Voltar para protecao</button><Suspense fallback={<p role="status">A carregar…</p>}><LoginTab /></Suspense></main>

  if (activeView === 'education') {
    const selectedTrack = tracks.find((track) => track.id === educationTrack) ?? tracks[0]!
    const askTutor = () => {
      const normalized = question.toLowerCase()
      if (!question.trim()) return
      if (normalized.includes('dinheiro') || normalized.includes('juros') || normalized.includes('poupar')) {
        setAnswer('Começa por separar o dinheiro em três partes: necessidades, objetivos e lazer. Ao poupar, os juros podem fazer o saldo crescer, mas nenhum investimento é garantido: compara sempre risco, prazo e custos.')
      } else if (normalized.includes('matemática') || normalized.includes('matematica')) {
        setAnswer('Vamos por etapas: identifica os dados, escreve o que precisas de descobrir, escolhe a operação e confirma se o resultado faz sentido. Podes enviar o enunciado sem dados pessoais.')
      } else {
        setAnswer('Boa pergunta. Divide o problema em partes pequenas, explica o que já sabes e confirma a resposta numa fonte de confiança. Posso ajudar com matérias escolares e literacia financeira, mas não substituo um professor ou consultor.')
      }
      setQuestion('')
    }

    return <main className="education-app">
      <header className="education-header"><div><p className="eyebrow">BaseGuard Educação</p><h1>Aprender com clareza</h1><p>Um percurso seguro do 5.º ano à faculdade, com literacia financeira desde cedo.</p></div><button className="profile-button" type="button" onClick={() => setActiveView('login')} aria-label="Abrir conta">AC</button></header>
      <nav className="education-nav" aria-label="Áreas de aprendizagem"><button className="education-nav-active" type="button">Percursos</button><button type="button" onClick={() => document.getElementById('finance')?.scrollIntoView({ behavior: 'smooth' })}>Treino financeiro</button><button type="button" onClick={() => document.getElementById('tutor')?.scrollIntoView({ behavior: 'smooth' })}>Tutor IA</button><button type="button" onClick={() => setActiveView('protection')}>Proteção</button></nav>
      <section className="education-hero"><div><p className="eyebrow">O teu próximo passo</p><h2>Escolhe o nível que combina contigo.</h2><p>Conteúdo progressivo, desafios curtos e explicações que respeitam o teu ritmo.</p></div><div className="hero-stat"><strong>4</strong><span>percursos preparados</span></div><div className="hero-stat"><strong>1</strong><span>conta, vários objetivos</span></div></section>
      <section className="track-grid" aria-label="Percursos escolares">{tracks.map((track) => <button className={educationTrack === track.id ? 'track-card selected' : 'track-card'} type="button" key={track.id} onClick={() => setEducationTrack(track.id)}><span className="track-label">{track.label}</span><strong>{track.title}</strong><p>{track.detail}</p><div className="progress-line"><span style={{ width: `${track.progress}%` }} /></div><small>{track.progress}% concluído</small></button>)}</section>
      <section className="learning-grid"><article className="learning-panel"><div className="panel-heading"><div><p className="eyebrow">Percurso atual</p><h2>{selectedTrack.title}</h2></div><span className="level-badge">{selectedTrack.label}</span></div><p className="learning-lead">{selectedTrack.detail}</p><div className="lesson-row"><span className="lesson-icon">01</span><div><strong>Aprender a aprender</strong><p>Define um objetivo e monta um plano de estudo.</p></div><b>Concluído</b></div><div className="lesson-row"><span className="lesson-icon next">02</span><div><strong>Desafio da semana</strong><p>Resolve um problema e explica o teu raciocínio.</p></div><b className="lesson-next">Próximo</b></div><button className="primary-action" type="button">Continuar percurso</button></article><article className="tutor-panel" id="tutor"><div className="panel-heading"><div><p className="eyebrow">Assistente de estudo</p><h2>Tutor IA</h2></div><span className="ai-status">Local · seguro</span></div><div className="tutor-answer"><span className="ai-mark">IA</span><p>{answer}</p></div><div className="tutor-input"><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') askTutor() }} placeholder="Pergunta sobre uma matéria..." aria-label="Pergunta ao tutor" /><button type="button" onClick={askTutor} aria-label="Enviar pergunta">Enviar</button></div><small>Não partilhes nome, morada, palavra-passe ou outros dados pessoais.</small></article></section>
      <section className="finance-section" id="finance"><div className="section-intro"><p className="eyebrow">Literacia para a vida</p><h2>Treino financeiro</h2><p>Aprende a tomar decisões informadas. O conteúdo é educativo e não é aconselhamento financeiro.</p></div><div className="finance-content"><div className="finance-lessons">{financeLessons.map((lesson, index) => <article key={lesson.title} className={financeComplete && index === 0 ? 'finance-lesson complete' : 'finance-lesson'}><span>{financeComplete && index === 0 ? 'OK' : `0${index + 1}`}</span><div><strong>{lesson.title}</strong><p>{lesson.detail}</p></div><small>{lesson.value}</small></article>)}</div><div className="finance-challenge"><span className="challenge-kicker">Desafio rápido</span><h3>Antes de comprar, qual pergunta vem primeiro?</h3><p>“Preciso mesmo disto ou estou a comprar por impulso?” é uma boa primeira verificação.</p><button className="primary-action" type="button" onClick={() => setFinanceComplete(true)}>{financeComplete ? 'Desafio concluído' : 'Marcar como concluído'}</button></div></div></section>
      <footer className="education-footer"><span>Conteúdo educativo acessível e progressivo.</span><a href="/legal/terms.html">Termos</a><a href="/legal/privacy.html">Privacidade</a></footer>
    </main>
  }

  const scanLabel = scanState === 'scanning' ? 'Verificando scripts...' : scanState === 'complete' ? 'Varredura concluida' : 'Pronto para verificar'

  return <main className="security-app">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">B</span><span>BaseGuard</span></div><nav aria-label="Navegacao principal"><button className="nav-item active" type="button">Visao geral</button><button className="nav-item" type="button">Protecao de scripts</button><button className="nav-item" type="button">Quarentena</button><button className="nav-item" type="button" onClick={() => setActiveView('education')}>Educação</button><button className="nav-item" type="button">Atividade</button></nav><div className="sidebar-footer"><button className="nav-item" type="button" onClick={() => setActiveView('login')}>Conta</button><p>Motor de protecao 1.0</p></div></aside>
    <section className="workspace">
      <header className="topbar"><div><p className="eyebrow">Central de seguranca</p><h1>Seu ambiente esta protegido</h1></div><button className="profile-button" type="button" onClick={() => setActiveView('login')} aria-label="Abrir conta">AC</button></header>
      <section className="status-panel" aria-live="polite"><div className="shield"><span>OK</span></div><div className="status-copy"><p className="status-title">Protecao ativa</p><p>Monitoramento em tempo real e bloqueio de comportamentos suspeitos estao ligados.</p></div><button className="scan-button" type="button" onClick={startScan} disabled={scanState === 'scanning'}>{scanState === 'scanning' ? 'Verificando' : 'Iniciar varredura'}</button></section>
      <section className="metrics" aria-label="Resumo da protecao"><article><p>Scripts analisados hoje</p><strong>{scanState === 'complete' ? '1.284' : '1.247'}</strong><span>+ 86 desde a ultima hora</span></article><article><p>Ameacas bloqueadas</p><strong>{threats.length}</strong><span>{threats.length ? 'Nenhuma acao necessaria' : 'Quarentena limpa'}</span></article><article><p>Ultima verificacao</p><strong>{scanState === 'complete' ? 'Agora' : 'Ha 42 min'}</strong><span className={scanState === 'scanning' ? 'pulse-text' : ''}>{scanLabel}</span></article></section>
      <section className="content-grid"><article className="panel scan-panel"><div className="panel-heading"><div><p className="eyebrow">Protecao proativa</p><h2>Monitoramento de scripts</h2></div><button className={protectedRealtime ? 'toggle on' : 'toggle'} type="button" onClick={() => setProtectedRealtime(!protectedRealtime)} aria-label="Alternar monitoramento em tempo real"><span /></button></div><div className="scan-visual"><div className={scanState === 'scanning' ? 'scan-ring scanning' : 'scan-ring'}><span>{scanState === 'scanning' ? '...' : protectedRealtime ? 'ON' : 'OFF'}</span></div><div><p className="visual-title">{protectedRealtime ? 'Analise comportamental ativa' : 'Analise em pausa'}</p><p>Detecta comandos perigosos, ofuscacao e downloads sem validacao antes da execucao.</p></div></div><div className="coverage"><span>PowerShell</span><span>Shell Script</span><span>VBScript</span><span>JavaScript</span></div></article><article className="panel activity-panel"><div className="panel-heading"><div><p className="eyebrow">Ultimas 24 horas</p><h2>Atividade protegida</h2></div><button className="text-button" type="button">Ver relatorio</button></div><ul className="activity-list"><li><i className="dot success" />Script validado em <b>Projetos/deploy.ps1</b><time>Agora</time></li><li><i className="dot warning" />Tentativa de download bloqueada<time>Ha 18 min</time></li><li><i className="dot success" />Verificacao agendada concluida<time>Ha 42 min</time></li></ul></article></section>
      <section className="panel threat-panel"><div className="panel-heading"><div><p className="eyebrow">Requer atencao</p><h2>Itens isolados</h2></div>{threats.length > 0 && <button className="text-button danger" type="button" onClick={() => setThreats([])}>Esvaziar quarentena</button>}</div>{threats.length > 0 ? <div className="threat-table"><div className="table-head"><span>Arquivo</span><span>Deteccao</span><span>Risco</span><span>Acao</span></div>{threats.map((threat) => <div className="table-row" key={threat.file}><strong>{threat.file}</strong><span>{threat.rule}</span><span><b className={threat.risk === 'Alto' ? 'risk high' : 'risk medium'}>{threat.risk}</b></span><span className="action-status">{threat.action}</span></div>)}</div> : <div className="empty-state"><strong>Quarentena vazia</strong><span>Os itens isolados aparecerao aqui para sua revisao.</span></div>}</section>
    </section>
  </main>
}

export default App
