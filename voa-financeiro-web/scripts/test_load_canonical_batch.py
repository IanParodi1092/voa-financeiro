from __future__ import annotations

import argparse
import os
import sys
import tempfile
import unittest
import uuid
from decimal import Decimal
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from load_canonical_batch import (  # noqa: E402
    DEFAULT_DICTIONARY,
    AggregateAccumulator,
    ColumnRule,
    LoadAborted,
    LoadState,
    RowOutcome,
    StagingError,
    build_plan,
    build_row_values,
    canonical_tables_for_counts,
    compute_aggregates,
    convert_value,
    describe_database_url,
    find_batch,
    insert_canonical,
    load_dictionary,
    normalize_key,
    parse_arguments,
    parse_canonical_columns,
    parse_date_value,
    parse_money,
    parse_unique_groups,
    preload_existing,
    preload_unique_keys,
    process_sheet,
    python_literal_default,
    quote_identifier,
    remember_unique_keys,
    render_report,
    required_columns,
    resolve_database_urls,
    resolve_defaults,
    row_uuid,
    sheet_order,
    store_row,
    summarize,
    unique_conflict,
    unique_key,
    uses_provenance,
)

MIGRATION_SQL = """
CREATE TABLE IF NOT EXISTS schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  legacy_source text,
  legacy_table text,
  legacy_id text,
  CONSTRAINT schools_legacy_key_unique UNIQUE (legacy_source, legacy_table, legacy_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  type text NOT NULL,
  value text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false
);

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS notes text DEFAULT 'n/a';

ALTER TABLE contacts ALTER COLUMN type SET DEFAULT 'unknown';
"""

TEXT = {"not_null": False, "has_default": False, "default": None}


def column(kind: str, not_null: bool = False, default: str | None = None) -> dict:
    return {
        "type": kind,
        "not_null": not_null,
        "has_default": default is not None,
        "default": default,
    }


SCHEMA = {
    "schools": {
        "id": column("uuid", True, "gen_random_uuid()"),
        "legal_name": column("text", True),
        "status": column("text", True, "'active'"),
        "legacy_source": column("text"),
        "legacy_table": column("text"),
        "legacy_id": column("text"),
    },
    "students": {
        "id": column("uuid", True, "gen_random_uuid()"),
        "school_id": column("uuid", True),
        "full_name": column("text", True),
        "status": column("text", True, "'active'"),
        "legacy_source": column("text"),
        "legacy_table": column("text"),
        "legacy_id": column("text"),
    },
    "customers": {
        "id": column("uuid", True, "gen_random_uuid()"),
        "full_name": column("text", True),
        "legacy_source": column("text"),
        "legacy_table": column("text"),
        "legacy_id": column("text"),
    },
    "contacts": {
        "id": column("uuid", True, "gen_random_uuid()"),
        "customer_id": column("uuid", True),
        "type": column("text", True),
        "value": column("text", True),
        "is_primary": column("boolean", True, "false"),
    },
    "agreements": {
        "id": column("uuid", True, "gen_random_uuid()"),
        "school_id": column("uuid", True),
        "customer_id": column("uuid", True),
        "total_amount": column("numeric", True),
        "installments_count": column("integer", True),
        "legacy_source": column("text"),
        "legacy_table": column("text"),
        "legacy_id": column("text"),
    },
    "installments": {
        "id": column("uuid", True, "gen_random_uuid()"),
        "agreement_id": column("uuid", True),
        "installment_number": column("integer", True),
        "original_amount": column("numeric", True),
    },
    "payments": {
        "id": column("uuid", True, "gen_random_uuid()"),
        "installment_id": column("uuid", True),
        "amount": column("numeric", True),
    },
}


DICTIONARY = {
    "version": 1,
    "source_name": "TEST.xlsx",
    "sheets": {
        "SHEET_SCHOOL": {
            "target_entity": "schools",
            "columns": [
                {
                    "match": "ID",
                    "map": "schools.legacy_id",
                    "type": "legacy_id",
                    "normalization": "trim",
                    "required": True,
                    "provides_legacy_id_for": "schools",
                },
                {
                    "match": "Nome",
                    "map": "schools.legal_name",
                    "type": "name",
                    "normalization": "trim",
                    "required": True,
                    "priority": 10,
                },
                {
                    "match": "RazaoSocial",
                    "map": "schools.legal_name",
                    "type": "name",
                    "normalization": "trim",
                    "priority": 20,
                },
            ],
        },
        "SHEET_STUDENT": {
            "target_entity": "students",
            "columns": [
                {
                    "match": "ID",
                    "map": "students.legacy_id",
                    "type": "legacy_id",
                    "normalization": "trim",
                    "required": True,
                    "provides_legacy_id_for": "students",
                },
                {
                    "match": "Aluno",
                    "map": "students.full_name",
                    "type": "name",
                    "normalization": "trim",
                    "required": True,
                },
                {
                    "match": "EscolaID",
                    "map": "students.school_id",
                    "type": "reference",
                    "ref": "schools",
                    "normalization": "trim",
                    "required": True,
                },
                {
                    "match": "Ativo",
                    "map": "students.status",
                    "type": "code",
                    "normalization": "value_map_ci",
                    "required": True,
                    "values": {"sim": "active", "nao": "inactive"},
                },
            ],
        },
        "SHEET_CONTACT": {
            "target_entity": "contacts",
            "columns": [
                {
                    "match": "ClienteID",
                    "map": "contacts.customer_id",
                    "type": "reference",
                    "ref": "customers",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "Tipo",
                    "map": "contacts.type",
                    "type": "code",
                    "normalization": "value_map_ci",
                    "status": "proposed",
                    "values": {"telefone": "phone", "email": "email"},
                },
                {
                    "match": "Valor",
                    "map": "contacts.value",
                    "type": "text",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                },
            ],
        },
        "SHEET_AGREEMENT": {
            "target_entity": "agreements",
            "columns": [
                {
                    "match": "ID",
                    "map": "agreements.legacy_id",
                    "type": "legacy_id",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                    "provides_legacy_id_for": "agreements",
                },
                {
                    "match": "EscolaID",
                    "map": "agreements.school_id",
                    "type": "reference",
                    "ref": "schools",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                },
            ],
        },
        "SHEET_INSTALLMENT": {
            "target_entity": "installments",
            "columns": [
                {
                    "match": "AcordoID",
                    "map": "installments.agreement_id",
                    "type": "reference",
                    "ref": "agreements",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "Parcela",
                    "map": "installments.installment_number",
                    "type": "integer",
                    "normalization": "integer",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "Valor",
                    "map": "installments.original_amount",
                    "type": "numeric",
                    "normalization": "money",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "ValorPago",
                    "map": "payments.amount",
                    "type": "numeric",
                    "normalization": "money",
                    "status": "proposed",
                },
            ],
            "links": {"payments.installment_id": "row:installments"},
        },
    },
}



def plan_of(dictionary: dict, requested=None, allow_proposed=(), schema=SCHEMA) -> dict:
    return build_plan(dictionary, schema, set(requested) if requested else None, set(allow_proposed))


def a_rule(**overrides) -> ColumnRule:
    base = {
        "source_column": "Campo",
        "table": "schools",
        "column": "legal_name",
        "field_type": "text",
        "normalization": "trim",
        "required": False,
        "priority": 10,
        "status": "confirmed",
        "ref": None,
        "values": None,
        "provides_legacy_id_for": None,
        "gap": None,
        "note": None,
    }
    base.update(overrides)
    return ColumnRule(**base)


class FakeCursor:
    """Minimal cursor double: records statements and replays canned results."""

    def __init__(self, results=None, rowcount: int = 0):
        self.results = list(results or [])
        self.statements: list[tuple[str, object]] = []
        self.rowcount = rowcount

    def execute(self, sql, params=None):
        self.statements.append((" ".join(str(sql).split()), params))

    def fetchone(self):
        return self.results.pop(0) if self.results else None

    def fetchall(self):
        return self.results.pop(0) if self.results else []

    def insert_statements(self) -> list[tuple[str, object]]:
        return [statement for statement in self.statements if statement[0].startswith("INSERT INTO")]


class RefusingCursor(FakeCursor):
    """Cursor double whose INSERT into one table raises, the way the database refuses the row."""

    def __init__(self, refuse_table: str = "contacts", results=None):
        super().__init__(results=results)
        self.refuse_table = refuse_table
        self.message = (
            f'new row for relation "{refuse_table}" violates check constraint "{refuse_table}_check"'
        )

    def execute(self, sql, params=None):
        statement = " ".join(str(sql).split())
        if statement.startswith("INSERT INTO") and f"INTO {self.refuse_table} " in statement:
            self.statements.append((statement, params))
            raise RuntimeError(self.message)
        super().execute(sql, params)


class SchemaParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        path = Path(self.temp.name) / "0001_test.sql"
        path.write_text(MIGRATION_SQL, encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_reads_columns_with_nullability_and_defaults(self) -> None:
        schema = parse_canonical_columns(Path(self.temp.name))
        self.assertEqual(
            required_columns("schools", schema), ["legal_name"]
        )
        self.assertTrue(schema["schools"]["status"]["has_default"])
        self.assertEqual(schema["schools"]["status"]["default"], "'active'")
        self.assertEqual(schema["schools"]["notes"]["default"], "'n/a'")

    def test_required_columns_ignore_defaults_and_nullable(self) -> None:
        schema = parse_canonical_columns(Path(self.temp.name))
        self.assertIn("customer_id", required_columns("contacts", schema))
        self.assertNotIn("is_primary", required_columns("contacts", schema))

    def test_real_migrations_mark_agreement_customer_as_required(self) -> None:
        schema = parse_canonical_columns()
        self.assertIn("customer_id", required_columns("agreements", schema))
        self.assertIn("installments_count", required_columns("agreements", schema))
        self.assertNotIn("status", required_columns("agreements", schema))

    def test_alter_column_default_from_a_later_migration_is_read(self) -> None:
        """`ALTER TABLE ... ALTER COLUMN ... SET DEFAULT` clears a column from the required set."""
        schema = parse_canonical_columns(Path(self.temp.name))
        self.assertTrue(schema["contacts"]["type"]["has_default"])
        self.assertEqual(schema["contacts"]["type"]["default"], "'unknown'")
        self.assertNotIn("type", required_columns("contacts", schema))
        self.assertEqual(resolve_defaults(schema, {"contacts": None})["contacts"]["type"], "unknown")

    def test_alter_column_drop_default_restores_the_required_gate(self) -> None:
        extra = Path(self.temp.name) / "0002_change.sql"
        extra.write_text(
            "ALTER TABLE contacts\n"
            "  ALTER COLUMN is_primary DROP DEFAULT,\n"
            "  ALTER COLUMN value SET NOT NULL;\n",
            encoding="utf-8",
        )
        schema = parse_canonical_columns(Path(self.temp.name))
        self.assertFalse(schema["contacts"]["is_primary"]["has_default"])
        self.assertIn("is_primary", required_columns("contacts", schema))
        self.assertTrue(schema["contacts"]["value"]["not_null"])

    def test_quote_identifier_rejects_injection(self) -> None:
        self.assertEqual(quote_identifier("schools"), "schools")
        with self.assertRaises(LoadAborted):
            quote_identifier("schools; drop table customers")


class ConversionTests(unittest.TestCase):
    def test_trim_and_collapse(self) -> None:
        self.assertEqual(convert_value("  Ana  Maria ", a_rule())[0], "Ana  Maria")
        self.assertEqual(
            convert_value("  Ana   Maria ", a_rule(normalization="collapse_ws"))[0], "Ana Maria"
        )

    def test_digits_keeps_only_numbers(self) -> None:
        self.assertEqual(convert_value("12.345.678/0001-90", a_rule(normalization="digits"))[0], "12345678000190")

    def test_money_brazilian_and_plain(self) -> None:
        self.assertEqual(str(parse_money("R$ 1.234,56")), "1234.56")
        self.assertEqual(str(parse_money("1.234,56")), "1234.56")
        self.assertEqual(str(parse_money("1234.56")), "1234.56")
        self.assertEqual(str(parse_money("(1.234,56)")), "-1234.56")
        self.assertIsNone(parse_money("abc"))
        self.assertEqual(str(convert_value("1.234,56", a_rule(normalization="money"))[0]), "1234.56")

    def test_money_reports_unparseable(self) -> None:
        value, finding = convert_value("sem valor", a_rule(normalization="money"))
        self.assertIsNone(value)
        self.assertEqual(finding, "LOAD_MONEY_UNPARSEABLE")

    def test_date_formats(self) -> None:
        self.assertEqual(parse_date_value("2024-03-05").isoformat(), "2024-03-05")
        self.assertEqual(parse_date_value("05/03/2024").isoformat(), "2024-03-05")
        self.assertIsNone(parse_date_value("31/31/2024"))
        self.assertEqual(str(convert_value("05/03/2024", a_rule(normalization="iso_date"))[0]), "2024-03-05")

    def test_integer_and_unmapped_values(self) -> None:
        self.assertEqual(convert_value(" 7 ", a_rule(normalization="integer"))[0], 7)
        value, finding = convert_value("x", a_rule(normalization="value_map_ci", values={"sim": "active"}))
        self.assertIsNone(value)
        self.assertEqual(finding, "LOAD_VALUE_UNMAPPED")

    def test_value_map_ci_ignores_case_and_accents(self) -> None:
        rule = a_rule(normalization="value_map_ci", values={"sim": "active", "nao": "inactive"})
        self.assertEqual(convert_value("Não", rule)[0], "inactive")
        self.assertEqual(convert_value("SIM", rule)[0], "active")
        rule_upper = a_rule(normalization="value_map_ci", values={"telefone": "phone"})
        self.assertEqual(convert_value("TELEFONE", rule_upper)[0], "phone")

    def test_min_positive_discards_zero(self) -> None:
        value, finding = convert_value("0,00", a_rule(normalization="min_positive"))
        self.assertIsNone(value)
        self.assertIsNone(finding)

    def test_positive_integer_discards_zero_and_negatives(self) -> None:
        rule = a_rule(normalization="positive_integer")
        self.assertEqual(convert_value("3", rule), (3, None))
        self.assertEqual(convert_value("4.0", rule), (4, None))
        self.assertEqual(convert_value("0", rule), (None, None))
        self.assertEqual(convert_value("-2", rule), (None, None))
        self.assertEqual(convert_value("1/12", rule), (None, "LOAD_INTEGER_UNPARSEABLE"))

    def test_fraction_accepts_brazilian_decimal_and_float_noise(self) -> None:
        rule = a_rule(normalization="fraction")
        self.assertEqual(str(convert_value("0,25", rule)[0]), "0.2500")
        self.assertEqual(str(convert_value("0,35", rule)[0]), "0.3500")
        self.assertEqual(str(convert_value("0,25000001", rule)[0]), "0.2500")
        self.assertEqual(str(convert_value("25%", rule)[0]), "0.2500")
        self.assertEqual(str(convert_value(0.15, rule)[0]), "0.1500")

    def test_fraction_refuses_values_outside_the_range(self) -> None:
        rule = a_rule(normalization="fraction")
        value, finding = convert_value("1,5", rule)
        self.assertIsNone(value)
        self.assertEqual(finding, "LOAD_FRACTION_UNPARSEABLE")
        self.assertIsNone(convert_value("25", rule)[0])
        self.assertIsNone(convert_value("-0,1", rule)[0])

    def test_month_year_normalises_the_legacy_format(self) -> None:
        rule = a_rule(normalization="month_year")
        self.assertEqual(convert_value("09 2024", rule)[0], "2024-09")
        self.assertEqual(convert_value("9/2024", rule)[0], "2024-09")
        self.assertEqual(convert_value("2024-09", rule)[0], "2024-09")
        value, finding = convert_value("13 2024", rule)
        self.assertIsNone(value)
        self.assertEqual(finding, "LOAD_MONTH_YEAR_UNPARSEABLE")

    def test_normalize_key_strips_accents(self) -> None:
        self.assertEqual(normalize_key("Não Ação"), "NAO ACAO")

    def test_python_literal_default(self) -> None:
        self.assertEqual(python_literal_default("'active'::text"), "active")
        self.assertEqual(python_literal_default("false"), False)
        self.assertEqual(python_literal_default("0"), 0)
        self.assertIsNone(python_literal_default("now()"))
        self.assertIsNone(python_literal_default("gen_random_uuid()"))



class PlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.plan_data = plan_of(DICTIONARY)
        self.tables = self.plan_data["tables"]

    def test_ready_tables_come_in_dependency_order(self) -> None:
        ready = [table for table in self.plan_data["order"] if self.tables[table].status == "ready"]
        self.assertEqual(ready, ["schools", "students"])

    def test_schools_required_columns_are_covered(self) -> None:
        self.assertEqual(self.tables["schools"].missing_required, [])
        self.assertEqual(self.tables["schools"].provider, "ID")

    def test_agreements_blocked_by_uncovered_required_columns(self) -> None:
        agreements = self.tables["agreements"]
        self.assertEqual(agreements.status, "blocked")
        self.assertEqual(agreements.blocked_reason, "required_columns_uncovered")
        self.assertEqual(
            agreements.missing_required, ["customer_id", "installments_count", "total_amount"]
        )

    def test_proposed_mapping_needs_operator_approval(self) -> None:
        for table in ("contacts", "installments", "payments"):
            self.assertEqual(self.tables[table].blocked_reason, "mapping_not_confirmed", table)
        self.assertIn("value", self.tables["contacts"].proposed_columns)

    def test_allow_proposed_unblocks_contact_sheet(self) -> None:
        plan = plan_of(DICTIONARY, allow_proposed={"contacts"})["tables"]
        self.assertEqual(plan["contacts"].status, "ready")

    def test_dependency_block_propagates(self) -> None:
        plan = plan_of(DICTIONARY, allow_proposed={"installments", "payments"})["tables"]
        self.assertEqual(plan["installments"].blocked_reason, "dependency_not_loaded")
        self.assertIn("agreements", plan["installments"].detail)
        self.assertEqual(plan["payments"].blocked_reason, "dependency_not_loaded")
        self.assertIn("installments", plan["payments"].detail)

    def test_row_links_become_column_coverage(self) -> None:
        payments = self.tables["payments"]
        self.assertEqual(payments.links, {"installment_id": "installments"})
        self.assertIn("installments", payments.dependencies)
        self.assertEqual(self.tables["installments"].dependencies, ["agreements"])

    def test_requested_filter_marks_other_tables(self) -> None:
        plan = plan_of(DICTIONARY, requested={"schools"})["tables"]
        self.assertEqual(plan["schools"].status, "ready")
        self.assertEqual(plan["students"].status, "not_requested")

    def test_unknown_target_column_is_a_problem(self) -> None:
        broken = {
            "sheets": {
                "SHEET_A": {
                    "target_entity": "schools",
                    "columns": [{"match": "X", "map": "schools.nao_existe", "type": "name"}],
                }
            }
        }
        problems = plan_of(broken)["problems"]
        self.assertIn("TARGET_COLUMN_UNKNOWN", [item["code"] for item in problems])

    def test_column_normalization_must_be_implemented_and_declared(self) -> None:
        unknown = {
            "sheets": {
                "SHEET_A": {
                    "target_entity": "schools",
                    "columns": [
                        {
                            "match": "X",
                            "map": "schools.legal_name",
                            "type": "name",
                            "normalization": "inventada",
                        }
                    ],
                }
            }
        }
        self.assertIn(
            "COLUMN_NORMALIZATION_UNKNOWN",
            [item["code"] for item in plan_of(unknown)["problems"]],
        )
        undeclared = {
            "normalizations": {"trim": "remove espacos nas pontas"},
            "sheets": {
                "SHEET_A": {
                    "target_entity": "schools",
                    "columns": [
                        {
                            "match": "X",
                            "map": "schools.legal_name",
                            "type": "name",
                            "normalization": "digits",
                        }
                    ],
                }
            },
        }
        self.assertIn(
            "COLUMN_NORMALIZATION_UNDECLARED",
            [item["code"] for item in plan_of(undeclared)["problems"]],
        )

    def test_wildcard_default_map_is_rejected(self) -> None:
        broken = {"sheets": {"SHEET_A": {"default": {"map": "schools.legal_name", "type": "name"}}}}
        problems = plan_of(broken)["problems"]
        self.assertEqual([item["code"] for item in problems], ["WILDCARD_MAP_NOT_SUPPORTED"])

    def test_link_conflict_with_map_is_a_problem(self) -> None:
        broken = {
            "sheets": {
                "SHEET_A": {
                    "target_entity": "installments",
                    "columns": [
                        {
                            "match": "Parcela",
                            "map": "installments.installment_number",
                            "type": "integer",
                            "normalization": "integer",
                        },
                        {
                            "match": "Acordo",
                            "map": "installments.agreement_id",
                            "type": "reference",
                            "ref": "agreements",
                        },
                        {"match": "Pg", "map": "payments.amount", "type": "numeric", "normalization": "money"},
                    ],
                    "links": {"payments.amount": "row:installments"},
                }
            }
        }
        problems = plan_of(broken)["problems"]
        self.assertIn("LINK_CONFLICTS_WITH_MAP", [item["code"] for item in problems])

    def test_sheet_order_uses_primary_table_order(self) -> None:
        plan_data = plan_of(DICTIONARY)
        order = sheet_order(plan_data["sheets"], plan_data["tables"])
        self.assertEqual(order[:3], ["SHEET_SCHOOL", "SHEET_CONTACT", "SHEET_STUDENT"])

    def test_sheet_order_waits_for_every_producer_of_a_referenced_table(self) -> None:
        """`contacts` waits for every sheet that creates `customers`, not only the first one.

        `TBL_PAGAMENTO` creates customers the `TBL_CLIENTE` sheet does not cover, so loading
        contacts before it discards those rows on an empty database as `LOAD_REFERENCE_UNRESOLVED`.
        """
        dictionary = {
            "version": 1,
            "source_name": "TEST.xlsx",
            "sheets": {
                "SHEET_CLIENTE": {
                    "target_entity": "customers",
                    "columns": [
                        {
                            "match": "ID",
                            "map": "customers.legacy_id",
                            "type": "legacy_id",
                            "normalization": "trim",
                            "required": True,
                            "provides_legacy_id_for": "customers",
                        },
                        {
                            "match": "Nome",
                            "map": "customers.full_name",
                            "type": "name",
                            "normalization": "trim",
                            "required": True,
                        },
                    ],
                },
                "SHEET_CONTATO": {
                    "target_entity": "contacts",
                    "columns": [
                        {
                            "match": "ClienteID",
                            "map": "contacts.customer_id",
                            "type": "reference",
                            "ref": "customers",
                            "normalization": "trim",
                            "required": True,
                        },
                        {
                            "match": "Tipo",
                            "map": "contacts.type",
                            "type": "code",
                            "normalization": "value_map_ci",
                            "required": True,
                            "values": {"telefone": "phone"},
                        },
                        {
                            "match": "Valor",
                            "map": "contacts.value",
                            "type": "text",
                            "normalization": "trim",
                            "required": True,
                        },
                    ],
                },
                "SHEET_PAGAMENTO": {
                    "target_entity": "agreements",
                    "columns": [
                        {
                            "match": "ID",
                            "map": "agreements.legacy_id",
                            "type": "legacy_id",
                            "normalization": "trim",
                            "required": True,
                            "provides_legacy_id_for": "agreements",
                        },
                        {
                            "match": "Cliente",
                            "map": "customers.full_name",
                            "type": "name",
                            "normalization": "trim",
                        },
                    ],
                },
            },
        }
        plan_data = plan_of(dictionary)
        order = sheet_order(plan_data["sheets"], plan_data["tables"])
        self.assertEqual(order, ["SHEET_CLIENTE", "SHEET_PAGAMENTO", "SHEET_CONTATO"])

    def test_sheet_order_survives_a_dependency_cycle(self) -> None:
        """Two sheets that reference each other fall back to the primary-table order."""
        dictionary = {
            "version": 1,
            "source_name": "TEST.xlsx",
            "sheets": {
                "SHEET_A": {
                    "target_entity": "agreements",
                    "columns": [
                        {
                            "match": "ID",
                            "map": "agreements.legacy_id",
                            "type": "legacy_id",
                            "normalization": "trim",
                            "required": True,
                            "provides_legacy_id_for": "agreements",
                        },
                        {
                            "match": "Cliente",
                            "map": "agreements.customer_id",
                            "type": "reference",
                            "ref": "contacts",
                            "required": True,
                        },
                    ],
                },
                "SHEET_B": {
                    "target_entity": "contacts",
                    "columns": [
                        {
                            "match": "Acordo",
                            "map": "contacts.customer_id",
                            "type": "reference",
                            "ref": "agreements",
                            "required": True,
                        },
                        {
                            "match": "Tipo",
                            "map": "contacts.type",
                            "type": "code",
                            "normalization": "value_map_ci",
                            "required": True,
                            "values": {"telefone": "phone"},
                        },
                    ],
                },
            },
        }
        plan_data = plan_of(dictionary)
        self.assertIn("DEPENDENCY_CYCLE", [item["code"] for item in plan_data["problems"]])
        order = sheet_order(plan_data["sheets"], plan_data["tables"])
        self.assertEqual(order, ["SHEET_B", "SHEET_A"])
        self.assertEqual(sorted(order), ["SHEET_A", "SHEET_B"])



class RowValueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.plan_data = plan_of(DICTIONARY, allow_proposed={"contacts"})
        self.plan = self.plan_data["tables"]
        self.defaults = resolve_defaults(SCHEMA, self.plan)
        self.maps: dict[str, dict[str, str]] = {"schools": {"1": "school-uuid-1"}}

    def resolve(self, sheet: str, payload: dict):
        tables = self.plan_data["sheets"][sheet]["tables"]
        return build_row_values(sheet, tables, self.plan, payload, self.maps, self.defaults)

    def test_priority_column_overrides_when_filled(self) -> None:
        outcomes = self.resolve(
            "SHEET_SCHOOL", {"ID": " 9 ", "Nome": "Escola A", "RazaoSocial": "ESCOLA A LTDA"}
        )
        self.assertEqual(outcomes["schools"].values["legal_name"], "ESCOLA A LTDA")
        self.assertEqual(outcomes["schools"].legacy_id, "9")

    def test_priority_keeps_first_value_when_second_is_empty(self) -> None:
        outcomes = self.resolve("SHEET_SCHOOL", {"ID": "9", "Nome": "Escola A", "RazaoSocial": None})
        self.assertEqual(outcomes["schools"].values["legal_name"], "Escola A")

    def test_required_empty_skips_the_row(self) -> None:
        outcomes = self.resolve("SHEET_SCHOOL", {"ID": "9", "Nome": "   "})
        outcome = outcomes["schools"]
        self.assertEqual(outcome.skipped, "LOAD_REQUIRED_FIELD_EMPTY")
        self.assertEqual(outcome.skip_field, "Nome")
        self.assertNotIn("legal_name", outcome.values)

    def test_required_empty_with_canonical_default_is_reported(self) -> None:
        outcomes = self.resolve(
            "SHEET_STUDENT", {"ID": "5", "Aluno": "Ana", "EscolaID": "1", "Ativo": None}
        )
        outcome = outcomes["students"]
        self.assertIsNone(outcome.skipped)
        self.assertEqual(outcome.values["status"], "active")
        self.assertEqual([code for code, _, _ in outcome.findings], ["LOAD_VALUE_DEFAULTED"])

    def test_reference_is_resolved_from_the_legacy_map(self) -> None:
        outcomes = self.resolve(
            "SHEET_STUDENT", {"ID": "5", "Aluno": "Ana", "EscolaID": " 1 ", "Ativo": "Não"}
        )
        self.assertEqual(outcomes["students"].values["school_id"], "school-uuid-1")
        self.assertEqual(outcomes["students"].values["status"], "inactive")

    def test_unresolved_required_reference_skips_the_row(self) -> None:
        outcomes = self.resolve(
            "SHEET_STUDENT", {"ID": "5", "Aluno": "Ana", "EscolaID": "404", "Ativo": "Sim"}
        )
        outcome = outcomes["students"]
        self.assertEqual(outcome.skipped, "LOAD_REFERENCE_UNRESOLVED")
        self.assertEqual(outcome.skip_field, "EscolaID")
        self.assertIn("404", outcome.skip_detail)

    def test_multivalue_reference_is_reported_and_resolved(self) -> None:
        outcomes = self.resolve(
            "SHEET_STUDENT", {"ID": "5", "Aluno": "Ana", "EscolaID": "1;2", "Ativo": "Sim"}
        )
        outcome = outcomes["students"]
        self.assertEqual(outcome.values["school_id"], "school-uuid-1")
        self.assertIn("LOAD_REFERENCE_MULTIVALUE", [code for code, _, _ in outcome.findings])

    def test_missing_legacy_id_is_reported(self) -> None:
        outcomes = self.resolve("SHEET_SCHOOL", {"ID": None, "Nome": "Escola A"})
        outcome = outcomes["schools"]
        self.assertEqual(outcome.skipped, "LOAD_LEGACY_ID_MISSING")
        self.assertIn("LOAD_LEGACY_ID_MISSING", [code for code, _, _ in outcome.findings])

    def test_row_uuid_is_deterministic(self) -> None:
        self.assertEqual(row_uuid("SHEET_CONTACT", 10), row_uuid("SHEET_CONTACT", 10))
        self.assertNotEqual(row_uuid("SHEET_CONTACT", 10), row_uuid("SHEET_CONTACT", 11))
        self.assertIsInstance(row_uuid("SHEET_CONTACT", 10), uuid.UUID)



class StoreRowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.plan = plan_of(DICTIONARY, allow_proposed={"contacts"})["tables"]

    def state(self, commit: bool, enrich: bool = False) -> LoadState:
        return LoadState(
            legacy_source="powerapps-voa", batch_id="batch-1", commit=commit, enrich=enrich
        )

    def outcome(self, legacy_id: str | None = "9", **values) -> RowOutcome:
        outcome = RowOutcome(values=dict(values))
        outcome.legacy_id = legacy_id
        return outcome

    def test_dry_run_counts_without_writing(self) -> None:
        cursor = FakeCursor()
        state = self.state(commit=False)
        store_row(
            cursor,
            "SHEET_SCHOOL",
            5,
            "schools",
            self.outcome(legal_name="Escola A"),
            self.plan["schools"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        self.assertEqual(cursor.statements, [])
        self.assertEqual(state.stats("schools").inserted, 1)
        self.assertEqual(state.legacy_maps["schools"]["9"], state.row_ids["schools"])

    def test_commit_inserts_with_provenance(self) -> None:
        cursor = FakeCursor(results=[("uuid-new",)])
        state = self.state(commit=True)
        store_row(
            cursor,
            "SHEET_SCHOOL",
            5,
            "schools",
            self.outcome(legal_name="Escola A"),
            self.plan["schools"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        insert_sql, params = cursor.insert_statements()[0]
        self.assertIn("ON CONFLICT (legacy_source, legacy_table, legacy_id) DO NOTHING", insert_sql)
        self.assertEqual(params[1:4], ["9", "powerapps-voa", "SHEET_SCHOOL"])
        self.assertEqual(state.stats("schools").inserted, 1)
        self.assertEqual(state.row_ids["schools"], "uuid-new")
        self.assertEqual(
            [sql for sql, _ in cursor.statements],
            ["SAVEPOINT load_row", insert_sql, "RELEASE SAVEPOINT load_row"],
        )

    def test_existing_provenance_key_is_reused(self) -> None:
        cursor = FakeCursor()
        state = self.state(commit=True)
        state.provenance_keys["schools"] = {("SHEET_SCHOOL", "9"): "uuid-existente"}
        store_row(
            cursor,
            "SHEET_SCHOOL",
            5,
            "schools",
            self.outcome(legal_name="Escola A"),
            self.plan["schools"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        self.assertEqual(cursor.statements, [])
        self.assertEqual(state.stats("schools").reused, 1)
        self.assertEqual(state.row_ids["schools"], "uuid-existente")

    def test_reused_row_is_enriched_when_the_operator_asks(self) -> None:
        """A column added by a later migration gets filled on rows an earlier run stored."""
        cursor = FakeCursor(rowcount=1)
        state = self.state(commit=True, enrich=True)
        state.provenance_keys["schools"] = {("SHEET_SCHOOL", "9"): "uuid-existente"}
        store_row(
            cursor,
            "SHEET_SCHOOL",
            5,
            "schools",
            self.outcome(legal_name="Escola A"),
            self.plan["schools"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        statement, params = cursor.statements[0]
        self.assertTrue(statement.startswith("UPDATE schools SET"))
        self.assertIn("legal_name = COALESCE(legal_name, %s)", statement)
        self.assertIn("WHERE id = %s AND (legal_name IS NULL)", statement)
        self.assertEqual(params[-1], "uuid-existente")
        stats = state.stats("schools")
        self.assertEqual(stats.reused, 1)
        self.assertEqual(stats.enriched, 1)

    def test_enrichment_is_skipped_without_commit(self) -> None:
        cursor = FakeCursor(rowcount=1)
        state = self.state(commit=False, enrich=True)
        state.provenance_keys["schools"] = {("SHEET_SCHOOL", "9"): "uuid-existente"}
        store_row(
            cursor,
            "SHEET_SCHOOL",
            5,
            "schools",
            self.outcome(legal_name="Escola A"),
            self.plan["schools"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        self.assertEqual(cursor.statements, [])
        self.assertEqual(state.stats("schools").enriched, 0)

    def test_enrichment_counts_only_rows_with_an_empty_column(self) -> None:
        cursor = FakeCursor(rowcount=0)
        state = self.state(commit=True, enrich=True)
        state.provenance_keys["schools"] = {("SHEET_SCHOOL", "9"): "uuid-existente"}
        store_row(
            cursor,
            "SHEET_SCHOOL",
            5,
            "schools",
            self.outcome(legal_name="Escola A"),
            self.plan["schools"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        self.assertEqual(state.stats("schools").enriched, 0)
        self.assertEqual(state.stats("schools").reused, 1)

    def test_deterministic_rows_are_enriched_too(self) -> None:
        cursor = FakeCursor(results=[(str(row_uuid("SHEET_CONTACT", 7)),)], rowcount=1)
        state = self.state(commit=True, enrich=True)
        target = self.plan["contacts"]
        outcome = self.outcome(
            legacy_id=None, customer_id="customer-uuid", type="phone", value="11 99999-0000"
        )
        store_row(cursor, "SHEET_CONTACT", 7, "contacts", outcome, target, SCHEMA, state.legacy_source, state)
        seen = len(cursor.statements)
        store_row(cursor, "SHEET_CONTACT", 7, "contacts", outcome, target, SCHEMA, state.legacy_source, state)
        new_statements = [sql for sql, _ in cursor.statements[seen:]]
        self.assertEqual(len(new_statements), 1)
        self.assertTrue(new_statements[0].startswith("UPDATE contacts SET"))
        self.assertEqual(state.stats("contacts").enriched, 1)

    def test_rows_without_legacy_id_are_skipped(self) -> None:
        cursor = FakeCursor()
        state = self.state(commit=True)
        store_row(
            cursor,
            "SHEET_SCHOOL",
            5,
            "schools",
            self.outcome(legacy_id=None, legal_name="Escola A"),
            self.plan["schools"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        stats = state.stats("schools")
        self.assertEqual(stats.skipped, 1)
        self.assertEqual(stats.skip_reasons, {"LOAD_LEGACY_ID_MISSING": 1})
        self.assertEqual(cursor.statements, [])

    def test_contacts_use_a_deterministic_uuid_and_stay_idempotent(self) -> None:
        cursor = FakeCursor(results=[(str(row_uuid("SHEET_CONTACT", 7)),)])
        state = self.state(commit=True)
        target = self.plan["contacts"]
        outcome = self.outcome(legacy_id=None, customer_id="customer-uuid", type="phone", value="11 99999-0000")
        store_row(cursor, "SHEET_CONTACT", 7, "contacts", outcome, target, SCHEMA, state.legacy_source, state)
        insert_sql, params = cursor.insert_statements()[0]
        self.assertIn("ON CONFLICT (id) DO NOTHING", insert_sql)
        self.assertEqual(params[1], str(row_uuid("SHEET_CONTACT", 7)))
        self.assertEqual(state.stats("contacts").inserted, 1)

        store_row(cursor, "SHEET_CONTACT", 7, "contacts", outcome, target, SCHEMA, state.legacy_source, state)
        self.assertEqual(state.stats("contacts").reused, 1)
        self.assertEqual(len(cursor.insert_statements()), 1)

    def test_a_duplicate_unique_key_is_reported_instead_of_inserted(self) -> None:
        cursor = FakeCursor()
        state = self.state(commit=True)
        state.unique_groups = {"contacts": [("customer_id", "value")]}
        state.unique_keys = {"contacts": {("customer-uuid", "11 99999-0000")}}
        stored = store_row(
            cursor,
            "SHEET_CONTACT",
            7,
            "contacts",
            self.outcome(legacy_id=None, customer_id="customer-uuid", type="phone", value="11 99999-0000"),
            self.plan["contacts"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        self.assertFalse(stored)
        self.assertEqual(cursor.statements, [])
        stats = state.stats("contacts")
        self.assertEqual(stats.inserted, 0)
        self.assertEqual(stats.skip_reasons, {"LOAD_DUPLICATE_ROW": 1})
        self.assertEqual(
            state.findings[("SHEET_CONTACT", "LOAD_DUPLICATE_ROW", "customer_id+value")]["count"], 1
        )

    def test_a_row_the_database_refuses_only_loses_itself(self) -> None:
        cursor = RefusingCursor(refuse_table="contacts")
        state = self.state(commit=True)
        stored = store_row(
            cursor,
            "SHEET_CONTACT",
            8,
            "contacts",
            self.outcome(legacy_id=None, customer_id="customer-uuid", type="phone", value="11 98888-0000"),
            self.plan["contacts"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        self.assertFalse(stored)
        self.assertEqual(state.stats("contacts").skip_reasons, {"LOAD_ROW_REJECTED": 1})
        self.assertEqual(state.row_ids, {})
        self.assertIn("ROLLBACK TO SAVEPOINT load_row", [sql for sql, _ in cursor.statements])
        self.assertIn("check constraint", state.findings[("SHEET_CONTACT", "LOAD_ROW_REJECTED", "contacts")]["message"])

    def test_a_rejected_row_keeps_the_transaction_usable(self) -> None:
        cursor = RefusingCursor(refuse_table="contacts", results=[("uuid-school",)])
        state = self.state(commit=True)
        store_row(
            cursor,
            "SHEET_CONTACT",
            8,
            "contacts",
            self.outcome(legacy_id=None, customer_id="customer-uuid", type="phone", value="1"),
            self.plan["contacts"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        stored = store_row(
            cursor,
            "SHEET_SCHOOL",
            5,
            "schools",
            self.outcome(legal_name="Escola A"),
            self.plan["schools"],
            SCHEMA,
            state.legacy_source,
            state,
        )
        self.assertTrue(stored)
        self.assertEqual(state.stats("schools").inserted, 1)
        self.assertEqual(state.stats("contacts").loaded, 0)


class PreloadTests(unittest.TestCase):
    def test_preload_builds_legacy_maps_and_id_sets(self) -> None:
        plan = plan_of(DICTIONARY, allow_proposed={"contacts"})["tables"]
        cursor = FakeCursor(
            results=[[("SHEET_SCHOOL", "9", "uuid-9")], [], [(uuid.uuid4(),)]]
        )
        state = LoadState(legacy_source="powerapps-voa", batch_id="batch-1", commit=False)
        preload_existing(cursor, plan, SCHEMA, state.legacy_source, state)
        self.assertEqual(state.legacy_maps["schools"], {"9": "uuid-9"})
        self.assertEqual(state.provenance_keys["schools"][("SHEET_SCHOOL", "9")], "uuid-9")
        self.assertEqual(len(state.existing_ids["contacts"]), 1)

    def test_uses_provenance_requires_provider_and_columns(self) -> None:
        self.assertTrue(uses_provenance("schools", SCHEMA, "ID"))
        self.assertFalse(uses_provenance("schools", SCHEMA, None))
        self.assertFalse(uses_provenance("contacts", SCHEMA, "ID"))

    def test_find_batch_raises_staging_error(self) -> None:
        class Args:
            batch_id = None

        with self.assertRaises(StagingError):
            find_batch(FakeCursor(results=[None]), {"source_name": "TEST.xlsx"}, Args())


class InsertTests(unittest.TestCase):
    def test_insert_returns_none_when_the_row_already_existed(self) -> None:
        self.assertEqual(
            insert_canonical(FakeCursor(results=[None]), "schools", {"legal_name": "A"}, "(id)"),
            (None, None),
        )

    def test_insert_returns_the_new_id(self) -> None:
        cursor = FakeCursor(results=[("uuid-1",)])
        self.assertEqual(insert_canonical(cursor, "schools", {"legal_name": "A"}, "(id)")[0], "uuid-1")
        sql, _ = cursor.insert_statements()[0]
        self.assertTrue(sql.startswith("INSERT INTO schools (legal_name) VALUES (%s)"))
        self.assertEqual(
            [sql for sql, _ in cursor.statements],
            ["SAVEPOINT load_row", sql, "RELEASE SAVEPOINT load_row"],
        )

    def test_insert_reports_the_database_refusal(self) -> None:
        cursor = RefusingCursor(refuse_table="payments")
        identifier, refused = insert_canonical(cursor, "payments", {"amount": 0}, "(id)")
        self.assertIsNone(identifier)
        self.assertIn("check constraint", refused)
        self.assertEqual(
            [sql for sql, _ in cursor.statements],
            [
                "SAVEPOINT load_row",
                "INSERT INTO payments (amount) VALUES (%s) ON CONFLICT (id) DO NOTHING RETURNING id",
                "ROLLBACK TO SAVEPOINT load_row",
            ],
        )


class UniqueKeyTests(unittest.TestCase):
    def state(self) -> LoadState:
        state = LoadState(legacy_source="powerapps-voa", batch_id="batch-1", commit=False)
        state.unique_groups = {"installments": [("agreement_id", "installment_number")]}
        return state

    def test_key_is_none_when_a_part_is_missing_or_blank(self) -> None:
        columns = ("agreement_id", "installment_number")
        self.assertIsNone(unique_key({"agreement_id": "a"}, columns))
        self.assertIsNone(unique_key({"agreement_id": "a", "installment_number": None}, columns))
        self.assertIsNone(unique_key({"agreement_id": "", "installment_number": 1}, columns))
        self.assertEqual(unique_key({"agreement_id": "a", "installment_number": 1}, columns), ("a", "1"))

    def test_conflict_is_detected_and_remembered(self) -> None:
        state = self.state()
        row = {"agreement_id": "a", "installment_number": 1}
        self.assertIsNone(unique_conflict(state, "installments", row))
        remember_unique_keys(state, "installments", row)
        self.assertEqual(unique_conflict(state, "installments", dict(row)), ("agreement_id", "installment_number"))
        self.assertIsNone(unique_conflict(state, "installments", {"agreement_id": "a", "installment_number": 2}))
        self.assertIsNone(unique_conflict(state, "schools", {"legal_name": "A"}))

    def test_preload_reads_the_keys_already_stored(self) -> None:
        plan = plan_of(DICTIONARY, allow_proposed={"contacts"})["tables"]
        state = self.state()
        state.unique_groups = {"contacts": [("customer_id", "value")]}
        cursor = FakeCursor(results=[[("c1", "11 9999-0000"), ("c2", "22 8888-0000")]])
        preload_unique_keys(cursor, plan, state)
        self.assertEqual(
            state.unique_keys["contacts"], {("c1", "11 9999-0000"), ("c2", "22 8888-0000")}
        )
        sql, _ = cursor.statements[0]
        self.assertEqual(sql, "SELECT customer_id, value FROM contacts")

    def test_preload_skips_tables_without_unique_groups(self) -> None:
        plan = plan_of(DICTIONARY, allow_proposed={"contacts"})["tables"]
        state = self.state()
        cursor = FakeCursor()
        preload_unique_keys(cursor, plan, state)
        self.assertEqual(cursor.statements, [])
        self.assertEqual(state.unique_keys, {})

    def test_real_migrations_declare_the_installment_and_asaas_keys(self) -> None:
        groups = parse_unique_groups()
        self.assertIn(("agreement_id", "installment_number"), groups["installments"])
        self.assertIn(("external_id",), groups["asaas_charges"])
        self.assertIn(("legacy_source", "legacy_table", "legacy_id"), groups["agreements"])
        self.assertNotIn(("id",), groups.get("schools", []))

    def test_fixture_migrations_parse_table_and_column_uniques(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "0001_test.sql"
            path.write_text(MIGRATION_SQL, encoding="utf-8")
            groups = parse_unique_groups(Path(folder))
        self.assertEqual(groups["schools"], [("legacy_source", "legacy_table", "legacy_id")])
        self.assertNotIn("contacts", groups)



class RealDictionaryTests(unittest.TestCase):
    """The real dictionary must keep the readiness split documented after the 2026-09-25 confirmation."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.dictionary = load_dictionary(DEFAULT_DICTIONARY)
        cls.schema = parse_canonical_columns()
        cls.plan_data = build_plan(cls.dictionary, cls.schema, None, set())
        cls.tables = cls.plan_data["tables"]

    def test_source_name_matches_the_staged_workbook(self) -> None:
        self.assertEqual(self.dictionary["source_name"], "VOA.xlsx")

    def test_master_data_is_ready_after_the_operator_confirmation(self) -> None:
        """The 22 `proposed` mappings were confirmed by the operator on 2026-09-25.

        TBL_PAGAMENTO synthesises the paying customer, so `customers` only became loadable
        once that decision was recorded as `confirmed` in the dictionary.
        """
        for table in ("schools", "students", "customers"):
            self.assertEqual(self.tables[table].status, "ready", table)
            self.assertEqual(self.tables[table].proposed_columns, [], table)

    def test_contacts_do_not_wait_for_an_extra_approval(self) -> None:
        self.assertEqual(self.tables["contacts"].status, "ready")
        self.assertEqual(self.tables["contacts"].proposed_columns, [])
        approved = build_plan(self.dictionary, self.schema, None, {"contacts"})["tables"]
        self.assertEqual(approved["contacts"].status, "ready")

    def test_agreements_cover_required_columns_and_are_ready(self) -> None:
        agreements = self.tables["agreements"]
        self.assertEqual(agreements.missing_required, [])
        self.assertEqual(agreements.status, "ready")
        self.assertEqual(agreements.proposed_columns, [])
        self.assertEqual(agreements.links, {"customer_id": "customers"})
        self.assertEqual(sorted(agreements.aggregates), ["installments_count", "total_amount"])

    def test_the_synthesised_customer_keeps_one_row_per_agreement(self) -> None:
        rules = self.dictionary["sheets"]["TBL_PAGAMENTO"]["columns"]
        providers = [rule for rule in rules if rule.get("provides_legacy_id_for")]
        self.assertEqual(
            sorted(rule["provides_legacy_id_for"] for rule in providers), ["agreements", "customers"]
        )
        self.assertEqual({rule["match"] for rule in providers}, {"ID"})

    def test_financial_children_are_ready_except_asaas_charges(self) -> None:
        for table in ("installments", "payments", "asaas_customers"):
            self.assertEqual(self.tables[table].status, "ready", table)
            self.assertEqual(self.tables[table].proposed_columns, [], table)
        charges = self.tables["asaas_charges"]
        self.assertEqual(charges.status, "blocked")
        self.assertEqual(charges.blocked_reason, "required_columns_uncovered")
        self.assertEqual(
            sorted(charges.missing_required),
            ["asaas_customer_id", "billing_type", "due_date", "environment", "value"],
        )

    def test_the_charge_status_default_comes_from_the_migration(self) -> None:
        """0008 gives `asaas_charges.status` a DEFAULT, so an empty invoice status is not an error.

        The 4.799 blank labels of `Pagamento_Banco_Status` (and the single `z` junk label) fall back
        to that default, reported as LOAD_VALUE_DEFAULTED instead of dropping the row.
        """
        self.assertNotIn("status", required_columns("asaas_charges", self.schema))
        defaults = resolve_defaults(self.schema, {"asaas_charges": None})
        self.assertEqual(defaults["asaas_charges"]["status"], "unknown")

    def test_retention_columns_are_mapped_by_the_migration(self) -> None:
        payments = self.tables["payments"]
        self.assertEqual(payments.status, "ready")
        for column in (
            "retention_status",
            "retention_percentage",
            "retention_approved_at",
            "retention_scheduled_month",
            "retention_released_at",
        ):
            self.assertIn(column, payments.rules, column)
            self.assertTrue(
                all(rule.status == "confirmed" for rule in payments.rules[column]), column
            )

    def test_installments_link_payments_to_the_same_row(self) -> None:
        self.assertEqual(self.tables["payments"].links, {"installment_id": "installments"})
        self.assertIn("installments", self.tables["payments"].dependencies)

    def test_no_structural_problem_in_the_real_plan(self) -> None:
        self.assertEqual(self.plan_data["problems"], [])

    def test_secrets_never_reach_a_mapped_column(self) -> None:
        banned = {"USER_SENHA", "USER_PASS", "BANCO_APIKEY"}
        for rules in self.dictionary["sheets"].values():
            for rule in rules.get("columns", []):
                if rule.get("match") in banned:
                    self.assertNotIn("map", rule)


TEST_NORMALIZATIONS = {
    "none": "sem transformacao",
    "trim": "remove espacos nas pontas",
    "collapse_ws": "remove espacos duplicados e das pontas",
    "money": "converte para numeric(14,2)",
    "integer": "converte para inteiro",
    "min_positive": "descarta valores menores ou iguais a zero",
    "positive_integer": "converte para inteiro e descarta valores menores ou iguais a zero",
}


FINANCIAL_DICTIONARY = {
    "version": 1,
    "source_name": "TEST.xlsx",
    "normalizations": TEST_NORMALIZATIONS,
    "sheets": {
        "SHEET_AGREEMENT": {
            "target_entity": "agreements",
            "notes": "acordo com cliente sintetizado, ambiente constante e total derivado das parcelas",
            "links": {
                "agreements.customer_id": "row:customers",
                "asaas_customers.customer_id": "row:customers",
            },
            "aggregates": {
                "source_sheet": "SHEET_INSTALLMENT",
                "row_table": "installments",
                "group_by": "AcordoID",
                "unique_by": {"Parcela": "installments.installment_number"},
                "targets": {
                    "agreements.total_amount": {
                        "op": "sum",
                        "measure": "Valor",
                        "normalization": "money",
                        "status": "proposed",
                    },
                    "agreements.installments_count": {
                        "op": "count",
                        "measure": "Valor",
                        "normalization": "money",
                        "status": "proposed",
                    },
                },
            },
            "columns": [
                {
                    "match": "ID",
                    "map": "agreements.legacy_id",
                    "type": "legacy_id",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                    "provides_legacy_id_for": "agreements",
                },
                {
                    "match": "ID",
                    "map": "customers.legacy_id",
                    "type": "legacy_id",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                    "provides_legacy_id_for": "customers",
                },
                {
                    "match": "EscolaID",
                    "map": "agreements.school_id",
                    "type": "reference",
                    "ref": "schools",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "Aluno",
                    "map": "customers.full_name",
                    "type": "name",
                    "normalization": "collapse_ws",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "CliAsaas",
                    "map": "asaas_customers.external_id",
                    "type": "text",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "CliAsaas",
                    "map": "asaas_customers.environment",
                    "type": "code",
                    "normalization": "none",
                    "const": "production",
                    "required": True,
                    "status": "proposed",
                },
            ],
        },
        "SHEET_INSTALLMENT": {
            "target_entity": "installments",
            "columns": [
                {
                    "match": "AcordoID",
                    "map": "installments.agreement_id",
                    "type": "reference",
                    "ref": "agreements",
                    "normalization": "trim",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "Parcela",
                    "map": "installments.installment_number",
                    "type": "integer",
                    "normalization": "integer",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "Valor",
                    "map": "installments.original_amount",
                    "type": "numeric",
                    "normalization": "money",
                    "required": True,
                    "status": "proposed",
                },
                {
                    "match": "ValorPago",
                    "map": "payments.amount",
                    "type": "numeric",
                    "normalization": "min_positive",
                    "required": True,
                    "status": "proposed",
                },
            ],
            "links": {"payments.installment_id": "row:installments"},
        },
    },
}


FINANCIAL_SCHEMA = {
    "agreements": SCHEMA["agreements"],
    "customers": SCHEMA["customers"],
    "installments": SCHEMA["installments"],
    "payments": SCHEMA["payments"],
    "asaas_customers": {
        "id": column("uuid", True, "gen_random_uuid()"),
        "customer_id": column("uuid", True),
        "external_id": column("text", True),
        "environment": column("text", True),
    },
}

FINANCIAL_APPROVAL = {"agreements", "customers", "asaas_customers", "installments", "payments"}


class CustomerSynthesisTests(unittest.TestCase):
    """`const`, `links: row:` and `aggregates` carry the agreement/customer chain."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.plan_data = plan_of(
            FINANCIAL_DICTIONARY, allow_proposed=FINANCIAL_APPROVAL, schema=FINANCIAL_SCHEMA
        )
        cls.plan = cls.plan_data["tables"]
        cls.defaults = resolve_defaults(FINANCIAL_SCHEMA, cls.plan)

    def state(self, commit: bool = False) -> LoadState:
        state = LoadState(legacy_source="powerapps-voa", batch_id="batch-1", commit=commit)
        state.legacy_maps["schools"] = {"1": "school-uuid-1"}
        return state

    def args(self):
        return argparse.Namespace(max_rows_per_sheet=None, exclude_error_rows=True)

    def resolve(self, sheet: str, payload: dict):
        tables = self.plan_data["sheets"][sheet]["tables"]
        return build_row_values(
            sheet, tables, self.plan, payload, {"schools": {"1": "school-uuid-1"}}, self.defaults
        )

    def test_a_table_fed_by_two_sheets_keeps_the_rules_of_each_sheet(self) -> None:
        """A canonical table shared by two sheets must not leak rules between them."""
        dictionary = {
            "normalizations": TEST_NORMALIZATIONS,
            "sheets": {
                "SHEET_A": {
                    "target_entity": "customers",
                    "columns": [
                        {
                            "match": "Nome",
                            "map": "customers.full_name",
                            "type": "name",
                            "normalization": "collapse_ws",
                            "required": True,
                        }
                    ],
                },
                "SHEET_B": {
                    "target_entity": "customers",
                    "columns": [
                        {
                            "match": "Pagador",
                            "map": "customers.full_name",
                            "type": "name",
                            "normalization": "collapse_ws",
                            "required": True,
                        }
                    ],
                },
            },
        }
        plan_data = plan_of(dictionary, schema=FINANCIAL_SCHEMA)
        plan = plan_data["tables"]
        defaults = resolve_defaults(FINANCIAL_SCHEMA, plan)
        outcomes = {
            sheet: build_row_values(
                sheet,
                plan_data["sheets"][sheet]["tables"],
                plan,
                payload,
                {},
                defaults,
            )["customers"]
            for sheet, payload in (("SHEET_A", {"Nome": "Ana"}), ("SHEET_B", {"Pagador": "Ana"}))
        }
        for sheet, outcome in outcomes.items():
            self.assertIsNone(outcome.skipped, sheet)
            self.assertEqual(outcome.values["full_name"], "Ana")

    def test_aggregate_columns_close_the_required_gap(self) -> None:
        self.assertEqual(self.plan_data["problems"], [])
        agreements = self.plan["agreements"]
        self.assertEqual(agreements.missing_required, [])
        self.assertEqual(agreements.status, "ready")
        self.assertEqual(agreements.links, {"customer_id": "customers"})
        self.assertEqual(
            agreements.columns,
            ["customer_id", "installments_count", "legacy_id", "school_id", "total_amount"],
        )
        self.assertIn("installments_count", agreements.numeric_columns)
        self.assertEqual(self.plan_data["sheets"]["SHEET_AGREEMENT"]["primary"], "agreements")

    def test_money_columns_leave_the_installment_count_out(self) -> None:
        """A reconciliacao soma dinheiro; contar parcelas nao entra no mesmo numero."""
        agreements = self.plan["agreements"]
        self.assertEqual(agreements.money_columns, ["total_amount"])
        self.assertEqual(agreements.numeric_columns, ["installments_count", "total_amount"])

    def test_the_synthesised_customer_shares_the_agreement_id(self) -> None:
        outcomes = self.resolve(
            "SHEET_AGREEMENT", {"ID": " 7 ", "EscolaID": "1", "Aluno": "Ana", "CliAsaas": "cus_1"}
        )
        self.assertEqual(outcomes["agreements"].legacy_id, "7")
        self.assertEqual(outcomes["customers"].legacy_id, "7")
        self.assertEqual(outcomes["customers"].values["full_name"], "Ana")
        self.assertEqual(outcomes["agreements"].values["school_id"], "school-uuid-1")

    def test_const_supplies_the_asaas_environment(self) -> None:
        outcomes = self.resolve(
            "SHEET_AGREEMENT", {"ID": "7", "EscolaID": "1", "Aluno": "Ana", "CliAsaas": "cus_1"}
        )
        self.assertEqual(
            outcomes["asaas_customers"].values, {"external_id": "cus_1", "environment": "production"}
        )

    def test_const_still_obeys_the_required_source_gate(self) -> None:
        outcomes = self.resolve(
            "SHEET_AGREEMENT", {"ID": "7", "EscolaID": "1", "Aluno": "Ana", "CliAsaas": None}
        )
        outcome = outcomes["asaas_customers"]
        self.assertEqual(outcome.skipped, "LOAD_REQUIRED_FIELD_EMPTY")
        self.assertEqual(outcome.skip_field, "CliAsaas")
        self.assertNotIn("environment", outcome.values)

    def test_aggregates_sum_and_count_the_child_rows(self) -> None:
        cursor = FakeCursor(
            results=[
                [
                    (1, {"AcordoID": "100", "Parcela": "1", "Valor": "100,00"}),
                    (2, {"AcordoID": "100", "Parcela": "2", "Valor": "200.00"}),
                    (3, {"AcordoID": "100", "Parcela": "2", "Valor": "200.00"}),
                    (4, {"AcordoID": "200", "Parcela": "01", "Valor": "50,00"}),
                    (5, {"AcordoID": "200", "Parcela": "1", "Valor": "10,00"}),
                    (6, {"AcordoID": "300", "Parcela": None, "Valor": "10,00"}),
                    (7, {"AcordoID": "400", "Parcela": "1", "Valor": "nao e numero"}),
                ]
            ]
        )
        values, report = compute_aggregates(cursor, self.plan, self.state())
        self.assertEqual(
            values["agreements.total_amount"], {"100": Decimal("300.00"), "200": Decimal("50.00")}
        )
        self.assertEqual(values["agreements.installments_count"], {"100": 2, "200": 1})
        self.assertEqual(report["SHEET_INSTALLMENT"]["rows"], 7)
        self.assertEqual(report["SHEET_INSTALLMENT"]["rows_used"], 3)
        self.assertEqual(report["SHEET_INSTALLMENT"]["duplicates_skipped"], 2)
        self.assertEqual(
            report["SHEET_INSTALLMENT"]["groups"],
            {"agreements.total_amount": 2, "agreements.installments_count": 2},
        )

    def test_a_broken_duplicate_does_not_block_the_valid_one(self) -> None:
        """The aggregate must deduplicate exactly like the child table does."""
        cursor = FakeCursor(
            results=[
                [
                    (1, {"AcordoID": "100", "Parcela": "1", "Valor": "nao e numero"}),
                    (2, {"AcordoID": "100", "Parcela": "1", "Valor": "100,00"}),
                ]
            ]
        )
        values, report = compute_aggregates(cursor, self.plan, self.state())
        self.assertEqual(values["agreements.total_amount"], {"100": Decimal("100.00")})
        self.assertEqual(values["agreements.installments_count"], {"100": 1})
        self.assertEqual(report["SHEET_INSTALLMENT"]["duplicates_skipped"], 0)

    def test_the_agreement_row_carries_the_customer_and_the_totals(self) -> None:
        cursor = FakeCursor(results=[("agreement-uuid",)])
        state = self.state(commit=True)
        outcome = RowOutcome(
            values={
                "school_id": "school-uuid-1",
                "customer_id": "customer-uuid-1",
                "total_amount": Decimal("300.00"),
                "installments_count": 2,
            },
            legacy_id="7",
        )
        stored = store_row(
            cursor,
            "SHEET_AGREEMENT",
            10,
            "agreements",
            outcome,
            self.plan["agreements"],
            FINANCIAL_SCHEMA,
            state.legacy_source,
            state,
        )
        self.assertTrue(stored)
        insert_sql, params = cursor.insert_statements()[0]
        self.assertIn("customer_id", insert_sql)
        self.assertIn("total_amount", insert_sql)
        self.assertIn("customer-uuid-1", params)
        self.assertIn(Decimal("300.00"), params)
        self.assertEqual(state.row_ids["agreements"], "agreement-uuid")

    def test_process_sheet_skips_a_parent_without_aggregate(self) -> None:
        state = self.state()
        entry = self.plan_data["sheets"]["SHEET_AGREEMENT"]
        cursor = FakeCursor(
            results=[
                [(10, 1, {"ID": "7", "EscolaID": "1", "Aluno": "Ana", "CliAsaas": "cus_1"}, "ok")],
                [],
            ]
        )
        counters = process_sheet(
            cursor,
            cursor,
            "SHEET_AGREEMENT",
            entry,
            self.plan,
            FINANCIAL_SCHEMA,
            self.defaults,
            {},
            state,
            self.args(),
        )
        self.assertEqual(counters["rows"], 1)
        self.assertEqual(counters["rows_loaded"], 0)
        self.assertEqual(counters["rows_skipped"], 1)
        self.assertEqual(state.stats("agreements").skip_reasons, {"LOAD_AGGREGATE_MISSING": 1})
        self.assertEqual(state.stats("customers").inserted, 1)
        self.assertEqual(state.stats("asaas_customers").skip_reasons, {})

    def test_process_sheet_loads_the_row_when_the_aggregate_exists(self) -> None:
        state = self.state(commit=True)
        entry = self.plan_data["sheets"]["SHEET_AGREEMENT"]
        cursor = FakeCursor(
            results=[
                [(10, 1, {"ID": "7", "EscolaID": "1", "Aluno": "Ana", "CliAsaas": "cus_1"}, "ok")],
                ("customer-uuid-1",),
                ("agreement-uuid-1",),
                ("asaas-uuid-1",),
                [],
            ]
        )
        aggregates = {
            "agreements.total_amount": {"7": Decimal("300.00")},
            "agreements.installments_count": {"7": 2},
        }
        counters = process_sheet(
            cursor,
            cursor,
            "SHEET_AGREEMENT",
            entry,
            self.plan,
            FINANCIAL_SCHEMA,
            self.defaults,
            aggregates,
            state,
            self.args(),
        )
        self.assertEqual(counters["rows"], 1)
        self.assertEqual(counters["rows_loaded"], 1)
        self.assertEqual(counters["rows_skipped"], 0)
        self.assertEqual(state.stats("agreements").inserted, 1)
        self.assertEqual(state.stats("agreements").numeric_totals["total_amount"], Decimal("300.00"))
        self.assertEqual(state.stats("customers").inserted, 1)
        self.assertEqual(state.stats("asaas_customers").inserted, 1)
        inserts = {
            statement.split("INTO ", 1)[1].split(" ", 1)[0]: params
            for statement, params in cursor.insert_statements()
        }
        self.assertEqual(sorted(inserts), ["agreements", "asaas_customers", "customers"])
        self.assertIn("customer-uuid-1", inserts["agreements"])
        self.assertIn(Decimal("300.00"), inserts["agreements"])
        self.assertEqual(inserts["asaas_customers"].count("production"), 1)
        self.assertEqual(state.row_ids["customers"], "customer-uuid-1")
        self.assertEqual(state.row_ids["agreements"], "agreement-uuid-1")


class AggregateValidationTests(unittest.TestCase):
    """The `aggregates` block is validated before any row is touched."""

    def broken_plan(self, aggregates: dict) -> list[str]:
        dictionary = {
            "normalizations": TEST_NORMALIZATIONS,
            "sheets": {
                "SHEET_AGREEMENT": {
                    "target_entity": "agreements",
                    "aggregates": aggregates,
                    "columns": [
                        {
                            "match": "ID",
                            "map": "agreements.legacy_id",
                            "type": "legacy_id",
                            "normalization": "trim",
                            "required": True,
                            "provides_legacy_id_for": "agreements",
                        }
                    ],
                },
                "SHEET_INSTALLMENT": {
                    "target_entity": "installments",
                    "columns": [
                        {
                            "match": "AcordoID",
                            "map": "installments.agreement_id",
                            "type": "reference",
                            "ref": "agreements",
                            "normalization": "trim",
                        },
                        {
                            "match": "Parcela",
                            "map": "installments.installment_number",
                            "type": "integer",
                            "normalization": "integer",
                        },
                        {
                            "match": "Valor",
                            "map": "installments.original_amount",
                            "type": "numeric",
                            "normalization": "money",
                        },
                    ],
                },
            },
        }
        return [item["code"] for item in plan_of(dictionary, schema=FINANCIAL_SCHEMA)["problems"]]

    def block(self, **overrides) -> dict:
        base = {
            "source_sheet": "SHEET_INSTALLMENT",
            "row_table": "installments",
            "group_by": "AcordoID",
            "targets": {
                "agreements.total_amount": {
                    "op": "sum",
                    "measure": "Valor",
                    "normalization": "money",
                }
            },
        }
        base.update(overrides)
        return base

    def test_a_complete_block_is_accepted(self) -> None:
        self.assertEqual(self.broken_plan(self.block()), [])
        self.assertEqual(
            self.broken_plan(self.block(unique_by={"Parcela": "installments.installment_number"})), []
        )

    def test_unknown_source_sheet_is_reported(self) -> None:
        self.assertEqual(
            self.broken_plan(self.block(source_sheet="SHEET_NAO_EXISTE")),
            ["AGGREGATE_SOURCE_SHEET_UNKNOWN"],
        )

    def test_row_table_must_be_mapped_by_the_source_sheet(self) -> None:
        self.assertEqual(
            self.broken_plan(self.block(row_table="payments")), ["AGGREGATE_ROW_TABLE_NOT_MAPPED"]
        )

    def test_group_by_must_be_a_declared_source_column(self) -> None:
        self.assertEqual(
            self.broken_plan(self.block(group_by="NaoExiste")), ["AGGREGATE_GROUP_COLUMN_UNKNOWN"]
        )

    def test_unique_by_must_be_an_object_of_child_columns(self) -> None:
        self.assertEqual(
            self.broken_plan(self.block(unique_by=["Parcela"])), ["AGGREGATE_UNIQUE_NOT_OBJECT"]
        )
        self.assertEqual(
            self.broken_plan(self.block(unique_by={"Parcela": "installments.nao_existe"})),
            ["AGGREGATE_UNIQUE_COLUMN_UNKNOWN"],
        )

    def test_target_table_must_be_mapped_by_the_same_sheet(self) -> None:
        targets = {"payments.amount": {"op": "count", "measure": "Valor"}}
        self.assertEqual(
            self.broken_plan(self.block(targets=targets)), ["AGGREGATE_TARGET_TABLE_NOT_MAPPED"]
        )

    def test_sum_requires_a_numeric_normalization(self) -> None:
        targets = {"agreements.total_amount": {"op": "sum", "measure": "Valor", "normalization": "trim"}}
        self.assertEqual(
            self.broken_plan(self.block(targets=targets)), ["AGGREGATE_SUM_REQUIRES_NUMERIC"]
        )

    def test_unsupported_operation_is_reported(self) -> None:
        targets = {"agreements.total_amount": {"op": "average", "measure": "Valor"}}
        self.assertEqual(self.broken_plan(self.block(targets=targets)), ["AGGREGATE_OP_UNSUPPORTED"])


class ReportTests(unittest.TestCase):
    def result(self, **overrides) -> dict:
        base = {
            "mode": "dry-run",
            "legacy_source": "powerapps-voa",
            "batch": {"id": "batch-1", "source_name": "VOA.xlsx", "status": "staging", "row_count": 10},
            "models": {"planned": ["schools"], "ready": ["schools"], "blocked": []},
            "plan": {
                "schools": {
                    "status": "ready",
                    "blocked_reason": None,
                    "detail": None,
                    "dependencies": [],
                    "missing_required": [],
                    "proposed_columns": [],
                    "links": {},
                    "columns": ["legal_name"],
                }
            },
            "sheets": [
                {
                    "sheet": "TBL_ESCOLA",
                    "tables": ["schools"],
                    "rows": 10,
                    "rows_loaded": 10,
                    "rows_skipped": 0,
                    "rows_status_skipped": 0,
                }
            ],
            "tables": {
                "schools": {
                    "rows_considered": 10,
                    "loaded": 10,
                    "inserted": 10,
                    "reused": 0,
                    "skipped": 0,
                    "skip_reasons": {},
                    "totals": {},
                }
            },
            "findings": [],
            "canonical_before": {"schools": 1},
            "canonical_after": {"schools": 11},
            "canonical_writes": False,
        }
        base.update(overrides)
        base["summary"] = summarize(base)
        return base

    def test_report_is_utf8_markdown_with_the_mode(self) -> None:
        report = render_report(self.result())
        self.assertIn("# Carga canonica do legado (fase 7)", report)
        self.assertIn("| Modo | dry-run |", report)
        self.assertIn("| `schools` | 10 | 10 | 10 | 0 | 0 | 0 | - |", report)
        self.assertIn("| `schools` | 1 | 11 |", report)

    def test_report_lists_blockers_and_findings(self) -> None:
        result = self.result(
            findings=[
                {
                    "sheet": "TBL_ALUNO",
                    "code": "LOAD_REFERENCE_UNRESOLVED",
                    "field": "Aluno.Escola.ID",
                    "count": 1,
                    "samples": [{"row": 6160, "detail": "Aluno.Escola.ID=16 sem registro em schools"}],
                }
            ]
        )
        result["plan"]["schools"]["status"] = "blocked"
        result["plan"]["schools"]["blocked_reason"] = "dependency_not_loaded"
        result["models"]["blocked"] = ["schools"]
        result["models"]["ready"] = []
        result["summary"] = summarize(result)
        report = render_report(result)
        self.assertIn("`LOAD_REFERENCE_UNRESOLVED`", report)
        self.assertIn("`schools`: dependency_not_loaded", report)

    def test_summary_counts_the_tables(self) -> None:
        summary = summarize(self.result())
        self.assertEqual(summary["ready_tables"], 1)
        self.assertEqual(summary["rows_loaded"], 10)
        self.assertEqual(summary["rows_enriched"], 0)
        self.assertFalse(summary["canonical_writes"])

    def test_canonical_counts_include_child_tables(self) -> None:
        plan = plan_of(DICTIONARY, allow_proposed={"contacts"})["tables"]
        tables = canonical_tables_for_counts(plan)
        self.assertIn("contacts", tables)
        self.assertIn("schools", tables)


class DatabaseRoutingTests(unittest.TestCase):
    """`--staging-url`/`STAGING_DATABASE_URL`: staging reads and canonical writes may split."""

    CANONICAL = "postgresql://postgres:secret@db.tiifccrnvniziyixxaqbq.supabase.co:5432/postgres"
    STAGING = "postgresql://postgres:local@localhost:5433/voa_staging"

    def test_single_database_is_the_default(self) -> None:
        with mock.patch.dict(os.environ, {"DIRECT_DATABASE_URL": self.CANONICAL}, clear=True):
            staging, canonical = resolve_database_urls()
        self.assertEqual(staging, self.CANONICAL)
        self.assertEqual(canonical, self.CANONICAL)

    def test_staging_env_var_splits_the_run(self) -> None:
        env = {"DIRECT_DATABASE_URL": self.CANONICAL, "STAGING_DATABASE_URL": self.STAGING}
        with mock.patch.dict(os.environ, env, clear=True):
            staging, canonical = resolve_database_urls()
        self.assertEqual(staging, self.STAGING)
        self.assertEqual(canonical, self.CANONICAL)

    def test_staging_flag_overrides_the_env_var(self) -> None:
        env = {"DIRECT_DATABASE_URL": self.CANONICAL, "STAGING_DATABASE_URL": self.STAGING}
        with mock.patch.dict(os.environ, env, clear=True):
            staging, canonical = resolve_database_urls("postgresql://localhost:5433/outro")
        self.assertEqual(staging, "postgresql://localhost:5433/outro")
        self.assertEqual(canonical, self.CANONICAL)

    def test_staging_flag_replaces_the_env_fallback(self) -> None:
        with mock.patch.dict(os.environ, {"DATABASE_URL": self.CANONICAL}, clear=True):
            staging, canonical = resolve_database_urls()
        self.assertEqual(staging, self.CANONICAL)
        self.assertEqual(canonical, self.CANONICAL)

    def test_canonical_url_is_required(self) -> None:
        with mock.patch.dict(os.environ, {"STAGING_DATABASE_URL": self.STAGING}, clear=True):
            with self.assertRaises(StagingError):
                resolve_database_urls()

    def test_flag_argument_exists_in_the_cli(self) -> None:
        with mock.patch.dict(os.environ, {"DATABASE_URL": self.CANONICAL}, clear=True):
            args = parse_arguments(["--staging-url", self.STAGING, "--commit"])
        self.assertEqual(args.staging_url, self.STAGING)
        self.assertTrue(args.commit)

    def test_describe_hides_credentials(self) -> None:
        self.assertEqual(describe_database_url(self.CANONICAL), "db.tiifccrnvniziyixxaqbq.supabase.co:5432/postgres")
        self.assertEqual(describe_database_url(self.STAGING), "localhost:5433/voa_staging")
        self.assertEqual(describe_database_url(None), "<unset>")

    def test_report_shows_both_databases(self) -> None:
        result = {
            "mode": "dry-run",
            "legacy_source": "powerapps-voa",
            "canonical_writes": False,
            "batch": {"id": "5cd769e4", "source_name": "VOA.xlsx", "status": "staging"},
            "database": {"staging": "localhost:5433/voa_staging", "canonical": "localhost:5432/postgres", "split": True},
            "summary": {
                "ready_tables": 1,
                "blocked_tables": 0,
                "rows_considered": 0,
                "rows_loaded": 0,
                "rows_inserted": 0,
                "rows_reused": 0,
                "rows_skipped": 0,
                "findings": 0,
                "canonical_writes": False,
            },
            "tables": {},
            "models": {"ready": [], "blocked": []},
            "plan": {},
            "sheets": [],
            "aggregates": {},
            "findings": [],
        }
        report = render_report(result)
        self.assertIn("| Staging | `localhost:5433/voa_staging` |", report)
        self.assertIn("| Canonico | `localhost:5432/postgres` |", report)
        self.assertIn("| Topologia | staging em banco separado do canonico |", report)


class ReportTopologyTests(unittest.TestCase):
    """The report states whether staging and canonical share one database."""

    def test_same_database_topology_is_reported(self):
        result = {
            "mode": "dry-run",
            "legacy_source": "powerapps-voa",
            "batch": {"id": "5cd769e4", "source_name": "VOA.xlsx", "status": "staging"},
            "database": {
                "staging": "localhost:5434/voa_staging",
                "canonical": "localhost:5434/voa_staging",
                "split": False,
            },
            "summary": {
                "ready_tables": 0,
                "blocked_tables": 0,
                "rows_considered": 0,
                "rows_loaded": 0,
                "rows_inserted": 0,
                "rows_reused": 0,
                "rows_skipped": 0,
                "findings": 0,
                "canonical_writes": False,
            },
            "tables": {},
            "models": {"ready": [], "blocked": []},
            "plan": {},
            "sheets": [],
            "aggregates": {},
            "findings": [],
        }
        report = render_report(result)
        self.assertIn("| Topologia | staging e canonico no mesmo banco |", report)
        self.assertNotIn("banco separado", report)


if __name__ == "__main__":
    unittest.main()

