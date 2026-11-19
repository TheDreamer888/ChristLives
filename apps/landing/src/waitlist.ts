/* Lista de espera. Sem bibliotecas, sem cookies, sem rastreio.
   O endereço da API vem de <meta name="lusorbe-api">; vazio = formulário escondido. */
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function initWaitlist(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="lusorbe-api"]')
  const api = meta?.content ? meta.content.replace(/\/+$/, '') : ''
  const form = document.getElementById('wl-form') as HTMLFormElement | null
  const soon = document.getElementById('wl-soon')
  if (!form || !api) return
  form.hidden = false
  if (soon) soon.hidden = true

  const status = form.querySelector<HTMLElement>('.wl-status')!
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement

  const say = (text: string, tone = '') => {
    status.textContent = text
    status.dataset.tone = tone
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const email = field('email').value.trim()
    if (!emailRe.test(email)) {
      say('Confirma o email.', 'bad')
      field('email').focus()
      return
    }
    if (!field('consent').checked) {
      say('Falta aceitar a utilização do email.', 'bad')
      field('consent').focus()
      return
    }
    button.disabled = true
    say('A enviar…')
    try {
      const res = await fetch(`${api}/api/waitlist`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          interest: 'outro',
          consent: true,
          website: field('website').value,
        }),
      })
      if (res.status === 202) {
        form.reset()
        say('Obrigado! Avisamos-te quando abrirmos.', 'ok')
      } else if (res.status === 429) {
        say('Muitas tentativas seguidas. Tenta daqui a pouco.', 'bad')
      } else {
        say('Não foi possível inscrever. Confirma o email e tenta de novo.', 'bad')
      }
    } catch {
      say('Sem ligação ao serviço. Tenta mais tarde.', 'bad')
    } finally {
      button.disabled = false
    }
  })
}
