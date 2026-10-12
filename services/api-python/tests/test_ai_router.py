from __future__ import annotations

import unittest
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from starlette.datastructures import Headers, UploadFile
from starlette.requests import Request

from src.app.routers.ai import (
    PLANS,
    _authenticated_user,
    _extract_pdf_text,
    _release_analysis,
    _reserve_analysis,
    analyze_pdf,
)


class PdfValidationTests(unittest.IsolatedAsyncioTestCase):
    def test_rejects_non_pdf_content(self) -> None:
        with self.assertRaises(HTTPException) as error:
            _extract_pdf_text(b"not a pdf")
        self.assertEqual(error.exception.status_code, 415)

    def test_rejects_malformed_pdf_content(self) -> None:
        with self.assertRaises(HTTPException) as error:
            _extract_pdf_text(b"%PDF-1.7\ninvalid")
        self.assertEqual(error.exception.status_code, 422)

    def test_rejects_pdf_without_extractable_text(self) -> None:
        from io import BytesIO

        from pypdf import PdfWriter

        output = BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        writer.write(output)

        with self.assertRaises(HTTPException) as error:
            _extract_pdf_text(output.getvalue())
        self.assertEqual(error.exception.status_code, 422)

    def test_free_plan_limits_are_explicit_and_paid_plans_are_not_enabled(self) -> None:
        self.assertEqual(PLANS["free"]["analyses_per_month"], 3)
        self.assertEqual(PLANS["free"]["max_pages"], 5)

    async def test_requires_authenticated_user(self) -> None:
        request = Request({"type": "http", "headers": []})
        with patch("src.app.routers.ai._current_user", new_callable=AsyncMock, return_value=None):
            with self.assertRaises(HTTPException) as error:
                await _authenticated_user(request)
        self.assertEqual(error.exception.status_code, 401)

    def test_shared_monthly_quota_rejects_fourth_request(self) -> None:
        user_id = "quota-test-user"
        reservations = [_reserve_analysis(user_id) for _ in range(3)]
        self.assertEqual([reservation[1] for reservation in reservations], [1, 2, 3])
        with self.assertRaises(HTTPException) as error:
            _reserve_analysis(user_id)
        self.assertEqual(error.exception.status_code, 429)
        for usage_key, _, _ in reservations:
            _release_analysis(usage_key)


class PdfOffloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_pdf_extraction_runs_in_threadpool(self) -> None:
        contents = b"%PDF-1.7\nmock document"
        request = Request({"type": "http", "headers": []})
        upload = UploadFile(
            file=BytesIO(contents),
            filename="report.pdf",
            headers=Headers({"content-type": "application/pdf"}),
        )

        with (
            patch("src.app.routers.ai._authenticated_user", new_callable=AsyncMock, return_value=SimpleNamespace(id="user")),
            patch("src.app.routers.ai.settings.ai_api_key", "configured"),
            patch("src.app.routers.ai.run_in_threadpool", new_callable=AsyncMock, return_value=("document text", 1)) as extract,
            patch("src.app.routers.ai._reserve_analysis", return_value=(("user", "month"), 1, 3)),
            patch("src.app.routers.ai._complete_chat", new_callable=AsyncMock, return_value="summary"),
        ):
            response = await analyze_pdf(request, upload)

        extract.assert_awaited_once_with(_extract_pdf_text, contents)
        self.assertEqual(response["analysis"], "summary")


if __name__ == "__main__":
    unittest.main()