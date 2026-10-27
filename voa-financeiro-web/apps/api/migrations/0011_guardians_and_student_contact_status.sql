-- 0011: entidade `guardians` (reabertura da classe C) e o que faltava para carregar `TBL_ENDTEL`.
--
-- A classe C (identidade do responsavel do aluno) ficou em `review` em 2026-10-27 com uma condicao
-- de reabertura explicita: "quando existir `guardians` (ou equivalente), o responsavel deixa de ser
-- candidato a `customers` e passa a ter entidade propria". Esta migration cria essa entidade. Ela
-- NAO decide o vinculo: a carga entra como `proposed` (so roda com `--allow-proposed guardians`),
-- `customer_id` fica nulo e `is_verified` fica falso - nome do legado nunca vira cliente.
--
-- 1. `guardians`: cada linha de `TBL_ALUNO` tem no maximo um responsavel (`Aluno.Responsavel_Financeiro`
--    em 6.350 de 6.652 alunos, mais `Aluno.CPFResponsavel`, `Aluno_RGResponsavel`,
--    `Aluno_ResponsavelProfissao` e `Aluno_ResponsavelEstadoCivil`). O guardiao e filho do aluno
--    (`student_id`) e nao do cliente pagador: o pagador do acordo ja e o proprio aluno na origem.
--    `customer_id` existe para a conciliacao assistida futura e nasce sempre nulo.
--
--    A chave legada do guardiao e a do aluno: a origem nao tem id de responsavel, so o nome na
--    linha. `guardians.legacy_id = TBL_ALUNO.ID` (um guardiao por linha de aluno), mesmo criterio
--    ja usado em `TBL_PAGAMENTO`, onde o mesmo `ID` identifica `agreements` e o cliente pagador
--    sintetizado - duas entidades, uma linha de origem.
--
-- 2. `student_contacts.status`: `TBL_ENDTEL` tem 35.578 ATIVADO e 5.996 DESATIVADO, e a tabela da
--    0010 nao tinha onde guardar. Sem a coluna, a unica saida seria descartar os inativos ou
--    carregar todos como ativos (perdendo a informacao de que o contato foi desativado). Toda
--    linha com valor tem status: as 41.117 carregaveis se dividem exatamente entre esses dois
--    rotulos.
--
--    `student_contacts.type` fica como esta (NOT NULL, sem default): a aba tem 41.574 linhas com
--    tipo, 41.117 delas com valor; as 457 restantes tem tipo e valor vazio e as 5.988 sem tipo
--    tambem nao tem valor nem status, ou seja, nao ha o que carregar nelas. Criar um rotulo
--    sintetico (`unknown`) gravaria linha sem dado nenhum.

CREATE TABLE IF NOT EXISTS guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers (id),
  full_name text NOT NULL,
  document_number text,
  document_rg text,
  marital_status text,
  occupation text,
  is_financial boolean NOT NULL DEFAULT true,
  is_verified boolean NOT NULL DEFAULT false,
  legacy_source text,
  legacy_table text,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT guardians_legacy_key_unique UNIQUE (legacy_source, legacy_table, legacy_id)
);

CREATE INDEX IF NOT EXISTS guardians_student_idx
  ON guardians (student_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS guardians_customer_idx
  ON guardians (customer_id) WHERE customer_id IS NOT NULL;

ALTER TABLE student_contacts
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
