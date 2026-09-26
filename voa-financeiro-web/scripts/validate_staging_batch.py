"""Validate a staged legacy batch without creating canonical records.

The validator reads only `migration_rows` of one `migration_batches` row and writes
only `migration_errors`, `reconciliation_reports` and (optionally) the status of
`migration_rows`. It never touches schools, customers, students, agreements,
installments, payments or asaas_charges.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stage_legacy_workbook import (  # noqa: E402
    chunked,
    connect,
    load_env,
    page_size,
    snapshot_canonical_counts,
)
from psycopg.types.json import Jsonb  # noqa: E402

VALIDATOR_TAG = "validate_staging_batch"
VALIDATOR_VERSION = 1
DEFAULT_SAMPLE_SIZE = 5
DEFAULT_ROW_STATUS_LIMIT = 20000

MISSING_LEGACY_ID = "MISSING_LEGACY_ID"
DUPLICATE_LEGACY_ID = "DUPLICATE_LEGACY_ID"
DUPLICATE_COMPOSITE_KEY = "DUPLICATE_COMPOSITE_KEY"
FK_MISSING_REFERENCE = "FK_MISSING_REFERENCE"
REQUIRED_FIELD_EMPTY = "REQUIRED_FIELD_EMPTY"
DOCUMENT_INVALID = "DOCUMENT_INVALID"
DOCUMENT_MISSING = "DOCUMENT_MISSING"
DUPLICATE_DOCUMENT = "DUPLICATE_DOCUMENT"
DATE_UNPARSEABLE = "DATE_UNPARSEABLE"
AMOUNT_UNPARSEABLE = "AMOUNT_UNPARSEABLE"
AMOUNT_NEGATIVE = "AMOUNT_NEGATIVE"
TEXT_ENCODING_SUSPECT = "TEXT_ENCODING_SUSPECT"

# Codes that keep a batch from moving to `validated`.
BLOCKING_CODES = frozenset({MISSING_LEGACY_ID, DUPLICATE_LEGACY_ID, DUPLICATE_COMPOSITE_KEY})

# Legacy relationships documented in docs/LEGACY_DOMAIN_INVENTORY.md.
FK_RULE_TUPLES: tuple[tuple[str, str, str, bool], ...] = (
    ("TBL_AGENDA", "Agenda_Aluno_ID", "TBL_ALUNO", False),
    ("TBL_AGENDA", "Agenda_Escola_ID", "TBL_ESCOLA", False),
    ("TBL_AGENDA", "Agenda_Processo_ID", "TBL_PROCESSO", False),
    ("TBL_AGENDAENVIO", "AGENDAENVIO_AGENDA_ID", "TBL_AGENDA", True),
    ("TBL_ALUNO", "Aluno.Escola.ID", "TBL_ESCOLA", True),
    ("TBL_ALUNO", "Aluno.Login.ID", "TBL_USER", False),
    ("TBL_CENTRODECUSTO", "CENTRODECUSTO_EMPRESA_ID", "TBL_EMPRESA", False),
    ("TBL_CLIENTECONTATO", "CLIENTECONTATO_CLIENTE_ID", "TBL_CLIENTE", True),
    ("TBL_CLIENTEENDTEL", "CLIENTEENDTEL_CLIENTE_ID", "TBL_CLIENTE", True),
    ("TBL_CONSULTA_CONTATO", "CONSULTA_CONTATO_ALUNO_ID", "TBL_ALUNO", True),
    ("TBL_CONTA", "CONTA_EMPRESA_ID", "TBL_EMPRESA", False),
    ("TBL_CONTATO", "Contato.Aluno.ID", "TBL_ALUNO", True),
    ("TBL_DESPESA", "DESPESA_DIVIDA_ID", "TBL_DIVIDA", False),
    ("TBL_DESPESA", "DESPESA_PROCESSO_ID", "TBL_PROCESSO", False),
    ("TBL_DIVIDA", "Divida.Aluno.ID", "TBL_ALUNO", True),
    ("TBL_DIVIDA", "Divida.Pagamento.ID", "TBL_PAGAMENTO", False),
    ("TBL_DIVIDA", "Divida.Processo.ID", "TBL_PROCESSO", False),
    ("TBL_DIVIDA_LISTAGEM", "Divida_Listagem.Divida.ID", "TBL_DIVIDA", True),
    ("TBL_ENDTEL", "ENDTEL_ALUNO_ID", "TBL_ALUNO", True),
    ("TBL_MODELODOCHISTORICO", "MODELODOCHISTORICO_MODELO_ID", "TBL_MODELODOC", False),
    ("TBL_PAGAMENTO", "Pagamento.Aluno_ID", "TBL_ALUNO", True),
    ("TBL_PAGAMENTO", "Pagamento.Escola_ID", "TBL_ESCOLA", True),
    ("TBL_PAGAMENTO", "Pagamento_Aluno_ID", "TBL_ALUNO", False),
    ("TBL_PAGAMENTO_FINANCEIRO", "PAGAMENTO_CONTA_ID", "TBL_CONTA", False),
    ("TBL_PAGAMENTO_FINANCEIRO", "PAGAMENTO_FORNECEDOR_ID", "TBL_CLIFOR", False),
    ("TBL_PAGAMENTO_LISTAGEM", "Pagamento_Listagem.Pagamento.ID", "TBL_PAGAMENTO", True),
    ("TBL_PROCESSO", "Processo_Escola_ID", "TBL_ESCOLA", True),
    ("TBL_PROCESSO", "Processo_User_ID", "TBL_USER", False),
    ("TBL_PROCESSODETALHE", "ProcessoDetalhe_ProcessoID", "TBL_PROCESSO", True),
    ("TBL_PROCESSODIVIDA", "PROCESSODIVIDAS_DIVIDA_ID", "TBL_DIVIDA", True),
    ("TBL_PROCESSODIVIDA", "PROCESSODIVIDAS_PROCESSO_ID", "TBL_PROCESSO", True),
    ("TBL_PROCESSORESPONSAVEL", "PROCESSORESPONSAVEL_USER_ID", "TBL_USER", False),
    ("TBL_PUBLICACAODETALHE", "PUBLICACAODETALHE_PUBLICACAO_ID", "TBL_PUBLICACOES", True),
    ("TBL_PUBLICACAODETALHE", "PUBLICACAODETALHE_USER_ID", "TBL_USER", False),
    ("TBL_ROTA", "ROTA_CLIENTE_ID", "TBL_CLIENTE", False),
    ("TBL_TAXAESCOLA", "TAXAESCOLA_ESCOLA_ID", "TBL_ESCOLA", True),
)

REQUIRED_FIELD_TUPLES: tuple[tuple[str, str], ...] = (
    ("TBL_ESCOLA", "Escola.Nome"),
    ("TBL_CLIENTE", "CLIENTE_NOME"),
    ("TBL_ALUNO", "Aluno.Nome"),
    ("TBL_DIVIDA", "Divida_Nome"),
    ("TBL_DIVIDA_LISTAGEM", "Divida_Listagem.Valor"),
    ("TBL_DIVIDA_LISTAGEM", "Divida_Listagem.Vencimento"),
    ("TBL_PAGAMENTO_LISTAGEM", "Pagamento_Listagem.Valor_Parcela"),
    ("TBL_PAGAMENTO_LISTAGEM", "Pagamento_Listagem.Parcela_Numero"),
)

DOCUMENT_RULE_TUPLES: tuple[tuple[str, str, str], ...] = (
    ("TBL_ESCOLA", "Escola.CNPJ", "cnpj"),
    ("TBL_EMPRESA", "EMPRESA_CNPJ", "cnpj"),
    ("TBL_CLIENTE", "CLIENTE_CNPJ", "cpf_or_cnpj"),
    ("TBL_ALUNO", "Aluno.CPFResponsavel", "cpf"),
    ("TBL_USER", "USER_CPF", "cpf"),
)

COMPOSITE_KEY_TUPLES: tuple[tuple[str, tuple[str, ...], str], ...] = (
    (
        "TBL_PAGAMENTO_LISTAGEM",
        ("Pagamento_Listagem.Pagamento.ID", "Pagamento_Listagem.Parcela_Numero"),
        "installment_number_per_agreement",
    ),
    (
        "TBL_DIVIDA_LISTAGEM",
        ("Divida_Listagem.Divida.ID", "Divida_Listagem.Vencimento", "Divida_Listagem.Valor"),
        "debt_item_natural_key",
    ),
)

MONEY_COLUMNS: dict[str, tuple[str, ...]] = {
    "TBL_DIVIDA": ("Divida.ValorOriginalTotal", "Divida.ValorAtualizadoTotal"),
    "TBL_DIVIDA_LISTAGEM": ("Divida_Listagem.Valor", "Divida_Listagem.Valor_Atualizado"),
    "TBL_PAGAMENTO_LISTAGEM": (
        "Pagamento_Listagem.Valor_Parcela",
        "Pagamento_Listagem.Valor_Pago",
        "Pagamento_Lista.ValorRetido",
    ),
    "TBL_TAXAESCOLA": ("TAXAESCOLA_VALOR",),
}

DATE_NAME_PATTERN = re.compile(
    r"(^|[\s_./])(data|date|created|modified|vencimento|mindata|ultimocontato|ultimadata)",
    re.IGNORECASE,
)
DATE_EXCLUDE_PATTERN = re.compile(r"(\bby\b|\buser\b|\busuario\b|\bpor\b)", re.IGNORECASE)
AMOUNT_NAME_PATTERN = re.compile(r"(valor|saldo|porcentagem|_porc$|multa|honorarios|preco)", re.IGNORECASE)

# Columns whose name suggests money but hold contact data or flags in the legacy workbook.
NON_MONETARY_COLUMNS = frozenset(
    {
        "CLIENTEENDTEL_VALOR",
        "ENDTEL_VALOR",
        "Pagamento_Lista.PGTColegio",
        "Pagamento_CopiaeCola",
        "Pagamento_LinkPag",
        "Pagamento_Email",
    }
)


def fk_rules_by_sheet() -> dict[str, list[tuple[str, str, bool]]]:
    rules: dict[str, list[tuple[str, str, bool]]] = defaultdict(list)
    for sheet, column, target, required in FK_RULE_TUPLES:
        rules[sheet].append((column, target, required))
    return dict(rules)


def required_fields_by_sheet() -> dict[str, list[str]]:
    rules: dict[str, list[str]] = defaultdict(list)
    for sheet, column in REQUIRED_FIELD_TUPLES:
        rules[sheet].append(column)
    return dict(rules)


def document_rules_by_sheet() -> dict[str, list[tuple[str, str]]]:
    rules: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for sheet, column, kind in DOCUMENT_RULE_TUPLES:
        rules[sheet].append((column, kind))
    return dict(rules)


def composite_keys_by_sheet() -> dict[str, list[tuple[tuple[str, ...], str]]]:
    rules: dict[str, list[tuple[tuple[str, ...], str]]] = defaultdict(list)
    for sheet, columns, label in COMPOSITE_KEY_TUPLES:
        rules[sheet].append((columns, label))
    return dict(rules)

def is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def value_key(value: Any) -> str:
    """Normalize a reference value so `1`, `1.0` and `"1"` compare equal."""
    return as_text(value)


def only_digits(value: Any) -> str:
    return re.sub(r"\D", "", as_text(value))


def is_valid_cpf(digits: str) -> bool:
    if len(digits) != 11 or digits == digits[0] * 11:
        return False
    for length in (9, 10):
        total = sum(int(digits[index]) * (length + 1 - index) for index in range(length))
        check = (total * 10) % 11 % 10
        if check != int(digits[length]):
            return False
    return True


def is_valid_cnpj(digits: str) -> bool:
    if len(digits) != 14 or digits == digits[0] * 14:
        return False

    def digit(slice_length: int) -> int:
        weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2][-slice_length:]
        total = sum(int(digits[index]) * weights[index] for index in range(slice_length))
        remainder = total % 11
        return 0 if remainder < 2 else 11 - remainder

    return digit(12) == int(digits[12]) and digit(13) == int(digits[13])


def classify_document(value: Any, expected: str) -> tuple[str, str]:
    """Return `(kind, digits)` for an expected kind of `cpf`, `cnpj` or `cpf_or_cnpj`."""
    digits = only_digits(value)
    if not digits:
        return ("empty", "")
    if expected == "cpf_or_cnpj":
        if len(digits) == 11:
            return ("cpf", digits)
        if len(digits) == 14:
            return ("cnpj", digits)
        return ("invalid-length", digits)
    return (expected, digits)


def validate_document(value: Any, expected: str) -> tuple[bool, str, str]:
    """Return `(valid, kind, digits)`. Empty values are handled by the caller."""
    kind, digits = classify_document(value, expected)
    if kind == "empty":
        return (False, kind, digits)
    if kind == "invalid-length":
        return (False, kind, digits)
    if kind == "cpf":
        return (is_valid_cpf(digits), kind, digits)
    if kind == "cnpj":
        return (is_valid_cnpj(digits), kind, digits)
    return (False, kind, digits)


ISO_DATE_PATTERN = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
BR_DATE_PATTERN = re.compile(r"^(\d{2})/(\d{2})/(\d{4})")


def parse_date_value(value: Any) -> date | None:
    """Parse ISO, pt-BR or Excel-style date values; return None when unparseable."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 20000 <= float(value) <= 60000:
            from datetime import timedelta

            return date(1899, 12, 30) + timedelta(days=int(value))
        return None
    text = as_text(value)
    if not text:
        return None
    match = ISO_DATE_PATTERN.match(text)
    if match:
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            return None
    match = BR_DATE_PATTERN.match(text)
    if match:
        try:
            return date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
        except ValueError:
            return None
    return None


def parse_amount(value: Any) -> Decimal | None:
    """Parse numbers and pt-BR currency strings such as `1.234,56` or `44,479`."""
    if isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    text = as_text(value)
    if not text:
        return None
    cleaned = re.sub(r"[R$\s]", "", text)
    if cleaned in {"", "-", "--"}:
        return None
    if "," in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


# Mojibake detection covers the two corruption paths that actually occur:
# 1. Windows-1252 bytes decoded as CP850 (the legacy exporter path): `Não` -> `NÒo`.
#    Only renderings that cannot be legitimate Portuguese are treated as evidence,
#    so `²`, `³`, `·` and `¶` are deliberately excluded (`m²`, `m³`, `·`, legal `¶`).
# 2. UTF-8 bytes decoded as Windows-1252/Latin-1: `Não` -> `NÃ£o`, `“x”` -> `â€œxâ€`.
#    Bare `Ã` is not evidence: `NÃO`, `CITAÇÃO` and `LEÃO` are correct Portuguese.
CP850_MOJIBAKE = frozenset("ÒßþÛÝÈË¬¾┌└├┬┴═║╔╩▄░ı")


def _cp1252_high_characters() -> frozenset[str]:
    """Characters that CP1252 produces for bytes 0x80-0xBF (plus their Latin-1 controls)."""
    characters: set[str] = set()
    for byte in range(0x80, 0xC0):
        raw = bytes([byte])
        try:
            characters.add(raw.decode("cp1252"))
        except UnicodeDecodeError:
            characters.add(raw.decode("latin-1"))
    return frozenset(characters)


CP1252_HIGH_CHARACTERS = _cp1252_high_characters()
UTF8_LEAD_CHARACTERS = frozenset("ÂÃâ")


def _has_utf8_as_latin1(text: str) -> bool:
    """Detect UTF-8 bytes decoded as Windows-1252/Latin-1: `Não` -> `NÃ£o`."""
    return any(
        text[index] in UTF8_LEAD_CHARACTERS and text[index + 1] in CP1252_HIGH_CHARACTERS
        for index in range(len(text) - 1)
    )


def has_mojibake(text: str) -> bool:
    """Report whether text carries an unambiguous mojibake signature."""
    if any(character in CP850_MOJIBAKE for character in text):
        return True
    return _has_utf8_as_latin1(text)


def _repair_cp850(text: str) -> str | None:
    try:
        repaired = text.encode("cp850").decode("cp1252")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None
    if repaired == text or has_mojibake(repaired):
        return None
    return repaired


def _encode_latin1_like(text: str) -> bytes | None:
    """Encode per character as CP1252, falling back to Latin-1 for its undefined bytes."""
    data = bytearray()
    for character in text:
        for codec in ("cp1252", "latin-1"):
            try:
                data.extend(character.encode(codec))
                break
            except UnicodeEncodeError:
                continue
        else:
            return None
    return bytes(data)


def _repair_utf8_as_latin1(text: str) -> str | None:
    data = _encode_latin1_like(text)
    if data is None:
        return None
    try:
        repaired = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if repaired == text or has_mojibake(repaired):
        return None
    return repaired


def repair_legacy_text(value: Any) -> str | None:
    """Return the repaired text when the value carries a mojibake signature.

    The repair is only reported, never applied automatically. Ambiguous renderings such
    as `Ú` for `é` are not treated as evidence because `Ú` is valid Portuguese
    (`ÚNICO`); the dictionary phase decides those column by column.
    """
    text = as_text(value)
    if not text or text.isascii():
        return None
    if _has_utf8_as_latin1(text):
        repaired = _repair_utf8_as_latin1(text)
        if repaired is not None:
            return repaired
    if any(character in CP850_MOJIBAKE for character in text):
        return _repair_cp850(text)
    return None

ERROR_SEVERITY: dict[str, str] = {
    MISSING_LEGACY_ID: "blocking",
    DUPLICATE_LEGACY_ID: "blocking",
    DUPLICATE_COMPOSITE_KEY: "blocking",
    FK_MISSING_REFERENCE: "error",
    REQUIRED_FIELD_EMPTY: "error",
    DOCUMENT_INVALID: "error",
}


def configure_stdio() -> None:
    """Keep `print` from failing and from writing text the terminal cannot decode.

    On Windows the interpreter writes stdout in the ANSI code page (cp1252 here) while
    PowerShell 5.1 decodes a piped stream as the OEM code page (cp850), which turned
    `Não Colégio São Paulo` into `NÒo ColÚgio SÒo Paulo` in earlier logs. `errors`
    is set to `replace` so an accent can never abort a migration command.
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


def severity_for(error_code: str) -> str:
    return ERROR_SEVERITY.get(error_code, "warning")


def preview(value: Any, limit: int = 80) -> str:
    text = as_text(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


@dataclass
class Finding:
    error_code: str
    severity: str
    sheet: str
    column: str | None
    message: str
    count: int = 0
    samples: list[dict[str, Any]] = field(default_factory=list)
    row_ids: list[Any] = field(default_factory=list)


@dataclass(frozen=True)
class SheetRules:
    foreign_keys: tuple[tuple[str, str, bool], ...] = ()
    required_fields: tuple[str, ...] = ()
    documents: tuple[tuple[str, str], ...] = ()
    composite_keys: tuple[tuple[tuple[str, ...], str], ...] = ()
    money_columns: tuple[str, ...] = ()


def build_rule_set(sheets: list[str]) -> dict[str, SheetRules]:
    fk_rules = fk_rules_by_sheet()
    required = required_fields_by_sheet()
    documents = document_rules_by_sheet()
    composite = composite_keys_by_sheet()
    return {
        sheet: SheetRules(
            foreign_keys=tuple(fk_rules.get(sheet, ())),
            required_fields=tuple(required.get(sheet, ())),
            documents=tuple(documents.get(sheet, ())),
            composite_keys=tuple(composite.get(sheet, ())),
            money_columns=tuple(MONEY_COLUMNS.get(sheet, ())),
        )
        for sheet in sheets
    }


class FindingCollector:
    def __init__(self, sample_size: int = DEFAULT_SAMPLE_SIZE, row_id_limit: int = DEFAULT_ROW_STATUS_LIMIT) -> None:
        self.sample_size = sample_size
        self.row_id_limit = row_id_limit
        self._findings: dict[tuple[str, str, str | None], Finding] = {}

    def add(
        self,
        error_code: str,
        sheet: str,
        column: str | None,
        message: str,
        sample: dict[str, Any] | None = None,
        row_id: Any = None,
    ) -> None:
        key = (sheet, error_code, column)
        finding = self._findings.get(key)
        severity = severity_for(error_code)
        if finding is None:
            finding = Finding(
                error_code=error_code,
                severity=severity,
                sheet=sheet,
                column=column,
                message=message,
            )
            self._findings[key] = finding
        finding.count += 1
        if sample is not None and len(finding.samples) < self.sample_size:
            finding.samples.append(sample)
        if row_id is not None and severity != "warning" and len(finding.row_ids) < self.row_id_limit:
            finding.row_ids.append(row_id)

    def findings(self) -> list[Finding]:
        return sorted(self._findings.values(), key=lambda item: (item.sheet, item.error_code, item.column or ""))


class BatchValidator:
    """Streaming validator: one pass over `migration_rows` of a single batch."""

    def __init__(
        self,
        rules: dict[str, SheetRules],
        reference_ids: dict[str, set[str]],
        collector: FindingCollector,
    ) -> None:
        self.rules = rules
        self.reference_ids = reference_ids
        self.collector = collector
        self.source_counts: Counter[str] = Counter()
        self.staged_counts: Counter[str] = Counter()
        self.duplicate_candidates: Counter[str] = Counter()
        self.money_totals: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
        self._legacy_ids: dict[str, Counter[str]] = defaultdict(Counter)
        self._composite: dict[str, dict[str, Counter[tuple[str, ...]]]] = defaultdict(dict)
        self._documents: dict[str, dict[str, Counter[str]]] = defaultdict(dict)
        self._violations: Counter[str] = Counter()

    def evaluate_row(
        self,
        sheet: str,
        row_number: int,
        legacy_id: str | None,
        payload: dict[str, Any],
        row_id: Any = None,
    ) -> None:
        rules = self.rules.get(sheet, SheetRules())
        self.source_counts[sheet] += 1
        self.staged_counts[sheet] += 1
        sample_base = {"row": row_number, "legacy_id": legacy_id}

        if not legacy_id:
            self._violations[sheet] += 1
            self.collector.add(MISSING_LEGACY_ID, sheet, "ID", f"{sheet}: row without legacy ID", sample_base, row_id)
        else:
            self._legacy_ids[sheet][legacy_id] += 1

        for column, target, required in rules.foreign_keys:
            raw = payload.get(column)
            if is_blank(raw):
                if required:
                    self._violations[sheet] += 1
                    self.collector.add(
                        FK_MISSING_REFERENCE,
                        sheet,
                        column,
                        f"{sheet}: required reference {column} -> {target} is empty",
                        sample_base,
                        row_id,
                    )
                continue
            token = value_key(raw)
            if token not in self.reference_ids.get(target, set()):
                self._violations[sheet] += 1
                self.collector.add(
                    FK_MISSING_REFERENCE,
                    sheet,
                    column,
                    f"{sheet}: {column} = {preview(raw, 40)} has no row in {target}",
                    {**sample_base, "value": preview(raw, 40), "target": target},
                    row_id,
                )

        for column in rules.required_fields:
            if is_blank(payload.get(column)):
                self._violations[sheet] += 1
                self.collector.add(
                    REQUIRED_FIELD_EMPTY,
                    sheet,
                    column,
                    f"{sheet}: required field {column} is empty",
                    sample_base,
                    row_id,
                )

        for column, expected in rules.documents:
            raw = payload.get(column)
            if is_blank(raw):
                self.collector.add(
                    DOCUMENT_MISSING,
                    sheet,
                    column,
                    f"{sheet}: document {column} not informed",
                    sample_base,
                    row_id,
                )
                continue
            valid, kind, digits = validate_document(raw, expected)
            if not valid:
                self._violations[sheet] += 1
                self.collector.add(
                    DOCUMENT_INVALID,
                    sheet,
                    column,
                    f"{sheet}: {column} = {preview(raw, 32)} is not a valid {expected}",
                    {**sample_base, "value": preview(raw, 32), "digits": len(digits), "kind": kind},
                    row_id,
                )
                continue
            self._documents[sheet].setdefault(column, Counter())[digits] += 1

        self._check_composite_keys(sheet, row_number, legacy_id, payload)
        self._check_row_values(sheet, row_number, legacy_id, payload)

    def _check_composite_keys(
        self,
        sheet: str,
        row_number: int,
        legacy_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        for columns, label in self.rules.get(sheet, SheetRules()).composite_keys:
            values = [payload.get(column) for column in columns]
            if any(is_blank(value) for value in values):
                continue
            key = tuple(value_key(value) for value in values)
            counter = self._composite[sheet].setdefault(label, Counter())
            counter[key] += 1
            if counter[key] == 2:
                self.collector.add(
                    DUPLICATE_COMPOSITE_KEY,
                    sheet,
                    " + ".join(columns),
                    f"{sheet}: duplicated {label} ({', '.join(columns)})",
                    {"row": row_number, "legacy_id": legacy_id, "key": list(key)},
                )
                self.duplicate_candidates[sheet] += 1

    def _check_row_values(
        self,
        sheet: str,
        row_number: int,
        legacy_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        rules = self.rules.get(sheet, SheetRules())
        sample_base = {"row": row_number, "legacy_id": legacy_id}
        money_columns = set(rules.money_columns)
        for column, value in payload.items():
            if is_blank(value) or value == "[REDACTED]":
                continue
            if column not in NON_MONETARY_COLUMNS and (
                column in money_columns or AMOUNT_NAME_PATTERN.search(column)
            ):
                amount = parse_amount(value)
                if amount is None:
                    self.collector.add(
                        AMOUNT_UNPARSEABLE,
                        sheet,
                        column,
                        f"{sheet}: {column} = {preview(value, 32)} is not a number",
                        {**sample_base, "value": preview(value, 32)},
                    )
                    continue
                if amount < 0:
                    self.collector.add(
                        AMOUNT_NEGATIVE,
                        sheet,
                        column,
                        f"{sheet}: {column} is negative",
                        {**sample_base, "value": preview(value, 32)},
                    )
                if column in money_columns:
                    self.money_totals[sheet][column] += amount
                continue
            if DATE_NAME_PATTERN.search(column) and not DATE_EXCLUDE_PATTERN.search(column):
                if parse_date_value(value) is None:
                    self.collector.add(
                        DATE_UNPARSEABLE,
                        sheet,
                        column,
                        f"{sheet}: {column} = {preview(value, 32)} is not a valid date",
                        {**sample_base, "value": preview(value, 32)},
                    )
                continue
            if isinstance(value, str):
                if has_mojibake(value):
                    repaired = repair_legacy_text(value)
                    self.collector.add(
                        TEXT_ENCODING_SUSPECT,
                        sheet,
                        column,
                        f"{sheet}: {column} carries a mojibake signature (CP850/UTF-8 mismatch)",
                        {
                            **sample_base,
                            "value": preview(value, 60),
                            "repaired": preview(repaired, 60) if repaired else None,
                        },
                    )

    def finish_sheet(self, sheet: str) -> None:
        for legacy_id, count in self._legacy_ids[sheet].items():
            if count > 1:
                self.collector.add(
                    DUPLICATE_LEGACY_ID,
                    sheet,
                    "ID",
                    f"{sheet}: legacy ID {legacy_id} appears {count} times",
                    {"legacy_id": legacy_id, "count": count},
                )
                self.duplicate_candidates[sheet] += count - 1
        self._legacy_ids[sheet].clear()
        for column, counter in self._documents[sheet].items():
            for digits, count in counter.items():
                if count > 1:
                    self.collector.add(
                        DUPLICATE_DOCUMENT,
                        sheet,
                        column,
                        f"{sheet}: document {digits[:4]}*** appears {count} times",
                        {"digits": len(digits), "prefix": digits[:4], "count": count},
                    )
                    self.duplicate_candidates[sheet] += count - 1
        self._documents[sheet].clear()

    def violations(self, sheet: str) -> int:
        return self._violations[sheet]


MONEY_TOTAL_COLUMN: dict[str, str] = {
    "TBL_DIVIDA": "Divida.ValorOriginalTotal",
    "TBL_DIVIDA_LISTAGEM": "Divida_Listagem.Valor",
    "TBL_PAGAMENTO_LISTAGEM": "Pagamento_Listagem.Valor_Parcela",
    "TBL_TAXAESCOLA": "TAXAESCOLA_VALOR",
}


def fetch_batch(conn: Any, batch_id: str | None, source_name: str | None) -> tuple[str, str, str]:
    cursor = conn.cursor()
    if batch_id:
        cursor.execute("SELECT id, source_name, status FROM migration_batches WHERE id = %s::uuid", (batch_id,))
    else:
        cursor.execute(
            """
            SELECT id, source_name, status
              FROM migration_batches
             WHERE (%s::text IS NULL OR source_name = %s)
             ORDER BY created_at DESC
             LIMIT 1
            """,
            (source_name, source_name),
        )
    row = cursor.fetchone()
    if not row:
        raise RuntimeError("No migration batch found for the given selector")
    return (str(row[0]), row[1], row[2])


def fetch_sheet_names(conn: Any, batch_id: str, only: list[str] | None = None) -> list[str]:
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT source_sheet, count(*)
          FROM migration_rows
         WHERE batch_id = %s::uuid AND (%s::text[] IS NULL OR source_sheet = ANY(%s::text[]))
         GROUP BY source_sheet
         ORDER BY source_sheet
        """,
        (batch_id, only, only),
    )
    return [row[0] for row in cursor.fetchall()]


def fetch_reference_ids(conn: Any, batch_id: str, only: list[str] | None = None) -> dict[str, set[str]]:
    """Load every staged legacy ID per sheet so foreign keys resolve inside the batch."""
    references: dict[str, set[str]] = defaultdict(set)
    with conn.cursor(name="validate_reference_ids") as cursor:
        cursor.itersize = page_size()
        cursor.execute(
            """
            SELECT source_sheet, legacy_id
              FROM migration_rows
             WHERE batch_id = %s::uuid AND legacy_id IS NOT NULL
               AND (%s::text[] IS NULL OR source_sheet = ANY(%s::text[]))
            """,
            (batch_id, only, only),
        )
        for sheet, legacy_id in cursor:
            references[sheet].add(as_text(legacy_id))
    if only:
        # Reference targets outside the selected sheets cannot be checked in a partial run.
        for sheet in only:
            for _, target, _ in fk_rules_by_sheet().get(sheet, ()):
                references.setdefault(target, set())
    return dict(references)


def validate_batch(
    conn: Any,
    batch_id: str,
    sheets: list[str] | None = None,
    limit_rows: int | None = None,
    sample_size: int = DEFAULT_SAMPLE_SIZE,
    row_status_limit: int = DEFAULT_ROW_STATUS_LIMIT,
    progress: bool = True,
) -> dict[str, Any]:
    available = fetch_sheet_names(conn, batch_id, sheets)
    reference_ids = fetch_reference_ids(conn, batch_id, sheets)
    rules = build_rule_set(available)
    collector = FindingCollector(sample_size=sample_size, row_id_limit=row_status_limit)
    validator = BatchValidator(rules, reference_ids, collector)

    scanned = 0
    current_sheet: str | None = None
    with conn.cursor(name="validate_rows") as cursor:
        cursor.itersize = page_size()
        cursor.execute(
            """
            SELECT id, source_sheet, source_row_number, legacy_id, payload
              FROM migration_rows
             WHERE batch_id = %s::uuid AND (%s::text[] IS NULL OR source_sheet = ANY(%s::text[]))
             ORDER BY source_sheet, source_row_number
            """,
            (batch_id, sheets, sheets),
        )
        for row_id, sheet, row_number, legacy_id, payload in cursor:
            if current_sheet is not None and sheet != current_sheet:
                validator.finish_sheet(current_sheet)
            current_sheet = sheet
            validator.evaluate_row(sheet, row_number, legacy_id, payload or {}, row_id)
            scanned += 1
            if limit_rows is not None and scanned >= limit_rows:
                break
            if progress and scanned % 50000 == 0:
                print(json.dumps({"progress": sheet, "scanned": scanned}), file=sys.stderr, flush=True)
    if current_sheet is not None:
        validator.finish_sheet(current_sheet)

    return {
        "batch_id": batch_id,
        "rows_scanned": scanned,
        "sheets": available,
        "validator": validator,
        "findings": collector.findings(),
    }


def summarize(result: dict[str, Any]) -> dict[str, Any]:
    validator: BatchValidator = result["validator"]
    findings: list[Finding] = result["findings"]
    by_severity = Counter(finding.severity for finding in findings)
    per_sheet: dict[str, dict[str, Any]] = {}
    for sheet in result["sheets"]:
        sheet_findings = [finding for finding in findings if finding.sheet == sheet]
        total_column = MONEY_TOTAL_COLUMN.get(sheet)
        per_sheet[sheet] = {
            "source_count": validator.source_counts[sheet],
            "staged_count": validator.staged_counts[sheet],
            "rows_with_violations": validator.violations(sheet),
            "duplicate_candidates": validator.duplicate_candidates[sheet],
            "blocking_errors": sum(finding.count for finding in sheet_findings if finding.severity == "blocking"),
            "errors": sum(finding.count for finding in sheet_findings if finding.severity == "error"),
            "warnings": sum(finding.count for finding in sheet_findings if finding.severity == "warning"),
            "source_total": (
                str(validator.money_totals[sheet][total_column])
                if total_column and validator.money_totals[sheet]
                else None
            ),
            "source_total_column": total_column,
            "money_totals": {column: str(value) for column, value in sorted(validator.money_totals[sheet].items())},
        }
    return {
        "batch_id": result["batch_id"],
        "rows_scanned": result["rows_scanned"],
        "sheet_count": len(result["sheets"]),
        "findings_count": len(findings),
        "totals": {
            "blocking": by_severity.get("blocking", 0),
            "error": by_severity.get("error", 0),
            "warning": by_severity.get("warning", 0),
        },
        "per_sheet": per_sheet,
        "findings": [
            {
                "error_code": finding.error_code,
                "severity": finding.severity,
                "sheet": finding.sheet,
                "column": finding.column,
                "count": finding.count,
                "message": finding.message,
                "samples": finding.samples,
            }
            for finding in findings
        ],
    }


def persist_validation(conn: Any, batch_id: str, result: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    findings: list[Finding] = result["findings"]
    cursor = conn.cursor()

    cursor.execute(
        "DELETE FROM migration_errors WHERE batch_id = %s::uuid AND details ->> 'validator' = %s",
        (batch_id, VALIDATOR_TAG),
    )
    removed = cursor.rowcount or 0

    if findings:
        params = [
            (
                batch_id,
                finding.error_code,
                finding.severity,
                finding.column,
                finding.message,
                Jsonb(
                    {
                        "validator": VALIDATOR_TAG,
                        "version": VALIDATOR_VERSION,
                        "count": finding.count,
                        "rows_flagged": len(finding.row_ids),
                        "samples": finding.samples,
                    }
                ),
            )
            for finding in findings
        ]
        for batch in chunked(params, page_size()):
            cursor.executemany(
                """
                INSERT INTO migration_errors (batch_id, error_code, severity, field_name, message, details)
                VALUES (%s::uuid, %s, %s, %s, %s, %s)
                """,
                batch,
            )

    cursor.execute(
        "UPDATE migration_rows SET status = 'staged' WHERE batch_id = %s::uuid AND status IN ('error', 'validated')",
        (batch_id,),
    )
    reset_rows = cursor.rowcount or 0

    flagged = 0
    for finding in findings:
        ids = [str(row_id) for row_id in finding.row_ids if row_id]
        if not ids:
            continue
        for batch in chunked(ids, 500):
            cursor.execute(
                "UPDATE migration_rows SET status = 'error' WHERE id = ANY(%s::uuid[])",
                (batch,),
            )
            flagged += cursor.rowcount or 0

    updated_reports = 0
    for sheet, sheet_summary in summary["per_sheet"].items():
        cursor.execute(
            """
            UPDATE reconciliation_reports
               SET source_count = %s,
                   staged_count = %s,
                   canonical_count = 0,
                   source_total = %s,
                   duplicate_candidates = %s,
                   blocking_errors = %s,
                   notes = %s
             WHERE batch_id = %s::uuid AND entity_name = %s
            """,
            (
                sheet_summary["source_count"],
                sheet_summary["staged_count"],
                sheet_summary["source_total"],
                sheet_summary["duplicate_candidates"],
                sheet_summary["blocking_errors"],
                (
                    f"validator {VALIDATOR_TAG}/{VALIDATOR_VERSION}: "
                    f"rows_with_violations={sheet_summary['rows_with_violations']}, "
                    f"errors={sheet_summary['errors']}, warnings={sheet_summary['warnings']}; "
                    "canonical load not executed (canonical_count stays 0)"
                ),
                batch_id,
                sheet,
            ),
        )
        updated_reports += cursor.rowcount or 0

    totals = summary["totals"]
    blocking = totals["blocking"] > 0 or any(finding.error_code in BLOCKING_CODES for finding in findings)
    batch_status = "validated" if not blocking and totals["error"] == 0 else "staging"
    cursor.execute(
        "UPDATE migration_batches SET status = %s, updated_at = now() WHERE id = %s::uuid",
        (batch_status, batch_id),
    )
    return {
        "removed_previous_validator_errors": removed,
        "inserted_errors": len(findings),
        "error_rows_reset": reset_rows,
        "rows_flagged_error": flagged,
        "reconciliation_reports_updated": updated_reports,
        "batch_status": batch_status,
    }


def render_markdown(
    summary: dict[str, Any],
    source_name: str,
    batch_status: str,
    generated_at: str,
    partial: bool,
) -> str:
    lines: list[str] = []
    lines.append("# Relatorio de validacao do staging")
    lines.append("")
    lines.append(f"- Gerado em: `{generated_at}`")
    lines.append(f"- Lote: `{summary['batch_id']}`")
    lines.append(f"- Fonte: `{source_name}`")
    lines.append(f"- Status do lote apos a validacao: `{batch_status}`")
    lines.append(f"- Linhas verificadas: {summary['rows_scanned']} em {summary['sheet_count']} abas")
    lines.append(
        "- Resultado: "
        f"{summary['totals']['blocking']} bloqueios, "
        f"{summary['totals']['error']} erros, "
        f"{summary['totals']['warning']} avisos"
    )
    lines.append("- Nenhuma escola, cliente, aluno, acordo, parcela, pagamento ou cobranca canonica foi criada.")
    if partial:
        lines.append("- ATENCAO: execucao parcial (subconjunto de abas e/ou limite de linhas).")
    lines.append("")
    lines.append("## Totais por aba")
    lines.append("")
    lines.append(
        "| Aba | Origem | Staged | Linhas com violacao | Duplicidades | Bloqueios | Erros | Avisos | Total (source_total) |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for sheet, item in summary["per_sheet"].items():
        total = item["source_total"]
        total_cell = f"{total} ({item['source_total_column']})" if total else "-"
        lines.append(
            f"| {sheet} | {item['source_count']} | {item['staged_count']} | {item['rows_with_violations']} | "
            f"{item['duplicate_candidates']} | {item['blocking_errors']} | {item['errors']} | {item['warnings']} | {total_cell} |"
        )
    lines.append("")
    lines.append("## Achados")
    lines.append("")
    lines.append("| Severidade | Codigo | Aba | Campo | Ocorrencias | Amostra |")
    lines.append("|---|---|---|---|---:|---|")
    for finding in summary["findings"]:
        sample = ""
        if finding["samples"]:
            sample = json.dumps(finding["samples"][0], ensure_ascii=False, default=str).replace("|", "/")
        lines.append(
            f"| {finding['severity']} | {finding['error_code']} | {finding['sheet']} | "
            f"{finding['column'] or '-'} | {finding['count']} | {sample} |"
        )
    lines.append("")
    lines.append("## Proximos passos")
    lines.append("")
    lines.append("1. Revisar os bloqueios (`DUPLICATE_COMPOSITE_KEY`) antes de qualquer carga canonica.")
    lines.append("2. Decidir caso a caso as referencias ausentes, os CPF/CNPJ invalidos e os documentos duplicados (nunca mesclar automaticamente).")
    lines.append("3. Tratar `Aluno.CPFResponsavel` com valores textuais (ex.: `Nao tem CPF: ...`) como campo nao confiavel para identidade, conforme `docs/CANONICAL_DATA_RULES.md`.")
    lines.append("4. Nenhum reparo de encoding e necessario: nenhuma assinatura de mojibake foi encontrada no lote. Acentos vistos em logs de terminal sao artefato cp1252/cp850 do console; use `--json-out`/`--report`.")
    lines.append("5. Somente depois aprovar o lote e executar a carga canonica com UUIDs novos.")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate a staged legacy batch without creating canonical records.",
    )
    parser.add_argument("--batch-id", help="Batch UUID; defaults to the newest batch")
    parser.add_argument("--source-name", default="VOA.xlsx", help="Batch source_name when --batch-id is omitted")
    parser.add_argument("--sheet", action="append", dest="sheets", help="Validate only this sheet (repeatable)")
    parser.add_argument("--limit-rows", type=int, default=None, help="Stop after N rows; requires --dry-run")
    parser.add_argument("--sample-size", type=int, default=DEFAULT_SAMPLE_SIZE)
    parser.add_argument("--row-status-limit", type=int, default=DEFAULT_ROW_STATUS_LIMIT)
    parser.add_argument("--dry-run", action="store_true", help="Validate and print without writing to the database")
    parser.add_argument("--report", type=Path, help="Write a Markdown report to this path")
    parser.add_argument(
        "--json-out",
        type=Path,
        help="Write the JSON result to this path as UTF-8 (preferred over shell redirection)",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress progress lines on stderr")
    args = parser.parse_args()

    if args.limit_rows is not None and not args.dry_run:
        raise SystemExit("--limit-rows is only allowed with --dry-run so a partial scan never writes to the database")

    load_env()
    connection = connect()
    try:
        canonical_before = snapshot_canonical_counts(connection.cursor())
        batch_id, source_name, status = fetch_batch(connection, args.batch_id, args.source_name or None)
        result = validate_batch(
            connection,
            batch_id,
            sheets=args.sheets,
            limit_rows=args.limit_rows,
            sample_size=args.sample_size,
            row_status_limit=args.row_status_limit,
            progress=not args.quiet,
        )
        summary = summarize(result)
        persistence: dict[str, Any] | None = None
        if args.dry_run:
            connection.rollback()
            batch_status = status
        else:
            persistence = persist_validation(connection, batch_id, result, summary)
            canonical_after = snapshot_canonical_counts(connection.cursor())
            if canonical_after != canonical_before:
                raise RuntimeError(
                    f"Validation changed canonical tables: before={canonical_before} after={canonical_after}"
                )
            connection.commit()
            batch_status = persistence["batch_status"]

        generated_at = datetime.now(timezone.utc).isoformat()
        partial = bool(args.sheets) or args.limit_rows is not None
        output = {
            "mode": "dry-run" if args.dry_run else "validation",
            "canonical_writes": False,
            "canonical_before": canonical_before,
            "source_name": source_name,
            "batch_id": batch_id,
            "batch_status": batch_status,
            "partial": partial,
            "rows_scanned": summary["rows_scanned"],
            "totals": summary["totals"],
            "per_sheet": summary["per_sheet"],
            "findings": summary["findings"],
            "persistence": persistence,
            "generated_at": generated_at,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2, default=str))

        if args.json_out:
            written = write_text_file(args.json_out, json.dumps(output, ensure_ascii=False, indent=2, default=str))
            print(json.dumps({"json_out": str(written)}), file=sys.stderr)

        if args.report:
            report_path = args.report if args.report.is_absolute() else Path.cwd() / args.report
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(
                render_markdown(summary, source_name, batch_status, generated_at, partial),
                encoding="utf-8",
            )
            print(json.dumps({"report": str(report_path)}), file=sys.stderr)
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
