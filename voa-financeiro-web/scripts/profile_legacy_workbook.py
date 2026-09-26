from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

import openpyxl

SENSITIVE_NAME_PARTS = ("senha", "apikey", "api_key", "token", "secret", "password")


def normalize(value: Any) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", text).strip().lower()


def is_sensitive(column: str) -> bool:
    normalized = normalize(column).replace(" ", "_")
    return any(part in normalized for part in SENSITIVE_NAME_PARTS)


def profile_sheet(sheet: openpyxl.worksheet.worksheet.Worksheet) -> dict[str, Any]:
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        return {"rows": 0, "columns": []}

    headers = [str(value) if value is not None else "" for value in rows[0]]
    columns: list[dict[str, Any]] = []
    for index, header in enumerate(headers):
        values = [row[index] if index < len(row) else None for row in rows[1:]]
        normalized_values = [normalize(value) for value in values if normalize(value)]
        counts = Counter(normalized_values)
        columns.append(
            {
                "name": header,
                "non_empty": len(normalized_values),
                "empty": len(values) - len(normalized_values),
                "distinct": len(counts),
                "duplicate_values": sum(1 for count in counts.values() if count > 1),
                "duplicate_rows_beyond_first": sum(count - 1 for count in counts.values() if count > 1),
                "sensitive": is_sensitive(header),
                "top_duplicates": counts.most_common(5) if not is_sensitive(header) else [],
            }
        )
    return {"rows": max(0, len(rows) - 1), "columns": columns}


def main() -> None:
    parser = argparse.ArgumentParser(description="Profile a legacy VOA workbook without importing data.")
    parser.add_argument("workbook", type=Path)
    args = parser.parse_args()

    workbook = openpyxl.load_workbook(args.workbook, read_only=True, data_only=True)
    result = {
        "source": str(args.workbook),
        "read_only": True,
        "sensitive_values_emitted": False,
        "sheets": {sheet.title: profile_sheet(sheet) for sheet in workbook.worksheets},
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
