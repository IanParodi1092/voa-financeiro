"""Resolve and audit the phase-2 legacy field dictionary.

The dictionary (`scripts/legacy_field_map.json`) is the only place where a legacy
column is allowed to become a canonical field. This script:

1. reads the legacy column inventory (workbook headers, exactly like the stager);
2. resolves every column to a decision (map / ignore / defer / review);
3. validates every `map` target against the canonical schema parsed from
   `apps/api/migrations/*.sql`;
4. writes `docs/FIELD_MAPPING_DICTIONARY.md` plus an optional JSON artifact.

It never connects to the database unless `--from-staging` is passed, and it never
writes canonical rows.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stage_legacy_workbook import (  # noqa: E402
    DEFAULT_WORKBOOK,
    unique_headers,
    write_text_file,
)

DEFAULT_DICTIONARY = Path(__file__).resolve().parent / "legacy_field_map.json"
DEFAULT_REPORT = Path(__file__).resolve().parents[1] / "docs" / "FIELD_MAPPING_DICTIONARY.md"
DEFAULT_MIGRATIONS = Path(__file__).resolve().parents[1] / "apps" / "api" / "migrations"

MAP = "map"
IGNORE = "ignore"
DEFER = "defer"
REVIEW = "review"
DECISION_KINDS = (MAP, IGNORE, DEFER, REVIEW)
UNMAPPED = "unmapped"

CONSTRAINT_PREFIXES = (
    "constraint",
    "primary key",
    "unique",
    "check",
    "foreign key",
    "exclude",
    "like",
)
IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]*$")


def load_dictionary(path: Path = DEFAULT_DICTIONARY) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: dictionary root must be an object")
    if not isinstance(data.get("sheets"), dict):
        raise ValueError(f"{path}: dictionary needs a 'sheets' object")
    return data


def strip_sql_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"--[^\n]*", " ", sql)


def split_sql_items(body: str) -> list[str]:
    items: list[str] = []
    depth = 0
    current: list[str] = []
    for char in body:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            items.append("".join(current))
            current = []
            continue
        current.append(char)
    if current:
        items.append("".join(current))
    return items


def column_name_from_item(item: str) -> str | None:
    text = item.strip()
    if not text:
        return None
    first = text.split(None, 1)[0].strip().strip('"').lower()
    if first in CONSTRAINT_PREFIXES or not IDENTIFIER.match(first):
        return None
    return first


def parse_canonical_schema(migrations_dir: Path = DEFAULT_MIGRATIONS) -> dict[str, set[str]]:
    """Return {table: {column, ...}} parsed from the real SQL migrations."""
    schema: dict[str, set[str]] = {}
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
            cursor = start
            while cursor < len(sql) and depth > 0:
                if sql[cursor] == "(":
                    depth += 1
                elif sql[cursor] == ")":
                    depth -= 1
                cursor += 1
            columns = schema.setdefault(table, set())
            for item in split_sql_items(sql[start : cursor - 1]):
                name = column_name_from_item(item)
                if name:
                    columns.add(name)
        for match in alter_pattern.finditer(sql):
            table = match.group(1).lower()
            columns = schema.setdefault(table, set())
            body = match.group(2)
            for item in split_sql_items(body):
                text = item.strip()
                add = re.match(r"add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)", text, re.I)
                if add:
                    columns.add(add.group(1).lower())
                    continue
                if re.match(r"(add|drop|alter)\b", text, re.I):
                    continue
                name = column_name_from_item(text)
                if name:
                    columns.add(name)
    return schema


def decision_of(entry: dict[str, Any]) -> str:
    kinds = [kind for kind in DECISION_KINDS if kind in entry]
    if len(kinds) != 1:
        raise ValueError(f"entry must declare exactly one of {DECISION_KINDS}: {entry!r}")
    return kinds[0]


def match_specificity(pattern: str) -> tuple[int, int]:
    return (1 if "*" not in pattern else 0, len(pattern))


def resolve_column(sheet_rules: dict[str, Any], column: str) -> tuple[dict[str, Any], str]:
    """Return (resolved_entry, source); source is `rule:<pattern>` or `default`."""
    exact: dict[str, Any] | None = None
    best: tuple[tuple[int, int], dict[str, Any], str] | None = None
    for rule in sheet_rules:
        pattern = rule["match"]
        if pattern == column:
            exact = rule
            break
        if "*" in pattern and fnmatch.fnmatchcase(column, pattern):
            rank = match_specificity(pattern)
            if best is None or rank > best[0]:
                best = (rank, rule, pattern)
    if exact is not None:
        return exact, f"rule:{exact['match']}"
    if best is not None:
        return best[1], f"rule:{best[2]}"
    return {}, UNMAPPED


def resolve_inventory(
    dictionary: dict[str, Any], inventory: dict[str, list[str]]
) -> dict[str, Any]:
    sheets_report: dict[str, Any] = {}
    unknown_sheets: list[str] = []
    for sheet in sorted(inventory):
        rules = dictionary["sheets"].get(sheet, {})
        if not rules:
            unknown_sheets.append(sheet)
        default = rules.get("default")
        columns: list[dict[str, Any]] = []
        for column in inventory[sheet]:
            entry, source = resolve_column(rules.get("columns", []), column)
            if not entry:
                if default is None:
                    columns.append(
                        {
                            "column": column,
                            "decision": UNMAPPED,
                            "source": UNMAPPED,
                            "target": None,
                            "type": None,
                            "normalization": None,
                            "required": False,
                            "priority": None,
                            "status": "confirmed",
                            "ref": None,
                            "gap": None,
                            "reason": None,
                            "note": None,
                            "values": None,
                        }
                    )
                    continue
                entry, source = default, "default"
            kind = decision_of(entry)
            columns.append(
                {
                    "column": column,
                    "decision": kind,
                    "source": source,
                    "target": entry.get(MAP),
                    "type": entry.get("type"),
                    "normalization": entry.get("normalization"),
                    "required": bool(entry.get("required", False)),
                    "priority": entry.get("priority"),
                    "status": entry.get("status", "confirmed"),
                    "ref": entry.get("ref"),
                    "gap": entry.get("gap"),
                    "reason": entry.get(IGNORE) or entry.get(DEFER) or entry.get(REVIEW),
                    "note": entry.get("note"),
                    "values": entry.get("values"),
                }
            )
        sheets_report[sheet] = {
            "target_entity": rules.get("target_entity"),
            "row_kind": rules.get("row_kind"),
            "notes": rules.get("notes"),
            "has_default": default is not None,
            "columns": columns,
            "totals": dict(Counter(c["decision"] for c in columns)),
        }
    return {"sheets": sheets_report, "unknown_sheets": unknown_sheets}


def validate_dictionary(
    dictionary: dict[str, Any], schema: dict[str, set[str]], inventory: dict[str, list[str]]
) -> dict[str, Any]:
    """Structural problems block the dictionary; policy items block only approval."""
    structural: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    allowed_types = set(dictionary.get("type_conventions", {}))
    allowed_norms = set(dictionary.get("normalizations", {}))
    allowed_reasons = set(dictionary.get("reason_codes", {}))
    gaps = set(dictionary.get("schema_gaps", {}))
    providers: dict[str, list[str]] = defaultdict(list)

    for sheet, rules in dictionary["sheets"].items():
        if not isinstance(rules, dict):
            structural.append({"code": "SHEET_NOT_OBJECT", "sheet": sheet})
            continue
        seen_patterns: Counter[tuple[str, str]] = Counter()
        for rule in rules.get("columns", []):
            pattern = rule.get("match")
            if not pattern:
                structural.append({"code": "RULE_WITHOUT_MATCH", "sheet": sheet, "rule": str(rule)})
                continue
            try:
                kind = decision_of(rule)
            except ValueError as error:
                structural.append(
                    {"code": "INVALID_DECISION", "sheet": sheet, "column": pattern, "detail": str(error)}
                )
                continue
            seen_patterns[
                (pattern, str(rule.get(MAP) or "")) if kind == MAP else (pattern, "")
            ] += 1
            if kind == MAP:
                target = rule.get(MAP, "")
                if "." not in target:
                    structural.append(
                        {"code": "TARGET_NOT_QUALIFIED", "sheet": sheet, "column": pattern, "target": target}
                    )
                else:
                    table, _, column = target.partition(".")
                    if table not in schema:
                        structural.append(
                            {"code": "TARGET_TABLE_UNKNOWN", "sheet": sheet, "column": pattern, "target": target}
                        )
                    elif column not in schema[table]:
                        structural.append(
                            {"code": "TARGET_COLUMN_UNKNOWN", "sheet": sheet, "column": pattern, "target": target}
                        )
                field_type = rule.get("type")
                if not field_type:
                    structural.append({"code": "MISSING_TYPE", "sheet": sheet, "column": pattern})
                elif field_type not in allowed_types:
                    structural.append(
                        {"code": "UNKNOWN_TYPE", "sheet": sheet, "column": pattern, "type": field_type}
                    )
                normalization = rule.get("normalization")
                if normalization and normalization not in allowed_norms:
                    structural.append(
                        {
                            "code": "UNKNOWN_NORMALIZATION",
                            "sheet": sheet,
                            "column": pattern,
                            "normalization": normalization,
                        }
                    )
                if rule.get("ref") and rule["ref"] not in schema:
                    structural.append(
                        {"code": "UNKNOWN_REF_TABLE", "sheet": sheet, "column": pattern, "ref": rule["ref"]}
                    )
                provider = rule.get("provides_legacy_id_for")
                if provider:
                    providers[provider].append(f"{sheet}.{pattern}")
            else:
                reason = rule.get(kind)
                if not reason:
                    structural.append({"code": "MISSING_REASON", "sheet": sheet, "column": pattern})
                elif reason not in allowed_reasons:
                    structural.append(
                        {"code": "UNKNOWN_REASON", "sheet": sheet, "column": pattern, "reason": reason}
                    )
            if rule.get("gap") and rule["gap"] not in gaps:
                structural.append(
                    {"code": "UNKNOWN_GAP", "sheet": sheet, "column": pattern, "gap": rule["gap"]}
                )
        for (pattern, target), count in seen_patterns.items():
            if count > 1:
                structural.append(
                    {
                        "code": "DUPLICATE_RULE",
                        "sheet": sheet,
                        "pattern": pattern,
                        "target": target or "decisao sem mapa",
                        "count": count,
                    }
                )

        mapped_targets: dict[str, set[str]] = defaultdict(set)
        for rule in rules.get("columns", []):
            if MAP in rule and isinstance(rule.get(MAP), str) and "." in rule[MAP]:
                table, _, column = rule[MAP].partition(".")
                mapped_targets[table].add(column)
        for target, spec in (rules.get("links") or {}).items():
            table, _, column = str(target).partition(".")
            if not column:
                structural.append({"code": "LINK_TARGET_NOT_QUALIFIED", "sheet": sheet, "link": target})
                continue
            if not isinstance(spec, str) or not spec.startswith("row:"):
                structural.append({"code": "LINK_SOURCE_UNSUPPORTED", "sheet": sheet, "link": target})
                continue
            row_table = spec.split(":", 1)[1]
            if table not in schema:
                structural.append({"code": "LINK_TARGET_TABLE_UNKNOWN", "sheet": sheet, "link": target})
                continue
            if column not in schema[table]:
                structural.append({"code": "LINK_TARGET_COLUMN_UNKNOWN", "sheet": sheet, "link": target})
                continue
            if row_table not in mapped_targets:
                structural.append(
                    {"code": "LINK_ROW_TABLE_NOT_MAPPED", "sheet": sheet, "link": target, "row_table": row_table}
                )
                continue
            if column in mapped_targets.get(table, set()):
                structural.append({"code": "LINK_CONFLICTS_WITH_MAP", "sheet": sheet, "link": target})

    for table, claimants in providers.items():
        if len(claimants) > 1:
            # Mais de uma aba pode alimentar a mesma entidade (provenance e por aba); o
            # aviso fica no relatorio para o operador conferir a decisao.
            warnings.append(
                {"code": "MULTIPLE_LEGACY_ID_PROVIDERS", "table": table, "columns": sorted(claimants)}
            )

    resolved = resolve_inventory(dictionary, inventory)
    used: dict[str, set[str]] = defaultdict(set)
    for sheet, report in resolved["sheets"].items():
        for column in report["columns"]:
            if column["source"].startswith("rule:"):
                used[sheet].add(column["source"].split(":", 1)[1])
    for sheet, rules in dictionary["sheets"].items():
        for rule in rules.get("columns", []):
            pattern = rule.get("match")
            if pattern and pattern not in used.get(sheet, set()):
                warnings.append({"code": "STALE_RULE", "sheet": sheet, "column": pattern})
    for sheet, report in resolved["sheets"].items():
        unmapped = [c["column"] for c in report["columns"] if c["decision"] == UNMAPPED]
        if unmapped:
            structural.append({"code": "UNMAPPED_COLUMNS", "sheet": sheet, "columns": unmapped})
    for sheet in resolved["unknown_sheets"]:
        structural.append({"code": "SHEET_NOT_IN_DICTIONARY", "sheet": sheet})

    policy: list[dict[str, Any]] = []
    for sheet, report in resolved["sheets"].items():
        for column in report["columns"]:
            if column["decision"] == REVIEW:
                policy.append(
                    {
                        "code": "REVIEW_REQUIRED",
                        "sheet": sheet,
                        "column": column["column"],
                        "reason": column["reason"],
                        "gap": column["gap"],
                    }
                )
            elif column["decision"] == MAP and column["status"] != "confirmed":
                policy.append(
                    {
                        "code": "MAPPING_NOT_CONFIRMED",
                        "sheet": sheet,
                        "column": column["column"],
                        "target": column["target"],
                        "status": column["status"],
                    }
                )
    return {
        "structural": structural,
        "warnings": warnings,
        "policy": policy,
        "resolved": resolved,
        "providers": {table: sorted(cols) for table, cols in providers.items()},
    }


def build_report(
    dictionary: dict[str, Any],
    validation: dict[str, Any],
    inventory: dict[str, list[str]],
    differences: list[dict[str, Any]] | None = None,
) -> str:
    resolved = validation["resolved"]["sheets"]
    totals: Counter[str] = Counter()
    for report in resolved.values():
        totals.update(report["totals"])
    column_count = sum(len(columns) for columns in inventory.values())
    providers = validation["providers"]
    lines: list[str] = []
    lines.append("# Dicionario de campos do legado (fase 2)")
    lines.append("")
    lines.append(
        "Gerado por `scripts/build_field_dictionary.py` a partir de "
        f"`{dictionary.get('source_name', 'VOA.xlsx')}` e do schema real em `apps/api/migrations/*.sql`."
    )
    lines.append("Este relatorio nao grava nada no banco e nao cria registros canonicos.")
    lines.append("")
    lines.append("## Resumo")
    lines.append("")
    lines.append("| Metrica | Valor |")
    lines.append("|---|---:|")
    lines.append(f"| Abas inventariadas | {len(inventory)} |")
    lines.append(f"| Colunas inventariadas | {column_count} |")
    lines.append(f"| Colunas com `map` | {totals[MAP]} |")
    lines.append(f"| Colunas `ignore` | {totals[IGNORE]} |")
    lines.append(f"| Colunas `defer` | {totals[DEFER]} |")
    lines.append(f"| Colunas `review` | {totals[REVIEW]} |")
    lines.append(f"| Colunas `unmapped` | {totals[UNMAPPED]} |")
    lines.append(f"| Problemas estruturais | {len(validation['structural'])} |")
    lines.append(f"| Itens de politica pendentes | {len(validation['policy'])} |")
    lines.append("")
    lines.append("## Portao de aprovacao")
    lines.append("")
    structural = len(validation["structural"])
    policy_count = len(validation["policy"])
    if structural:
        lines.append(f"- Estrutural: FALHOU ({structural} problema(s)). Corrija o dicionario antes de seguir.")
    else:
        lines.append("- Estrutural: OK. Todo mapa aponta para tabela/coluna existente no schema canonico.")
    if policy_count:
        lines.append(
            f"- Aprovacao: BLOQUEADA ({policy_count} item(ns) `review` ou mapeamento nao confirmado). "
            "Nenhuma carga canonica pode rodar antes da decisao de negocio."
        )
    else:
        lines.append("- Aprovacao: LIBERADA para revisao final do lote.")
    lines.append("")
    lines.append("## Conferencia staging x workbook")
    lines.append("")
    if differences is None:
        lines.append("Nao executada nesta rodada. Use `--from-staging` para comparar as colunas do workbook com o payload gravado no lote.")
    elif not differences:
        lines.append("Cada coluna do workbook aparece exatamente uma vez no payload do lote de staging.")
    else:
        lines.append("| Aba | Tipo | Linhas no lote | Faltando no staging | Extra no staging |")
        lines.append("|---|---|---:|---:|---:|")
        for item in differences:
            lines.append(
                f"| {item['sheet']} | {item['kind']} | {item['staged_rows']} | "
                f"{len(item['missing_in_staging'])} | {len(item['extra_in_staging'])} |"
            )
    lines.append("")
    lines.append("## Provedores de `legacy_id` por tabela canonica")
    lines.append("")
    lines.append("| Tabela | Coluna provedora |")
    lines.append("|---|---|")
    for table, claimants in sorted(providers.items()):
        lines.append(f"| {table} | {', '.join(claimants)} |")
    lines.append("")

    linked = {
        sheet: rules["links"]
        for sheet, rules in dictionary["sheets"].items()
        if isinstance(rules, dict) and rules.get("links")
    }
    if linked:
        lines.append("## Vinculos resolvidos na mesma linha")
        lines.append("")
        lines.append("| Aba | Coluna canonica | Origem dentro da linha |")
        lines.append("|---|---|---|")
        for sheet, links in sorted(linked.items()):
            for target, spec in sorted(links.items()):
                lines.append(f"| {sheet} | `{target}` | `{spec}` |")
        lines.append("")
    lines.append("## Abas mapeadas para entidade canonica")
    lines.append("")
    lines.append("| Aba | Entidade | Colunas | map | ignore | defer | review |")
    lines.append("|---|---|---:|---:|---:|---:|---:|")
    for sheet in sorted(resolved):
        report = resolved[sheet]
        if not report["target_entity"]:
            continue
        totals_sheet = Counter(report["totals"])
        lines.append(
            f"| {sheet} | `{report['target_entity']}` | {len(report['columns'])} | "
            f"{totals_sheet[MAP]} | {totals_sheet[IGNORE]} | {totals_sheet[DEFER]} | {totals_sheet[REVIEW]} |"
        )
    lines.append("")
    lines.append("## Detalhe por aba")
    lines.append("")
    for sheet in sorted(inventory):
        report = resolved[sheet]
        lines.append(f"### {sheet}")
        lines.append("")
        entity = report["target_entity"] or "(sem entidade canonica nesta fase)"
        lines.append(f"- Entidade canonica: {entity}")
        lines.append(f"- Tipo de linha: {report['row_kind'] or 'n/a'}")
        if report["notes"]:
            lines.append(f"- Observacoes: {report['notes']}")
        totals_sheet = Counter(report["totals"])
        lines.append(
            f"- Colunas: {len(report['columns'])} (map={totals_sheet[MAP]}, "
            f"ignore={totals_sheet[IGNORE]}, defer={totals_sheet[DEFER]}, "
            f"review={totals_sheet[REVIEW]}, unmapped={totals_sheet[UNMAPPED]})"
        )
        lines.append("")
        lines.append("| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for column in report["columns"]:
            detail = column["note"] or column["reason"] or ""
            if column["values"]:
                rendered = ", ".join(f"{key}->{value}" for key, value in column["values"].items())
                detail = f"{detail} [valores: {rendered}]".strip()
            if column["gap"]:
                detail = f"{detail} [gap: {column['gap']}]".strip()
            if column["status"] and column["status"] != "confirmed":
                detail = f"{detail} [status: {column['status']}]".strip()
            lines.append(
                "| {col} | {decision} | {target} | {type} | {norm} | {req} | {ref} | {detail} |".format(
                    col=column["column"],
                    decision=column["decision"],
                    target=column["target"] or "",
                    type=column["type"] or "",
                    norm=column["normalization"] or "",
                    req="sim" if column["required"] else "",
                    ref=column["ref"] or "",
                    detail=detail.replace("|", "/"),
                )
            )
        lines.append("")

    gaps = dictionary.get("schema_gaps", {})
    if gaps:
        mentions: dict[str, list[str]] = defaultdict(list)
        for sheet in sorted(resolved):
            for column in resolved[sheet]["columns"]:
                if column.get("gap"):
                    mentions[column["gap"]].append(f"{sheet}.{column['column']}")
        lines.append("## Lacunas de schema (migrations necessarias antes da carga)")
        lines.append("")
        lines.append("| Gap | Descricao | Colunas legadas afetadas |")
        lines.append("|---|---|---:|")
        for gap, description in gaps.items():
            lines.append(f"| `{gap}` | {description} | {len(mentions.get(gap, []))} |")
        lines.append("")
        for gap, description in gaps.items():
            affected = mentions.get(gap, [])
            if not affected:
                continue
            lines.append(f"### {gap}")
            lines.append("")
            lines.append(f"{description}")
            lines.append("")
            preview = ", ".join(f"`{item}`" for item in affected[:12])
            suffix = f" e mais {len(affected) - 12} coluna(s)" if len(affected) > 12 else ""
            lines.append(f"Colunas: {preview}{suffix}.")
            lines.append("")

    policy = validation["policy"]
    lines.append("## Decisoes de politica pendentes")
    lines.append("")
    if not policy:
        lines.append("Nenhum item pendente: o dicionario esta liberado para aprovacao do lote.")
    else:
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for item in policy:
            key = (item["code"], item.get("reason") or item.get("status") or "")
            grouped[key].append(item)
        lines.append("| Codigo | Motivo | Ocorrencias | Abas | Exemplos |")
        lines.append("|---|---|---:|---|---|")
        for (code, reason), items in sorted(grouped.items()):
            sheets = sorted({item["sheet"] for item in items})
            samples = ", ".join(f"`{item['sheet']}.{item['column']}`" for item in items[:4])
            lines.append(f"| `{code}` | `{reason}` | {len(items)} | {', '.join(sheets)} | {samples} |")
    lines.append("")

    reason_totals: Counter[tuple[str, str]] = Counter()
    for sheet in resolved:
        for column in resolved[sheet]["columns"]:
            if column["decision"] in (IGNORE, DEFER, REVIEW):
                reason_totals[(column["decision"], column["reason"])] += 1
    lines.append("## Motivos registrados")
    lines.append("")
    lines.append("| Decisao | Motivo | Colunas | Descricao |")
    lines.append("|---|---|---:|---|")
    reasons_doc = dictionary.get("reason_codes", {})
    for (decision, reason), count in sorted(reason_totals.items()):
        lines.append(f"| {decision} | `{reason}` | {count} | {reasons_doc.get(reason, '').replace('|', '/')} |")
    lines.append("")

    if validation["warnings"]:
        lines.append("## Avisos (nao bloqueiam)")
        lines.append("")
        lines.append("| Codigo | Aba/Tabela | Coluna(s) | Detalhe |")
        lines.append("|---|---|---|---|")
        for warning in validation["warnings"]:
            location = warning.get("sheet") or warning.get("table") or "-"
            columns = warning.get("column") or ", ".join(warning.get("columns") or []) or "-"
            detail = warning.get("detail") or warning.get("reason") or "-"
            lines.append(f"| `{warning['code']}` | {location} | {columns} | {detail} |")
        lines.append("")

    if validation["structural"]:
        lines.append("## Problemas estruturais")
        lines.append("")
        lines.append("| Codigo | Aba | Detalhe |")
        lines.append("|---|---|---|")
        for problem in validation["structural"]:
            detail = problem.get("columns") or problem.get("detail") or problem.get("target") or problem.get("reason") or ""
            if isinstance(detail, list):
                detail = ", ".join(detail[:10])
            lines.append(f"| `{problem['code']}` | {problem.get('sheet', '')} | {str(detail)[:200]} |")
        lines.append("")

    return "\n".join(lines)


def read_workbook_inventory(workbook_path: Path = DEFAULT_WORKBOOK) -> dict[str, list[str]]:
    """Column inventory per sheet, using the same header rules as the stager."""
    workbook = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)
    inventory: dict[str, list[str]] = {}
    try:
        for sheet in workbook.worksheets:
            iterator = sheet.iter_rows(values_only=True)
            header_row = next(iterator, None)
            inventory[sheet.title] = unique_headers(list(header_row)) if header_row else []
    finally:
        workbook.close()
    return inventory


def read_staging_inventory(source_name: str) -> dict[str, dict[str, Any]]:
    """Columns and row counts actually stored in staging for the newest batch."""
    from stage_legacy_workbook import connect, load_env

    load_env()
    inventory: dict[str, dict[str, Any]] = {}
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                select id from migration_batches
                 where source_name = %s
                 order by created_at desc
                 limit 1
                """,
                (source_name,),
            )
            row = cursor.fetchone()
            if row is None:
                raise SystemExit(f"no migration_batches row found for source_name={source_name!r}")
            batch_id = str(row[0])
            cursor.execute(
                """
                select r.source_sheet,
                       count(distinct r.id) as rows,
                       array_agg(distinct e.key) as keys
                  from migration_rows r, jsonb_each_text(r.payload) as e
                 where r.batch_id = %s::uuid
                 group by 1
                 order by 1
                """,
                (batch_id,),
            )
            for sheet, rows, keys in cursor.fetchall():
                inventory[sheet] = {"columns": sorted(keys), "rows": int(rows)}
    return inventory


def compare_inventories(
    workbook: dict[str, list[str]], staging: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    """Classify each difference as an empty sheet or a real column mismatch."""
    differences: list[dict[str, Any]] = []
    for sheet in sorted(set(workbook) | set(staging)):
        expected = list(workbook.get(sheet, []))
        staged = list(staging.get(sheet, {}).get("columns", []))
        rows = int(staging.get(sheet, {}).get("rows", 0))
        missing = [column for column in expected if column not in staged]
        extra = [column for column in staged if column not in expected]
        if not missing and not extra:
            continue
        kind = "empty_sheet" if rows == 0 and not extra else "column_mismatch"
        differences.append(
            {
                "sheet": sheet,
                "kind": kind,
                "staged_rows": rows,
                "missing_in_staging": missing,
                "extra_in_staging": extra,
            }
        )
    return differences


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--map", dest="map_path", type=Path, default=DEFAULT_DICTIONARY)
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--migrations", type=Path, default=DEFAULT_MIGRATIONS)
    parser.add_argument("--report", dest="report_path", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--json-out", dest="json_out", type=Path, default=None)
    parser.add_argument("--from-staging", action="store_true", help="cross-check the staged payload columns")
    parser.add_argument(
        "--gate",
        choices=("structural", "approved"),
        default="structural",
        help="`structural` fails on broken mapping; `approved` also fails while policy items are open",
    )
    parser.add_argument("--no-report", action="store_true", help="do not write the markdown report")
    return parser.parse_args(argv)


def summarize(validation: dict[str, Any], differences: list[dict[str, Any]]) -> dict[str, Any]:
    resolved = validation["resolved"]["sheets"]
    totals: Counter[str] = Counter()
    for report in resolved.values():
        totals.update(report["totals"])
    return {
        "sheets": len(resolved),
        "columns": sum(len(report["columns"]) for report in resolved.values()),
        "map": totals[MAP],
        "ignore": totals[IGNORE],
        "defer": totals[DEFER],
        "review": totals[REVIEW],
        "unmapped": totals[UNMAPPED],
        "structural_issues": len(validation["structural"]),
        "warnings": len(validation["warnings"]),
        "policy_items": len(validation["policy"]),
        "staging_mismatches": sum(1 for item in differences if item["kind"] == "column_mismatch"),
        "staging_empty_sheets": sum(1 for item in differences if item["kind"] == "empty_sheet"),
        "canonical_writes": False,
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    dictionary = load_dictionary(args.map_path)
    schema = parse_canonical_schema(args.migrations)
    inventory = read_workbook_inventory(args.workbook)
    source_name = dictionary.get("source_name", "VOA.xlsx")

    differences: list[dict[str, Any]] = []
    if args.from_staging:
        differences = compare_inventories(inventory, read_staging_inventory(source_name))

    validation = validate_dictionary(dictionary, schema, inventory)
    report = build_report(dictionary, validation, inventory, differences)
    summary = summarize(validation, differences)

    if not args.no_report:
        written = write_text_file(args.report_path, report)
        print(f"report: {written}")
    if args.json_out:
        payload = {
            "summary": summary,
            "gate": args.gate,
            "structural": validation["structural"],
            "warnings": validation["warnings"],
            "policy": validation["policy"],
            "providers": validation["providers"],
            "staging_differences": differences,
            "sheets": {
                sheet: {
                    "target_entity": report["target_entity"],
                    "totals": report["totals"],
                    "links": dictionary["sheets"].get(sheet, {}).get("links", {}),
                    "columns": report["columns"],
                }
                for sheet, report in validation["resolved"]["sheets"].items()
            },
        }
        written = write_text_file(args.json_out, json.dumps(payload, ensure_ascii=False, indent=2))
        print(f"json: {written}")

    print("dictionary summary")
    for key, value in summary.items():
        print(f"  {key}: {value}")

    if validation["warnings"]:
        print(f"warnings: {len(validation['warnings'])}")
        for warning in validation["warnings"][:10]:
            location = warning.get("sheet") or warning.get("table") or "-"
            columns = warning.get("column") or ", ".join(warning.get("columns") or []) or "-"
            print(f"  {warning['code']} [{location}.{columns}]")

    mismatches = [item for item in differences if item["kind"] == "column_mismatch"]
    if mismatches:
        print("staging column mismatches")
        for item in mismatches:
            print(f"  {item['sheet']}: missing={item['missing_in_staging'][:5]} extra={item['extra_in_staging'][:5]}")
        return 3

    if validation["structural"]:
        print("structural issues")
        for problem in validation["structural"][:20]:
            detail = problem.get("columns") or problem.get("detail") or problem.get("target") or ""
            if isinstance(detail, list):
                detail = f"{len(detail)} column(s): {', '.join(detail[:5])}"
            print(f"  {problem['code']} [{problem.get('sheet', '-')}] {detail}")
        if len(validation["structural"]) > 20:
            print(f"  ... {len(validation['structural']) - 20} more")
        return 1

    if args.gate == "approved" and validation["policy"]:
        print(f"approval gate blocked by {len(validation['policy'])} open item(s)")
        for item in validation["policy"][:20]:
            print(f"  {item['code']} [{item['sheet']}.{item['column']}] {item.get('target') or item.get('reason')}")
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())




