import { useEffect, useState } from 'react'
import { aiApi, type IndicatorSeries } from '../../lib/aiApi'
import { COURSES, LEARNING_RESOURCES, courseProgress, readProgress, writeProgress, type Course, type Lesson } from '../../lib/courses'
import { AiIcon } from './shared'
import type { ChatSeed } from './ChatView'

const COUNTRIES = [
  { id: 'PT', label: 'Portugal' }, { id: 'BR', label: 'Brasil' }, { id: 'US', label: 'EUA' },
  { id: 'EMU', label: 'Zona euro' }, { id: 'GB', label: 'Reino Unido' }, { id: 'WLD', label: 'Mundo' },
]

function Sparkbars({ series }: { series: IndicatorSeries }) {
  const values = series.points.map(p => p.value)
  const max = Math.max(...values.map(Math.abs), 0.0001)
  const hasNegative = values.some(v => v < 0)
  const last = series.points[series.points.length - 1]
  return <figure className="indicator-chart">
    <figcaption><strong>{series.label}</strong> · {series.country_name}{last && <span>{last.value.toLocaleString('pt-PT', { maximumFractionDigits: 2 })} {series.unit} em {last.year}</span>}</figcaption>
    <div className={hasNegative ? 'bars bars--signed' : 'bars'} role="img" aria-label={`${series.label}: ${series.points.map(p => `${p.year} ${p.value}`).join(', ')}`}>
      {series.points.map(p => <span key={p.year} className={p.value < 0 ? 'neg' : ''} style={{ height: `${Math.max(2, (Math.abs(p.value) / max) * (hasNegative ? 50 : 100))}%` }} title={`${p.year}: ${p.value}`} />)}
    </div>
    <div className="bars-axis"><span>{series.points[0]?.year}</span><span>{last?.year}</span></div>
    <small>{series.source}</small>
  </figure>
}

function LessonPanel({ course, lesson, done, onDone, openChat }: { course: Course; lesson: Lesson; done: boolean; onDone: () => void; openChat: (seed: Omit<ChatSeed, 'id'>) => void }) {
  const [country, setCountry] = useState('PT')
  const [series, setSeries] = useState<IndicatorSeries | null>(null)
  const [dataError, setDataError] = useState('')
  const [choice, setChoice] = useState<number | null>(null)

  useEffect(() => { setChoice(null) }, [lesson.id])
  useEffect(() => {
    if (!lesson.indicator) { setSeries(null); return }
    let active = true
    setDataError('')
    aiApi.getIndicator(country, lesson.indicator, 15)
      .then(result => { if (active) setSeries(result) })
      .catch(reason => { if (active) { setSeries(null); setDataError(reason instanceof Error ? reason.message : 'Dados indisponíveis.') } })
    return () => { active = false }
  }, [lesson.indicator, country])

  const correct = choice === lesson.quiz.answer
  const askTutor = () => openChat({
    mode: 'tutor',
    prompt: `Estou na lição «${lesson.title}» do curso «${course.title}». Explica-me os conceitos ${lesson.concepts.join(', ')} com exemplos práticos e faz-me 3 perguntas de verificação.`,
    context: [`Resumo da lição: ${lesson.summary}`, series ? `Dados (${series.source}) — ${series.label}, ${series.country_name}: ${series.points.map(p => `${p.year}: ${p.value}`).join('; ')}` : ''].filter(Boolean).join('\n'),
  })

  return <article className="aegis-panel lesson-panel">
    <p className="eyebrow">{course.title.toUpperCase()} · {lesson.minutes} MIN</p>
    <h2>{lesson.title}</h2>
    <p className="lesson-summary">{lesson.summary}</p>
    <ul className="concept-chips" aria-label="Conceitos">{lesson.concepts.map(c => <li key={c}>{c}</li>)}</ul>

    {lesson.indicator && <section className="lesson-data" aria-label="Dados reais">
      <div className="panel-row">
        <h3>Dados reais</h3>
        <label className="country-select"><span className="sr-only">País</span>
          <select value={country} onChange={e => setCountry(e.target.value)}>{COUNTRIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        </label>
      </div>
      {series ? <Sparkbars series={series} /> : dataError ? <p className="agency-note">{dataError}</p> : <div className="indicator-chart skeleton" aria-hidden="true" />}
    </section>}

    <section className="quiz" aria-label="Verificação">
      <h3>Verifica o que aprendeste</h3>
      <p>{lesson.quiz.question}</p>
      <div className="quiz-options" role="radiogroup">
        {lesson.quiz.options.map((option, index) => <button key={option} type="button" role="radio" aria-checked={choice === index}
          className={choice === null ? '' : index === lesson.quiz.answer ? 'right' : choice === index ? 'wrong' : ''} onClick={() => { setChoice(index); if (index === lesson.quiz.answer && !done) onDone() }}>{option}</button>)}
      </div>
      {choice !== null && <p className={correct ? 'quiz-feedback quiz-feedback--ok' : 'quiz-feedback'} role="status">{correct ? 'Certo! ' : 'Ainda não. '}{lesson.quiz.explanation}</p>}
    </section>

    <div className="button-row">
      <button className="button button-dark" type="button" onClick={askTutor}><AiIcon name="spark" size={16} />Perguntar ao tutor IA</button>
      {!done && <button className="button button-outline" type="button" onClick={onDone}>Marcar como concluída</button>}
      {done && <span className="status-pill status-pill--ok"><i />Concluída</span>}
    </div>
  </article>
}

export default function CoursesView({ openChat }: { openChat: (seed: Omit<ChatSeed, 'id'>) => void }) {
  const [done, setDone] = useState<string[]>(readProgress)
  const [courseId, setCourseId] = useState(COURSES[0]?.id ?? '')
  const course = COURSES.find(c => c.id === courseId) ?? COURSES[0]
  const [lessonId, setLessonId] = useState(course?.lessons[0]?.id ?? '')
  const lesson = course?.lessons.find(l => l.id === lessonId) ?? course?.lessons[0]

  useEffect(() => { writeProgress(done) }, [done])
  if (!course || !lesson) return null
  const markDone = () => setDone(d => [...new Set([...d, `${course.id}/${lesson.id}`])])

  return <section className="courses-layout">
    <div className="course-cards" role="tablist" aria-label="Cursos">
      {COURSES.map(c => {
        const progress = courseProgress(c, done)
        return <button key={c.id} type="button" role="tab" aria-selected={c.id === course.id} className={c.id === course.id ? 'course-card selected' : 'course-card'}
          onClick={() => { setCourseId(c.id); setLessonId(c.lessons[0]?.id ?? '') }}>
          <span className="course-level">{c.level}</span>
          <strong>{c.title}</strong>
          <small>{c.description}</small>
          <span className="progress"><i style={{ width: `${progress}%` }} /></span>
          <small>{progress}% concluído · {c.lessons.length} lições</small>
        </button>
      })}
    </div>

    <div className="course-body">
      <nav className="aegis-panel lesson-list" aria-label={`Lições de ${course.title}`}>
        <p className="eyebrow">LIÇÕES</p>
        <ol>
          {course.lessons.map((l, index) => {
            const isDone = done.includes(`${course.id}/${l.id}`)
            return <li key={l.id}><button type="button" aria-current={l.id === lesson.id ? 'step' : undefined} className={l.id === lesson.id ? 'active' : ''} onClick={() => setLessonId(l.id)}>
              <span className={isDone ? 'lesson-num done' : 'lesson-num'}>{isDone ? <AiIcon name="check" size={14} /> : index + 1}</span>
              <span>{l.title}<small>{l.minutes} min{l.indicator ? ' · dados reais' : ''}</small></span>
            </button></li>
          })}
        </ol>
        <p className="eyebrow">RECURSOS GRATUITOS</p>
        <ul className="resource-links">{LEARNING_RESOURCES.map(r => <li key={r.href}><a href={r.href} target="_blank" rel="noopener noreferrer">{r.label} <AiIcon name="external" size={12} /></a></li>)}</ul>
      </nav>
      <LessonPanel course={course} lesson={lesson} done={done.includes(`${course.id}/${lesson.id}`)} onDone={markDone} openChat={openChat} />
    </div>
  </section>
}
