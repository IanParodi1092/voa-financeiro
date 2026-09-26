from __future__ import annotations

import sys
import unittest
from decimal import Decimal
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_staging_batch import (  # noqa: E402
    BatchValidator,
    DUPLICATE_COMPOSITE_KEY,
    DUPLICATE_LEGACY_ID,
    FK_MISSING_REFERENCE,
    FindingCollector,
    SheetRules,
    TEXT_ENCODING_SUSPECT,
    build_rule_set,
    has_mojibake,
    is_valid_cnpj,
    is_valid_cpf,
    parse_amount,
    parse_date_value,
    render_markdown,
    repair_legacy_text,
    severity_for,
    summarize,
    validate_document,
)


class DocumentTests(unittest.TestCase):
    def test_validates_cpf_check_digits(self) -> None:
        self.assertTrue(is_valid_cpf("52998224725"))
        self.assertFalse(is_valid_cpf("52998224724"))
        self.assertFalse(is_valid_cpf("11111111111"))
        self.assertFalse(is_valid_cpf("5299822472"))

    def test_validates_cnpj_check_digits(self) -> None:
        self.assertTrue(is_valid_cnpj("11222333000181"))
        self.assertFalse(is_valid_cnpj("11222333000180"))
        self.assertFalse(is_valid_cnpj("00000000000000"))

    def test_classifies_document_kind(self) -> None:
        valid, kind, digits = validate_document("07.833.136/0001-21", "cpf_or_cnpj")
        self.assertEqual(kind, "cnpj")
        self.assertEqual(digits, "07833136000121")
        self.assertEqual(valid, is_valid_cnpj("07833136000121"))

        valid, kind, _ = validate_document("529.982.247-25", "cpf_or_cnpj")
        self.assertEqual(kind, "cpf")
        self.assertTrue(valid)

        valid, kind, digits = validate_document("123", "cpf_or_cnpj")
        self.assertFalse(valid)
        self.assertEqual(kind, "invalid-length")
        self.assertEqual(digits, "123")


class AmountTests(unittest.TestCase):
    def test_parses_pt_br_and_numbers(self) -> None:
        self.assertEqual(parse_amount("44,479"), Decimal("44.479"))
        self.assertEqual(parse_amount("1.234,56"), Decimal("1234.56"))
        self.assertEqual(parse_amount("R$ 10,00"), Decimal("10.00"))
        self.assertEqual(parse_amount(408), Decimal("408"))
        self.assertEqual(parse_amount(0.5), Decimal("0.5"))
        self.assertIsNone(parse_amount(""))
        self.assertIsNone(parse_amount("abc"))
        self.assertIsNone(parse_amount(True))


class DateTests(unittest.TestCase):
    def test_parses_iso_br_and_serial(self) -> None:
        self.assertEqual(parse_date_value("2021-10-10T20:00:00"), date(2021, 10, 10))
        self.assertEqual(parse_date_value("10/10/2021"), date(2021, 10, 10))
        self.assertIsNotNone(parse_date_value(44500))
        self.assertIsNone(parse_date_value("nao e data"))
        self.assertIsNone(parse_date_value("2021-13-45"))


class EncodingTests(unittest.TestCase):
    def test_detects_and_repairs_cp850_mojibake(self) -> None:
        cases = {
            "N\u00d2o": "N\u00e3o",
            "Prescrever\u00df em breve": "Prescrever\u00e1 em breve",
            "Educa\u00fe\u00d2o infantil - pr\u00da-escola": "Educa\u00e7\u00e3o infantil - pr\u00e9-escola",
            "Rua Rodolfo Champarine, n\u2551 275, Carapicu\u00ddba": "Rua Rodolfo Champarine, n\u00ba 275, Carapicu\u00edba",
            "LOTUS INCORPORA\u00c3\u0131ES": "LOTUS INCORPORA\u00c7\u00d5ES",
        }
        for value, expected in cases.items():
            with self.subTest(value=ascii(value)):
                self.assertTrue(has_mojibake(value))
                self.assertEqual(repair_legacy_text(value), expected)

    def test_detects_and_repairs_utf8_read_as_latin1(self) -> None:
        cases = {
            "N\u00c3\u00a3o": "N\u00e3o",
            "Educa\u00c3\u00a7\u00c3\u00a3o": "Educa\u00e7\u00e3o",
            "S\u00c3\u00a3o Paulo": "S\u00e3o Paulo",
            "Jos\u00c3\u00a9 da Silva": "Jos\u00e9 da Silva",
            "\u00e2\u20ac\u0153citacao": "\u201ccitacao",
            "\u00e2\u20ac\u009dcitacao": "\u201dcitacao",
        }
        for value, expected in cases.items():
            with self.subTest(value=ascii(value)):
                self.assertTrue(has_mojibake(value))
                self.assertEqual(repair_legacy_text(value), expected)

    def test_ignores_correct_portuguese(self) -> None:
        correct = [
            "Col\u00e9gio Manass\u00e9s",
            "N\u00e3o completa chamada",
            "N\u00c3O ENVIADO",
            "CITA\u00c7\u00c3O",
            "LE\u00c3O",
            "EVOLU\u00c7\u00c3O",
            "MARIANA VIT\u00d3RIA",
            "ESCRIT\u00d3RIO",
            "CAMPANHA \u00daNICA",
            "Processo n\u00ba 275",
            "370m\u00b2 Azulejo",
            "art. 841, \u00a7 2\u00ba do CPC",
            "S\u00e3o Paulo",
            "\u2013 Osasco",
            "D\u00b4Arc Instituto",
            "Anna Beatriz Mu\u00f1oz",
            "",
            None,
        ]
        for value in correct:
            with self.subTest(value=ascii(value)):
                self.assertFalse(has_mojibake(value) if isinstance(value, str) else False)
                self.assertIsNone(repair_legacy_text(value))

    def test_known_limitation_ambiguous_renderings(self) -> None:
        # `Col\xdagiogio` is the CP850 rendering of `Col\xe9gio`, but `\xda` is also valid
        # Portuguese (`\xdaNICO`), so the heuristic does not flag it; the dictionary phase
        # decides those columns.
        self.assertFalse(has_mojibake("Col\u00dagiogio"))
        self.assertIsNone(repair_legacy_text("Col\u00dagiogio"))
        self.assertFalse(has_mojibake("N\u00d3S"))


class SeverityTests(unittest.TestCase):
    def test_severity_mapping(self) -> None:
        self.assertEqual(severity_for(DUPLICATE_LEGACY_ID), "blocking")
        self.assertEqual(severity_for(DUPLICATE_COMPOSITE_KEY), "blocking")
        self.assertEqual(severity_for(FK_MISSING_REFERENCE), "error")
        self.assertEqual(severity_for(TEXT_ENCODING_SUSPECT), "warning")


class BatchValidatorTests(unittest.TestCase):
    def build_validator(self) -> tuple[BatchValidator, FindingCollector]:
        rules = {
            "TBL_ALUNO": SheetRules(
                foreign_keys=(("Aluno.Escola.ID", "TBL_ESCOLA", True),),
                required_fields=("Aluno.Nome",),
                documents=(("Aluno.CPFResponsavel", "cpf"),),
            ),
            "TBL_DIVIDA_LISTAGEM": SheetRules(
                foreign_keys=(("Divida_Listagem.Divida.ID", "TBL_DIVIDA", True),),
                required_fields=("Divida_Listagem.Valor",),
                composite_keys=(
                    (("Divida_Listagem.Divida.ID", "Divida_Listagem.Vencimento"), "debt_item_natural_key"),
                ),
                money_columns=("Divida_Listagem.Valor",),
            ),
        }
        references = {"TBL_ESCOLA": {"1"}, "TBL_ALUNO": {"10"}, "TBL_DIVIDA": {"500"}}
        collector = FindingCollector(sample_size=2, row_id_limit=10)
        return BatchValidator(rules, references, collector), collector

    def test_flags_missing_reference_and_required_field(self) -> None:
        validator, collector = self.build_validator()
        validator.evaluate_row(
            "TBL_ALUNO",
            2,
            "10",
            {"ID": 10, "Aluno.Nome": None, "Aluno.Escola.ID": 999, "Aluno.CPFResponsavel": "11111111111"},
            "row-1",
        )
        codes = {finding.error_code for finding in collector.findings()}
        self.assertIn(FK_MISSING_REFERENCE, codes)
        self.assertIn("REQUIRED_FIELD_EMPTY", codes)
        self.assertIn("DOCUMENT_INVALID", codes)
        self.assertEqual(validator.violations("TBL_ALUNO"), 3)

    def test_accepts_existing_reference_and_valid_document(self) -> None:
        validator, collector = self.build_validator()
        validator.evaluate_row(
            "TBL_ALUNO",
            2,
            "10",
            {"ID": 10, "Aluno.Nome": "Ana", "Aluno.Escola.ID": 1, "Aluno.CPFResponsavel": "529.982.247-25"},
            "row-1",
        )
        self.assertEqual(validator.violations("TBL_ALUNO"), 0)
        self.assertEqual([finding.error_code for finding in collector.findings()], [])

    def test_detects_duplicate_legacy_id_and_composite_key(self) -> None:
        validator, collector = self.build_validator()
        for row_number in (2, 3):
            validator.evaluate_row(
                "TBL_DIVIDA_LISTAGEM",
                row_number,
                "20477",
                {
                    "ID": 20477,
                    "Divida_Listagem.Divida.ID": "500",
                    "Divida_Listagem.Valor": 408,
                    "Divida_Listagem.Vencimento": "2021-10-10T20:00:00",
                },
            )
        validator.finish_sheet("TBL_DIVIDA_LISTAGEM")
        findings = {finding.error_code: finding for finding in collector.findings()}
        self.assertIn(DUPLICATE_LEGACY_ID, findings)
        self.assertEqual(findings[DUPLICATE_LEGACY_ID].severity, "blocking")
        self.assertIn(DUPLICATE_COMPOSITE_KEY, findings)
        self.assertEqual(validator.duplicate_candidates["TBL_DIVIDA_LISTAGEM"], 2)
        self.assertEqual(
            validator.money_totals["TBL_DIVIDA_LISTAGEM"]["Divida_Listagem.Valor"], Decimal("816")
        )

    def test_ignores_audit_by_columns_and_contact_values(self) -> None:
        rules = {
            "TBL_PAGAMENTO_FINANCEIRO": SheetRules(),
            "TBL_ENDTEL": SheetRules(),
        }
        collector = FindingCollector(sample_size=2)
        validator = BatchValidator(rules, {}, collector)
        validator.evaluate_row(
            "TBL_PAGAMENTO_FINANCEIRO",
            2,
            "1",
            {"Created By": "[List]", "Modified By": "[List]", "Created": "2022-01-01T10:00:00"},
        )
        validator.evaluate_row(
            "TBL_ENDTEL",
            2,
            "1",
            {"ENDTEL_VALOR": "(11) 36916430", "Created": "2022-01-01T10:00:00"},
        )
        self.assertEqual([finding.error_code for finding in collector.findings()], [])
        self.assertEqual(validator.violations("TBL_ENDTEL"), 0)

    def test_flags_unparseable_money_and_dates(self) -> None:
        rules = {"TBL_PUBLICACAODETALHE": SheetRules(), "TBL_CONTA": SheetRules()}
        collector = FindingCollector(sample_size=2)
        validator = BatchValidator(rules, {}, collector)
        validator.evaluate_row(
            "TBL_PUBLICACAODETALHE",
            2,
            "1815",
            {"PUBLICACAODETALHE_VALOR": "</tbody></table>", "PUBLICACOES_DATA": "32/13/2021"},
        )
        codes = {finding.error_code for finding in collector.findings()}
        self.assertIn("AMOUNT_UNPARSEABLE", codes)
        self.assertIn("DATE_UNPARSEABLE", codes)

    def test_flags_legacy_encoding_and_missing_legacy_id(self) -> None:
        validator, collector = self.build_validator()
        validator.evaluate_row(
            "TBL_ALUNO",
            2,
            None,
            {"Aluno.Nome": "N\u00d2o informado", "Aluno.Escola.ID": 1},
        )
        findings = {finding.error_code for finding in collector.findings()}
        self.assertIn("MISSING_LEGACY_ID", findings)
        self.assertIn(TEXT_ENCODING_SUSPECT, findings)

    def test_does_not_flag_correct_accents(self) -> None:
        validator, collector = self.build_validator()
        validator.evaluate_row(
            "TBL_ALUNO",
            2,
            "10",
            {
                "ID": 10,
                "Aluno.Nome": "Joaquim Moura Rom\u00e3o",
                "Aluno.Escola.ID": 1,
                "Aluno.CPFResponsavel": "529.982.247-25",
                "Aluno.Endereco": "Rua Rodolfo Champarine, n\u00ba 275, Carapicu\u00edba",
            },
        )
        self.assertNotIn(TEXT_ENCODING_SUSPECT, {finding.error_code for finding in collector.findings()})


class ReportingTests(unittest.TestCase):
    def build_result(self) -> dict:
        rules = build_rule_set(["TBL_ALUNO"])
        collector = FindingCollector(sample_size=1)
        references = {"TBL_ESCOLA": set()}
        validator = BatchValidator(rules, references, collector)
        validator.evaluate_row("TBL_ALUNO", 2, "10", {"ID": 10, "Aluno.Escola.ID": 5, "Aluno.Nome": "Ana"}, "row-1")
        validator.finish_sheet("TBL_ALUNO")
        return {
            "batch_id": "00000000-0000-0000-0000-000000000000",
            "rows_scanned": 1,
            "sheets": ["TBL_ALUNO"],
            "validator": validator,
            "findings": collector.findings(),
        }

    def test_summarize_counts_by_severity(self) -> None:
        summary = summarize(self.build_result())
        self.assertEqual(summary["rows_scanned"], 1)
        self.assertEqual(summary["totals"]["error"], 1)
        self.assertEqual(summary["per_sheet"]["TBL_ALUNO"]["staged_count"], 1)
        self.assertEqual(summary["per_sheet"]["TBL_ALUNO"]["blocking_errors"], 0)

    def test_markdown_report_mentions_no_canonical_writes(self) -> None:
        summary = summarize(self.build_result())
        markdown = render_markdown(summary, "VOA.xlsx", "staging", "2026-09-25T00:00:00+00:00", partial=False)
        self.assertIn("# Relatorio de validacao do staging", markdown)
        self.assertIn("canonica", markdown)
        self.assertIn("FK_MISSING_REFERENCE", markdown)
        self.assertIn("| TBL_ALUNO |", markdown)


if __name__ == "__main__":
    unittest.main()


