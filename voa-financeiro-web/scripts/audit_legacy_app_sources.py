"""Audit what the legacy Canvas app reads against what the legacy workbook exposes.

The Canvas app (`_legacy-powerapps/`) is bound to Dataverse tables (`TBL_*`) and to a
handful of external sources (Excel Online, custom connectors). The workbook
(`VOA.xlsx`) only carries the sheets that a previous export produced. When the two
diverge, the app reads a table/column that our spreadsheets simply do not have, and
that divergence explains why some legacy screens cannot be reproduced from the
workbook alone.

This script is read-only:

1. locates the most recent unpacked copy of the app and reads its data sources;
2. reads the workbook headers (exactly like the stager);
3. reads the Dataverse solution export (`SolutionExport/CDSDefault_unmanaged_unpacked`)
   to know which physical attributes and display names the environment really has;
4. counts the display-name references in the app source (`Src/**/*.fx.yaml`);
5. writes `docs/LEGACY_APP_SOURCE_GAPS.md` with tables, columns and origins that the
   app pulls but the workbook does not carry.

It never connects to the database and never writes canonical rows.
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stage_legacy_workbook import configure_stdio, write_text_file  # noqa: E402

DEFAULT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_APP_ROOT = DEFAULT_ROOT / "_legacy-powerapps"
DEFAULT_WORKBOOK = DEFAULT_APP_ROOT / "root-exports" / "VOA.xlsx"
DEFAULT_SOLUTION = (
    DEFAULT_APP_ROOT
    / "projects-and-sources"
    / "Dataverse"
    / "SolutionExport"
    / "CDSDefault_unmanaged_unpacked"
    / "Entities"
)
DEFAULT_REPORT = Path(__file__).resolve().parents[1] / "docs" / "LEGACY_APP_SOURCE_GAPS.md"
MINIMUM_SOURCES = 40

SYSTEM_ATTRIBUTE_SUFFIX = re.compile(
    r"_(AsyncOperations|BulkDeleteFailures|MailboxTrackingFolders|"
    r"PrincipalObjectAttributeAccesses|ProcessSession|SyncErrors)$"
)
SYSTEM_COLUMNS = {
    "created",
    "modified",
    "created by",
    "modified by",
    "attachments",
    "complianceassetid",
    "authorid",
    "editorid",
    "contenttypeid",
    "odata_colortag",
    "odata_uiversionstring",
    "filesystemobjecttype",
    "serverredirectedembeduri",
    "serverredirectedembedurl",
    "id.1",
    "id2",
    "guid",
    "createdon",
    "modifiedon",
    "ownerid",
    "statecode",
    "statuscode",
}
GENERIC_DISPLAYS = {"Title", "Attachments", "__PowerAppsId__"}


def normalize(text: str) -> str:
    """Fold a legacy name so `TBL_PAGAMENTO (2)` and `TBL_PAGAMENTO_2` compare equal."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def is_system_column(label: str) -> bool:
    """Dataverse/SharePoint plumbing, with repeated underscores folded (`OData__ColorTag`)."""
    return re.sub(r"_+", "_", label.strip().lower()) in SYSTEM_COLUMNS


def is_base_currency(label: str) -> bool:
    lowered = label.strip().lower()
    return lowered.endswith("(base)") or lowered in {"exchangerate", "taxa de cambio"}


def find_app_source(root: Path, minimum_sources: int = MINIMUM_SOURCES) -> Path:
    """Return the newest unpacked app copy that carries at least `minimum_sources` folders."""
    best: tuple[float, Path] | None = None
    for candidate in sorted(root.rglob("DataSources")):
        if not candidate.is_dir():
            continue
        files = list(candidate.glob("*.json"))
        if len(files) < minimum_sources:
            continue
        stamp = max((path.stat().st_mtime for path in files), default=0.0)
        if best is None or stamp > best[0]:
            best = (stamp, candidate.parent)
    if best is None:
        raise FileNotFoundError(f"nenhuma copia da app com {minimum_sources}+ data sources em {root}")
    return best[1]


def read_field_references(
    source_dir: Path, universe: dict[str, set[str]]
) -> tuple[Counter, dict[str, set[str]]]:
    """Count display-name references (`'Aluno.Nome'`, `ThisItem.CLIENTE_NOME`) per table."""
    counts: Counter = Counter()
    where: dict[str, set[str]] = {}
    patterns = {
        display: re.compile(r"(?<![A-Za-z0-9_])" + re.escape(display) + r"(?![A-Za-z0-9_])")
        for display in universe
        if len(display) >= 4
    }
    files = sorted((source_dir / "Src").rglob("*.yaml")) + sorted((source_dir / "Src").rglob("*.json"))
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        for display, pattern in patterns.items():
            hits = len(pattern.findall(text))
            if not hits:
                continue
            for table in universe[display]:
                key = f"{table}|{display}"
                counts[key] += hits
                where.setdefault(key, set()).add(path.name)
    return counts, where


def read_workbook_headers(workbook: Path) -> dict[str, list[str]]:
    """Read row 1 of every sheet, exactly like `stage_legacy_workbook` does."""
    book = openpyxl.load_workbook(workbook, read_only=True, data_only=True)
    try:
        headers: dict[str, list[str]] = {}
        for sheet in book.sheetnames:
            row = next(book[sheet].iter_rows(min_row=1, max_row=1, values_only=True), ())
            headers[sheet] = [str(cell).strip() for cell in row if cell is not None]
        return headers
    finally:
        book.close()


def read_dataverse_entities(entities_dir: Path) -> dict[str, dict[str, Any]]:
    """Read `Entities/*/Entity.xml`: display name plus physical/display name of every attribute."""
    entities: dict[str, dict[str, Any]] = {}
    for folder in sorted(entities_dir.iterdir()):
        xml = folder / "Entity.xml"
        if not xml.exists():
            continue
        text = xml.read_text(encoding="utf-8-sig", errors="replace")
        name = re.search(r'<Name LocalizedName="([^"]+)"', text)
        display = name.group(1) if name else folder.name
        attributes = []
        for physical, body in re.findall(r'<attribute PhysicalName="([^"]+)">(.*?)</attribute>', text, re.S):
            label = re.search(r'<displayname[^>]*description="([^"]*)"', body)
            attributes.append({"physical": physical, "label": label.group(1) if label else physical})
        entities[display] = {"folder": folder.name, "attributes": attributes}
    return entities


def resolve_sheet(table: str, sheet_headers: dict[str, list[str]]) -> tuple[str | None, bool]:
    """Match a data source name to a worksheet; `True` when the match is exact (folded)."""
    folded = {normalize(sheet): sheet for sheet in sheet_headers}
    key = normalize(table)
    if key in folded:
        return folded[key], True
    for candidate, sheet in folded.items():
        if candidate.endswith(key) or key.endswith(candidate):
            return sheet, False
    return None, False


def resolve_variant_sheets(table: str, sheet_headers: dict[str, list[str]], taken: set[str]) -> list[str]:
    """Sheets whose name is the table name plus a suffix (`TBL_EXTRATO_FINANCEIRO`).

    The workbook carry both the canonical sheet and exports of the same table under a
    suffixed name. A suffixed sheet only counts as a variant when it has a header row and
    when its name is not already the canonical sheet of another data source or entity
    (`TBL_CLIENTEENDTEL` is not a variant of `TBL_CLIENTE`).
    """
    key = normalize(table)
    variants = []
    for sheet in sheet_headers:
        folded = normalize(sheet)
        if folded == key or not folded.startswith(key) or not sheet_headers[sheet]:
            continue
        if folded in taken:
            continue
        variants.append(sheet)
    return sorted(variants)


def sheet_coverage(sheet: str | None, sheet_headers: dict[str, list[str]], fields: list[str]) -> int:
    """How many of `fields` the sheet exposes (folded comparison, same rule as the stager)."""
    if not sheet:
        return 0
    columns = {normalize(column) for column in sheet_headers.get(sheet, ())}
    return sum(1 for field in fields if normalize(field) in columns)


def entity_columns(entity: dict[str, Any] | None) -> set[str]:
    """Every folded name the current Dataverse schema accepts for an entity."""
    if not entity:
        return set()
    names: set[str] = set()
    for attribute in entity["attributes"]:
        names.add(normalize(attribute["label"]))
        names.add(normalize(attribute["physical"]))
        names.add(normalize(re.sub(r"^cr04f_", "", attribute["physical"])))
    return names


def suggestions(name: str, candidates: list[str], cutoff: float = 0.8) -> list[str]:
    folded = {normalize(candidate): candidate for candidate in candidates}
    matches = difflib.get_close_matches(normalize(name), list(folded), n=3, cutoff=cutoff)
    return [folded[match] for match in matches]


def read_app_sources(source_dir: Path) -> list[dict[str, Any]]:
    """Read every entry of `DataSources/*.json` (tables, connectors, samples, views)."""
    entries: list[dict[str, Any]] = []
    for path in sorted((source_dir / "DataSources").glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            continue
        for entry in payload if isinstance(payload, list) else [payload]:
            mapping = (
                entry.get("NativeCDSDataSourceInfoNameMapping")
                or entry.get("ConnectedDataSourceInfoNameMapping")
                or {}
            )
            entries.append(
                {
                    "file": path.name,
                    "type": entry.get("Type") or "Unknown",
                    "name": entry.get("Name") or path.stem,
                    "logical": entry.get("LogicalName") or "",
                    "fields": {
                        logical: display
                        for logical, display in mapping.items()
                        if logical.startswith("cr04f_")
                        and not SYSTEM_ATTRIBUTE_SUFFIX.search(logical)
                        and display != (entry.get("Name") or path.stem)
                    },
                    "extra_fields": {
                        logical: display
                        for logical, display in mapping.items()
                        if not logical.startswith("cr04f_")
                    },
                    "detail": entry.get("ServiceKind")
                    or entry.get("TableName")
                    or entry.get("DatasetName")
                    or "",
                }
            )
    return entries


def audit(
    app_sources: list[dict[str, Any]],
    sheet_headers: dict[str, list[str]],
    entities: dict[str, dict[str, Any]],
    counts: Counter,
    where: dict[str, set[str]],
) -> dict[str, Any]:
    """Cross app data sources, workbook headers and Dataverse schema into the gap report."""
    table_kinds = {"NativeCDSDataSourceInfo"}
    external_kinds = {"ConnectedDataSourceInfo", "ServiceInfo", "ConnectedWadl"}
    tables = [source for source in app_sources if source["type"] in table_kinds]
    external = [source for source in app_sources if source["type"] in external_kinds]
    metadata = Counter(source["type"] for source in app_sources if source["type"] not in table_kinds | external_kinds)
    sheet_names = list(sheet_headers)
    entity_by_folded = {normalize(name): name for name in entities}

    tables_without_sheet: list[dict[str, Any]] = []
    name_mismatch: list[dict[str, Any]] = []
    field_gaps: list[dict[str, Any]] = []
    sheet_only_columns: list[dict[str, Any]] = []
    variant_sheets: list[dict[str, Any]] = []
    matched_sheets: set[str] = set()
    taken_sheets = {normalize(source["name"]) for source in tables} | set(entity_by_folded)

    for source in sorted(tables, key=lambda item: item["name"]):
        table = source["name"]
        primary, exact = resolve_sheet(table, sheet_headers)
        variants = resolve_variant_sheets(table, sheet_headers, taken_sheets)
        used = sorted(
            (
                (key.split("|", 1)[1], value)
                for key, value in counts.items()
                if key.startswith(f"{table}|")
                and not is_system_column(key.split("|", 1)[1])
                and key.split("|", 1)[1] not in GENERIC_DISPLAYS
            ),
            key=lambda item: (-item[1], item[0]),
        )
        used_fields = [field for field, _ in used]
        ranked = sorted(
            ((sheet_coverage(name, sheet_headers, used_fields), name) for name in variants),
            key=lambda item: (-item[0], item[1]),
        )
        sheet = primary
        if ranked and ranked[0][0] > sheet_coverage(primary, sheet_headers, used_fields):
            sheet = ranked[0][1]
        if sheet is None:
            tables_without_sheet.append(
                {
                    "table": table,
                    "logical": source["logical"],
                    "fields": len(source["fields"]),
                    "used": used[:8],
                    "used_total": len(used),
                    "suggestions": suggestions(table, sheet_names),
                    "variants": [{"sheet": name, "covered": covered} for covered, name in ranked if covered],
                }
            )
            continue
        matched_sheets.add(sheet)
        if primary:
            matched_sheets.add(primary)
        if sheet != primary:
            variant_sheets.append(
                {
                    "table": table,
                    "sheet": primary,
                    "variant": sheet,
                    "covered": sheet_coverage(sheet, sheet_headers, used_fields),
                    "used_total": len(used_fields),
                }
            )
        if not exact:
            name_mismatch.append({"table": table, "sheet": sheet})
        columns = sheet_headers[sheet]
        folded_columns = {normalize(column) for column in columns}
        entity_name = entity_by_folded.get(normalize(table))
        entity = entities.get(entity_name) if entity_name else None
        gaps = {"business": [], "base_currency": []}
        for display, references in used:
            if normalize(display) in folded_columns:
                continue
            bucket = "base_currency" if is_base_currency(display) else "business"
            gaps[bucket].append(
                {"field": display, "references": references, "files": sorted(where.get(f"{table}|{display}", ()))[:3]}
            )
        if any(gaps.values()):
            field_gaps.append({"table": table, "sheet": sheet, "variant": sheet != primary, **gaps})
        if entity:
            known = entity_columns(entity)
            unknown = [
                column
                for column in columns
                if normalize(column) not in known and not is_system_column(column)
            ]
            if unknown:
                sheet_only_columns.append({"table": table, "sheet": sheet, "columns": unknown})

    extra_sheets = [
        {
            "sheet": sheet,
            "columns": len(sheet_headers[sheet]),
            "entity": entity_by_folded.get(normalize(sheet)),
            "suggestions": suggestions(sheet, [source["name"] for source in tables] + list(entities)),
        }
        for sheet in sorted(sheet_headers)
        if sheet not in matched_sheets
    ]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "app_data_sources": len(app_sources),
            "app_tables": len(tables),
            "app_external_sources": len(external),
            "workbook_sheets": len(sheet_headers),
            "dataverse_entities": len(entities),
            "referenced_fields": len({key.split("|", 1)[1] for key in counts}),
            "variant_sheets": len(variant_sheets),
        },
        "tables_without_sheet": tables_without_sheet,
        "name_mismatch": name_mismatch,
        "variant_sheets": variant_sheets,
        "field_gaps": field_gaps,
        "sheet_only_columns": sheet_only_columns,
        "extra_sheets": extra_sheets,
        "external_sources": [
            {
                "type": source["type"],
                "name": source["name"],
                "detail": source["detail"],
                "fields": sorted(source["fields"].values()) + sorted(source["extra_fields"].values()),
            }
            for source in sorted(external, key=lambda item: item["name"])
        ],
        "metadata_sources": dict(sorted(metadata.items())),
    }


def render_report(report: dict[str, Any], inputs: dict[str, str]) -> str:
    """Render the markdown report consumed by the operator."""
    counts = report["counts"]
    lines: list[str] = [
        "# Lacunas entre o Canvas App legado e as planilhas do workbook",
        "",
        f"- Gerado em: `{report['generated_at']}`",
        f"- Fonte da app: `{inputs['app_source']}`",
        f"- Workbook: `{inputs['workbook']}`",
        f"- Solucao Dataverse: `{inputs['solution']}`",
        f"- Data sources da app: {counts['app_data_sources']} "
        f"({counts['app_tables']} tabelas Dataverse, {counts['app_external_sources']} fontes externas)",
        f"- Abas do workbook: {counts['workbook_sheets']} | Entidades Dataverse: {counts['dataverse_entities']} | "
        f"Campos referenciados pela app: {counts['referenced_fields']}",
        "- Script: `scripts/audit_legacy_app_sources.py` (somente leitura).",
        "",
        "## Leitura rapida",
        "",
        f"- {len(report['tables_without_sheet'])} tabelas lidas pela app nao tem aba no workbook.",
        f"- {counts['variant_sheets']} tabelas tem o conteudo em uma aba irma (ex.: `TBL_EXTRATO` vazio e "
        "`TBL_EXTRATO_FINANCEIRO` com os campos).",
        f"- {len(report['extra_sheets'])} abas do workbook nao correspondem a nenhuma entidade da app/Dataverse.",
        f"- {sum(len(gap['business']) for gap in report['field_gaps'])} campos de negocio lidos pela app faltam nas "
        "abas correspondentes.",
        f"- {sum(len(item['columns']) for item in report['sheet_only_columns'])} colunas das abas nao existem no schema "
        "atual do Dataverse (nome antigo ou sobra de exportacao).",
        f"- {len(report['external_sources'])} fontes externas (Excel Online e conectores) nunca estiveram no workbook.",
        "",
        "## 1. Tabelas que a app le e que nao existem no workbook",
        "",
        "| Tabela | Entidade Dataverse | Campos no schema | Campos usados pela app | Aba irma (cobertura) | "
        "Aba parecida no workbook |",
        "|---|---|---:|---:|---|---|",
    ]
    for item in report["tables_without_sheet"]:
        similar = ", ".join(item["suggestions"]) or "-"
        variants = ", ".join(
            f"`{variant['sheet']}` ({variant['covered']}/{item['used_total']})" for variant in item.get("variants", ())
        ) or "-"
        lines.append(
            f"| {item['table']} | `{item['logical']}` | {item['fields']} | {item['used_total']} | {variants} | {similar} |"
        )
    if not report["tables_without_sheet"]:
        lines.append("| - | - | - | - | - | - |")
    lines += ["", "Campos mais usados nessas tabelas ausentes:", ""]
    for item in report["tables_without_sheet"]:
        if not item["used"]:
            continue
        detail = ", ".join(f"`{field}` ({refs})" for field, refs in item["used"])
        lines.append(f"- `{item['table']}`: {detail}")
    lines += ["", "## 2. Divergencia de nome entre aba e entidade", ""]
    if report["name_mismatch"]:
        lines += ["| Tabela da app | Aba do workbook |", "|---|---|"]
        for item in report["name_mismatch"]:
            lines.append(f"| {item['table']} | {item['sheet']} |")
    else:
        lines.append("Nenhuma: toda aba corresponde exatamente ao nome da tabela da app.")
    lines += [
        "",
        "## 3. Abas do workbook sem entidade correspondente",
        "",
        "| Aba | Colunas | Entidade Dataverse | Nome mais proximo na app/Dataverse |",
        "|---|---:|---|---|",
    ]
    for item in report["extra_sheets"]:
        similar = ", ".join(item["suggestions"]) or "-"
        lines.append(f"| {item['sheet']} | {item['columns']} | {item['entity'] or '-'} | {similar} |")
    lines += [
        "",
        "## 3b. Abas irmas que entregam o conteudo da tabela",
        "",
        "Quando a aba com o nome exato da tabela esta vazia (ou nao existe) e uma aba com sufixo "
        "(`_FINANCEIRO`) tem os mesmos campos, o diagnostico usa a aba irma. A tabela nao esta sem aba: "
        "o conteudo dela esta apenas sob outro nome, e o stager/dicionario devem apontar para essa aba.",
        "",
    ]
    if report["variant_sheets"]:
        lines += ["| Tabela | Aba com o nome da tabela | Aba usada | Campos cobertos |", "|---|---|---|---|"]
        for item in report["variant_sheets"]:
            lines.append(
                f"| {item['table']} | {item['sheet'] or '-'} | {item['variant']} | "
                f"{item['covered']}/{item['used_total']} |"
            )
    else:
        lines.append("Nenhuma: toda tabela resolvida por aba com o nome exato tem os campos que a app usa.")
    lines += ["", "## 4. Campos de negocio que a app le e que a aba nao tem", ""]
    business = [gap for gap in report["field_gaps"] if gap["business"]]
    if business:
        lines += ["| Tabela | Aba | Campo | Referencias | Telas |", "|---|---|---|---:|---|"]
        for gap in business:
            for field in gap["business"]:
                files = ", ".join(field["files"]) or "-"
                lines.append(f"| {gap['table']} | {gap['sheet']} | `{field['field']}` | {field['references']} | {files} |")
    else:
        lines.append("Nenhum.")
    base_currency = [gap for gap in report["field_gaps"] if gap["base_currency"]]
    lines += ["", "Campos de moeda base (`* (Base)`, `ExchangeRate`) que a app enxerga e a aba nao tem:", ""]
    if base_currency:
        for gap in base_currency:
            fields = ", ".join(f"`{field['field']}` ({field['references']})" for field in gap["base_currency"])
            lines.append(f"- `{gap['table']}`: {fields}")
        lines.append("")
        lines.append("Sao o espelho em moeda base do proprio valor: derivaveis, nao bloqueiam a migracao.")
    else:
        lines.append("Nenhum.")
    lines += ["", "## 5. Colunas das abas que nao existem no schema atual do Dataverse", ""]
    if report["sheet_only_columns"]:
        lines += ["| Aba | Colunas |", "|---|---|"]
        for item in report["sheet_only_columns"]:
            lines.append(f"| {item['sheet']} | " + ", ".join(f"`{column}`" for column in item["columns"]) + " |")
    else:
        lines.append("Nenhuma.")
    lines += ["", "## 6. Fontes fora do Dataverse", ""]
    if report["external_sources"]:
        lines += ["| Tipo | Fonte | Detalhe | Campos |", "|---|---|---|---|"]
        for item in report["external_sources"]:
            fields = ", ".join(f"`{field}`" for field in item["fields"]) or "-"
            lines.append(f"| {item['type']} | {item['name']} | `{item['detail']}` | {fields} |")
    else:
        lines.append("Nenhuma.")
    if report["metadata_sources"]:
        lines += [
            "",
            "Metadados da app sem dado de negocio (nao precisam de aba): "
            + ", ".join(f"{kind}={total}" for kind, total in report["metadata_sources"].items())
            + ".",
        ]
    lines += [
        "",
        "## 7. Leitura e decisoes pendentes",
        "",
        "- As secoes 1 e 4 sao o que a app consegue ler e o workbook nao entrega: sem elas a tela legada nao e "
        "reproduzivel so com a planilha.",
        "- A secao 5 e o inverso: nome antigo dentro da aba (ex.: `CONTA_DESCRICAO`) escondendo a coluna real "
        "(`CONTA_NOME`). Precisa de decisao de mapeamento, nao de nova exportacao.",
        "- A secao 3b mostra onde o dado existe, mas sob outro nome de aba: nao falta exportacao, falta apontar o "
        "stager e o dicionario (`scripts/legacy_field_map.json`) para a aba irma.",
        "- A secao 3 lista abas auxiliares (manual/exportacao duplicada) que nao representam entidade.",
        "- Nada aqui conecta no banco nem escreve linha canonica; o script apenas le app, workbook e solucao.",
        "",
        "Decisoes sugeridas ao operador:",
        "",
        "1. `TBL_CONTA.CONTA_NOME` e `TBL_CENTRODECUSTO.EMPRESA_ID`: confirmar o nome atual no Dataverse e ajustar o "
        "dicionario; a coluna antiga da aba (`CONTA_DESCRICAO`, `CENTRODECUSTO_EMPRESA_ID`, `EMPRESA_NOME`) passa a "
        "`ignore` com motivo explicito.",
        "2. `TBL_EMAILLISTACONTATO` (aba) x `TBL_EMAILISTACONTATO` (entidade): corrigir o nome da aba ou registrar "
        "como aba auxiliar, confirmando na origem por que ela veio vazia.",
        "3. Tabelas da secao 1: hoje restam `TBL_CONSULTA` (um lookup para `TBL_CONSULTA_CONTATO`, que ja "
        "tem aba) e `TBL_EMAILISTACONTATO` (contato de cobranca). As demais tabelas que faltavam entraram no "
        "workbook em 2026-09-25 e ja estao no dicionario com motivo proprio (`payables_not_modeled`, "
        "`billing_integration_not_modeled`, `dre_not_modeled`, `no_canonical_destination`).",
        "4. Fontes externas da secao 6: fora do escopo da planilha; documentar como dependencia de integracao "
        "(Asaas, e-mail e planilha de extrato no OneDrive).",
        "5. Abas da secao 3b: decidir entre preencher a aba com o nome da tabela ou declarar a aba irma como "
        "origem no stager e no dicionario (hoje as tres estao declaradas como `defer`).",
        "",
    ]
    return "\n".join(lines)


def collect(app_source: Path, workbook: Path, solution: Path) -> dict[str, Any]:
    """Run the whole read-only audit and return the structured report."""
    app_sources = read_app_sources(app_source)
    sheet_headers = read_workbook_headers(workbook)
    entities = read_dataverse_entities(solution)
    universe: dict[str, set[str]] = {}
    for source in app_sources:
        if source["type"] != "NativeCDSDataSourceInfo":
            continue
        for display in source["fields"].values():
            universe.setdefault(display, set()).add(source["name"])
    counts, where = read_field_references(app_source, universe)
    return audit(app_sources, sheet_headers, entities, counts, where)


def as_relative(path: Path, base: Path) -> str:
    """Keep the generated report free of machine-specific absolute paths when possible."""
    try:
        return str(path.resolve().relative_to(base.resolve())).replace("\\", "/")
    except ValueError:
        return str(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compara o Canvas App legado com as planilhas do workbook.")
    parser.add_argument("--app-root", type=Path, default=DEFAULT_APP_ROOT, help="raiz onde procurar a copia da app")
    parser.add_argument("--app-source", type=Path, default=None, help="copia descompactada da app (default: a mais nova)")
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--solution", type=Path, default=DEFAULT_SOLUTION, help="pasta Entities da solucao Dataverse")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="markdown de saida")
    parser.add_argument("--json", type=Path, default=None, help="artefato JSON opcional")
    parser.add_argument("--no-write", action="store_true", help="somente imprimir o resumo")
    args = parser.parse_args(argv)

    for label, path in (("workbook", args.workbook), ("solucao Dataverse", args.solution)):
        if not path.exists():
            print(f"caminho ausente: {label} -> {path}")
            return 2
    app_source = args.app_source if args.app_source else find_app_source(args.app_root)
    if not (app_source / "DataSources").is_dir():
        print(f"copia da app sem DataSources: {app_source}")
        return 2

    report = collect(app_source, args.workbook, args.solution)
    counts = report["counts"]
    print(f"fonte da app: {app_source}")
    print(
        f"data sources: {counts['app_data_sources']} "
        f"({counts['app_tables']} tabelas, {counts['app_external_sources']} fontes externas)"
    )
    print(f"abas do workbook: {counts['workbook_sheets']} | entidades Dataverse: {counts['dataverse_entities']}")
    print(f"campos referenciados pela app: {counts['referenced_fields']}")
    print(f"tabelas sem aba: {len(report['tables_without_sheet'])}")
    print(f"campos de negocio ausentes na aba: {sum(len(gap['business']) for gap in report['field_gaps'])}")
    print(f"colunas das abas fora do schema atual: {sum(len(item['columns']) for item in report['sheet_only_columns'])}")
    print(f"abas sem entidade: {len(report['extra_sheets'])} | fontes externas: {len(report['external_sources'])}")

    if args.json:
        write_text_file(args.json, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(f"json: {args.json}")
    if not args.no_write:
        inputs = {
            "app_source": as_relative(app_source, DEFAULT_ROOT),
            "workbook": as_relative(args.workbook, DEFAULT_ROOT),
            "solution": as_relative(args.solution, DEFAULT_ROOT),
        }
        write_text_file(args.report, render_report(report, inputs))
        print(f"relatorio: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



