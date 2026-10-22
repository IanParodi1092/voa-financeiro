"""Tests for `backfill_legacy_provenance.py` (migration 0009 companion)."""

from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any

from backfill_legacy_provenance import (
    DEFAULT_TABLES,
    BackfillPlan,
    apply_backfill,
    backfill_targets,
    legacy_id_of,
    live_provenance_columns,
    plan_backfill,
    render_report,
    require_live_columns,
    staged_candidates,
)
from load_canonical_batch import (
    PROVENANCE_COLUMNS,
    StagingError,
    column_rule,
    load_dictionary,
    parse_canonical_columns,
    row_uuid,
)
from build_field_dictionary import DEFAULT_DICTIONARY, DEFAULT_MIGRATIONS

PROVENANCE = {column: {"type": "text", "not_null": False, "has_default": False} for column in PROVENANCE_COLUMNS}

SCHEMA: dict[str, dict[str, Any]] = {
    "contacts": dict(PROVENANCE),
    "installments": dict(PROVENANCE),
    "schools": dict(PROVENANCE),
}


def dictionary_with(*columns_by_sheet: tuple[str, list[dict[str, Any]]]) -> dict[str, Any]:
    return {"source_name": "TEST.xlsx", "sheets": {sheet: {"columns": rows} for sheet, rows in columns_by_sheet}}


def provider(column: str, table: str) -> dict[str, Any]:
    return {
        "match": column,
        "map": f"{table}.legacy_id",
        "type": "legacy_id",
        "normalization": "trim",
        "required": True,
        "provides_legacy_id_for": table,
    }


DICTIONARY = dictionary_with(
    ("TBL_CLIENTEENDTEL", [provider("ID", "contacts")]),
    ("TBL_PAGAMENTO_LISTAGEM", [provider(" ID ", "installments")]),
    ("TBL_DIVIDA", [{"match": "ID", "defer": "no_canonical_destination"}]),
)


class FakeCursor:
    """Records statements and replays canned `fetchall` pages."""

    def __init__(self, pages: list[list[tuple[Any, ...]]] | None = None, rowcount: int = 1) -> None:
        self.pages = [list(page) for page in (pages or [])]
        self.statements: list[tuple[str, tuple[Any, ...] | None]] = []
        self.rowcount = rowcount

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> None:
        self.statements.append((sql, params))

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self.pages.pop(0) if self.pages else []


class TargetTests(unittest.TestCase):
    def test_targets_resolve_the_sheet_that_provides_each_legacy_id(self) -> None:
        targets = backfill_targets(DICTIONARY, SCHEMA)
        self.assertEqual(list(targets), list(DEFAULT_TABLES))
        self.assertEqual(targets["contacts"].sheet, "TBL_CLIENTEENDTEL")
        self.assertEqual(targets["contacts"].rule.source_column, "ID")
        self.assertEqual(targets["installments"].sheet, "TBL_PAGAMENTO_LISTAGEM")
        self.assertEqual(targets["installments"].rule.source_column, " ID ")

    def test_targets_refuse_a_table_without_a_provider(self) -> None:
        with self.assertRaises(StagingError):
            backfill_targets(DICTIONARY, SCHEMA, ("schools",))

    def test_targets_refuse_a_database_without_the_migration(self) -> None:
        """Migration 0009 is what creates the columns; without it the backfill must stop."""
        schema = {"contacts": {"customer_id": {}}, "installments": dict(PROVENANCE)}
        with self.assertRaises(StagingError) as raised:
            backfill_targets(DICTIONARY, schema)
        self.assertIn("0009", str(raised.exception))

    def test_targets_refuse_two_sheets_claiming_the_same_table(self) -> None:
        dictionary = dictionary_with(
            ("TBL_CLIENTEENDTEL", [provider("ID", "contacts")]),
            ("TBL_OUTRA", [provider("ID", "contacts")]),
            ("TBL_PAGAMENTO_LISTAGEM", [provider("ID", "installments")]),
        )
        with self.assertRaises(StagingError):
            backfill_targets(dictionary, SCHEMA)

    def test_real_dictionary_and_migrations_expose_both_targets(self) -> None:
        dictionary = load_dictionary(DEFAULT_DICTIONARY)
        schema = parse_canonical_columns(DEFAULT_MIGRATIONS)
        targets = backfill_targets(dictionary, schema)
        self.assertEqual(targets["contacts"].sheet, "TBL_CLIENTEENDTEL")
        self.assertEqual(targets["installments"].sheet, "TBL_PAGAMENTO_LISTAGEM")
        for column in PROVENANCE_COLUMNS:
            self.assertIn(column, schema["contacts"], column)
            self.assertIn(column, schema["installments"], column)


class LiveSchemaTests(unittest.TestCase):
    """The 0009 check has to read the connected database, not only the migration files."""

    def test_all_provenance_columns_present_returns_nothing(self) -> None:
        cursor = FakeCursor(pages=[[("id",), ("legacy_source",), ("legacy_table",), ("legacy_id",)]])
        self.assertEqual(live_provenance_columns(cursor, "contacts"), (True, []))
        statement, params = cursor.statements[0]
        self.assertIn("information_schema.columns", statement)
        self.assertIn("current_schemas(false)", statement)
        self.assertEqual(params, ("contacts",))

    def test_partial_columns_report_only_the_missing_ones(self) -> None:
        cursor = FakeCursor(pages=[[("legacy_source",)]])
        self.assertEqual(
            live_provenance_columns(cursor, "installments"), (True, ["legacy_table", "legacy_id"])
        )

    def test_a_missing_table_is_reported_as_absent(self) -> None:
        cursor = FakeCursor(pages=[[]])
        self.assertEqual(
            live_provenance_columns(cursor, "contacts"), (False, list(PROVENANCE_COLUMNS))
        )

    def test_require_live_columns_raises_an_actionable_error(self) -> None:
        cursor = FakeCursor(pages=[[("legacy_source",), ("id",)]])
        with self.assertRaises(StagingError) as caught:
            require_live_columns(cursor, "contacts")
        self.assertIn("db:migrate", str(caught.exception))
        self.assertIn("legacy_table", str(caught.exception))

    def test_require_live_columns_explains_a_missing_table(self) -> None:
        cursor = FakeCursor(pages=[[]])
        with self.assertRaises(StagingError) as caught:
            require_live_columns(cursor, "contacts")
        self.assertIn("tabela nao existe", str(caught.exception))

    def test_require_live_columns_is_silent_when_the_migration_ran(self) -> None:
        cursor = FakeCursor(pages=[[("legacy_source",), ("legacy_table",), ("legacy_id",)]])
        self.assertIsNone(require_live_columns(cursor, "installments"))


class LegacyIdTests(unittest.TestCase):
    def rule(self, normalization: str = "trim"):
        raw = provider("ID", "contacts")
        raw["normalization"] = normalization
        return column_rule("TBL_CLIENTEENDTEL", raw, [])

    def test_value_is_trimmed(self) -> None:
        self.assertEqual(legacy_id_of({"ID": "  4711 "}, self.rule()), "4711")

    def test_numeric_cell_becomes_text(self) -> None:
        self.assertEqual(legacy_id_of({"ID": 4711}, self.rule()), "4711")

    def test_blank_or_missing_id_is_ignored(self) -> None:
        self.assertIsNone(legacy_id_of({"ID": "   "}, self.rule()))
        self.assertIsNone(legacy_id_of({}, self.rule()))
        self.assertIsNone(legacy_id_of({"ID": None}, self.rule()))



class PlanTests(unittest.TestCase):
    def test_rows_are_split_into_stamp_already_and_missing(self) -> None:
        plan = plan_backfill(
            [("u1", "7"), ("u2", "8"), ("u3", "9"), ("u4", "5")],
            {"u1": None, "u2": "8", "u3": None},
        )
        self.assertEqual(plan.stamp, (("u1", "7"), ("u3", "9")))
        self.assertEqual(plan.already, 1)
        self.assertEqual(plan.missing, 1)
        self.assertEqual(plan.conflicts, ())

    def test_a_divergent_stored_key_is_reported_and_not_overwritten(self) -> None:
        plan = plan_backfill([("u1", "7"), ("u2", "8")], {"u1": "77", "u2": None})
        self.assertEqual(plan.stamp, (("u2", "8"),))
        self.assertEqual(plan.conflicts, (("u1", "77", "7"),))

    def test_a_second_run_has_nothing_left_to_stamp(self) -> None:
        plan = plan_backfill([("u1", "7")], {"u1": "7"})
        self.assertEqual(plan, BackfillPlan(stamp=(), already=1, missing=0, conflicts=()))


class ApplyTests(unittest.TestCase):
    def test_updates_only_rows_without_a_legacy_id(self) -> None:
        cursor = FakeCursor(rowcount=1)
        stamped = apply_backfill(
            cursor, "contacts", "TBL_CLIENTEENDTEL", "powerapps-voa", (("u1", "7"), ("u2", "8"))
        )
        self.assertEqual(stamped, 2)
        self.assertEqual(len(cursor.statements), 2)
        sql, params = cursor.statements[0]
        self.assertIn("legacy_id IS NULL", sql)
        self.assertIn("id = %s::uuid", sql)
        self.assertEqual(params, ("powerapps-voa", "TBL_CLIENTEENDTEL", "7", "u1"))

    def test_a_row_already_stamped_does_not_count(self) -> None:
        cursor = FakeCursor(rowcount=0)
        stamped = apply_backfill(
            cursor, "installments", "TBL_PAGAMENTO_LISTAGEM", "powerapps-voa", (("u1", "7"),)
        )
        self.assertEqual(stamped, 0)


class StagedCandidateTests(unittest.TestCase):
    def test_rows_are_paged_by_source_row_number(self) -> None:
        target = backfill_targets(DICTIONARY, SCHEMA)["contacts"]
        cursor = FakeCursor(
            pages=[
                [(2, {"ID": " 10 "}), (3, {"ID": ""})],
                [(5, {"ID": 11})],
            ]
        )
        candidates, blanks = staged_candidates(cursor, "batch-1", target, page_size=2)
        self.assertEqual(blanks, 1)
        self.assertEqual(
            candidates,
            [
                (str(row_uuid("TBL_CLIENTEENDTEL", 2)), "10"),
                (str(row_uuid("TBL_CLIENTEENDTEL", 5)), "11"),
            ],
        )
        self.assertEqual(len(cursor.statements), 3)
        self.assertEqual(cursor.statements[0][1], ("batch-1", "TBL_CLIENTEENDTEL", 0, 2))
        self.assertEqual(cursor.statements[1][1], ("batch-1", "TBL_CLIENTEENDTEL", 3, 2))


class ReportTests(unittest.TestCase):
    def result(self, commit: bool) -> dict[str, Any]:
        return {
            "commit": commit,
            "batch_id": "batch-1",
            "batch_status": "committed",
            "databases": {"staging": "localhost:5432/voa", "canonical": "db.example:5432/postgres"},
            "tables": {
                "contacts": {
                    "sheet": "TBL_CLIENTEENDTEL",
                    "column": "ID",
                    "to_stamp": 46829,
                    "stamped": 46829 if commit else 0,
                    "already": 0,
                    "missing": 7953,
                    "conflicts": 0,
                }
            },
        }

    def test_dry_run_says_nothing_was_written(self) -> None:
        text = render_report(self.result(commit=False))
        self.assertIn("dry-run", text)
        self.assertIn("nada foi gravado", text)

    def test_commit_reports_the_stamped_rows(self) -> None:
        text = render_report(self.result(commit=True))
        self.assertIn("46829 carimbadas", text)
        self.assertIn("7953 fora do canonico", text)
