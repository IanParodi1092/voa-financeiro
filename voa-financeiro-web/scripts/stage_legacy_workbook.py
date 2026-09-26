from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator

import openpyxl
import psycopg
from psycopg.types.json import Jsonb

SENSITIVE_NAME_PARTS = ("senha", "apikey", "api_key", "token", "secret", "password", "_pass", "passwd")
CANONICAL_TABLES = ("schools", "customers", "students", "agreements", "installments", "payments", "asaas_charges")
DEFAULT_WORKBOOK = Path(__file__).resolve().parents[2] / "_legacy-powerapps" / "root-exports" / "VOA.xlsx"
DEFAULT_PAGE_SIZE = 500


def configure_stdio() -> None:
    """Keep `print` from aborting on accented text.

    On Windows the interpreter writes stdout in the ANSI code page (cp1252 here) while
    PowerShell 5.1 decodes a piped stream as the OEM code page (cp850), so redirected
    output must be written with `--json-out`/`--report` instead of `>`.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(errors="replace")
        except (ValueError, OSError):
            continue


configure_stdio()


def write_text_file(path: Path, text: str) -> Path:
    """Write UTF-8 output directly, so `>` redirection is not needed."""
    target = path if path.is_absolute() else Path.cwd() / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target


def load_env() -> None:
    """Load KEY=VALUE pairs from the monorepo .env without extra dependencies.

    Existing environment variables always win, so CI or shell overrides are respected.
    """
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key:
            continue
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def page_size() -> int:
    raw = os.environ.get("MIGRATION_BATCH_SIZE", "").strip()
    if not raw:
        return DEFAULT_PAGE_SIZE
    try:
        parsed = int(raw)
    except ValueError:
        return DEFAULT_PAGE_SIZE
    return parsed if parsed > 0 else DEFAULT_PAGE_SIZE


def chunked(items: list[Any], size: int) -> Iterator[list[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def normalize_header(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def is_sensitive(column: str) -> bool:
    normalized = normalize_header(column).replace(" ", "_").lower()
    return any(part in normalized for part in SENSITIVE_NAME_PARTS)


def serialize_cell(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    return text or None


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def row_hash(sheet: str, row_number: int, payload: dict[str, Any]) -> str:
    return stable_hash({"sheet": sheet, "row": row_number, "payload": payload})


def extract_legacy_id(payload: dict[str, Any]) -> str | None:
    value = payload.get("ID")
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def is_empty_payload(payload: dict[str, Any]) -> bool:
    return all(value is None or value == "" for value in payload.values())


def redact_payload(payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    redacted: dict[str, Any] = {}
    fields: list[str] = []
    for key, value in payload.items():
        if is_sensitive(key) and value not in (None, ""):
            redacted[key] = "[REDACTED]"
            fields.append(key)
        else:
            redacted[key] = value
    return redacted, fields


def unique_headers(raw_headers: list[Any]) -> list[str]:
    seen: Counter[str] = Counter()
    headers: list[str] = []
    for index, raw in enumerate(raw_headers):
        name = normalize_header(raw) or f"_col_{index + 1}"
        seen[name] += 1
        headers.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
    return headers


def snapshot_canonical_counts(cursor: Any) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in CANONICAL_TABLES:
        cursor.execute(f"SELECT count(*) FROM {table}")
        counts[table] = int(cursor.fetchone()[0])
    return counts


def iter_sheet_staging(
    workbook_path: Path,
    sheet_names: set[str] | None = None,
    max_rows_per_sheet: int | None = None,
) -> Iterator[dict[str, Any]]:
    workbook = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)
    try:
        for sheet in workbook.worksheets:
            if sheet_names and sheet.title not in sheet_names:
                continue
            iterator = sheet.iter_rows(values_only=True)
            header_row = next(iterator, None)
            rows: list[dict[str, Any]] = []
            errors: list[dict[str, Any]] = []
            if header_row is None:
                yield {
                    "sheet": sheet.title,
                    "rows": [],
                    "errors": [],
                    "report": {
                        "entity_name": sheet.title,
                        "source_count": 0,
                        "staged_count": 0,
                        "duplicate_candidates": 0,
                        "blocking_errors": 0,
                        "notes": "dry-run staging; no header row",
                    },
                }
                continue

            headers = unique_headers(list(header_row))
            source_count = 0
            missing_ids = 0
            missing_id_samples: list[int] = []
            redacted_fields: Counter[str] = Counter()
            redacted_rows = 0
            legacy_ids: list[str] = []
            content_hashes: list[str] = []

            for offset, values in enumerate(iterator, start=2):
                if max_rows_per_sheet is not None and source_count >= max_rows_per_sheet:
                    break
                payload = {
                    headers[index]: serialize_cell(values[index] if index < len(values) else None)
                    for index in range(len(headers))
                }
                if is_empty_payload(payload):
                    continue
                source_count += 1
                payload, redacted = redact_payload(payload)
                if redacted:
                    redacted_rows += 1
                    redacted_fields.update(redacted)
                legacy_id = extract_legacy_id(payload)
                if not legacy_id:
                    missing_ids += 1
                    if len(missing_id_samples) < 5:
                        missing_id_samples.append(offset)
                content_hash = stable_hash(payload)
                if legacy_id:
                    legacy_ids.append(legacy_id)
                content_hashes.append(content_hash)
                rows.append(
                    {
                        "source_sheet": sheet.title,
                        "source_row_number": offset,
                        "legacy_table": sheet.title,
                        "legacy_id": legacy_id,
                        "row_hash": row_hash(sheet.title, offset, payload),
                        "payload": payload,
                        "normalized_payload": {
                            "legacy_id": legacy_id,
                            "content_hash": content_hash,
                            "redacted_fields": redacted,
                        },
                    }
                )

            id_counts = Counter(legacy_ids)
            hash_counts = Counter(content_hashes)
            duplicate_ids = sum(count - 1 for count in id_counts.values() if count > 1)
            duplicate_payloads = sum(count - 1 for count in hash_counts.values() if count > 1)
            if missing_ids:
                errors.append(
                    {
                        "error_code": "MISSING_LEGACY_ID",
                        "severity": "warning",
                        "field_name": "ID",
                        "message": f"{sheet.title}: {missing_ids} row(s) without legacy ID",
                        "details": {"count": missing_ids, "sample_rows": missing_id_samples},
                    }
                )
            if duplicate_ids:
                errors.append(
                    {
                        "error_code": "DUPLICATE_LEGACY_ID",
                        "severity": "warning",
                        "field_name": "ID",
                        "message": f"{sheet.title}: {duplicate_ids} duplicate legacy ID occurrence(s)",
                        "details": {
                            "count": duplicate_ids,
                            "sample_ids": [key for key, count in id_counts.items() if count > 1][:5],
                        },
                    }
                )
            if duplicate_payloads:
                errors.append(
                    {
                        "error_code": "DUPLICATE_PAYLOAD",
                        "severity": "warning",
                        "field_name": None,
                        "message": f"{sheet.title}: {duplicate_payloads} duplicate payload occurrence(s)",
                        "details": {"count": duplicate_payloads},
                    }
                )
            if redacted_rows:
                errors.append(
                    {
                        "error_code": "SENSITIVE_FIELDS_REDACTED",
                        "severity": "warning",
                        "field_name": None,
                        "message": f"{sheet.title}: secrets redacted in {redacted_rows} row(s)",
                        "details": {"rows": redacted_rows, "fields": sorted(redacted_fields)},
                    }
                )
            yield {
                "sheet": sheet.title,
                "rows": rows,
                "errors": errors,
                "report": {
                    "entity_name": sheet.title,
                    "source_count": source_count,
                    "staged_count": len(rows),
                    "duplicate_candidates": duplicate_ids + duplicate_payloads,
                    "blocking_errors": 0,
                    "notes": "dry-run staging; canonical_count remains 0; no schools/customers/students/charges created",
                },
            }
    finally:
        workbook.close()


def stage_workbook(workbook_path: Path, sheet_names: set[str] | None = None, max_rows_per_sheet: int | None = None) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    for sheet in iter_sheet_staging(workbook_path, sheet_names, max_rows_per_sheet):
        rows.extend(sheet["rows"])
        errors.extend(sheet["errors"])
        reports.append(sheet["report"])
    return {
        "source_name": workbook_path.name,
        "source_hash": hash_file(workbook_path),
        "row_count": len(rows),
        "sheet_count": len(reports),
        "rows": rows,
        "errors": errors,
        "reports": reports,
    }


def persist_sheet(cursor: Any, batch_id: str, sheet: dict[str, Any]) -> None:
    if sheet["rows"]:
        row_params = [
            (
                batch_id,
                row["source_sheet"],
                row["source_row_number"],
                row["legacy_table"],
                row["legacy_id"],
                row["row_hash"],
                Jsonb(row["payload"]),
                Jsonb(row["normalized_payload"]),
                "staged",
            )
            for row in sheet["rows"]
        ]
        for batch in chunked(row_params, page_size()):
            cursor.executemany(
                """
                INSERT INTO migration_rows (
                  batch_id, source_sheet, source_row_number, legacy_table, legacy_id, row_hash, payload, normalized_payload, status
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                batch,
            )
    if sheet["errors"]:
        error_params = [
            (
                batch_id,
                error["error_code"],
                error["severity"],
                error.get("field_name"),
                error["message"],
                Jsonb(error.get("details") or {}),
            )
            for error in sheet["errors"]
        ]
        for batch in chunked(error_params, page_size()):
            cursor.executemany(
                """
                INSERT INTO migration_errors (batch_id, error_code, severity, field_name, message, details)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                batch,
            )
    report = sheet["report"]
    cursor.execute(
        """
        INSERT INTO reconciliation_reports (
          batch_id, entity_name, source_count, staged_count, canonical_count,
          duplicate_candidates, blocking_errors, notes
        ) VALUES (%s, %s, %s, %s, 0, %s, %s, %s)
        """,
        (
            batch_id,
            report["entity_name"],
            report["source_count"],
            report["staged_count"],
            report["duplicate_candidates"],
            report["blocking_errors"],
            report["notes"],
        ),
    )


def source_identity(workbook_path: Path, sheet_names: set[str] | None = None, max_rows_per_sheet: int | None = None) -> tuple[str, str]:
    name = workbook_path.name
    extras: list[str] = []
    if sheet_names:
        extras.append("sheets=" + ",".join(sorted(sheet_names)))
    if max_rows_per_sheet is not None:
        extras.append(f"max={max_rows_per_sheet}")
    if extras:
        name = f"{name}#{';'.join(extras)}"
    return name, hash_file(workbook_path)


def persist_staging(connection: Any, workbook_path: Path, sheet_names: set[str] | None = None, max_rows_per_sheet: int | None = None) -> dict[str, Any]:
    source_name, source_hash = source_identity(workbook_path, sheet_names, max_rows_per_sheet)
    cursor = connection.cursor()
    before = snapshot_canonical_counts(cursor)
    cursor.execute(
        """
        SELECT id, status, completed_at
          FROM migration_batches
         WHERE source_name = %s AND source_hash = %s
        """,
        (source_name, source_hash),
    )
    existing = cursor.fetchone()
    if existing and existing[1] not in {"failed"} and existing[2] is not None:
        cursor.execute("SELECT count(*) FROM migration_rows WHERE batch_id = %s", (existing[0],))
        staged = int(cursor.fetchone()[0])
        return {
            "batch_id": str(existing[0]),
            "status": existing[1],
            "reused": True,
            "source_name": source_name,
            "source_hash": source_hash,
            "row_count": staged,
            "canonical_before": before,
            "canonical_after": before,
            "reports": [],
            "errors": [],
        }

    if existing:
        cursor.execute("DELETE FROM migration_batches WHERE id = %s", (existing[0],))

    cursor.execute(
        """
        INSERT INTO migration_batches (source_name, source_hash, source_kind, status, row_count, started_at)
        VALUES (%s, %s, 'xlsx', 'staging', 0, now())
        RETURNING id
        """,
        (source_name, source_hash),
    )
    batch_id = cursor.fetchone()[0]
    total_rows = 0
    reports: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    try:
        for sheet in iter_sheet_staging(workbook_path, sheet_names, max_rows_per_sheet):
            persist_sheet(cursor, batch_id, sheet)
            total_rows += len(sheet["rows"])
            reports.append(sheet["report"])
            errors.extend(sheet["errors"])
            print(json.dumps({"progress": sheet["sheet"], "staged": len(sheet["rows"])}, ensure_ascii=False), flush=True)
        cursor.execute(
            """
            UPDATE migration_batches
               SET row_count = %s, status = 'staging', completed_at = now(), updated_at = now()
             WHERE id = %s
            """,
            (total_rows, batch_id),
        )
        after = snapshot_canonical_counts(cursor)
        if after != before:
            raise RuntimeError(f"Dry-run staging changed canonical tables: before={before} after={after}")
        return {
            "batch_id": str(batch_id),
            "status": "staging",
            "reused": False,
            "source_name": source_name,
            "source_hash": source_hash,
            "row_count": total_rows,
            "canonical_before": before,
            "canonical_after": after,
            "reports": reports,
            "errors": errors,
        }
    except Exception:
        cursor.execute(
            "UPDATE migration_batches SET status = 'failed', updated_at = now() WHERE id = %s",
            (batch_id,),
        )
        raise


def connect() -> Any:
    database_url = os.environ.get("DIRECT_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL or DIRECT_DATABASE_URL is required")
    return psycopg.connect(database_url)


def main() -> None:
    parser = argparse.ArgumentParser(description="Stage a legacy VOA workbook without creating canonical records.")
    parser.add_argument("workbook", nargs="?", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--preview", action="store_true", help="Read and summarize without writing to the database")
    parser.add_argument("--sheets", help="Comma-separated sheet names to include")
    parser.add_argument("--max-rows-per-sheet", type=int, default=None)
    parser.add_argument(
        "--json-out",
        type=Path,
        help="Write the JSON result to this path as UTF-8 (preferred over shell redirection)",
    )
    args = parser.parse_args()
    workbook_path = args.workbook.resolve()
    if not workbook_path.exists():
        raise SystemExit(f"Workbook not found: {workbook_path}")

    sheet_names = {name.strip() for name in args.sheets.split(",")} if args.sheets else None

    if args.preview:
        staged = stage_workbook(workbook_path, sheet_names=sheet_names, max_rows_per_sheet=args.max_rows_per_sheet)
        payload = {
            "source_name": staged["source_name"],
            "source_hash": staged["source_hash"],
            "row_count": staged["row_count"],
            "sheet_count": staged["sheet_count"],
            "error_count": len(staged["errors"]),
            "canonical_writes": False,
            "mode": "preview",
            "reports": [
                {
                    "entity_name": report["entity_name"],
                    "source_count": report["source_count"],
                    "staged_count": report["staged_count"],
                    "duplicate_candidates": report["duplicate_candidates"],
                }
                for report in staged["reports"]
            ],
            "errors": staged["errors"],
        }
        rendered = json.dumps(payload, ensure_ascii=False, indent=2)
        print(rendered)
        if args.json_out:
            write_text_file(args.json_out, rendered)
        return

    load_env()
    connection = connect()
    try:
        persisted = persist_staging(connection, workbook_path, sheet_names, args.max_rows_per_sheet)
        connection.commit()
        payload = {
            "source_name": persisted.get("source_name", workbook_path.name),
            "source_hash": persisted.get("source_hash", hash_file(workbook_path)),
            "mode": "staging",
            "canonical_writes": False,
            "batch_id": persisted["batch_id"],
            "status": persisted["status"],
            "reused": persisted["reused"],
            "row_count": persisted["row_count"],
            "error_count": len(persisted["errors"]),
            "canonical_before": persisted["canonical_before"],
            "canonical_after": persisted["canonical_after"],
            "reports": [
                {
                    "entity_name": report["entity_name"],
                    "source_count": report["source_count"],
                    "staged_count": report["staged_count"],
                    "duplicate_candidates": report["duplicate_candidates"],
                }
                for report in persisted["reports"]
            ],
            "errors": persisted["errors"],
        }
        rendered = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
        print(rendered)
        if args.json_out:
            write_text_file(args.json_out, rendered)
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        raise
