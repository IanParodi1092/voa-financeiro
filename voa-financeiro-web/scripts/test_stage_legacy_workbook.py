from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage_legacy_workbook import extract_legacy_id, is_sensitive, redact_payload, stage_workbook


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
