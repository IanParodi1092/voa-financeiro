from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_field_dictionary import (  # noqa: E402
    DEFAULT_DICTIONARY,
    DEFAULT_WORKBOOK,
    IGNORE,
    MAP,
    REVIEW,
    UNMAPPED,
    build_report,
    compare_inventories,
    decision_of,
    load_dictionary,
    parse_canonical_schema,
    read_workbook_inventory,
    resolve_column,
    resolve_inventory,
    validate_dictionary,
)

SCHEMA = {"schools": {"id", "legal_name", "document_number"}, "customers": {"id", "full_name"}}

MINIMAL_DICTIONARY = {
    "version": 1,
    "source_name": "TEST.xlsx",
    "type_conventions": {"name": "nome"},
    "normalizations": {"trim": "trim"},
    "reason_codes": {"empty_column": "vazia", "pending_policy": "pendente"},
    "schema_gaps": {"demo_gap": "gap de teste"},
    "sheets": {
        "SHEET_A": {
            "target_entity": "schools",
            "columns": [
                {"match": "Nome", "map": "schools.legal_name", "type": "name", "normalization": "trim"},
                {"match": "Vazia", "ignore": "empty_column"},
                {"match": "Pendente", "review": "pending_policy", "gap": "demo_gap"},
                {"match": "X*", "ignore": "empty_column"},
            ],
        }
    },
}


class DecisionTests(unittest.TestCase):
    def test_requires_exactly_one_kind(self) -> None:
        self.assertEqual(decision_of({"map": "schools.id", "type": "name"}), MAP)
        self.assertEqual(decision_of({"review": "pending_policy"}), REVIEW)
        with self.assertRaises(ValueError):
            decision_of({"map": "schools.id", "ignore": "empty_column"})
        with self.assertRaises(ValueError):
            decision_of({"note": "sem decisao"})


class ResolutionTests(unittest.TestCase):
    def test_exact_rule_beats_wildcard(self) -> None:
        rules = MINIMAL_DICTIONARY["sheets"]["SHEET_A"]["columns"]
        entry, source = resolve_column(rules, "Nome")
        self.assertEqual(source, "rule:Nome")
        self.assertEqual(entry["map"], "schools.legal_name")

    def test_wildcard_rule_resolves_unknown_column(self) -> None:
        rules = MINIMAL_DICTIONARY["sheets"]["SHEET_A"]["columns"]
        entry, source = resolve_column(rules, "XYZ")
        self.assertEqual(source, "rule:X*")
        self.assertEqual(entry["ignore"], "empty_column")

    def test_unmatched_column_without_default_is_unmapped(self) -> None:
        rules = MINIMAL_DICTIONARY["sheets"]["SHEET_A"]["columns"]
        entry, source = resolve_column(rules, "Outra")
        self.assertEqual(entry, {})
        self.assertEqual(source, UNMAPPED)

    def test_default_applies_when_sheet_declares_one(self) -> None:
        dictionary = {
            "sheets": {
                "SHEET_B": {"target_entity": None, "default": {"ignore": "empty_column"}}
            }
        }
        resolved = resolve_inventory(dictionary, {"SHEET_B": ["A", "B"]})["sheets"]["SHEET_B"]
        self.assertEqual([column["decision"] for column in resolved["columns"]], [IGNORE, IGNORE])
        self.assertEqual(resolved["columns"][0]["source"], "default")

    def test_unknown_sheet_is_reported(self) -> None:
        resolved = resolve_inventory({"sheets": {}}, {"SHEET_Z": ["A"]})
        self.assertEqual(resolved["unknown_sheets"], ["SHEET_Z"])
        column = resolved["sheets"]["SHEET_Z"]["columns"][0]
        self.assertEqual(column["decision"], UNMAPPED)
        # sem default a coluna nao tem decisao, mas o relatorio ainda a renderiza: as chaves
        # precisam existir do mesmo jeito (um KeyError aqui derruba o relatorio inteiro).
        self.assertEqual(
            set(column),
            {
                "column",
                "decision",
                "source",
                "target",
                "type",
                "normalization",
                "required",
                "priority",
                "status",
                "ref",
                "gap",
                "reason",
                "note",
                "values",
            },
        )


class ValidationTests(unittest.TestCase):
    def test_accepts_a_consistent_dictionary(self) -> None:
        validation = validate_dictionary(
            MINIMAL_DICTIONARY, SCHEMA, {"SHEET_A": ["Nome", "Vazia", "Pendente"]}
        )
        self.assertEqual(validation["structural"], [])
        self.assertEqual([item["code"] for item in validation["policy"]], ["REVIEW_REQUIRED"])

    def test_rejects_unknown_target_column(self) -> None:
        dictionary = {
            "type_conventions": {"name": "n"},
            "schema_gaps": {},
            "sheets": {
                "SHEET_A": {
                    "columns": [{"match": "Nome", "map": "schools.nome_inexistente", "type": "name"}]
                }
            },
        }
        codes = [
            item["code"]
            for item in validate_dictionary(dictionary, SCHEMA, {"SHEET_A": ["Nome"]})["structural"]
        ]
        self.assertIn("TARGET_COLUMN_UNKNOWN", codes)

    def test_rejects_unknown_target_table(self) -> None:
        dictionary = {
            "type_conventions": {"name": "n"},
            "schema_gaps": {},
            "sheets": {
                "SHEET_A": {"columns": [{"match": "Nome", "map": "legado.legal_name", "type": "name"}]}
            },
        }
        codes = [
            item["code"]
            for item in validate_dictionary(dictionary, SCHEMA, {"SHEET_A": ["Nome"]})["structural"]
        ]
        self.assertIn("TARGET_TABLE_UNKNOWN", codes)

    def test_rejects_missing_type_and_unknown_reason(self) -> None:
        dictionary = {
            "type_conventions": {"name": "n"},
            "reason_codes": {"empty_column": "vazia"},
            "schema_gaps": {},
            "sheets": {
                "SHEET_A": {
                    "columns": [
                        {"match": "Nome", "map": "schools.legal_name"},
                        {"match": "Vazia", "ignore": "motivo_desconhecido"},
                    ]
                }
            },
        }
        codes = [
            item["code"]
            for item in validate_dictionary(dictionary, SCHEMA, {"SHEET_A": ["Nome", "Vazia"]})["structural"]
        ]
        self.assertIn("MISSING_TYPE", codes)
        self.assertIn("UNKNOWN_REASON", codes)

    def test_rejects_missing_reason(self) -> None:
        dictionary = {
            "type_conventions": {},
            "reason_codes": {},
            "schema_gaps": {},
            "sheets": {"SHEET_A": {"columns": [{"match": "Vazia", "defer": ""}]}},
        }
        codes = [
            item["code"]
            for item in validate_dictionary(dictionary, SCHEMA, {"SHEET_A": ["Vazia"]})["structural"]
        ]
        self.assertIn("MISSING_REASON", codes)

    def test_rejects_duplicate_rules(self) -> None:
        dictionary = {
            "type_conventions": {"name": "n"},
            "reason_codes": {"empty_column": "vazia"},
            "schema_gaps": {},
            "sheets": {
                "SHEET_A": {
                    "columns": [
                        {"match": "Nome", "ignore": "empty_column"},
                        {"match": "Nome", "ignore": "empty_column"},
                    ]
                }
            },
        }
        codes = [
            item["code"]
            for item in validate_dictionary(dictionary, SCHEMA, {"SHEET_A": ["Nome"]})["structural"]
        ]
        self.assertIn("DUPLICATE_RULE", codes)

    def test_warns_about_two_legacy_id_providers(self) -> None:
        dictionary = {
            "type_conventions": {"legacy_id": "id"},
            "reason_codes": {},
            "schema_gaps": {},
            "sheets": {
                "SHEET_A": {
                    "columns": [
                        {
                            "match": "ID",
                            "map": "schools.id",
                            "type": "legacy_id",
                            "provides_legacy_id_for": "schools",
                        }
                    ]
                },
                "SHEET_B": {
                    "columns": [
                        {
                            "match": "ID",
                            "map": "customers.id",
                            "type": "legacy_id",
                            "provides_legacy_id_for": "schools",
                        }
                    ]
                },
            },
        }
        validation = validate_dictionary(
            dictionary, SCHEMA, {"SHEET_A": ["ID"], "SHEET_B": ["ID"]}
        )
        self.assertIn("MULTIPLE_LEGACY_ID_PROVIDERS", [item["code"] for item in validation["warnings"]])
        self.assertNotIn(
            "MULTIPLE_LEGACY_ID_PROVIDERS", [item["code"] for item in validation["structural"]]
        )

    def test_flags_unmapped_columns_and_unknown_sheets(self) -> None:
        dictionary = {"type_conventions": {}, "reason_codes": {}, "schema_gaps": {}, "sheets": {}}
        validation = validate_dictionary(dictionary, SCHEMA, {"SHEET_NOVA": ["A", "B"]})
        codes = [item["code"] for item in validation["structural"]]
        self.assertIn("SHEET_NOT_IN_DICTIONARY", codes)
        self.assertIn("UNMAPPED_COLUMNS", codes)

    def test_warns_about_rules_that_match_nothing(self) -> None:
        validation = validate_dictionary(
            MINIMAL_DICTIONARY, SCHEMA, {"SHEET_A": ["Nome", "Vazia", "Pendente"]}
        )
        stale = {item["column"] for item in validation["warnings"]}
        self.assertIn("X*", stale)
        self.assertNotIn("Nome", stale)
        self.assertEqual(validation["structural"], [])


class SchemaParsingTests(unittest.TestCase):
    def test_parses_create_and_alter_statements(self) -> None:
        schema = parse_canonical_schema()
        self.assertIn("schools", schema)
        for column in (
            "id",
            "legal_name",
            "trade_name",
            "document_number",
            "legacy_source",
            "legacy_table",
            "legacy_id",
        ):
            self.assertIn(column, schema["schools"])
        self.assertIn("retained_amount", schema["payments"])
        self.assertIn("enrollment_number", schema["students"])
        self.assertNotIn("constraint", schema["schools"])


class InventoryComparisonTests(unittest.TestCase):
    def test_classifies_empty_sheet_and_column_mismatch(self) -> None:
        workbook = {"SHEET_A": ["A", "B"], "SHEET_B": ["X"], "SHEET_C": ["Y"]}
        staging = {
            "SHEET_A": {"columns": ["A", "B"], "rows": 10},
            "SHEET_B": {"columns": [], "rows": 0},
            "SHEET_C": {"columns": ["Y", "Z"], "rows": 3},
        }
        differences = compare_inventories(workbook, staging)
        kinds = {item["sheet"]: item["kind"] for item in differences}
        self.assertEqual(kinds, {"SHEET_B": "empty_sheet", "SHEET_C": "column_mismatch"})
        extra = [item for item in differences if item["kind"] == "column_mismatch"][0]
        self.assertEqual(extra["extra_in_staging"], ["Z"])

    def test_reports_no_difference_when_columns_match(self) -> None:
        workbook = {"SHEET_A": ["A", "B"]}
        staging = {"SHEET_A": {"columns": ["B", "A"], "rows": 5}}
        self.assertEqual(compare_inventories(workbook, staging), [])


class ReportTests(unittest.TestCase):
    def test_renders_a_sheet_the_dictionary_does_not_know_yet(self) -> None:
        inventory = {"SHEET_NOVA": ["Nome", "TBL_CATEGORIAFILHODRE_DESCRICAO"]}
        validation = validate_dictionary(MINIMAL_DICTIONARY, SCHEMA, inventory)
        text = build_report(MINIMAL_DICTIONARY, validation, inventory, [])
        self.assertIn("### SHEET_NOVA", text)
        self.assertIn("TBL_CATEGORIAFILHODRE_DESCRICAO", text)


class RealDictionaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DEFAULT_WORKBOOK.exists():
            raise unittest.SkipTest(f"workbook not available: {DEFAULT_WORKBOOK}")
        cls.dictionary = load_dictionary(DEFAULT_DICTIONARY)
        cls.schema = parse_canonical_schema()
        cls.inventory = read_workbook_inventory(DEFAULT_WORKBOOK)
        cls.validation = validate_dictionary(cls.dictionary, cls.schema, cls.inventory)
        cls.resolved = cls.validation["resolved"]["sheets"]

    def test_covers_every_legacy_column(self) -> None:
        self.assertEqual(self.validation["structural"], [])
        decisions = {
            column["decision"]
            for report in self.resolved.values()
            for column in report["columns"]
        }
        self.assertNotIn(UNMAPPED, decisions)

    def test_every_map_target_exists_in_the_canonical_schema(self) -> None:
        mapped = 0
        for sheet, report in self.resolved.items():
            for column in report["columns"]:
                if column["decision"] != MAP:
                    continue
                mapped += 1
                table, _, target = column["target"].partition(".")
                self.assertIn(table, self.schema, f"{sheet}.{column['column']}")
                self.assertIn(target, self.schema[table], f"{sheet}.{column['column']}")
        self.assertGreater(mapped, 0)

    def test_core_entities_have_a_legacy_id_provider(self) -> None:
        providers = self.validation["providers"]
        for table in ("schools", "customers", "students", "agreements"):
            self.assertIn(table, providers)
            self.assertTrue(providers[table], table)
        # customers e alimentado por duas abas desde a decisao dos clientes pagadores
        # sintetizados: TBL_CLIENTE (registro institucional) e TBL_PAGAMENTO (pagador).
        self.assertEqual(providers["customers"], ["TBL_CLIENTE.ID", "TBL_PAGAMENTO.ID"])

    def test_no_legacy_secret_is_mapped(self) -> None:
        for sheet, report in self.resolved.items():
            for column in report["columns"]:
                if column["decision"] != MAP:
                    continue
                name = column["column"].lower()
                self.assertNotIn("senha", name)
                self.assertNotIn("pass", name)
                self.assertNotIn("apikey", name)

    def test_open_decisions_stay_blocked(self) -> None:
        reasons = {item.get("reason") for item in self.validation["policy"]}
        self.assertIn("unreliable_document_source", reasons)
        self.assertIn("pending_policy", reasons)
        self.assertIn("name_only_link_not_allowed", reasons)


if __name__ == "__main__":
    unittest.main(verbosity=2)

