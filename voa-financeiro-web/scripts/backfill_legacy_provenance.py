"""Carimba `legacy_source`/`legacy_table`/`legacy_id` nas linhas canonicas ja carregadas.

A migration 0009 criou essas colunas em `contacts` e `installments`, mas as linhas gravadas antes
delas ficaram com `legacy_id` nulo: a carga as endereca pelo UUID deterministico que gera a partir
de `<aba>:<linha do staging>`. Este script percorre o lote de staging, recalcula o mesmo UUID e
grava a chave legada, que e o que permite reusar a linha em reprocessamentos
(`ON CONFLICT (legacy_source, legacy_table, legacy_id)`) e reconciliar linha a linha com o
PowerApps.

Ordem de execucao (ver docs/FIELD_MAPPING_TRIAGE.md):

    npm run db:migrate                                   # 0009 cria as colunas
    python scripts/backfill_legacy_provenance.py         # dry-run, mostra o que faria
    python scripts/backfill_legacy_provenance.py --commit

O script e idempotente: so toca linhas com `legacy_id` nulo e reporta (sem alterar) as linhas que
ja tem uma chave legada diferente da esperada. Linhas que a carga pulou (duplicidade, referencia
nao resolvida) simplesmente nao existem no canonico e aparecem como `missing`.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_field_dictionary import DEFAULT_DICTIONARY, DEFAULT_MIGRATIONS, load_dictionary  # noqa: E402
from load_canonical_batch import (  # noqa: E402
    DEFAULT_BATCH_PAGE,
    DEFAULT_LEGACY_SOURCE,
    PROVENANCE_COLUMNS,
    ColumnRule,
    StagingError,
    column_rule,
    convert_value,
    find_batch,
    is_blank,
    parse_canonical_columns,
    resolve_database_urls,
    row_uuid,
)
from stage_legacy_workbook import (  # noqa: E402
    configure_stdio,
    connect,
    describe_database_url,
    load_env,
    write_text_file,
)

DEFAULT_TABLES = ("contacts", "installments")


@dataclass(frozen=True)
class Target:
    """One canonical table whose rows must be stamped with the legacy key of a single sheet."""

    table: str
    sheet: str
    rule: ColumnRule


@dataclass(frozen=True)
class BackfillPlan:
    """What a table needs: rows to stamp, rows already stamped and rows the loader never wrote."""

    stamp: tuple[tuple[str, str], ...]
    already: int
    missing: int
    conflicts: tuple[tuple[str, str, str], ...]


def backfill_targets(
    dictionary: dict[str, Any],
    schema: dict[str, dict[str, Any]],
    tables: tuple[str, ...] = DEFAULT_TABLES,
) -> dict[str, Target]:
    """Resolve, per table, the sheet/column that provides its legacy id.

    Fails when the table has no provider (nothing to backfill), when two sheets claim the same
    table (`MULTIPLE_LEGACY_ID_PROVIDERS` is a warning in the dictionary but ambiguous here) or
    when the canonical table still lacks the provenance columns, which means migration 0009 was
    not applied to this database yet.
    """
    claimed: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for sheet, sheet_rules in dictionary.get("sheets", {}).items():
        for raw in sheet_rules.get("columns", []):
            provider = raw.get("provides_legacy_id_for")
            if provider and provider in tables:
                claimed.setdefault(provider, []).append((sheet, raw))

    targets: dict[str, Target] = {}
    for table in tables:
        entries = claimed.get(table, [])
        if not entries:
            raise StagingError(f"{table}: dicionario nao declara provides_legacy_id_for")
        if len(entries) > 1:
            detail = ", ".join(f"{sheet}.{raw['match']}" for sheet, raw in entries)
            raise StagingError(f"{table}: mais de uma origem de legacy_id ({detail})")
        sheet, raw = entries[0]
        missing = [column for column in PROVENANCE_COLUMNS if column not in schema.get(table, {})]
        if missing:
            raise StagingError(
                f"{table}: colunas ausentes {missing}; rode `npm run db:migrate` (migration 0009) "
                "antes do backfill"
            )
        problems: list[dict[str, Any]] = []
        rule = column_rule(sheet, raw, problems)
        if rule is None:
            raise StagingError(f"{table}: regra invalida em {sheet}.{raw.get('match')} ({problems})")
        targets[table] = Target(table=table, sheet=sheet, rule=rule)
    return targets


def legacy_id_of(payload: dict[str, Any], rule: ColumnRule) -> str | None:
    """Return the legacy id stored in `rule.source_column`, or `None` when it cannot be used."""
    raw = payload.get(rule.source_column)
    if is_blank(raw):
        return None
    converted, finding = convert_value(raw, rule)
    if finding or converted is None:
        return None
    text = str(converted).strip()
    return text or None


def plan_backfill(candidates: list[tuple[str, str]], existing: dict[str, str | None]) -> BackfillPlan:
    """Split the candidates into `stamp`/`already`/`missing` and list divergent stored keys."""
    stamp: list[tuple[str, str]] = []
    conflicts: list[tuple[str, str, str]] = []
    already = 0
    missing = 0
    for identifier, legacy_id in candidates:
        if identifier not in existing:
            missing += 1
            continue
        stored = existing[identifier]
        if stored is None:
            stamp.append((identifier, legacy_id))
        elif stored == legacy_id:
            already += 1
        else:
            conflicts.append((identifier, stored, legacy_id))
    return BackfillPlan(tuple(stamp), already, missing, tuple(conflicts))


def apply_backfill(
    cursor: Any,
    table: str,
    sheet: str,
    legacy_source: str,
    updates: tuple[tuple[str, str], ...],
) -> int:
    """Stamp the planned rows; the `legacy_id IS NULL` guard keeps a second run a no-op."""
    stamped = 0
    for identifier, legacy_id in updates:
        cursor.execute(
            f"""
            UPDATE {table}
               SET legacy_source = %s, legacy_table = %s, legacy_id = %s
             WHERE id = %s::uuid AND legacy_id IS NULL
            """,
            (legacy_source, sheet, legacy_id, identifier),
        )
        stamped += max(cursor.rowcount or 0, 0)
    return stamped


def existing_legacy_ids(cursor: Any, table: str) -> dict[str, str | None]:
    """Read the whole table once: 46k contacts and 15k installments fit in memory."""
    cursor.execute(f"SELECT id::text, legacy_id FROM {table}")
    return {str(row[0]): row[1] for row in cursor.fetchall()}


def staged_candidates(
    cursor: Any,
    batch_id: str,
    target: Target,
    page_size: int = DEFAULT_BATCH_PAGE,
) -> tuple[list[tuple[str, str]], int]:
    """Walk the staged rows of the sheet and return `[(uuid, legacy_id)]` plus the blank count."""
    candidates: list[tuple[str, str]] = []
    blanks = 0
    last_row = 0
    while True:
        cursor.execute(
            """
            SELECT source_row_number, payload FROM migration_rows
             WHERE batch_id = %s::uuid AND source_sheet = %s AND source_row_number > %s
             ORDER BY source_row_number
             LIMIT %s
            """,
            (batch_id, target.sheet, last_row, page_size),
        )
        rows = cursor.fetchall()
        if not rows:
            break
        for row_number, payload in rows:
            last_row = int(row_number)
            legacy_id = legacy_id_of(payload or {}, target.rule)
            if legacy_id is None:
                blanks += 1
                continue
            candidates.append((str(row_uuid(target.sheet, last_row)), legacy_id))
    return candidates, blanks


def run_backfill(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    load_env()
    dictionary = load_dictionary(args.map_path)
    schema = parse_canonical_columns(args.migrations)
    targets = backfill_targets(dictionary, schema, tuple(args.tables))

    staging_url, canonical_url = resolve_database_urls(getattr(args, "staging_url", None))
    result: dict[str, Any] = {
        "ok": True,
        "commit": bool(args.commit),
        "batch_id": None,
        "legacy_source": args.legacy_source,
        "databases": {
            "staging": describe_database_url(staging_url),
            "canonical": describe_database_url(canonical_url),
        },
        "tables": {},
    }

    staging = connect(staging_url)
    try:
        canonical = connect(canonical_url)
        try:
            batch = find_batch(staging.cursor(), dictionary, argparse.Namespace(batch_id=args.batch_id))
            result["batch_id"] = batch["id"]
            result["batch_status"] = batch["status"]
            for table, target in targets.items():
                candidates, blanks = staged_candidates(staging.cursor(), batch["id"], target)
                planned = plan_backfill(candidates, existing_legacy_ids(canonical.cursor(), table))
                stamped = 0
                if args.commit:
                    stamped = apply_backfill(
                        canonical.cursor(), table, target.sheet, args.legacy_source, planned.stamp
                    )
                    canonical.commit()
                result["tables"][table] = {
                    "sheet": target.sheet,
                    "column": target.rule.source_column,
                    "staged": len(candidates),
                    "blank_legacy_id": blanks,
                    "to_stamp": len(planned.stamp),
                    "stamped": stamped,
                    "already": planned.already,
                    "missing": planned.missing,
                    "conflicts": len(planned.conflicts),
                    "conflict_rows": [list(item) for item in planned.conflicts[:10]],
                }
        finally:
            canonical.close()
    finally:
        staging.close()

    conflicts = sum(entry["conflicts"] for entry in result["tables"].values())
    result["ok"] = conflicts == 0
    return (0 if conflicts == 0 else 1), result


def render_report(result: dict[str, Any]) -> str:
    """Short human summary; the JSON keeps the full per-table detail."""
    lines = [
        f"backfill de proveniencia legada ({'commit' if result['commit'] else 'dry-run'})",
        f"  lote: {result['batch_id']} (status {result.get('batch_status')})",
        f"  staging:   {result['databases']['staging']}",
        f"  canonico:  {result['databases']['canonical']}",
    ]
    if not result["commit"]:
        lines.append("  nada foi gravado: use --commit para carimbar as linhas")
    for table, entry in result["tables"].items():
        lines.append(
            f"  {table} <- {entry['sheet']}.{entry['column']}: "
            f"{entry['to_stamp']} a carimbar, {entry['stamped']} carimbadas, "
            f"{entry['already']} ja tinham a chave, {entry['missing']} fora do canonico, "
            f"{entry['conflicts']} divergentes"
        )
    return "\n".join(lines)


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--map", dest="map_path", type=Path, default=DEFAULT_DICTIONARY)
    parser.add_argument("--migrations", type=Path, default=DEFAULT_MIGRATIONS)
    parser.add_argument("--batch-id", default=None, help="migration_batches row to read (default: newest)")
    parser.add_argument(
        "--table",
        dest="tables",
        action="append",
        choices=DEFAULT_TABLES,
        help=f"tabela a carimbar; repetivel (default: {', '.join(DEFAULT_TABLES)})",
    )
    parser.add_argument(
        "--staging-url",
        default=None,
        help="database that holds migration_rows (default: STAGING_DATABASE_URL, then DATABASE_URL)",
    )
    parser.add_argument("--commit", action="store_true", help="grava as linhas (default e dry-run)")
    parser.add_argument("--legacy-source", default=DEFAULT_LEGACY_SOURCE)
    parser.add_argument("--json-out", dest="json_out", type=Path, default=None)
    parser.add_argument("--no-report", action="store_true", help="do not print the summary")
    args = parser.parse_args(argv)
    args.tables = args.tables or list(DEFAULT_TABLES)
    return args


def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    args = parse_arguments(argv)
    try:
        exit_code, result = run_backfill(args)
    except StagingError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 3

    if not args.no_report:
        print(render_report(result))
    if args.json_out:
        written = write_text_file(args.json_out, json.dumps(result, ensure_ascii=False, indent=2))
        print(f"json: {written}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())


