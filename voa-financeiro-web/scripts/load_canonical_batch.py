"""Load the staged legacy batch into the canonical tables (phase 7).

The field dictionary (`scripts/legacy_field_map.json`) is the only source of truth:
a canonical column is written only when a legacy column maps to it with an explicit
`map` decision, resolved and validated by `scripts/build_field_dictionary.py`.

Rules enforced by this loader:

1. Nothing is inferred. A target table is loaded only when every `NOT NULL` canonical
   column without a default is covered by the mapping (directly or through a
   documented `links` entry) and only when the dependency tables it references were
   loaded first.
2. Dry-run by default. `--commit` is required to write canonical rows.
3. Rows are never merged, renamed or deleted. A row the mapping cannot satisfy is
   skipped, counted and reported; the staging payload stays intact.
4. Entities with provenance columns (`legacy_source`, `legacy_table`, `legacy_id`) are
   idempotent through that key, so a second run reuses the existing UUID instead of
   inserting a duplicate. Tables without provenance columns (e.g. `contacts`,
   `installments`) get a deterministic UUID derived from the source row, so re-running
   is also idempotent.
5. Mappings marked `status: "proposed"` require an explicit `--allow-proposed <table>`
   from the operator, which is recorded in the report and in `reconciliation_reports`.
6. `UNIQUE` constraints declared in the migrations are indexed in memory before the load,
   so a row that would repeat a stored key (e.g. `installments (agreement_id,
   installment_number)`) is reported as `LOAD_DUPLICATE_ROW` instead of reaching the
   database, with the same outcome in a dry run and in `--commit`.
7. Every `INSERT` runs inside a `SAVEPOINT`: a `CHECK`, partial `UNIQUE` or foreign key
   violation rejects only that row (`LOAD_ROW_REJECTED`, with the database message) and
   leaves the transaction usable for the remaining rows.
8. A column rule may declare `const`, a literal the loader writes when the rule's source
   column has a value (e.g. `asaas_customers.environment = "production"`). It is how a
   decision that is the same for every row is recorded in the dictionary instead of being
   hard-coded here.
9. A sheet may declare `aggregates`, the derived columns that come from the rows of another
   sheet (e.g. `agreements.total_amount` = sum of `TBL_PAGAMENTO_LISTAGEM.Valor_Parcela`
   grouped by the agreement legacy id). The values are computed before the load, from the
   staged payloads of the source sheet, deduplicated by `unique_by` (mirroring the child
   `UNIQUE` constraint) and reported as `LOAD_AGGREGATE_MISSING` when a parent row has no
   aggregate to read.
10. Sheets run only after **every** sheet that produces a table they reference, not merely
    after the first one: `contacts` waits for `TBL_PAGAMENTO` as well as `TBL_CLIENTE`,
    because `TBL_PAGAMENTO` creates customers the other sheet does not cover. Without that
    rule a fresh (empty) database loses those rows as `LOAD_REFERENCE_UNRESOLVED`, while a
    rerun against a populated canonical would resolve them.
11. A column rule may only use a normalization implemented here (`SUPPORTED_NORMALIZATIONS`) and
    declared in the dictionary (`normalizations`), so a typo is reported as a structural problem
    instead of silently passing the raw legacy value through.
12. `DEFAULT` clauses added by a later migration (`ALTER TABLE ... ALTER COLUMN ... SET DEFAULT`)
    are read like the ones declared in the `CREATE TABLE`: that is what turns a `NOT NULL` column
    into an optional one and gives the loader its `LOAD_VALUE_DEFAULTED` fallback.
13. `--enrich-reused` (commit-only) completes rows that an earlier run already stored: a column
    added by a later migration is filled where it is still NULL (`COALESCE`), so a stored value is
    never overwritten. Without it a rerun only reuses rows and the new column stays empty.

Exit codes: 0 loaded as requested, 1 structural problem, 3 staging problem,
4 partial load (some requested entity is blocked).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
import uuid
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_field_dictionary import (  # noqa: E402
    DEFAULT_DICTIONARY,
    DEFAULT_MIGRATIONS,
    IDENTIFIER,
    MAP,
    column_name_from_item,
    decision_of,
    load_dictionary,
    split_sql_items,
    strip_sql_comments,
)
from stage_legacy_workbook import (  # noqa: E402
    CANONICAL_TABLES,
    STAGING_URL_ENV,
    chunked,
    connect,
    database_url,
    describe_database_url,
    load_env,
    write_text_file,
)

DEFAULT_REPORT = Path(__file__).resolve().parents[1] / "docs" / "CANONICAL_LOAD_REPORT.md"
DEFAULT_LEGACY_SOURCE = "powerapps-voa"
DEFAULT_BATCH_PAGE = 5000


def resolve_database_urls(staging_url: str | None = None) -> tuple[str, str]:
    """Return `(staging_url, canonical_url)` for a run.

    The canonical URL always comes from `DIRECT_DATABASE_URL`/`DATABASE_URL`. The staging URL comes
    from `--staging-url`, then `STAGING_DATABASE_URL`, then the canonical URL - the fallback keeps
    the historical single-database behaviour. When the two differ, `migration_rows` is read from the
    staging database while the canonical rows are written to Supabase.
    """
    canonical = (database_url(prefer_staging=False) or "").strip()
    if not canonical:
        raise StagingError("DATABASE_URL or DIRECT_DATABASE_URL is required")
    staging = (staging_url or "").strip() or (os.environ.get(STAGING_URL_ENV) or "").strip() or canonical
    return staging, canonical

LOADER_ERROR_CODES = (
    "LOAD_REQUIRED_FIELD_EMPTY",
    "LOAD_REFERENCE_UNRESOLVED",
    "LOAD_VALUE_UNMAPPED",
    "LOAD_VALUE_DEFAULTED",
    "LOAD_DATE_UNPARSEABLE",
    "LOAD_MONEY_UNPARSEABLE",
    "LOAD_INTEGER_UNPARSEABLE",
    "LOAD_FRACTION_UNPARSEABLE",
    "LOAD_MONTH_YEAR_UNPARSEABLE",
    "LOAD_LEGACY_ID_MISSING",
    "LOAD_TABLE_BLOCKED",
    "LOAD_REFERENCE_MULTIVALUE",
    "LOAD_ROW_STATUS_ERROR",
    "LOAD_DUPLICATE_ROW",
    "LOAD_ROW_REJECTED",
    "LOAD_ROW_LINK_UNRESOLVED",
    "LOAD_AGGREGATE_MISSING",
)

LOAD_ORDER = (
    "schools",
    "customers",
    "contacts",
    "students",
    "agreements",
    "installments",
    "asaas_customers",
    "asaas_charges",
    "payments",
    "retention_ledger",
    "users",
)

PROVENANCE_COLUMNS = ("legacy_source", "legacy_table", "legacy_id")
UUID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "voa-financeiro-web:canonical-load")

NUMBER_PATTERN = re.compile(r"^-?\d+(\.\d+)?$")

SUPPORTED_NORMALIZATIONS = (
    "none",
    "trim",
    "collapse_ws",
    "digits",
    "upper",
    "normalize_name",
    "iso_date",
    "iso_datetime",
    "money",
    "integer",
    "boolean_sim_nao",
    "value_map",
    "value_map_ci",
    "min_positive",
    "positive_integer",
    "fraction",
    "month_year",
)


class LoadAborted(RuntimeError):
    """Raised when the plan cannot run (structural or mapping problem)."""


class StagingError(LoadAborted):
    """Raised when the staged batch required for the load is missing or inconsistent."""


@dataclass(frozen=True)
class ColumnRule:
    source_column: str
    table: str
    column: str
    field_type: str
    normalization: str | None
    required: bool
    priority: int
    status: str
    ref: str | None
    values: dict[str, str] | None
    provides_legacy_id_for: str | None
    gap: str | None
    note: str | None
    const: Any | None = None
    sheet: str = ""


@dataclass(frozen=True)
class AggregateSpec:
    """A canonical column derived from the rows of another sheet.

    Example: `agreements.total_amount` sums the staged `TBL_PAGAMENTO_LISTAGEM` rows that
    belong to the same agreement. Grouping uses the legacy id carried by `group_by`, so the
    aggregate never depends on rows already written to the canonical tables.
    """

    target: str
    table: str
    column: str
    source_sheet: str
    row_table: str
    group_by: str
    op: str
    measure: str | None
    normalization: str | None
    unique_by: tuple[tuple[str, str], ...]
    status: str
    note: str | None


@dataclass
class TablePlan:
    table: str
    rules: dict[str, list[ColumnRule]] = field(default_factory=dict)
    links: dict[str, str] = field(default_factory=dict)
    aggregates: dict[str, AggregateSpec] = field(default_factory=dict)
    provider: str | None = None
    missing_required: list[str] = field(default_factory=list)
    proposed_columns: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    status: str = "pending"
    blocked_reason: str | None = None
    detail: str | None = None

    @property
    def columns(self) -> list[str]:
        return sorted(set(self.rules) | set(self.links) | set(self.aggregates))

    @property
    def ref_targets(self) -> dict[str, str]:
        targets: dict[str, str] = {}
        for column, rules in self.rules.items():
            for rule in rules:
                if rule.ref:
                    targets.setdefault(column, rule.ref)
        return targets

    @property
    def numeric_columns(self) -> list[str]:
        return sorted(
            column
            for column, rules in self.rules.items()
            if all(rule.field_type == "numeric" for rule in rules)
        ) + sorted(self.aggregates)

    @property
    def money_columns(self) -> list[str]:
        """Colunas monetarias: as que a reconciliacao pode somar num unico numero."""
        return sorted(
            column
            for column, rules in self.rules.items()
            if all(rule.field_type == "numeric" for rule in rules)
        ) + sorted(
            column
            for column, spec in self.aggregates.items()
            if spec.op == "sum" and (spec.normalization or "") == "money"
        )


def entity_order(table: str) -> int:
    return LOAD_ORDER.index(table) if table in LOAD_ORDER else len(LOAD_ORDER)


def parse_canonical_columns(
    migrations_dir: Path = DEFAULT_MIGRATIONS,
) -> dict[str, dict[str, dict[str, Any]]]:
    """Return {table: {column: {type, not_null, has_default}}} from the SQL migrations."""
    tables: dict[str, dict[str, dict[str, Any]]] = {}
    create_pattern = re.compile(
        r"create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s*\(", re.I
    )
    alter_pattern = re.compile(
        r"alter\s+table\s+(?:if\s+exists\s+)?([a-z0-9_]+)\s+(.*?);", re.I | re.S
    )
    for path in sorted(migrations_dir.glob("*.sql")):
        sql = strip_sql_comments(path.read_text(encoding="utf-8"))
        for match in create_pattern.finditer(sql):
            table = match.group(1).lower()
            start = match.end()
            depth = 1
            position = start
            while position < len(sql) and depth > 0:
                if sql[position] == "(":
                    depth += 1
                elif sql[position] == ")":
                    depth -= 1
                position += 1
            columns = tables.setdefault(table, {})
            for item in split_sql_items(sql[start : position - 1]):
                name = column_name_from_item(item)
                if not name:
                    continue
                columns[name] = describe_column(item, name)
        for match in alter_pattern.finditer(sql):
            table = match.group(1).lower()
            columns = tables.setdefault(table, {})
            for item in split_sql_items(match.group(2)):
                add = re.match(
                    r"add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)(.*)$",
                    item.strip(),
                    re.I | re.S,
                )
                if add:
                    name = add.group(1).lower()
                    columns[name] = describe_column(f"{name}{add.group(2)}", name)
                    continue
                apply_alter_column(columns, item)
    return tables


def apply_alter_column(columns: dict[str, dict[str, Any]], item: str) -> bool:
    """Apply a table-level `ALTER COLUMN` clause to the parsed columns of a table.

    A default added by a later migration (instead of by the `CREATE TABLE` itself) is exactly what
    makes a `NOT NULL` column optional for the loader, so `SET DEFAULT` has to be understood here
    as well.
    """
    change = re.match(
        r"alter\s+column\s+(?:if\s+exists\s+)?([a-z0-9_]+)\s+(.*)$", item.strip(), re.I | re.S
    )
    if not change:
        return False
    info = columns.get(change.group(1).lower())
    if info is None:
        return False
    action = change.group(2)
    default = re.search(r"set\s+default\s+(.+)$", action, re.I | re.S)
    if default:
        info["has_default"] = True
        info["default"] = default.group(1).strip().rstrip(",")
        return True
    if re.search(r"drop\s+default", action, re.I):
        info["has_default"] = False
        info["default"] = None
        return True
    if re.search(r"set\s+not\s+null", action, re.I):
        info["not_null"] = True
        return True
    if re.search(r"drop\s+not\s+null", action, re.I):
        info["not_null"] = False
        return True
    return False


def describe_column(item: str, name: str) -> dict[str, Any]:
    body = item.strip()
    remainder = body[len(name) :] if body.lower().startswith(name) else body
    lowered = remainder.lower()
    words = remainder.strip().split()
    default_match = re.search(
        r"\bdefault\s+(.+?)(?=\s+(?:check|constraint|references|primary\s+key|unique|not\s+null)\b|$)",
        remainder,
        re.I | re.S,
    )
    return {
        "type": (words[0].lower().strip(",") if words else ""),
        "not_null": "not null" in lowered,
        "has_default": "default" in lowered,
        "default": (default_match.group(1).strip().rstrip(",") if default_match else None),
    }


def parse_unique_groups(migrations_dir: Path = DEFAULT_MIGRATIONS) -> dict[str, list[tuple[str, ...]]]:
    """Return {table: [(column, ...)]} for the UNIQUE constraints declared in the migrations.

    Partial unique indexes are not modelled here (they cannot be expressed as a plain key);
    they are still protected at insert time by the per-row savepoint in `try_insert`.
    """
    groups: dict[str, list[tuple[str, ...]]] = {}
    create_pattern = re.compile(
        r"create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s*\(", re.I
    )
    table_constraint = re.compile(
        r"^\s*(?:constraint\s+[a-z0-9_]+\s+)?unique\s*\(([^)]+)\)", re.I
    )
    for path in sorted(migrations_dir.glob("*.sql")):
        sql = strip_sql_comments(path.read_text(encoding="utf-8"))
        for match in create_pattern.finditer(sql):
            table = match.group(1).lower()
            start = match.end()
            depth = 1
            position = start
            while position < len(sql) and depth > 0:
                if sql[position] == "(":
                    depth += 1
                elif sql[position] == ")":
                    depth -= 1
                position += 1
            entries = groups.setdefault(table, [])
            for item in split_sql_items(sql[start : position - 1]):
                body = item.strip()
                if not body:
                    continue
                constraint = table_constraint.match(body)
                if constraint:
                    columns = tuple(part.strip().lower() for part in constraint.group(1).split(","))
                    if all(columns) and columns not in entries:
                        entries.append(columns)
                    continue
                name = column_name_from_item(body)
                if not name:
                    continue
                column = name.lower()
                if column == "id" or column in PROVENANCE_COLUMNS:
                    continue
                if re.search(r"\bunique\b", body, re.I) and (column,) not in entries:
                    entries.append((column,))
            if not entries:
                groups.pop(table, None)
    return groups


def required_columns(table: str, schema: dict[str, dict[str, dict[str, Any]]]) -> list[str]:
    return sorted(
        column
        for column, info in schema.get(table, {}).items()
        if info["not_null"] and not info["has_default"]
    )


def column_rule(sheet: str, rule: dict[str, Any], problems: list[dict[str, Any]]) -> ColumnRule | None:
    target = rule.get("map", "")
    table, separator, column = target.partition(".")
    if not separator:
        problems.append({"code": "TARGET_NOT_QUALIFIED", "sheet": sheet, "rule": str(rule)})
        return None
    return ColumnRule(
        source_column=rule["match"],
        table=table,
        column=column,
        field_type=rule.get("type") or "text",
        normalization=rule.get("normalization"),
        required=bool(rule.get("required", False)),
        priority=int(rule.get("priority", 10)),
        status=rule.get("status", "confirmed"),
        ref=rule.get("ref"),
        values=rule.get("values"),
        provides_legacy_id_for=rule.get("provides_legacy_id_for"),
        gap=rule.get("gap"),
        note=rule.get("note"),
        const=rule.get("const"),
        sheet=sheet,
    )


AGGREGATE_OPS = ("count", "sum")
NUMERIC_NORMALIZATIONS = ("money", "integer", "positive_integer")


def mapped_tables(sheet_rules: dict[str, Any]) -> set[str]:
    tables: set[str] = set()
    for rule in sheet_rules.get("columns", []):
        if isinstance(rule, dict) and isinstance(rule.get("map"), str) and "." in rule["map"]:
            tables.add(rule["map"].split(".", 1)[0])
    return tables


def mapped_columns(sheet_rules: dict[str, Any], table: str) -> set[str]:
    prefix = f"{table}."
    return {
        rule["map"].split(".", 1)[1]
        for rule in sheet_rules.get("columns", [])
        if isinstance(rule, dict) and isinstance(rule.get("map"), str) and rule["map"].startswith(prefix)
    }


def declared_columns(sheet_rules: dict[str, Any]) -> set[str]:
    return {
        rule["match"]
        for rule in sheet_rules.get("columns", [])
        if isinstance(rule, dict) and isinstance(rule.get("match"), str)
    }


def parse_aggregates(
    sheet: str,
    block: Any,
    dictionary: dict[str, Any],
    entries: dict[str, dict[str, list[ColumnRule]]],
    problems: list[dict[str, Any]],
) -> dict[str, dict[str, AggregateSpec]]:
    """Validate the `aggregates` block of one sheet, grouped by target table."""
    if block is None:
        return {}
    if not isinstance(block, dict):
        problems.append({"code": "AGGREGATE_NOT_OBJECT", "sheet": sheet})
        return {}

    source_sheet = block.get("source_sheet")
    row_table = block.get("row_table")
    group_by = block.get("group_by")
    unique_by = block.get("unique_by") or {}
    targets = block.get("targets")
    sheets = dictionary.get("sheets", {})
    source_rules = sheets.get(source_sheet) if isinstance(source_sheet, str) else None

    if not isinstance(source_rules, dict):
        problems.append(
            {"code": "AGGREGATE_SOURCE_SHEET_UNKNOWN", "sheet": sheet, "source_sheet": str(source_sheet)}
        )
        return {}
    if not isinstance(row_table, str) or row_table not in mapped_tables(source_rules):
        problems.append(
            {"code": "AGGREGATE_ROW_TABLE_NOT_MAPPED", "sheet": sheet, "row_table": str(row_table)}
        )
        return {}
    source_columns = declared_columns(source_rules)
    if not isinstance(group_by, str) or group_by not in source_columns:
        problems.append({"code": "AGGREGATE_GROUP_COLUMN_UNKNOWN", "sheet": sheet, "column": str(group_by)})
        return {}
    if not isinstance(unique_by, dict):
        problems.append({"code": "AGGREGATE_UNIQUE_NOT_OBJECT", "sheet": sheet, "columns": str(unique_by)})
        return {}
    row_columns = mapped_columns(source_rules, row_table)
    for source_column, canonical in unique_by.items():
        canonical_column = str(canonical).split(".", 1)[-1] if isinstance(canonical, str) else ""
        if (
            source_column not in source_columns
            or not isinstance(canonical, str)
            or not canonical.startswith(f"{row_table}.")
            or canonical_column not in row_columns
        ):
            problems.append(
                {
                    "code": "AGGREGATE_UNIQUE_COLUMN_UNKNOWN",
                    "sheet": sheet,
                    "columns": f"{source_column}={canonical}",
                }
            )
            return {}
    if not isinstance(targets, dict) or not targets:
        problems.append({"code": "AGGREGATE_TARGETS_MISSING", "sheet": sheet})
        return {}

    normalizations = dictionary.get("normalizations", {})
    result: dict[str, dict[str, AggregateSpec]] = {}
    for target, spec in targets.items():
        table, separator, column = str(target).partition(".")
        if not separator:
            problems.append({"code": "AGGREGATE_TARGET_NOT_QUALIFIED", "sheet": sheet, "target": str(target)})
            continue
        if table not in entries:
            problems.append(
                {"code": "AGGREGATE_TARGET_TABLE_NOT_MAPPED", "sheet": sheet, "target": str(target)}
            )
            continue
        if not isinstance(spec, dict):
            problems.append({"code": "AGGREGATE_TARGET_NOT_OBJECT", "sheet": sheet, "target": str(target)})
            continue
        op = str(spec.get("op", "")).lower()
        if op not in AGGREGATE_OPS:
            problems.append(
                {"code": "AGGREGATE_OP_UNSUPPORTED", "sheet": sheet, "target": str(target), "op": str(op)}
            )
            continue
        measure = spec.get("measure")
        if measure is not None and (not isinstance(measure, str) or measure not in source_columns):
            problems.append(
                {"code": "AGGREGATE_MEASURE_COLUMN_UNKNOWN", "sheet": sheet, "target": str(target), "column": str(measure)}
            )
            continue
        if op == "sum" and not measure:
            problems.append({"code": "AGGREGATE_MEASURE_REQUIRED", "sheet": sheet, "target": str(target)})
            continue
        normalization = spec.get("normalization")
        if normalization is not None and normalization not in normalizations:
            problems.append(
                {
                    "code": "AGGREGATE_NORMALIZATION_UNKNOWN",
                    "sheet": sheet,
                    "target": str(target),
                    "normalization": str(normalization),
                }
            )
            continue
        if op == "sum" and normalization not in NUMERIC_NORMALIZATIONS:
            problems.append(
                {
                    "code": "AGGREGATE_SUM_REQUIRES_NUMERIC",
                    "sheet": sheet,
                    "target": str(target),
                    "normalization": str(normalization),
                }
            )
            continue
        result.setdefault(table, {})[column] = AggregateSpec(
            target=str(target),
            table=table,
            column=column,
            source_sheet=source_sheet,
            row_table=row_table,
            group_by=group_by,
            op=op,
            measure=measure,
            normalization=normalization,
            unique_by=tuple(
                (str(source), str(canonical)) for source, canonical in unique_by.items()
            ),
            status=str(spec.get("status", "proposed")),
            note=spec.get("note"),
        )
    return result


def build_plan(
    dictionary: dict[str, Any],
    schema: dict[str, dict[str, dict[str, Any]]],
    requested: set[str] | None,
    allow_proposed: set[str],
) -> dict[str, Any]:
    """Resolve every sheet into per-table load plans and their readiness."""
    problems: list[dict[str, Any]] = []
    plan: dict[str, TablePlan] = {}
    sheet_plan: dict[str, dict[str, Any]] = {}

    for sheet, rules in dictionary["sheets"].items():
        if not isinstance(rules, dict):
            problems.append({"code": "SHEET_NOT_OBJECT", "sheet": sheet})
            continue
        default = rules.get("default")
        if isinstance(default, dict) and MAP in default:
            problems.append(
                {
                    "code": "WILDCARD_MAP_NOT_SUPPORTED",
                    "sheet": sheet,
                    "reason": "a `default` mapping would apply to unknown columns",
                }
            )
            continue

        entries: dict[str, dict[str, list[ColumnRule]]] = {}
        providers: dict[str, ColumnRule] = {}
        for rule in rules.get("columns", []):
            try:
                kind = decision_of(rule)
            except ValueError as error:
                problems.append({"code": "INVALID_DECISION", "sheet": sheet, "reason": str(error)})
                continue
            if kind != MAP:
                continue
            parsed = column_rule(sheet, rule, problems)
            if parsed is None:
                continue
            if parsed.normalization is not None:
                if parsed.normalization not in SUPPORTED_NORMALIZATIONS:
                    problems.append(
                        {
                            "code": "COLUMN_NORMALIZATION_UNKNOWN",
                            "sheet": sheet,
                            "target": f"{parsed.table}.{parsed.column}",
                            "normalization": str(parsed.normalization),
                        }
                    )
                    continue
                declared = dictionary.get("normalizations")
                if isinstance(declared, dict) and declared and parsed.normalization not in declared:
                    problems.append(
                        {
                            "code": "COLUMN_NORMALIZATION_UNDECLARED",
                            "sheet": sheet,
                            "target": f"{parsed.table}.{parsed.column}",
                            "normalization": str(parsed.normalization),
                        }
                    )
                    continue
            entries.setdefault(parsed.table, {}).setdefault(parsed.column, []).append(parsed)
            if parsed.provides_legacy_id_for:
                providers.setdefault(parsed.provides_legacy_id_for, parsed)

        links: dict[str, dict[str, str]] = {}
        for target, spec in (rules.get("links") or {}).items():
            table, separator, column = target.partition(".")
            if not separator:
                problems.append({"code": "LINK_TARGET_NOT_QUALIFIED", "sheet": sheet, "link": target})
                continue
            if not isinstance(spec, str) or not spec.startswith("row:"):
                problems.append(
                    {"code": "LINK_SOURCE_UNSUPPORTED", "sheet": sheet, "link": target, "source": str(spec)}
                )
                continue
            reference = spec.split(":", 1)[1]
            if table not in entries:
                problems.append({"code": "LINK_TABLE_NOT_MAPPED", "sheet": sheet, "link": target})
                continue
            if reference not in entries:
                problems.append(
                    {"code": "LINK_ROW_TABLE_NOT_MAPPED", "sheet": sheet, "link": target, "row_table": reference}
                )
                continue
            if column in entries[table]:
                problems.append({"code": "LINK_CONFLICTS_WITH_MAP", "sheet": sheet, "link": target})
                continue
            links.setdefault(table, {})[column] = reference

        aggregates = parse_aggregates(sheet, rules.get("aggregates"), dictionary, entries, problems)

        if not entries:
            sheet_plan[sheet] = {
                "target_entity": rules.get("target_entity"),
                "row_kind": rules.get("row_kind"),
                "tables": [],
                "status": "no_mapping",
            }
            continue

        sheet_tables: list[str] = []
        for table in sorted(entries):
            table_rules = entries[table]
            table_links = links.get(table, {})
            table_aggregates = aggregates.get(table, {})
            target = plan.get(table)
            if target is None:
                target = TablePlan(table=table)
                plan[table] = target
            for column, column_rules in table_rules.items():
                target.rules.setdefault(column, []).extend(column_rules)
            target.links.update(table_links)
            target.aggregates.update(table_aggregates)
            provider = providers.get(table)
            if provider is not None and target.provider is None:
                target.provider = provider.source_column
            target.proposed_columns.extend(
                column
                for column, column_rules in table_rules.items()
                if any(rule.status != "confirmed" for rule in column_rules)
            )
            target.proposed_columns.extend(
                column
                for column, spec in table_aggregates.items()
                if spec.status != "confirmed"
            )
            covered = set(table_rules) | set(table_links) | set(table_aggregates)
            for column in required_columns(table, schema):
                if column not in covered and column not in target.missing_required:
                    target.missing_required.append(column)
            if table not in schema:
                problems.append({"code": "TARGET_TABLE_UNKNOWN", "sheet": sheet, "target": table})
            else:
                for column in sorted(table_rules) + sorted(table_links) + sorted(table_aggregates):
                    if column not in schema[table]:
                        problems.append(
                            {"code": "TARGET_COLUMN_UNKNOWN", "sheet": sheet, "target": f"{table}.{column}"}
                        )
            sheet_tables.append(table)

        ordered_tables = sorted(sheet_tables, key=lambda item: (entity_order(item), item))
        declared_entity = rules.get("target_entity")
        sheet_plan[sheet] = {
            "target_entity": declared_entity,
            "row_kind": rules.get("row_kind"),
            "tables": ordered_tables,
            "status": "mapped",
            "primary": declared_entity if declared_entity in sheet_tables else ordered_tables[0],
        }

    for target in plan.values():
        target.missing_required.sort()
        target.proposed_columns = sorted(set(target.proposed_columns))
        dependencies = set(target.ref_targets.values()) | set(target.links.values())
        dependencies.discard(target.table)
        target.dependencies = sorted(item for item in dependencies if item in plan)

    order = topological_order(plan, problems)
    for table in order:
        evaluate_readiness(plan[table], requested, allow_proposed, plan)
    for target in plan.values():
        if target.status == "pending":
            target.status = "blocked"
            target.blocked_reason = "dependency_cycle"

    return {"problems": problems, "tables": plan, "sheets": sheet_plan, "order": order}


def topological_order(plan: dict[str, TablePlan], problems: list[dict[str, Any]]) -> list[str]:
    """Deterministic dependency order: schools before students, agreements before installments."""
    resolved: set[str] = set()
    order: list[str] = []
    while len(resolved) < len(plan):
        ready = sorted(
            (
                table
                for table, target in plan.items()
                if table not in resolved and set(target.dependencies) <= resolved
            ),
            key=lambda item: (entity_order(item), item),
        )
        if not ready:
            problems.append(
                {
                    "code": "DEPENDENCY_CYCLE",
                    "tables": sorted(set(plan) - resolved),
                    "reason": "dependency order could not be resolved",
                }
            )
            order.extend(sorted(set(plan) - resolved, key=lambda item: (entity_order(item), item)))
            break
        for table in ready:
            order.append(table)
            resolved.add(table)
    return order


def evaluate_readiness(
    target: TablePlan,
    requested: set[str] | None,
    allow_proposed: set[str],
    plan: dict[str, TablePlan],
    seen: set[str] | None = None,
) -> None:
    """Classify a table as `ready`, `not_requested` or `blocked` with an explicit reason."""
    if target.status in {"ready", "blocked", "not_requested"}:
        return
    seen = set() if seen is None else seen
    if target.table in seen:
        return
    seen.add(target.table)
    if requested is not None and target.table not in requested:
        target.status = "not_requested"
        target.blocked_reason = "not_requested"
        return
    if not target.rules:
        target.status = "blocked"
        target.blocked_reason = "no_mapped_columns"
        return
    if target.missing_required:
        target.status = "blocked"
        target.blocked_reason = "required_columns_uncovered"
        target.detail = ", ".join(target.missing_required)
        return
    if target.proposed_columns and target.table not in allow_proposed:
        target.status = "blocked"
        target.blocked_reason = "mapping_not_confirmed"
        target.detail = ", ".join(target.proposed_columns)
        return
    for dependency in target.dependencies:
        other = plan.get(dependency)
        if other is None:
            continue
        evaluate_readiness(other, requested, allow_proposed, plan, seen)
        if other.status != "ready":
            target.status = "blocked"
            target.blocked_reason = "dependency_not_loaded"
            target.detail = f"{dependency} ({other.status})"
            return
    target.status = "ready"


# ---------------------------------------------------------------------------
# Value conversion
# ---------------------------------------------------------------------------

DATE_FORMATS = ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y", "%Y/%m/%d", "%d-%m-%Y")
DATETIME_FORMATS = (
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%d/%m/%Y",
)


def normalize_key(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value if value is not None else ""))
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", text).strip().upper()


def is_blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    return False


def parse_money(value: Any) -> Decimal | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return Decimal(str(value)).quantize(Decimal("0.01"))
    text = str(value).strip()
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    text = re.sub(r"[^\d,.\-]", "", text)
    if text.count(",") and text.count("."):
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif text.count(","):
        decimals = len(text) - text.rfind(",") - 1
        text = text.replace(",", "." if decimals in (1, 2) else "")
    try:
        amount = Decimal(text)
    except (InvalidOperation, ValueError):
        return None
    if negative:
        amount = -amount
    return amount.quantize(Decimal("0.01"))


def parse_fraction(value: Any) -> Decimal | None:
    """Legacy retention fraction: `0,25`, `0.25`, `25%` or float noise, always within 0..1.

    Anything outside 0..1 is refused instead of guessed: `payments.retention_percentage` is
    `numeric(5,4)` with a CHECK, and a value that violates the CHECK would abort the transaction.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        amount = Decimal(str(value))
    else:
        text = str(value).strip().replace(" ", "")
        if not text:
            return None
        percent = text.endswith("%")
        text = text.rstrip("%").replace(",", ".")
        if text.count(".") > 1:
            return None
        try:
            amount = Decimal(text)
        except (InvalidOperation, ValueError):
            return None
        if percent:
            amount = amount / 100
    if amount < 0 or amount > 1:
        return None
    return amount.quantize(Decimal("0.0001"))


MONTH_YEAR_PATTERN = re.compile(r"^(\d{1,2})[/\-. ](\d{4})$|^(\d{4})[/\-. ](\d{1,2})$")


def parse_month_year(value: Any) -> str | None:
    """Legacy `MM AAAA` (or `AAAA-MM`) as the canonical `AAAA-MM` text."""
    if isinstance(value, (date, datetime)):
        return f"{value.year:04d}-{value.month:02d}"
    text = str(value).strip()
    if not text:
        return None
    match = MONTH_YEAR_PATTERN.match(text)
    if not match:
        return None
    if match.group(1):
        month, year = int(match.group(1)), int(match.group(2))
    else:
        year, month = int(match.group(3)), int(match.group(4))
    if not 1 <= month <= 12:
        return None
    return f"{year:04d}-{month:02d}"


def parse_date_value(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text[:10], fmt).date()
        except ValueError:
            continue
    return None


def parse_datetime_value(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    text = str(value).strip()
    if not text:
        return None
    for fmt in DATETIME_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    moment = parse_date_value(text)
    return datetime(moment.year, moment.month, moment.day) if moment else None


def apply_value_map(raw: Any, rule: ColumnRule, case_insensitive: bool) -> str | None:
    if not rule.values:
        return None
    if case_insensitive:
        mapping = {normalize_key(key): value for key, value in rule.values.items()}
        return mapping.get(normalize_key(raw))
    return rule.values.get(str(raw).strip())


def convert_value(raw: Any, rule: ColumnRule) -> tuple[Any, str | None]:
    """Return (value, finding_code). A `None` finding means the conversion succeeded."""
    normalization = rule.normalization or "none"
    if normalization == "none":
        return raw, None
    if normalization == "trim":
        return str(raw).strip(), None
    if normalization == "collapse_ws":
        return re.sub(r"\s+", " ", str(raw)).strip(), None
    if normalization == "digits":
        return re.sub(r"\D", "", str(raw)), None
    if normalization == "upper":
        return str(raw).strip().upper(), None
    if normalization == "normalize_name":
        return normalize_key(raw), None
    if normalization == "iso_date":
        parsed = parse_date_value(raw)
        return (parsed, None) if parsed else (None, "LOAD_DATE_UNPARSEABLE")
    if normalization == "iso_datetime":
        parsed = parse_datetime_value(raw)
        return (parsed, None) if parsed else (None, "LOAD_DATE_UNPARSEABLE")
    if normalization == "money":
        text = str(raw).strip()
        if NUMBER_PATTERN.match(text):
            return Decimal(text).quantize(Decimal("0.01")), None
        parsed = parse_money(raw)
        return (parsed, None) if parsed is not None else (None, "LOAD_MONEY_UNPARSEABLE")
    if normalization == "integer":
        text = str(raw).strip()
        if re.fullmatch(r"-?\d+\.0+", text):
            text = text.split(".", 1)[0]
        try:
            return int(Decimal(text)), None
        except (InvalidOperation, ValueError):
            return None, "LOAD_INTEGER_UNPARSEABLE"
    if normalization == "boolean_sim_nao":
        mapping = rule.values or {"sim": "true", "nao": "false"}
        translated = {normalize_key(key): value for key, value in mapping.items()}.get(normalize_key(raw))
        if translated is None:
            return None, "LOAD_VALUE_UNMAPPED"
        return str(translated).strip().lower() in {"true", "1", "sim", "yes"}, None
    if normalization in {"value_map", "value_map_ci"}:
        mapped = apply_value_map(raw, rule, normalization == "value_map_ci")
        if mapped is None:
            return None, "LOAD_VALUE_UNMAPPED"
        return mapped, None
    if normalization == "fraction":
        parsed = parse_fraction(raw)
        return (parsed, None) if parsed is not None else (None, "LOAD_FRACTION_UNPARSEABLE")
    if normalization == "month_year":
        parsed = parse_month_year(raw)
        return (parsed, None) if parsed is not None else (None, "LOAD_MONTH_YEAR_UNPARSEABLE")
    if normalization == "min_positive":
        parsed = parse_money(raw)
        if parsed is None:
            return None, "LOAD_MONEY_UNPARSEABLE"
        return (None, None) if parsed <= 0 else (parsed, None)
    if normalization == "positive_integer":
        text = str(raw).strip()
        if re.fullmatch(r"-?\d+\.0+", text):
            text = text.split(".", 1)[0]
        try:
            parsed_integer = int(Decimal(text))
        except (InvalidOperation, ValueError):
            return None, "LOAD_INTEGER_UNPARSEABLE"
        return (parsed_integer, None) if parsed_integer > 0 else (None, None)
    return raw, None


@dataclass
class RowOutcome:
    """Values resolved for one canonical table out of one staged row."""

    values: dict[str, Any] = field(default_factory=dict)
    legacy_id: str | None = None
    findings: list[tuple[str, str, str]] = field(default_factory=list)
    skipped: str | None = None
    skip_field: str | None = None
    skip_detail: str | None = None

    def note(self, code: str, field_name: str, detail: str) -> None:
        self.findings.append((code, field_name, detail))

    def skip(self, code: str, field_name: str, detail: str) -> None:
        """Register the first reason that stops this row for this table."""
        if self.skipped is None:
            self.skipped = code
            self.skip_field = field_name
            self.skip_detail = detail


def resolve_reference(
    raw_value: Any,
    rule: ColumnRule,
    outcome: RowOutcome,
    legacy_maps: dict[str, dict[str, Any]],
) -> Any:
    """Map a legacy id to the canonical UUID loaded for that legacy id."""
    target_map = legacy_maps.get(rule.ref or "", {})
    candidates = [item.strip() for item in str(raw_value).split(";") if item.strip()]
    if len(candidates) > 1:
        outcome.note(
            "LOAD_REFERENCE_MULTIVALUE",
            rule.source_column,
            f"{rule.table}.{rule.column} recebeu {len(candidates)} ids: {raw_value}",
        )
    for candidate in candidates:
        resolved = target_map.get(candidate)
        if resolved is not None:
            return resolved
    return None


def row_uuid(sheet: str, row_number: int) -> uuid.UUID:
    return uuid.uuid5(UUID_NAMESPACE, f"{sheet}:{row_number}")


def python_literal_default(raw_default: str) -> Any:
    """Convert a simple SQL default literal into a Python value (`now()`/UUIDs are ignored)."""
    text = raw_default.strip()
    match = re.match(r"^'((?:[^']|'')*)'(?:::[\w\s\[\]]+)?$", text)
    if match:
        return match.group(1).replace("''", "'")
    lowered = text.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if re.fullmatch(r"-?\d+(\.\d+)?", text):
        return Decimal(text) if "." in text else int(text)
    return None


def build_row_values(
    sheet: str,
    tables: list[str],
    plan: dict[str, TablePlan],
    payload: dict[str, Any],
    legacy_maps: dict[str, dict[str, Any]],
    defaults: dict[str, dict[str, Any]],
) -> dict[str, RowOutcome]:
    """Resolve every mapped table of a sheet from a single staged payload."""
    outcomes: dict[str, RowOutcome] = {}
    for table in tables:
        target = plan[table]
        outcome = RowOutcome()
        table_defaults = defaults.get(table, {})
        ordered: list[tuple[int, str, str, ColumnRule]] = []
        for column, rules in target.rules.items():
            for rule in rules:
                if rule.sheet and rule.sheet != sheet:
                    # Uma tabela canonica pode ser alimentada por varias abas (ex.: customers
                    # vem de TBL_CLIENTE e do pagador sintetizado de TBL_PAGAMENTO): cada aba
                    # resolve apenas as regras que ela mesma declara.
                    continue
                ordered.append((rule.priority, column, rule.source_column, rule))
        for _, column, _, rule in sorted(ordered, key=lambda item: (item[0], item[1], item[2])):
            raw = payload.get(rule.source_column)
            if rule.const is not None and not is_blank(raw):
                # A literal decision recorded in the dictionary: the source column only
                # gates the rule (blank still follows the required/default logic below).
                outcome.values[column] = rule.const
                if rule.field_type == "legacy_id" and rule.provides_legacy_id_for:
                    outcome.legacy_id = str(rule.const)
                continue
            if is_blank(raw):
                if rule.required and column in table_defaults:
                    outcome.values[column] = table_defaults[column]
                    outcome.note(
                        "LOAD_VALUE_DEFAULTED",
                        rule.source_column,
                        f"{table}.{column} vazio na origem; usado padrao canonico "
                        f"{table_defaults[column]!r}",
                    )
                    continue
                if rule.field_type == "legacy_id" and rule.provides_legacy_id_for:
                    outcome.note(
                        "LOAD_LEGACY_ID_MISSING",
                        rule.source_column,
                        f"{table} sem legacy_id em {sheet}",
                    )
                    if rule.required:
                        outcome.skip(
                            "LOAD_LEGACY_ID_MISSING",
                            rule.source_column,
                            f"{rule.source_column} vazio na origem",
                        )
                    continue
                if rule.required:
                    outcome.skip(
                        "LOAD_REQUIRED_FIELD_EMPTY",
                        rule.source_column,
                        f"{rule.source_column} vazio na origem",
                    )
                continue
            converted, finding = convert_value(raw, rule)
            if finding:
                if column in table_defaults:
                    outcome.values[column] = table_defaults[column]
                    outcome.note(
                        "LOAD_VALUE_DEFAULTED",
                        rule.source_column,
                        f"{table}.{column} nao traduzido ({raw!r}); usado padrao canonico "
                        f"{table_defaults[column]!r}",
                    )
                    continue
                if rule.required:
                    outcome.skip(finding, rule.source_column, f"{rule.source_column}={raw!r} ({finding})")
                    continue
                outcome.note(
                    finding, rule.source_column, f"valor legado {raw!r} descartado em {table}.{column}"
                )
                continue
            if is_blank(converted):
                if rule.required and column in table_defaults:
                    outcome.values[column] = table_defaults[column]
                    outcome.note(
                        "LOAD_VALUE_DEFAULTED",
                        rule.source_column,
                        f"{table}.{column} ficou vazio apos normalizacao; usado padrao canonico "
                        f"{table_defaults[column]!r}",
                    )
                    continue
                if rule.required:
                    outcome.skip(
                        "LOAD_REQUIRED_FIELD_EMPTY",
                        rule.source_column,
                        f"{rule.source_column} vazio apos normalizacao",
                    )
                continue
            if rule.ref:
                resolved = resolve_reference(converted, rule, outcome, legacy_maps)
                if resolved is None:
                    if rule.required:
                        outcome.skip(
                            "LOAD_REFERENCE_UNRESOLVED",
                            rule.source_column,
                            f"{rule.source_column}={converted} sem registro em {rule.ref}",
                        )
                        continue
                    outcome.note(
                        "LOAD_REFERENCE_UNRESOLVED",
                        rule.source_column,
                        f"{table}.{rule.column}: {rule.ref} sem correspondente para {converted!r}",
                    )
                    continue
                outcome.values[column] = resolved
                continue
            outcome.values[column] = converted
            if rule.field_type == "legacy_id" and rule.provides_legacy_id_for:
                outcome.legacy_id = str(converted)
        outcomes[table] = outcome
    return outcomes


# ---------------------------------------------------------------------------
# Database layer
# ---------------------------------------------------------------------------


@dataclass
class TableStats:
    table: str
    rows_considered: int = 0
    inserted: int = 0
    reused: int = 0
    enriched: int = 0
    skipped: int = 0
    skip_reasons: dict[str, int] = field(default_factory=dict)
    numeric_totals: dict[str, Decimal] = field(default_factory=dict)
    ids: list[str] = field(default_factory=list)

    @property
    def loaded(self) -> int:
        return self.inserted + self.reused

    def count_skip(self, reason: str) -> None:
        self.skipped += 1
        self.skip_reasons[reason] = self.skip_reasons.get(reason, 0) + 1


@dataclass
class LoadState:
    legacy_source: str
    batch_id: str
    commit: bool
    enrich: bool = False
    tables: dict[str, TableStats] = field(default_factory=dict)
    legacy_maps: dict[str, dict[str, Any]] = field(default_factory=dict)
    provenance_keys: dict[str, dict[tuple[str, str], Any]] = field(default_factory=dict)
    existing_ids: dict[str, set[str]] = field(default_factory=dict)
    findings: dict[tuple[str, str, str], dict[str, Any]] = field(default_factory=dict)
    row_ids: dict[str, Any] = field(default_factory=dict)
    committed_row_ids: list[str] = field(default_factory=list)
    canonical_before: dict[str, int] = field(default_factory=dict)
    unique_groups: dict[str, list[tuple[str, ...]]] = field(default_factory=dict)
    unique_keys: dict[str, set[tuple[str, ...]]] = field(default_factory=dict)

    def stats(self, table: str) -> TableStats:
        if table not in self.tables:
            self.tables[table] = TableStats(table=table)
        return self.tables[table]

    def finding(self, sheet: str, code: str, field_name: str, detail: str, row_number: int) -> None:
        key = (sheet, code, field_name or "-")
        entry = self.findings.get(key)
        if entry is None:
            entry = {"count": 0, "samples": [], "message": detail}
            self.findings[key] = entry
        entry["count"] += 1
        if len(entry["samples"]) < 5:
            entry["samples"].append({"row": row_number, "detail": detail})


def canonical_tables_for_counts(plan: dict[str, TablePlan]) -> list[str]:
    tables = [table for table in CANONICAL_TABLES if table in plan]
    for extra in ("contacts", "users", "retention_ledger", "asaas_customers"):
        if extra in plan and extra not in tables:
            tables.append(extra)
    return tables or list(plan)


def quote_identifier(name: str) -> str:
    if not IDENTIFIER.match(name):
        raise LoadAborted(f"unsafe SQL identifier: {name!r}")
    return name


def snapshot_canonical_counts(cursor: Any, tables: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in tables:
        cursor.execute(f"SELECT count(*) FROM {quote_identifier(table)}")
        counts[table] = int(cursor.fetchone()[0])
    return counts


def uses_provenance(table: str, schema: dict[str, dict[str, dict[str, Any]]], provider: str | None) -> bool:
    columns = schema.get(table, {})
    return provider is not None and all(column in columns for column in PROVENANCE_COLUMNS)


def preload_existing(
    cursor: Any,
    plan: dict[str, TablePlan],
    schema: dict[str, dict[str, dict[str, Any]]],
    legacy_source: str,
    state: LoadState,
) -> None:
    """Seed the legacy id maps from rows already loaded, so reruns and partial runs resolve."""
    for table, target in plan.items():
        if target.status != "ready":
            continue
        if uses_provenance(table, schema, target.provider):
            cursor.execute(
                f"""
                SELECT legacy_table, legacy_id, id FROM {quote_identifier(table)}
                 WHERE legacy_source = %s AND legacy_id IS NOT NULL
                """,
                (legacy_source,),
            )
            keys: dict[tuple[str, str], Any] = {}
            legacy = state.legacy_maps.setdefault(table, {})
            for legacy_table, legacy_id, identifier in cursor.fetchall():
                keys[(str(legacy_table), str(legacy_id))] = identifier
                legacy.setdefault(str(legacy_id), identifier)
            state.provenance_keys[table] = keys
        else:
            cursor.execute(f"SELECT id FROM {quote_identifier(table)}")
            state.existing_ids[table] = {str(row[0]) for row in cursor.fetchall()}


def unique_key(values: dict[str, Any], columns: tuple[str, ...]) -> tuple[str, ...] | None:
    """Build a comparable key for one UNIQUE constraint, or None when the key cannot conflict.

    Postgres treats NULLs as distinct, so a missing/blank part means "no conflict".
    """
    parts: list[str] = []
    for column in columns:
        if column not in values:
            return None
        value = values[column]
        if value is None or value == "":
            return None
        parts.append(str(value))
    return tuple(parts)


def unique_conflict(
    state: LoadState, table: str, values: dict[str, Any]
) -> tuple[str, ...] | None:
    """Return the UNIQUE constraint this row would violate, judged from the ids already stored."""
    known = state.unique_keys.get(table)
    if not known:
        return None
    for columns in state.unique_groups.get(table, []):
        key = unique_key(values, columns)
        if key is not None and key in known:
            return columns
    return None


def remember_unique_keys(state: LoadState, table: str, values: dict[str, Any]) -> None:
    known = state.unique_keys.setdefault(table, set())
    for columns in state.unique_groups.get(table, []):
        key = unique_key(values, columns)
        if key is not None:
            known.add(key)


def preload_unique_keys(cursor: Any, plan: dict[str, TablePlan], state: LoadState) -> None:
    """Load the UNIQUE keys already present, so a rerun reports the same duplicates as the first."""
    for table, target in plan.items():
        if target.status != "ready":
            continue
        groups = state.unique_groups.get(table)
        if not groups:
            continue
        columns = sorted({column for group in groups for column in group})
        cursor.execute(f"SELECT {', '.join(quote_identifier(name) for name in columns)} FROM {quote_identifier(table)}")
        known = state.unique_keys.setdefault(table, set())
        for row in cursor.fetchall():
            values = dict(zip(columns, row))
            for group in groups:
                key = unique_key(values, group)
                if key is not None:
                    known.add(key)


def insert_canonical(
    cursor: Any,
    table: str,
    values: dict[str, Any],
    conflict_target: str,
) -> tuple[Any | None, str | None]:
    """Insert one row inside a savepoint.

    Returns `(id, None)` when the row was inserted, `(None, None)` when the conflict target
    already existed and `(None, detail)` when the database refused the row (CHECK, unique
    index, foreign key). A refused row only loses itself: the savepoint is rolled back, so
    the surrounding transaction stays usable and the caller can report the reason.
    """
    columns = sorted(values)
    for column in columns:
        quote_identifier(column)
    placeholders = ", ".join(["%s"] * len(columns))
    sql = (
        f"INSERT INTO {quote_identifier(table)} ({', '.join(columns)}) VALUES ({placeholders}) "
        f"ON CONFLICT {conflict_target} DO NOTHING RETURNING id"
    )
    cursor.execute("SAVEPOINT load_row")
    try:
        cursor.execute(sql, [values[column] for column in columns])
        row = cursor.fetchone()
    except Exception as error:  # psycopg.Error raised by the database for this row
        detail = str(error).strip().splitlines()[0] if str(error).strip() else error.__class__.__name__
        try:
            cursor.execute("ROLLBACK TO SAVEPOINT load_row")
        except Exception as rollback_error:
            raise LoadAborted(
                f"{table}: savepoint nao pode ser revertido ({rollback_error}); "
                "a conexao com o banco foi perdida"
            ) from error
        return None, detail or error.__class__.__name__
    cursor.execute("RELEASE SAVEPOINT load_row")
    return (None if row is None else str(row[0])), None


def enrich_reused_row(
    cursor: Any,
    table: str,
    identifier: str,
    values: dict[str, Any],
) -> bool:
    """Fill the mapped columns that are still NULL in an already stored row.

    A rerun reuses the row by its legacy key and, without this step, a column added by a later
    migration would stay empty forever. `COALESCE` guarantees the stored value always wins, so the
    statement is idempotent and can never rewrite canonical data; it is a commit-only write.
    """
    columns = sorted(column for column in values if column != "id")
    if not columns:
        return False
    for column in columns:
        quote_identifier(column)
    assignments = ", ".join(f"{column} = COALESCE({column}, %s)" for column in columns)
    empty = " OR ".join(f"{column} IS NULL" for column in columns)
    cursor.execute(
        f"UPDATE {quote_identifier(table)} SET {assignments} "
        f"WHERE id = %s AND ({empty})",
        [values[column] for column in columns] + [identifier],
    )
    return (cursor.rowcount or 0) > 0


def reject_row(
    state: LoadState,
    table: str,
    sheet: str,
    row_number: int,
    code: str,
    field_name: str,
    detail: str,
) -> bool:
    """Count and report a row the loader cannot store. Always returns False (nothing stored)."""
    state.stats(table).count_skip(code)
    state.finding(sheet, code, field_name, detail, row_number)
    return False


def store_row(
    cursor: Any,
    sheet: str,
    row_number: int,
    table: str,
    outcome: RowOutcome,
    target: TablePlan,
    schema: dict[str, dict[str, dict[str, Any]]],
    legacy_source: str,
    state: LoadState,
) -> bool:
    """Insert (or reuse) one canonical row and keep the id maps in sync.

    Returns True when the row ended up stored (inserted now or reused from an earlier run)
    and False when it was refused by a UNIQUE constraint or by the database.
    """
    stats = state.stats(table)
    if uses_provenance(table, schema, target.provider):
        legacy_id = outcome.legacy_id
        if not legacy_id:
            stats.count_skip("LOAD_LEGACY_ID_MISSING")
            return False
        existing = state.provenance_keys.setdefault(table, {}).get((sheet, legacy_id))
        if existing is not None:
            stats.reused += 1
            state.legacy_maps.setdefault(table, {})[legacy_id] = existing
            state.row_ids[table] = existing
            stats.ids.append(str(existing))
            if state.enrich and state.commit and enrich_reused_row(
                cursor, table, str(existing), outcome.values
            ):
                stats.enriched += 1
            return True
        identifier = str(uuid.uuid4())
        values = {
            "id": identifier,
            "legacy_source": legacy_source,
            "legacy_table": sheet,
            "legacy_id": legacy_id,
            **outcome.values,
        }
        duplicate = unique_conflict(state, table, values)
        if duplicate is not None:
            return reject_row(
                state,
                table,
                sheet,
                row_number,
                "LOAD_DUPLICATE_ROW",
                "+".join(duplicate),
                f"{table}: {'+'.join(duplicate)} ja existe no canonico "
                f"(linha legada {sheet}.{legacy_id})",
            )
        if state.commit:
            inserted, refused = insert_canonical(
                cursor, table, values, "(legacy_source, legacy_table, legacy_id)"
            )
            if refused:
                return reject_row(
                    state,
                    table,
                    sheet,
                    row_number,
                    "LOAD_ROW_REJECTED",
                    table,
                    f"{table}: banco recusou a linha ({refused})",
                )
            if inserted is None:
                cursor.execute(
                    f"""
                    SELECT id FROM {quote_identifier(table)}
                     WHERE legacy_source = %s AND legacy_table = %s AND legacy_id = %s
                    """,
                    (legacy_source, sheet, legacy_id),
                )
                row = cursor.fetchone()
                if row is None:
                    raise LoadAborted(f"{table}: linha sumiu apos conflito na chave legada {legacy_id}")
                identifier = str(row[0])
                stats.reused += 1
            else:
                identifier = inserted
                stats.inserted += 1
        else:
            stats.inserted += 1
        remember_unique_keys(state, table, {**values, "id": identifier})
        state.provenance_keys.setdefault(table, {})[(sheet, legacy_id)] = identifier
        state.legacy_maps.setdefault(table, {})[legacy_id] = identifier
        state.row_ids[table] = identifier
        stats.ids.append(str(identifier))
        return True

    identifier = str(row_uuid(sheet, row_number))
    known = state.existing_ids.setdefault(table, set())
    if identifier in known:
        stats.reused += 1
        state.row_ids[table] = identifier
        stats.ids.append(identifier)
        if state.enrich and state.commit and enrich_reused_row(cursor, table, identifier, outcome.values):
            stats.enriched += 1
        return True
    values = {"id": identifier, **outcome.values}
    duplicate = unique_conflict(state, table, values)
    if duplicate is not None:
        return reject_row(
            state,
            table,
            sheet,
            row_number,
            "LOAD_DUPLICATE_ROW",
            "+".join(duplicate),
            f"{table}: {'+'.join(duplicate)} ja existe no canonico (linha {sheet}.{row_number})",
        )
    if state.commit:
        inserted, refused = insert_canonical(cursor, table, values, "(id)")
        if refused:
            return reject_row(
                state,
                table,
                sheet,
                row_number,
                "LOAD_ROW_REJECTED",
                table,
                f"{table}: banco recusou a linha ({refused})",
            )
        if inserted is None:
            stats.reused += 1
        else:
            identifier = inserted
            stats.inserted += 1
    else:
        stats.inserted += 1
    remember_unique_keys(state, table, {**values, "id": identifier})
    known.add(identifier)
    state.row_ids[table] = identifier
    stats.ids.append(identifier)
    return True


def resolve_defaults(
    schema: dict[str, dict[str, dict[str, Any]]], plan: dict[str, TablePlan]
) -> dict[str, dict[str, Any]]:
    """Canonical literal defaults usable as an explicit fallback, per table/column."""
    defaults: dict[str, dict[str, Any]] = {}
    for table in plan:
        entry: dict[str, Any] = {}
        for column, info in schema.get(table, {}).items():
            if not info.get("default"):
                continue
            value = python_literal_default(str(info["default"]))
            if value is not None:
                entry[column] = value
        if entry:
            defaults[table] = entry
    return defaults


def staged_rows(cursor: Any, batch_id: str, sheet: str) -> int:
    cursor.execute(
        "SELECT count(*) FROM migration_rows WHERE batch_id = %s AND source_sheet = %s",
        (batch_id, sheet),
    )
    row = cursor.fetchone()
    return int(row[0]) if row else 0


def find_batch(cursor: Any, dictionary: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    if args.batch_id:
        cursor.execute(
            "SELECT id, source_name, status, row_count FROM migration_batches WHERE id = %s::uuid",
            (args.batch_id,),
        )
    else:
        cursor.execute(
            """
            SELECT id, source_name, status, row_count FROM migration_batches
             WHERE source_name = %s AND row_count > 0
             ORDER BY created_at DESC
             LIMIT 1
            """,
            (dictionary.get("source_name", "VOA.xlsx"),),
        )
    row = cursor.fetchone()
    if row is None:
        raise StagingError("no staged batch found for this source; run the stager first")
    return {"id": str(row[0]), "source_name": row[1], "status": row[2], "row_count": int(row[3])}


class AggregateAccumulator:
    """Derive, from the staged rows of one sheet, the aggregate columns of another sheet."""

    def __init__(
        self,
        specs: dict[str, AggregateSpec],
        unique_rules: dict[str, list[ColumnRule]],
    ) -> None:
        self.specs = specs
        self.unique_rules = unique_rules
        self.rows = 0
        self.used = 0
        self.duplicates = 0
        self.seen: dict[str, set[tuple[str, ...]]] = {target: set() for target in specs}
        self.totals: dict[str, dict[str, Any]] = {target: {} for target in specs}
        self._measure_rules: dict[str, ColumnRule] = {
            target: ColumnRule(
                source_column=spec.measure or spec.group_by,
                table=spec.table,
                column=spec.column,
                field_type="numeric",
                normalization=spec.normalization,
                required=True,
                priority=10,
                status=spec.status,
                ref=None,
                values=None,
                provides_legacy_id_for=None,
                gap=None,
                note=spec.note,
            )
            for target, spec in specs.items()
        }

    def add(self, payload: dict[str, Any]) -> None:
        """Fold one staged row of the source sheet into every declared aggregate."""
        self.rows += 1
        used = False
        duplicated = False
        for target, spec in self.specs.items():
            group = payload.get(spec.group_by)
            if is_blank(group):
                continue
            key = str(group).strip()
            parts = self.unique_parts(target, payload) if spec.unique_by else None
            if spec.unique_by and parts is None:
                continue
            # A chave unica so e reivindicada por uma linha utilizavel, exatamente como o
            # loader faz: uma linha descartada por valor invalido nao bloqueia a duplicata
            # valida que vem depois.
            identity = (key, *parts) if parts is not None else None
            value: Any = None
            if spec.measure:
                value, finding = convert_value(payload.get(spec.measure), self._measure_rules[target])
                if finding or is_blank(value):
                    continue
            if identity is not None:
                if identity in self.seen[target]:
                    duplicated = True
                    continue
                self.seen[target].add(identity)
            if spec.op == "sum":
                self.totals[target][key] = self.totals[target].get(key, Decimal("0")) + value
            else:
                self.totals[target][key] = self.totals[target].get(key, 0) + 1
            used = True
        if used:
            self.used += 1
        elif duplicated:
            self.duplicates += 1

    def unique_parts(self, target: str, payload: dict[str, Any]) -> tuple[str, ...] | None:
        """Key of the child UNIQUE constraint, converted exactly as the child table does."""
        parts: list[str] = []
        for rule in self.unique_rules.get(target, []):
            value, finding = convert_value(payload.get(rule.source_column), rule)
            if finding or is_blank(value):
                return None
            parts.append(str(value))
        return tuple(parts)

    def results(self) -> dict[str, dict[str, Any]]:
        return {target: dict(values) for target, values in self.totals.items()}

    def summary(self) -> dict[str, Any]:
        return {
            "rows": self.rows,
            "rows_used": self.used,
            "duplicates_skipped": self.duplicates,
            "groups": {target: len(values) for target, values in self.totals.items()},
        }


def compute_aggregates(
    cursor: Any,
    plan: dict[str, TablePlan],
    state: LoadState,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Compute every derived column from the staged rows of its declared source sheet."""
    specs: dict[str, dict[str, AggregateSpec]] = {}
    for target in plan.values():
        if target.status != "ready":
            continue
        for spec in target.aggregates.values():
            specs.setdefault(spec.source_sheet, {})[spec.target] = spec

    values: dict[str, dict[str, Any]] = {}
    report: dict[str, Any] = {}
    for sheet in sorted(specs):
        unique_rules: dict[str, list[ColumnRule]] = {}
        for target, spec in specs[sheet].items():
            rules: list[ColumnRule] = []
            for source_column, canonical in spec.unique_by:
                unique_table, _, canonical_column = canonical.partition(".")
                row_target = plan.get(unique_table or spec.row_table)
                available = row_target.rules.get(canonical_column) if row_target else None
                if not available:
                    raise LoadAborted(
                        f"{spec.target}: sem regra de {canonical} "
                        f"para deduplicar {source_column}"
                    )
                rules.append(replace(available[0], source_column=source_column))
            unique_rules[target] = rules
        accumulator = AggregateAccumulator(specs[sheet], unique_rules)
        last_row = 0
        while True:
            cursor.execute(
                """
                SELECT source_row_number, payload
                  FROM migration_rows
                 WHERE batch_id = %s AND source_sheet = %s AND source_row_number > %s
                 ORDER BY source_row_number
                 LIMIT %s
                """,
                (state.batch_id, sheet, last_row, DEFAULT_BATCH_PAGE),
            )
            page = cursor.fetchall()
            if not page:
                break
            for row_number, payload in page:
                last_row = int(row_number)
                accumulator.add(payload or {})
        values.update(accumulator.results())
        report[sheet] = {"targets": sorted(specs[sheet]), **accumulator.summary()}
    return values, report


def process_sheet(
    cursor: Any,
    staging_cursor: Any,
    sheet: str,
    entry: dict[str, Any],
    plan: dict[str, TablePlan],
    schema: dict[str, dict[str, dict[str, Any]]],
    defaults: dict[str, dict[str, Any]],
    aggregates: dict[str, dict[str, Any]],
    state: LoadState,
    args: argparse.Namespace,
) -> dict[str, Any]:
    """Load every ready table of one sheet, one staged row at a time."""
    tables = [table for table in entry["tables"] if plan[table].status == "ready"]
    primary = entry.get("primary")
    if primary not in tables:
        primary = tables[0] if tables else None
    counters: dict[str, Any] = {
        "sheet": sheet,
        "tables": tables,
        "primary": primary,
        "rows": 0,
        "rows_loaded": 0,
        "rows_skipped": 0,
        "rows_status_skipped": 0,
    }
    if not tables:
        return counters

    page = DEFAULT_BATCH_PAGE
    last_row = 0
    while True:
        limit = page
        if args.max_rows_per_sheet:
            remaining = args.max_rows_per_sheet - counters["rows"]
            if remaining <= 0:
                break
            limit = min(page, remaining)
        staging_cursor.execute(
            """
            SELECT id, source_row_number, payload, status
              FROM migration_rows
             WHERE batch_id = %s AND source_sheet = %s AND source_row_number > %s
             ORDER BY source_row_number
             LIMIT %s
            """,
            (state.batch_id, sheet, last_row, limit),
        )
        batch = staging_cursor.fetchall()
        if not batch:
            break
        for row_id, row_number, payload, row_status in batch:
            last_row = int(row_number)
            counters["rows"] += 1
            if row_status == "error" and args.exclude_error_rows:
                counters["rows_status_skipped"] += 1
                state.finding(
                    sheet,
                    "LOAD_ROW_STATUS_ERROR",
                    "-",
                    "linha marcada como error pelo validador; ignorada por --exclude-error-rows",
                    last_row,
                )
                continue
            state.row_ids = {}
            outcomes = build_row_values(sheet, tables, plan, payload or {}, state.legacy_maps, defaults)
            primary_loaded = False
            for table in tables:
                target = plan[table]
                outcome = outcomes[table]
                stats = state.stats(table)
                stats.rows_considered += 1
                for code, field_name, detail in outcome.findings:
                    state.finding(sheet, code, field_name, detail, last_row)
                link_failure = None
                for column, row_table in target.links.items():
                    value = state.row_ids.get(row_table)
                    if value is None:
                        link_failure = f"{table}.{column} -> {row_table}"
                        break
                    outcome.values[column] = value
                if link_failure:
                    stats.count_skip("LOAD_ROW_LINK_UNRESOLVED")
                    state.finding(
                        sheet,
                        "LOAD_ROW_LINK_UNRESOLVED",
                        link_failure,
                        f"{table}: vinculo da propria linha nao resolvido",
                        last_row,
                    )
                    continue
                aggregate_failure = None
                aggregate_detail = ""
                for column, spec in target.aggregates.items():
                    by_group = aggregates.get(spec.target)
                    key = outcome.legacy_id
                    value = by_group.get(key) if by_group and key else None
                    if value is None:
                        aggregate_failure = f"{table}.{column} <- {spec.source_sheet}"
                        aggregate_detail = (
                            f"{table}: sem agregado de {spec.source_sheet} "
                            f"({spec.op} de {spec.measure or 'linhas'}) para o id legado {key or 'ausente'}"
                        )
                        break
                    outcome.values[column] = value
                if aggregate_failure:
                    stats.count_skip("LOAD_AGGREGATE_MISSING")
                    state.finding(
                        sheet,
                        "LOAD_AGGREGATE_MISSING",
                        aggregate_failure,
                        aggregate_detail,
                        last_row,
                    )
                    continue
                if outcome.skipped:
                    stats.count_skip(outcome.skipped)
                    state.finding(
                        sheet,
                        outcome.skipped,
                        outcome.skip_field or "-",
                        f"{table}: {outcome.skip_detail or 'linha nao carregada'}",
                        last_row,
                    )
                    continue
                stored = store_row(cursor, sheet, last_row, table, outcome, target, schema, state.legacy_source, state)
                if stored:
                    # Totais somados apenas para linhas que realmente entraram (novas ou
                    # reutilizadas): a reconciliacao precisa fechar com o canonico, nao com o
                    # staging inteiro.
                    for column in target.numeric_columns:
                        value = outcome.values.get(column)
                        if isinstance(value, Decimal):
                            stats.numeric_totals[column] = stats.numeric_totals.get(column, Decimal("0")) + value
                if table == primary and outcome.skipped is None and stored:
                    primary_loaded = True
            if primary is None:
                continue
            if primary_loaded:
                counters["rows_loaded"] += 1
                state.committed_row_ids.append(str(row_id))
            else:
                counters["rows_skipped"] += 1
    return counters


def persist_findings(cursor: Any, state: LoadState) -> int:
    """Replace this loader's findings for the batch, keeping validator findings intact."""
    cursor.execute(
        "DELETE FROM migration_errors WHERE batch_id = %s::uuid AND error_code = ANY(%s)",
        (state.batch_id, list(LOADER_ERROR_CODES)),
    )
    inserted = 0
    for (sheet, code, field_name), entry in sorted(state.findings.items()):
        severity = "warning" if code in {"LOAD_VALUE_DEFAULTED", "LOAD_REFERENCE_MULTIVALUE"} else "error"
        if entry["count"]:
            cursor.execute(
                """
                INSERT INTO migration_errors (
                  batch_id, error_code, severity, field_name, message, details
                ) VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    state.batch_id,
                    code,
                    severity,
                    None if field_name == "-" else field_name,
                    f"{sheet}: {entry['message']} ({entry['count']} linha(s))",
                    Jsonb({"sheet": sheet, "count": entry["count"], "samples": entry["samples"]}),
                ),
            )
            inserted += 1
    return inserted


def persist_row_status(cursor: Any, state: LoadState) -> int:
    updated = 0
    for chunk in chunked(state.committed_row_ids, 1000):
        cursor.execute(
            "UPDATE migration_rows SET status = 'committed' WHERE id = ANY(%s::uuid[]) AND status <> 'committed'",
            (chunk,),
        )
        updated += cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
    return updated


def canonical_numeric_total(cursor: Any, table: str, columns: list[str], ids: list[str]) -> Decimal | None:
    if not columns or not ids:
        return None
    expression = " + ".join(f"coalesce({quote_identifier(column)}, 0)" for column in columns)
    total: Decimal | None = None
    for chunk in chunked(ids, 5000):
        cursor.execute(
            f"SELECT coalesce(sum({expression}), 0) FROM {quote_identifier(table)} WHERE id = ANY(%s::uuid[])",
            (chunk,),
        )
        partial = cursor.fetchone()[0]
        total = (total or Decimal("0")) + Decimal(partial or 0)
    return total


def persist_reconciliation(
    cursor: Any,
    state: LoadState,
    plan: dict[str, TablePlan],
    sheet_plan: dict[str, dict[str, Any]],
    counts_after: dict[str, int],
    allow_proposed: set[str],
    batch: dict[str, Any],
) -> None:
    for table, target in sorted(plan.items()):
        stats = state.tables.get(table)
        if stats is None:
            continue
        money_columns = target.money_columns
        source_total = (
            sum(
                (value for column, value in stats.numeric_totals.items() if column in money_columns),
                Decimal("0"),
            )
            if stats.numeric_totals
            else None
        )
        canonical_total = (
            canonical_numeric_total(cursor, table, money_columns, stats.ids) if state.commit else source_total
        )
        approved = "aprovado explicitamente" if table in allow_proposed else "confirmado no dicionario"
        sheets = sorted(sheet for sheet, entry in sheet_plan.items() if table in entry.get("tables", []))
        notes = (
            f"carga canonica ({approved}); fonte={state.legacy_source}; arquivo={batch['source_name']}; "
            f"abas={', '.join(sheets)}; linhas legadas={stats.rows_considered}; "
            f"carregadas={stats.loaded} (novas={stats.inserted}, reusadas={stats.reused}); "
            f"descartadas={stats.skipped}{skip_detail(stats)}; total na tabela={counts_after.get(table, 'n/a')}"
        )
        cursor.execute(
            """
            INSERT INTO reconciliation_reports (
              batch_id, entity_name, source_count, staged_count, canonical_count,
              source_total, canonical_total, duplicate_candidates, blocking_errors, notes
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (batch_id, entity_name) DO UPDATE SET
              source_count = EXCLUDED.source_count,
              staged_count = EXCLUDED.staged_count,
              canonical_count = EXCLUDED.canonical_count,
              source_total = EXCLUDED.source_total,
              canonical_total = EXCLUDED.canonical_total,
              duplicate_candidates = EXCLUDED.duplicate_candidates,
              blocking_errors = EXCLUDED.blocking_errors,
              notes = EXCLUDED.notes
            """,
            (
                state.batch_id,
                table,
                stats.rows_considered,
                stats.loaded,
                counts_after.get(table, stats.loaded),
                source_total,
                canonical_total,
                stats.reused,
                stats.skipped,
                notes,
            ),
        )


def skip_detail(stats: TableStats) -> str:
    if not stats.skip_reasons:
        return ""
    rendered = ", ".join(f"{code}={count}" for code, count in sorted(stats.skip_reasons.items()))
    return f" [{rendered}]"


def persist_batch_status(cursor: Any, state: LoadState, status: str | None) -> None:
    if not status:
        return
    cursor.execute(
        """
        UPDATE migration_batches
           SET status = %s, completed_at = now(), updated_at = now()
         WHERE id = %s::uuid
        """,
        (status, state.batch_id),
    )


def sheet_order(
    sheet_plan: dict[str, dict[str, Any]], plan: dict[str, TablePlan]
) -> list[str]:
    """Order the sheets so a provider of a referenced table always loads before its consumers.

    The primary-table order (`LOAD_ORDER`) decides the daily sequence, but a sheet that consumes a
    table has to wait for **every** sheet that produces it. `TBL_PAGAMENTO` also creates `customers`
    (rows the other sheets do not cover), so the sheet that loads `contacts` must run after it;
    otherwise the reference cannot resolve in a database that is still empty, and the row is
    discarded as `LOAD_REFERENCE_UNRESOLVED` while a rerun against a populated canonical resolves it.
    """

    def sort_key(sheet: str) -> tuple[int, str]:
        primary = sheet_plan[sheet].get("primary")
        return (entity_order(primary) if primary else len(LOAD_ORDER), sheet)

    providers: dict[str, list[str]] = {}
    for sheet, entry in sheet_plan.items():
        for table in entry.get("tables", []):
            providers.setdefault(table, []).append(sheet)

    pending: dict[str, set[str]] = {}
    for sheet, entry in sheet_plan.items():
        waiting: set[str] = set()
        for table in entry.get("tables", []):
            target = plan.get(table)
            if target is None:
                continue
            for dependency in target.dependencies:
                waiting.update(
                    producer for producer in providers.get(dependency, []) if producer != sheet
                )
        pending[sheet] = waiting

    order: list[str] = []
    while pending:
        ready = sorted((sheet for sheet, waiting in pending.items() if not waiting), key=sort_key)
        if not ready:
            # dependency cycle: keep the primary-table order instead of stalling the load
            order.extend(sorted(pending, key=sort_key))
            break
        for sheet in ready:
            order.append(sheet)
            del pending[sheet]
            for waiting in pending.values():
                waiting.discard(sheet)
    return order


def run_load(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    dictionary = load_dictionary(args.map_path)
    schema = parse_canonical_columns(args.migrations)
    unique_groups = parse_unique_groups(args.migrations)
    requested = set(args.entities) if args.entities else None
    allow_proposed = set(args.allow_proposed or [])
    plan_data = build_plan(dictionary, schema, requested, allow_proposed)
    problems = plan_data["problems"]
    if problems:
        rendered = "; ".join(
            f"{item['code']} [{item.get('sheet') or item.get('target') or item.get('tables')}]"
            for item in problems[:6]
        )
        raise LoadAborted(f"invalid load plan: {rendered}")
    plan: dict[str, TablePlan] = plan_data["tables"]
    sheet_plan: dict[str, dict[str, Any]] = plan_data["sheets"]
    ready = [table for table in plan_data["order"] if plan[table].status == "ready"]
    blocked = [table for table in plan_data["order"] if plan[table].status == "blocked"]
    defaults = resolve_defaults(schema, plan)

    legacy_source = args.legacy_source or DEFAULT_LEGACY_SOURCE
    result: dict[str, Any] = {
        "mode": "commit" if args.commit else "dry-run",
        "legacy_source": legacy_source,
        "models": {"planned": list(plan_data["order"]), "ready": ready, "blocked": blocked},
        "plan": {
            table: {
                "status": target.status,
                "blocked_reason": target.blocked_reason,
                "detail": target.detail,
                "dependencies": target.dependencies,
                "missing_required": target.missing_required,
                "proposed_columns": target.proposed_columns,
                "links": target.links,
                "columns": target.columns,
                "aggregates": {
                    column: {
                        "target": spec.target,
                        "source_sheet": spec.source_sheet,
                        "row_table": spec.row_table,
                        "group_by": spec.group_by,
                        "op": spec.op,
                        "measure": spec.measure,
                        "unique_by": list(spec.unique_by),
                        "status": spec.status,
                    }
                    for column, spec in sorted(target.aggregates.items())
                },
            }
            for table, target in sorted(plan.items())
        },
        "sheets": [],
        "tables": {},
        "findings": [],
        "canonical_writes": bool(args.commit and ready),
    }

    load_env()
    staging_url, canonical_url = resolve_database_urls(getattr(args, "staging_url", None))
    split_databases = staging_url != canonical_url
    connection = connect(canonical_url)
    try:
        staging_connection = connect(staging_url) if split_databases else None
    except Exception:
        connection.close()
        raise
    result["database"] = {
        "staging": describe_database_url(staging_url),
        "canonical": describe_database_url(canonical_url),
        "split": split_databases,
    }
    print(
        json.dumps(
            {
                "staging": result["database"]["staging"],
                "canonical": result["database"]["canonical"],
                "split": split_databases,
            }
        ),
        flush=True,
    )
    try:
        cursor = connection.cursor()
        staging_cursor = staging_connection.cursor() if staging_connection else cursor
        batch = find_batch(staging_cursor, dictionary, args)
        state = LoadState(
            legacy_source=legacy_source,
            batch_id=batch["id"],
            commit=args.commit,
            enrich=args.enrich_reused,
        )
        state.unique_groups = unique_groups
        counts_tables = canonical_tables_for_counts(plan)
        state.canonical_before = snapshot_canonical_counts(cursor, counts_tables)
        result["batch"] = batch
        result["canonical_before"] = state.canonical_before

        preload_existing(cursor, plan, schema, legacy_source, state)
        preload_unique_keys(cursor, plan, state)
        aggregates, aggregate_report = compute_aggregates(staging_cursor, plan, state)
        result["aggregates"] = aggregate_report
        for source_sheet, information in sorted(aggregate_report.items()):
            groups = ", ".join(f"{target}={count}" for target, count in sorted(information["groups"].items()))
            print(
                f"  derivados {source_sheet}: rows={information['rows']} "
                f"used={information['rows_used']} duplicates={information['duplicates_skipped']} ({groups})",
                flush=True,
            )

        for sheet in sheet_order(sheet_plan, plan):
            entry = sheet_plan[sheet]
            ready_tables = [table for table in entry.get("tables", []) if plan[table].status == "ready"]
            if not ready_tables:
                staged = staged_rows(staging_cursor, state.batch_id, sheet)
                result["sheets"].append(
                    {
                        "sheet": sheet,
                        "tables": entry.get("tables", []),
                        "status": entry.get("status"),
                        "rows": staged,
                        "rows_loaded": 0,
                        "rows_skipped": 0,
                    }
                )
                continue
            counters = process_sheet(
                cursor, staging_cursor, sheet, entry, plan, schema, defaults, aggregates, state, args
            )
            result["sheets"].append(counters)
            print(
                f"  {sheet}: rows={counters['rows']} loaded={counters['rows_loaded']} "
                f"skipped={counters['rows_skipped']}",
                flush=True,
            )

        counts_after = (
            snapshot_canonical_counts(cursor, counts_tables)
            if state.commit
            else dict(state.canonical_before)
        )
        result["canonical_after"] = counts_after
        result["tables"] = {
            table: {
                "rows_considered": stats.rows_considered,
                "loaded": stats.loaded,
                "inserted": stats.inserted,
                "reused": stats.reused,
                "enriched": stats.enriched,
                "skipped": stats.skipped,
                "skip_reasons": stats.skip_reasons,
                "totals": {column: str(value) for column, value in sorted(stats.numeric_totals.items())},
            }
            for table, stats in sorted(state.tables.items())
        }
        result["findings"] = [
            {
                "sheet": sheet,
                "code": code,
                "field": None if field == "-" else field,
                "count": entry["count"],
                "samples": entry["samples"],
            }
            for (sheet, code, field), entry in sorted(state.findings.items())
        ]
        result["rows_marked_committed"] = len(state.committed_row_ids)

        if state.commit:
            result["findings_persisted"] = persist_findings(staging_cursor, state)
            result["rows_updated"] = persist_row_status(staging_cursor, state)
            persist_reconciliation(
                staging_cursor, state, plan, sheet_plan, counts_after, allow_proposed, batch
            )
            persist_batch_status(staging_cursor, state, args.set_batch_status)
            connection.commit()
            if staging_connection is not None:
                # Bancos separados: o canonico commita primeiro (a carga e idempotente por
                # `legacy_id`), e so depois os achados/reconciliacao do lote vao para o staging.
                staging_connection.commit()
        else:
            connection.rollback()
            if staging_connection is not None:
                staging_connection.rollback()
    except Exception:
        connection.rollback()
        if staging_connection is not None:
            staging_connection.rollback()
        raise
    finally:
        connection.close()
        if staging_connection is not None:
            staging_connection.close()

    result["summary"] = summarize(result)
    result["exit_code"] = 4 if blocked else 0
    return result["exit_code"], result


def summarize(result: dict[str, Any]) -> dict[str, Any]:
    tables = result["tables"]
    return {
        "mode": result["mode"],
        "ready_tables": len(result["models"]["ready"]),
        "blocked_tables": len(result["models"]["blocked"]),
        "rows_considered": sum(item["rows_considered"] for item in tables.values()),
        "rows_loaded": sum(item["loaded"] for item in tables.values()),
        "rows_inserted": sum(item["inserted"] for item in tables.values()),
        "rows_reused": sum(item["reused"] for item in tables.values()),
        "rows_enriched": sum(item.get("enriched", 0) for item in tables.values()),
        "rows_skipped": sum(item["skipped"] for item in tables.values()),
        "findings": len(result["findings"]),
        "canonical_writes": result["canonical_writes"],
    }


def render_report(result: dict[str, Any]) -> str:
    """Markdown report written straight to disk as UTF-8 (never through shell redirection)."""
    summary = result["summary"]
    batch = result.get("batch", {})
    database = result.get("database", {})
    lines: list[str] = []
    lines.append("# Carga canonica do legado (fase 7)")
    lines.append("")
    lines.append("Gerado por `scripts/load_canonical_batch.py` a partir do dicionario ")
    lines.append("`scripts/legacy_field_map.json` e do lote de staging aprovado.")
    lines.append("")
    metrics = [
        "| Metrica | Valor |",
        "|---|---:|",
        f"| Modo | {result['mode']} |",
        f"| Lote | `{batch.get('id', 'n/a')}` "
        f"({batch.get('source_name', 'n/a')}, status {batch.get('status', 'n/a')}) |",
        f"| Fonte legada | `{result['legacy_source']}` |",
    ]
    if database:
        metrics.append(f"| Staging | `{database.get('staging', 'n/a')}` |")
        metrics.append(f"| Canonico | `{database.get('canonical', 'n/a')}` |")
        metrics.append(
            "| Topologia | "
            + (
                "staging em banco separado do canonico"
                if database.get("split")
                else "staging e canonico no mesmo banco"
            )
            + " |"
        )
    metrics.extend(
        [
            f"| Entidades prontas | {summary['ready_tables']} |",
            f"| Entidades bloqueadas | {summary['blocked_tables']} |",
            f"| Linhas legadas avaliadas | {summary['rows_considered']} |",
            f"| Linhas carregadas | {summary['rows_loaded']} |",
            f"| Linhas novas | {summary['rows_inserted']} |",
            f"| Linhas reutilizadas (idempotencia) | {summary['rows_reused']} |",
            f"| Linhas descartadas | {summary['rows_skipped']} |",
            f"| Achados registrados | {summary['findings']} |",
            f"| Escrita canonica nesta rodada | {'sim' if summary['canonical_writes'] else 'nao'} |",
        ]
    )
    lines.append("\n".join(metrics))
    lines.append("")

    lines.append("## Plano por entidade canonica")
    lines.append("")
    lines.append("| Tabela | Situacao | Motivo | Dependencias | Colunas mapeadas | Obrigatorias sem cobertura |")
    lines.append("|---|---|---|---|---:|---|")
    for table, entry in sorted(result["plan"].items()):
        missing = ", ".join(entry["missing_required"]) or "nenhuma"
        detail = f" ({entry['detail']})" if entry.get("detail") else ""
        lines.append(
            f"| `{table}` | {entry['status']} | {entry['blocked_reason'] or ''}{detail} | "
            f"{', '.join(entry['dependencies']) or '-'} | {len(entry['columns'])} | {missing} |"
        )
    lines.append("")

    derived = [
        (table, column, spec)
        for table, entry in sorted(result["plan"].items())
        for column, spec in sorted(entry.get("aggregates", {}).items())
    ]
    if derived:
        lines.append("## Colunas derivadas (agregados)")
        lines.append("")
        lines.append("| Tabela | Coluna | Origem | Agrupamento | Operacao | Medida | Chave unica | Status |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for table, column, spec in derived:
            unique = ", ".join(
                f"{source}={canonical}" for source, canonical in spec["unique_by"]
            ) or "-"
            lines.append(
                f"| `{table}` | `{column}` | {spec['source_sheet']} | {spec['group_by']} | "
                f"{spec['op']} | {spec['measure'] or '-'} | {unique} | {spec['status']} |"
            )
        lines.append("")
        aggregate_report = result.get("aggregates") or {}
        if aggregate_report:
            lines.append("| Aba de origem | Linhas lidas | Linhas usadas | Duplicadas ignoradas | Grupos |")
            lines.append("|---|---:|---:|---:|---|")
            for source, information in sorted(aggregate_report.items()):
                groups = ", ".join(
                    f"`{target}`={count}" for target, count in sorted(information["groups"].items())
                )
                lines.append(
                    f"| {source} | {information['rows']} | {information['rows_used']} | "
                    f"{information['duplicates_skipped']} | {groups or '-'} |"
                )
            lines.append("")

    lines.append("## Abas processadas")
    lines.append("")
    lines.append("| Aba | Situacao | Tabelas | Linhas legadas | Carregadas | Descartadas | Ignoradas por status |")
    lines.append("|---|---|---|---:|---:|---:|---:|")
    for sheet in result["sheets"]:
        tables = ", ".join(sheet.get("tables") or []) or "-"
        situation = sheet.get("status") or "carregada"
        lines.append(
            f"| {sheet['sheet']} | {situation} | {tables} | {sheet['rows']} | "
            f"{sheet['rows_loaded']} | {sheet['rows_skipped']} | {sheet.get('rows_status_skipped', 0)} |"
        )
    lines.append("")

    lines.append("## Resultado por tabela")
    lines.append("")
    lines.append("| Tabela | Legadas | Carregadas | Novas | Reusadas | Atualizadas | Descartadas | Motivos de descarte |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---|")
    for table, entry in sorted(result["tables"].items()):
        reasons = ", ".join(f"{code}={count}" for code, count in sorted(entry["skip_reasons"].items()))
        lines.append(
            f"| `{table}` | {entry['rows_considered']} | {entry['loaded']} | {entry['inserted']} | "
            f"{entry['reused']} | {entry.get('enriched', 0)} | {entry['skipped']} | {reasons or '-'} |"
        )
    lines.append("")
    if any(entry["totals"] for entry in result["tables"].values()):
        lines.append("## Totais monetarios por tabela")
        lines.append("")
        lines.append("| Tabela | Coluna | Total no staging |")
        lines.append("|---|---|---:|")
        for table, entry in sorted(result["tables"].items()):
            for column, value in sorted(entry["totals"].items()):
                lines.append(f"| `{table}` | `{column}` | {value} |")
        lines.append("")

    lines.append("## Achados")
    lines.append("")
    if not result["findings"]:
        lines.append("Nenhum achado: todas as linhas elegiveis foram carregadas.")
    else:
        lines.append("| Aba | Codigo | Campo | Linhas | Exemplos |")
        lines.append("|---|---|---|---:|---|")
        for finding in result["findings"]:
            samples = "; ".join(f"linha {item['row']}: {item['detail']}" for item in finding["samples"][:3])
            lines.append(
                f"| {finding['sheet']} | `{finding['code']}` | {finding['field'] or '-'} | "
                f"{finding['count']} | {samples.replace('|', '/')} |"
            )
    lines.append("")

    before = result.get("canonical_before", {})
    after = result.get("canonical_after", {})
    lines.append("## Contagens canonicas")
    lines.append("")
    lines.append("| Tabela | Antes | Depois |")
    lines.append("|---|---:|---:|")
    for table in sorted(set(before) | set(after)):
        lines.append(f"| `{table}` | {before.get(table, 'n/a')} | {after.get(table, 'n/a')} |")
    lines.append("")

    lines.append("## Bloqueios e proximos passos")
    lines.append("")
    blocked = [table for table, entry in result["plan"].items() if entry["status"] == "blocked"]
    not_requested = [table for table, entry in result["plan"].items() if entry["status"] == "not_requested"]
    if not blocked:
        lines.append("- Nenhuma entidade solicitada ficou bloqueada nesta rodada.")
    for table in blocked:
        entry = result["plan"][table]
        detail = f" ({entry['detail']})" if entry.get("detail") else ""
        lines.append(f"- `{table}`: {entry['blocked_reason']}{detail}")
    if not_requested:
        lines.append(f"- Fora do escopo desta rodada: {', '.join(f'`{table}`' for table in not_requested)}.")
    lines.append("")
    return "\n".join(lines)


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--map", dest="map_path", type=Path, default=DEFAULT_DICTIONARY)
    parser.add_argument("--migrations", type=Path, default=DEFAULT_MIGRATIONS)
    parser.add_argument("--report", dest="report_path", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--json-out", dest="json_out", type=Path, default=None)
    parser.add_argument("--no-report", action="store_true", help="do not write the markdown report")
    parser.add_argument("--batch-id", default=None, help="load a specific migration_batches row")
    parser.add_argument(
        "--staging-url",
        default=None,
        help=(
            "database that holds migration_rows/migration_batches (default: STAGING_DATABASE_URL, "
            "then DIRECT_DATABASE_URL/DATABASE_URL); the canonical rows always go to "
            "DIRECT_DATABASE_URL/DATABASE_URL"
        ),
    )
    parser.add_argument("--entities", default=None, help="comma-separated canonical tables to load")
    parser.add_argument(
        "--allow-proposed",
        dest="allow_proposed",
        default=None,
        help="comma-separated tables whose `status: proposed` mapping the operator approves now",
    )
    parser.add_argument(
        "--exclude-error-rows",
        action="store_true",
        help="skip rows the staging validator marked as error (default: decide from the mapping)",
    )
    parser.add_argument("--max-rows-per-sheet", type=int, default=None)
    parser.add_argument("--commit", action="store_true", help="write canonical rows (default is a dry run)")
    parser.add_argument(
        "--enrich-reused",
        dest="enrich_reused",
        action="store_true",
        help=(
            "with --commit, also fill the mapped columns that are still NULL in rows reused by "
            "their legacy key (never overwrites a stored value)"
        ),
    )
    parser.add_argument("--dry-run", action="store_true", help="explicit no-op flag, for clarity in logs")
    parser.add_argument("--legacy-source", default=None, help="value stored in legacy_source")
    parser.add_argument(
        "--set-batch-status",
        choices=("validated", "approved", "committed"),
        default=None,
        help="change migration_batches.status at the end of a committed run",
    )
    args = parser.parse_args(argv)
    args.entities = split_list(args.entities)
    args.allow_proposed = split_list(args.allow_proposed) or []
    return args


def split_list(raw: str | None) -> list[str] | None:
    if not raw:
        return None
    items = [item.strip() for item in raw.split(",") if item.strip()]
    return items or None


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    if args.set_batch_status and not args.commit:
        print(json.dumps({"ok": False, "error": "--set-batch-status requires --commit"}))
        return 1
    if args.max_rows_per_sheet is not None and args.max_rows_per_sheet <= 0:
        print(json.dumps({"ok": False, "error": "--max-rows-per-sheet must be positive"}))
        return 1
    if args.enrich_reused and not args.commit:
        print(json.dumps({"ok": False, "error": "--enrich-reused requires --commit"}))
        return 1

    try:
        exit_code, result = run_load(args)
    except StagingError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 3
    except LoadAborted as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1

    if not args.no_report:
        written = write_text_file(args.report_path, render_report(result))
        print(f"report: {written}")
    if args.json_out:
        written = write_text_file(args.json_out, json.dumps(result, ensure_ascii=False, indent=2, default=str))
        print(f"json: {written}")

    summary = result["summary"]
    print(f"mode: {summary['mode']}")
    print(f"ready tables: {', '.join(result['models']['ready']) or '-'}")
    print(
        "rows: considered={rows_considered} loaded={rows_loaded} inserted={rows_inserted} "
        "reused={rows_reused} enriched={rows_enriched} skipped={rows_skipped}".format(**summary)
    )
    print(f"findings: {summary['findings']}")
    for table in result["models"]["blocked"]:
        entry = result["plan"][table]
        detail = f" ({entry['detail']})" if entry.get("detail") else ""
        print(f"  blocked {table}: {entry['blocked_reason']}{detail}")
    print(f"exit: {exit_code}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

