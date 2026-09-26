from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage_legacy_workbook import (
    describe_database_url,
    database_url,
    extract_legacy_id,
    is_sensitive,
    redact_payload,
    stage_workbook,
)


class DatabaseUrlTests(unittest.TestCase):
    """`STAGING_DATABASE_URL` lets the staging tables live in another database."""

    CANONICAL = "postgresql://postgres:secret@db.example.supabase.co:5432/postgres"
    STAGING = "postgresql://postgres:local@localhost:5433/voa_staging"

    def test_staging_env_var_wins_for_staging_scripts(self) -> None:
        env = {"DIRECT_DATABASE_URL": self.CANONICAL, "STAGING_DATABASE_URL": self.STAGING}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(database_url(), self.STAGING)

    def test_canonical_resolution_ignores_the_staging_env_var(self) -> None:
        env = {"DIRECT_DATABASE_URL": self.CANONICAL, "STAGING_DATABASE_URL": self.STAGING}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(database_url(prefer_staging=False), self.CANONICAL)

    def test_direct_url_has_priority_over_database_url(self) -> None:
        env = {"DIRECT_DATABASE_URL": self.CANONICAL, "DATABASE_URL": "postgresql://pooler/db"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(database_url(), self.CANONICAL)

    def test_missing_url_returns_none(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(database_url())
            self.assertIsNone(database_url(prefer_staging=False))

    def test_describe_never_leaks_the_password(self) -> None:
        self.assertEqual(describe_database_url(self.CANONICAL), "db.example.supabase.co:5432/postgres")
        self.assertEqual(describe_database_url(self.STAGING), "localhost:5433/voa_staging")
        self.assertEqual(describe_database_url(""), "<unset>")
        self.assertNotIn("secret", describe_database_url(self.CANONICAL))


class StageLegacyWorkbookTests(unittest.TestCase):
    def test_redacts_passwords_and_api_keys(self) -> None:
        self.assertTrue(is_sensitive("USER_SENHA"))
        self.assertTrue(is_sensitive("USER_PASS"))
        self.assertTrue(is_sensitive("BANCO_APIKEY"))
        payload, fields = redact_payload({"USER_SENHA": "secret-value", "USER_NOME": "Ana", "ID": 1})
        self.assertEqual(payload["USER_SENHA"], "[REDACTED]")
        self.assertEqual(payload["USER_NOME"], "Ana")
        self.assertEqual(fields, ["USER_SENHA"])

    def test_extracts_legacy_id(self) -> None:
        self.assertEqual(extract_legacy_id({"ID": 75, "Escola.Nome": "Colegio"}), "75")
        self.assertIsNone(extract_legacy_id({"ID": None, "Escola.Nome": "Colegio"}))

    def test_preview_does_not_require_canonical_tables(self) -> None:
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "TBL_ESCOLA"
        sheet.append(["Title", "ID", "Escola.Nome", "BANCO_APIKEY"])
        sheet.append(["escola", 1, "Colegio Alfa", "live-key"])
        sheet.append(["escola", 1, "Colegio Alfa", "live-key"])
        sheet.append([None, None, None, None])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "VOA.xlsx"
            workbook.save(path)
            staged = stage_workbook(path)
        self.assertEqual(staged["row_count"], 2)
        self.assertEqual(staged["rows"][0]["payload"]["BANCO_APIKEY"], "[REDACTED]")
        self.assertIsNone(staged["rows"][0]["payload"].get("legalName"))
        codes = {error["error_code"] for error in staged["errors"]}
        self.assertIn("SENSITIVE_FIELDS_REDACTED", codes)
        self.assertIn("DUPLICATE_LEGACY_ID", codes)
        self.assertEqual(staged["reports"][0]["canonical_count"] if "canonical_count" in staged["reports"][0] else 0, 0)


if __name__ == "__main__":
    unittest.main()
