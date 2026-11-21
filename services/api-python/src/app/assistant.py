"""Assistente opcional da Lusorbe, com o Claude (Anthropic).

Regras que este módulo garante:

* **Só com conta.** Cada pedido exige sessão válida (conta não suspensa) e
  Origin da própria app: ninguém gasta créditos de IA sem login.
* **Limites por conta.** ``ASSISTANT_DAILY_LIMIT`` mensagens por dia (30 por
  omissão) e uma rajada máxima por minuto. O limite usa o mesmo limitador do
  login (Redis em produção), por isso vale entre instâncias.
* **Consentimento explícito.** O pedido tem de levar ``consent: true``: a pessoa
  aceitou que o texto da conversa é enviado à Anthropic para gerar a resposta.
* **Nada guardado.** A conversa vive no browser. O servidor não guarda nem
  regista o conteúdo; regista só contagens e erros.
* **Desligado sem chave.** Sem ``ANTHROPIC_API_KEY`` (ou com
  ``ASSISTANT_ENABLED=false``) responde 503 e a app mostra que está indisponível.
* **Habilidades e línguas.** O pedido escolhe uma habilidade (``skill``), que
  acrescenta instruções ao prompt, e opcionalmente a língua da resposta
  (``language``, código BCP 47). Sem língua, responde na língua da pessoa.
  A habilidade de matemática liga o raciocínio adaptativo e escreve fórmulas
  em LaTeX, que a app desenha.
"""
from __future__ import annotations

import hashlib
import os
from typing import Any, Literal

import anthropic
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from src.app.auth import routes as auth_routes
from src.app.auth.store import UserRecord
from src.pylibrary.logging import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/api/assistant", tags=["assistant"])

DATA_NOTICE = (
    "O texto desta conversa é enviado à Anthropic (Claude) para gerar a resposta. "
    "A Lusorbe não guarda a conversa. Não escrevas palavras-passe, números de cartão "
    "ou outros dados que não queiras partilhar."
)

MAX_TURNS = 20
MAX_MESSAGE_CHARS = 4000
MAX_TOTAL_CHARS = 24000

SYSTEM_PROMPT = """És o assistente da Lusorbe, uma plataforma que junta segurança digital, literacia financeira e aprendizagem.

Responde na língua em que a pessoa escreve (por omissão, português de Portugal), de forma clara e direta, com passos concretos quando ajudam. Sê curto em perguntas simples e completo em perguntas difíceis.
Podes usar Markdown simples: listas, **negrito**, `código` e blocos de código. Fórmulas matemáticas em LaTeX entre $...$ (na linha) ou $$...$$ (em bloco).

O que fazes bem:
- Segurança digital defensiva: reconhecer burlas, phishing, scripts e comandos perigosos, proteger contas, palavras-passe, passkeys, cópias de segurança, privacidade.
- Literacia financeira: explicar conceitos (juros, inflação, diversificação, comissões, risco), ler um extrato, perceber um produto financeiro.
- Aprender: explicar temas passo a passo, sugerir como estudar.
- Matemática, escrita, tradução e programação, quando a pessoa escolhe essa habilidade ou pergunta diretamente.

Limites:
- Não dás aconselhamento de investimento personalizado (o que comprar, vender ou quando). Explicas conceitos e riscos e sugeres falar com um profissional habilitado.
- Não dás aconselhamento jurídico, médico ou fiscal definitivo; explicas o geral e indicas a quem recorrer.
- Não ajudas a atacar, invadir ou enganar terceiros.
- Se alguém partilhar uma palavra-passe, código ou número de cartão, diz-lhe para o alterar e não o repitas.
- Se não souberes ou a informação puder estar desatualizada (preços, leis, notícias), di-lo.

Sobre a Lusorbe: tem revisão de scripts, simulador de mercados, percursos de aprendizagem, guia por temas e controlo dos dados da conta. Não inventes funcionalidades que não estão nesta lista."""


SKILLS: dict[str, dict[str, str]] = {
    "geral": {
        "name": "Geral",
        "description": "Segurança, dinheiro e estudo.",
        "prompt": "",
    },
    "matematica": {
        "name": "Matemática",
        "description": "Resolve passo a passo, com fórmulas e verificação.",
        "prompt": (
            "Habilidade ativa: MATEMÁTICA. Resolve passo a passo: identifica o que é pedido, "
            "escolhe o método, faz as contas sem saltar passos e verifica o resultado (substituindo, "
            "por outro método ou por ordem de grandeza). Escreve todas as expressões em LaTeX "
            "($...$ na linha, $$...$$ em bloco). Termina com a resposta final numa linha própria, "
            "começada por **Resposta:**. Se o enunciado for ambíguo, diz que suposição fizeste."
        ),
    },
    "seguranca": {
        "name": "Segurança",
        "description": "Burlas, phishing, contas e scripts suspeitos.",
        "prompt": (
            "Habilidade ativa: SEGURANÇA DIGITAL DEFENSIVA. Avalia o risco (baixo, médio, alto) "
            "logo no início, explica os sinais que encontraste e dá os passos a seguir por ordem. "
            "Se a pessoa já clicou ou partilhou dados, começa pelo que fazer agora."
        ),
    },
    "financas": {
        "name": "Finanças",
        "description": "Conceitos, contas e produtos explicados.",
        "prompt": (
            "Habilidade ativa: LITERACIA FINANCEIRA. Explica com exemplos numéricos simples e "
            "mostra as contas. Nunca digas o que comprar ou vender; mostra custos, riscos e "
            "perguntas a fazer a um profissional habilitado."
        ),
    },
    "estudo": {
        "name": "Estudo",
        "description": "Explicações, resumos e perguntas de treino.",
        "prompt": (
            "Habilidade ativa: ESTUDO. Explica do simples para o complexo, com um exemplo. "
            "No fim, propõe 2 ou 3 perguntas curtas para a pessoa testar o que aprendeu "
            "(com as respostas escondidas no fim, depois de uma linha '---')."
        ),
    },
    "escrita": {
        "name": "Escrita e tradução",
        "description": "Rever, reescrever, resumir e traduzir textos.",
        "prompt": (
            "Habilidade ativa: ESCRITA E TRADUÇÃO. Mantém o sentido e o tom do original. "
            "Ao rever, mostra o texto corrigido e depois uma lista curta das mudanças. "
            "Ao traduzir, entrega só a tradução, salvo se a pessoa pedir explicações."
        ),
    },
    "codigo": {
        "name": "Programação",
        "description": "Explicar, corrigir e escrever código seguro.",
        "prompt": (
            "Habilidade ativa: PROGRAMAÇÃO. Dá código completo e funcional em blocos com a "
            "linguagem indicada, explica o essencial em poucas linhas e assinala riscos de "
            "segurança (injeção, segredos no código, permissões). Não escrevas malware, "
            "ferramentas de intrusão nem código para contornar proteções."
        ),
    },
}

# Línguas que a app oferece no seletor; a API aceita qualquer código BCP 47 válido.
LANGUAGES: dict[str, str] = {
    "pt-PT": "Português (Portugal)", "pt-BR": "Português (Brasil)", "en": "English",
    "es": "Español", "fr": "Français", "de": "Deutsch", "it": "Italiano",
    "nl": "Nederlands", "pl": "Polski", "ro": "Română", "uk": "Українська",
    "ru": "Русский", "tr": "Türkçe", "ar": "العربية", "hi": "हिन्दी",
    "zh-CN": "中文（简体）", "ja": "日本語", "ko": "한국어",
}


def _system_blocks(skill: str, language: str | None) -> list[dict[str, Any]]:
    """Prompt base (em cache) + instruções da habilidade e da língua."""
    blocks: list[dict[str, Any]] = [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]
    extra = SKILLS[skill]["prompt"]
    if language:
        label = LANGUAGES.get(language, language)
        extra = f"{extra}\n\nResponde sempre nesta língua: {label} ({language}), mesmo que a pessoa escreva noutra.".strip()
    if extra:
        blocks.append({"type": "text", "text": extra})
    return blocks


def _enabled() -> bool:
    if os.getenv("ASSISTANT_ENABLED", "true").strip().lower() in {"0", "false", "no", "off"}:
        return False
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


def _daily_limit() -> int:
    return max(1, int(os.getenv("ASSISTANT_DAILY_LIMIT", "30")))


def _model() -> str:
    return os.getenv("ASSISTANT_MODEL", "claude-opus-5-5").strip() or "claude-opus-5-5"


_client: Any = None


def get_client() -> Any:
    """Cliente Anthropic partilhado (criado na primeira utilização; os testes substituem-no)."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=60.0, max_retries=2)
    return _client


def set_client(client: Any) -> None:
    global _client
    _client = client


# ---------- Esquemas ----------


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)


class AssistantRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_TURNS)
    consent: Literal[True] = Field(description="Confirma que a pessoa aceitou o envio do texto à Anthropic.")
    skill: Literal["geral", "matematica", "seguranca", "financas", "estudo", "escrita", "codigo"] = "geral"
    language: str | None = Field(
        default=None,
        pattern=r"^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$",
        description="Língua da resposta (BCP 47). Sem ela, responde na língua da pessoa.",
    )

    @field_validator("messages")
    @classmethod
    def _shape(cls, messages: list[ChatMessage]) -> list[ChatMessage]:
        if messages[0].role != "user" or messages[-1].role != "user":
            raise ValueError("A conversa tem de começar e acabar com uma mensagem tua.")
        for prev, cur in zip(messages, messages[1:]):
            if prev.role == cur.role:
                raise ValueError("As mensagens têm de alternar entre ti e o assistente.")
        if sum(len(m.content) for m in messages) > MAX_TOTAL_CHARS:
            raise ValueError("A conversa ficou demasiado longa. Começa uma nova.")
        return messages


class AssistantReply(BaseModel):
    reply: str
    refused: bool = Field(description="True quando o pedido foi recusado por segurança.")


class AssistantSkill(BaseModel):
    id: str
    name: str
    description: str


class AssistantLanguage(BaseModel):
    code: str
    name: str


class AssistantStatus(BaseModel):
    enabled: bool
    daily_limit: int
    model: str
    data_notice: str
    skills: list[AssistantSkill] = []
    languages: list[AssistantLanguage] = []


# ---------- Limites ----------


def _limit(user: UserRecord) -> None:
    """Gasta uma mensagem da quota da conta (rajada por minuto e total por dia)."""
    limiter = auth_routes.limiter
    retry = limiter.hit(f"assistant:burst:{user.id}", limit=6, window_seconds=60)
    if retry is not None:
        raise HTTPException(429, "Estás a enviar mensagens depressa demais. Espera um pouco.", headers={"Retry-After": str(retry)})
    daily = _daily_limit()
    retry = limiter.hit(f"assistant:day:{user.id}", limit=daily, window_seconds=86400)
    if retry is not None:
        raise HTTPException(
            429,
            f"Chegaste ao limite de {daily} mensagens por dia.",
            headers={"Retry-After": str(retry)},
        )


# ---------- Rotas ----------


@router.get("/status", response_model=AssistantStatus)
def status(user: UserRecord = Depends(auth_routes._require_user)) -> AssistantStatus:
    return AssistantStatus(
        enabled=_enabled(),
        daily_limit=_daily_limit(),
        model=_model(),
        data_notice=DATA_NOTICE,
        skills=[AssistantSkill(id=k, name=v["name"], description=v["description"]) for k, v in SKILLS.items()],
        languages=[AssistantLanguage(code=k, name=v) for k, v in LANGUAGES.items()],
    )


@router.post("/messages", response_model=AssistantReply, dependencies=[Depends(auth_routes._require_same_origin)])
def send_message(
    body: AssistantRequest,
    request: Request,
    user: UserRecord = Depends(auth_routes._require_user),
) -> AssistantReply:
    if not _enabled():
        raise HTTPException(503, "O assistente não está disponível neste momento.")
    _limit(user)

    # Matemática: raciocínio adaptativo e mais esforço, para contas com verificação.
    reasoning: dict[str, Any] = {}
    effort = os.getenv("ASSISTANT_EFFORT", "medium")
    if body.skill == "matematica":
        reasoning["thinking"] = {"type": "adaptive"}
        effort = os.getenv("ASSISTANT_MATH_EFFORT", "high")

    try:
        response = get_client().beta.messages.create(
            model=_model(),
            max_tokens=16000,
            system=_system_blocks(body.skill, body.language),
            messages=[{"role": m.role, "content": m.content} for m in body.messages],
            output_config={"effort": effort},
            **reasoning,
            # Se o modelo principal recusar por precaução, a API tenta um modelo alternativo.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            # Identificador opaco (hash): a Anthropic pode detetar abusos sem saber quem é.
            metadata={"user_id": hashlib.sha256(user.id.encode()).hexdigest()},
        )
    except anthropic.RateLimitError:
        logger.warning("assistant: limite do fornecedor atingido")
        raise HTTPException(503, "O assistente está ocupado. Tenta daqui a pouco.", headers={"Retry-After": "30"})
    except anthropic.APIStatusError as exc:
        logger.error(f"assistant: erro do fornecedor {exc.status_code}")
        raise HTTPException(502, "O assistente não conseguiu responder. Tenta de novo.")
    except anthropic.APIConnectionError:
        logger.error("assistant: sem ligação ao fornecedor")
        raise HTTPException(502, "O assistente não conseguiu responder. Tenta de novo.")

    if response.stop_reason == "refusal":
        return AssistantReply(
            reply="Não posso ajudar com esse pedido. Se precisas de ajuda com segurança, dinheiro ou estudo, reformula e eu ajudo.",
            refused=True,
        )

    text = "".join(block.text for block in response.content if getattr(block, "type", None) == "text").strip()
    if response.stop_reason == "max_tokens":
        text += "\n\n(A resposta foi cortada por ser longa. Pede-me para continuar.)"
    if not text:
        raise HTTPException(502, "O assistente não conseguiu responder. Tenta de novo.")
    return AssistantReply(reply=text, refused=False)
