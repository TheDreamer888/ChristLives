from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import AsyncMock, patch

from cryptography.fernet import Fernet
from fastapi import HTTPException
from starlette.requests import Request

from src.app.routers.assistant import (
    NO_ANSWER,
    AssistantMessage,
    SalesLeadRequest,
    _contains_sensitive_input,
    _delete_sales_lead,
    _retrieve_documents,
    _save_sales_lead,
    chat,
    create_sales_lead,
    list_knowledge_sources,
    search_knowledge,
)


class AssistantKnowledgeTests(unittest.TestCase):
    def test_retrieval_finds_relevant_document_for_accents_and_case(self) -> None:
        documents = _retrieve_documents("Como funciona a AUTENTICAÇÃO por passkey?")
        self.assertEqual(documents[0]["id"], "terms")

    def test_unrelated_question_does_not_invoke_model(self) -> None:
        self.assertEqual(_retrieve_documents("Qual é a previsão do tempo em Lisboa?"), [])

    def test_sensitive_chat_content_is_rejected_before_external_processing(self) -> None:
        self.assertTrue(_contains_sensitive_input("O meu email é pessoa@example.com"))
        self.assertTrue(_contains_sensitive_input("A palavra-passe: segredo123"))
        self.assertFalse(_contains_sensitive_input("Como ativo uma passkey no Aegis?"))

    def test_search_returns_approved_sources_with_review_metadata(self) -> None:
        response = asyncio.run(search_knowledge(q="NIS2", limit=1))
        self.assertEqual(len(response["results"]), 1)
        self.assertEqual(response["results"][0]["authority"], "Portugal — Diário da República")
        self.assertEqual(response["results"][0]["reviewed_at"], "2026-10-10")
        self.assertTrue(response["results"][0]["url"].startswith("https://"))

    def test_sources_endpoint_does_not_expose_document_text(self) -> None:
        response = asyncio.run(list_knowledge_sources())
        self.assertGreaterEqual(len(response["sources"]), 10)
        self.assertNotIn("text", response["sources"][0])


class AssistantEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_rejects_sensitive_input_before_calling_model(self) -> None:
        request = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1234)})
        with patch(
            "src.app.routers.assistant._complete_chat",
            new_callable=AsyncMock,
        ) as complete, self.assertRaises(HTTPException) as error:
            await chat(
                AssistantMessage(message="O meu email é pessoa@example.com"),
                request,
            )
        self.assertEqual(error.exception.status_code, 422)
        complete.assert_not_awaited()

    async def test_chat_accepts_only_retrieved_citation_ids(self) -> None:
        request = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1234)})
        model_result = '{"answer":"Usa uma passkey para iniciar sessão.","source_ids":["terms","unknown"]}'
        with (
            patch("src.app.routers.assistant.settings.ai_api_key", "configured"),
            patch("src.app.routers.assistant._complete_chat", new_callable=AsyncMock, return_value=model_result) as complete,
            patch("src.app.routers.assistant._CHAT_WINDOWS", {}),
        ):
            response = await chat(
                AssistantMessage(message="Como funciona passkey?"),
                request,
            )
        self.assertEqual(response["answer"], "Usa uma passkey para iniciar sessão.")
        self.assertEqual(
            response["sources"],
            [{
                "title": "Termos de Serviço do Aegis",
                "url": "/legal/terms.html",
                "authority": "Aegis",
                "reviewed_at": "2026-10-10",
            }],
        )
        complete.assert_awaited_once()
        self.assertEqual(complete.await_args.kwargs["max_tokens"], 450)

    async def test_chat_abstains_when_model_cites_no_known_source(self) -> None:
        request = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1234)})
        with (
            patch("src.app.routers.assistant.settings.ai_api_key", "configured"),
            patch("src.app.routers.assistant._complete_chat", new_callable=AsyncMock, return_value='{"answer":"Resposta inventada","source_ids":["unknown"]}'),
            patch("src.app.routers.assistant._CHAT_WINDOWS", {}),
        ):
            response = await chat(
                AssistantMessage(message="Como funciona passkey?"),
                request,
            )
        self.assertEqual(response, {"answer": NO_ANSWER, "sources": []})


class SalesLeadStorageTests(unittest.TestCase):
    def test_lead_is_encrypted_and_deletion_token_removes_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "sales.sqlite3"
            with (
                patch("src.app.routers.assistant.settings.sales_lead_db_path", database_path),
                patch(
                    "src.app.routers.assistant.settings.sales_lead_enc_key",
                    Fernet.generate_key().decode("ascii"),
                ),
            ):
                token = _save_sales_lead(
                    SalesLeadRequest(
                        name="Ada Example",
                        email="ada@example.com",
                        adult_confirmed=True,
                        consent=True,
                    )
                )
                with closing(sqlite3.connect(database_path)) as connection:
                    row = connection.execute(
                        "SELECT name_ciphertext, email_ciphertext, delete_token_hash FROM sales_leads"
                    ).fetchone()
                with closing(sqlite3.connect(database_path)) as connection:
                    count_before = connection.execute("SELECT COUNT(*) FROM sales_leads").fetchone()[0]
                self.assertNotIn("Ada Example", row[0])
                self.assertNotIn("ada@example.com", row[1])
                self.assertNotEqual(token, row[2])
                self.assertEqual(count_before, 1)
                _delete_sales_lead(token)
                with closing(sqlite3.connect(database_path)) as connection:
                    self.assertEqual(connection.execute("SELECT COUNT(*) FROM sales_leads").fetchone()[0], 0)

    def test_lead_requires_adult_confirmation_and_consent(self) -> None:
        body = SalesLeadRequest(
            name="Ada Example",
            email="ada@example.com",
            adult_confirmed=False,
            consent=True,
        )
        with self.assertRaises(HTTPException) as error:
            asyncio.run(
                create_sales_lead(body, Request({"type": "http", "headers": []}))
            )
        self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
