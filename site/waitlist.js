/* Lista de espera da landing. Sem bibliotecas, sem cookies, sem rastreio.
   O endereço da API vem de <meta name="aegis-api">; vazio = formulário escondido. */
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="aegis-api"]');
  var api = meta && meta.content ? meta.content.replace(/\/+$/, '') : '';
  var form = document.getElementById('wl-form');
  var soon = document.getElementById('wl-soon');
  if (!form || !api) return;
  form.hidden = false;
  if (soon) soon.hidden = true;

  var status = form.querySelector('.wl-status');
  var button = form.querySelector('button[type="submit"]');
  var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function say(text, tone) {
    status.textContent = text;
    status.dataset.tone = tone || '';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var email = form.email.value.trim();
    if (!emailRe.test(email)) { say('Confirma o email.', 'bad'); form.email.focus(); return; }
    if (!form.consent.checked) { say('Falta aceitar a utilização do email.', 'bad'); form.consent.focus(); return; }

    button.disabled = true;
    say('A enviar…');
    fetch(api + '/api/waitlist', {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        interest: form.interest.value,
        consent: true,
        website: form.website.value
      })
    }).then(function (res) {
      if (res.status === 202) {
        form.reset();
        say('Obrigado! Avisamos-te quando abrirmos.', 'ok');
      } else if (res.status === 429) {
        say('Muitas tentativas seguidas. Tenta daqui a pouco.', 'bad');
      } else {
        say('Não foi possível inscrever. Confirma o email e tenta de novo.', 'bad');
      }
    }).catch(function () {
      say('Sem ligação ao serviço. Tenta mais tarde.', 'bad');
    }).then(function () {
      button.disabled = false;
    });
  });
})();
