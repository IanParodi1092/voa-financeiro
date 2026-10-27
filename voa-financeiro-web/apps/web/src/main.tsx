import { useEffect, useState } from 'react';
import { Button, Field, FluentProvider, Input, MessageBar, Spinner, Subtitle1, Title1, makeStyles, webLightTheme } from '@fluentui/react-components';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const TOKEN_KEY = 'voa.accessToken';
const useStyles = makeStyles({
  page: { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '32px', background: 'linear-gradient(135deg, #081b29 0%, #123b50 52%, #e8f0ed 52%)' },
  panel: { width: 'min(100%, 440px)', padding: '40px', background: '#ffffff', borderTop: '5px solid #e05a3f', boxShadow: '0 24px 60px #05131d55' },
  brand: { display: 'grid', gap: '8px', marginBottom: '28px' },
  form: { display: 'grid', gap: '18px' },
  actions: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' },
  dashboard: { width: 'min(100%, 860px)', padding: '40px', background: '#ffffff', borderTop: '5px solid #e05a3f', boxShadow: '0 24px 60px #05131d55' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '24px', marginBottom: '36px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' },
  metric: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '22px', background: '#f2f6f4', border: '1px solid #d8e4de' },
  customerSection: { marginTop: '32px', paddingTop: '28px', borderTop: '1px solid #d8e4de' },
  list: { margin: '24px 0 0', padding: 0, listStyleType: 'none' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '20px' },
  linkHint: { margin: '6px 0 0', color: '#3d5a50', fontSize: '13px' },
  linkItem: { display: 'grid', gap: '6px', padding: '16px 0', borderBottom: '1px solid #e3ece8' },
  linkRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '16px' },
  linkMeta: { margin: 0, color: '#3d5a50', fontSize: '13px' },
  linkCandidates: { margin: 0, paddingLeft: '18px', color: '#123b50', fontSize: '13px' },
  linkCandidate: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '2px 0' },
  linkActions: { display: 'flex', justifyContent: 'flex-end', marginTop: '6px' },
  linkPager: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginTop: '20px', fontSize: '13px' }
});

type User = { sub?: string; name?: string; roles?: string[] };

type GuardianLinkStatus = 'single' | 'ambiguous' | 'no_match' | 'no_payer' | 'linked';

type GuardianLinkCandidate = {
  customerId: string;
  fullName: string;
  legacyTable: string | null;
  legacyId: string | null;
  agreements: number;
};

type GuardianLinkItem = {
  guardianId: string;
  guardianName: string;
  studentId: string;
  studentName: string;
  linkedCustomerId: string | null;
  payers: number;
  status: GuardianLinkStatus;
  candidates: GuardianLinkCandidate[];
};

type GuardianLinkQueue = {
  generatedAt: string;
  status: GuardianLinkStatus | null;
  limit: number;
  offset: number;
  titles: Record<GuardianLinkStatus, string>;
  counts: Record<GuardianLinkStatus, number>;
  items: GuardianLinkItem[];
};

/** Ordem dos chips: a mesma da fila (o que da para confirmar em um clique primeiro). */
const GUARDIAN_LINK_ORDER: GuardianLinkStatus[] = ['single', 'ambiguous', 'no_match', 'no_payer', 'linked'];

/**
 * Rotulo curto do chip. A frase completa de cada situacao vem da API em `titles` e e usada na linha e
 * no `title` do botao, para nao existirem duas versoes do texto de dominio no front.
 */
const GUARDIAN_LINK_SHORT: Record<GuardianLinkStatus, string> = {
  single: 'Um pagador',
  ambiguous: 'Ambiguo',
  no_match: 'Outro nome',
  no_payer: 'Sem pagador',
  linked: 'Vinculado'
};

const GUARDIAN_LINK_PAGE = 25;


function App() {
  const styles = useStyles();
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<{ id: string; fullName: string; email?: string }[]>([]);
  const [showCustomers, setShowCustomers] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerEmail, setNewCustomerEmail] = useState('');
  const [schools, setSchools] = useState<{ id: string; legalName: string; tradeName?: string }[]>([]);
  const [showSchools, setShowSchools] = useState(false);
  const [newSchoolName, setNewSchoolName] = useState('');
  const [students, setStudents] = useState<{ id: string; fullName: string; schoolId: string }[]>([]);
  const [showStudents, setShowStudents] = useState(false);
  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentSchoolId, setNewStudentSchoolId] = useState('');
  const [linkQueue, setLinkQueue] = useState<GuardianLinkQueue | null>(null);
  const [linkStatus, setLinkStatus] = useState<GuardianLinkStatus | ''>('');
  const [showLinks, setShowLinks] = useState(false);
  const [linkLoading, setLinkLoading] = useState(false);
  const [busy, setBusy] = useState<{ guardianId: string; action: 'link' | 'unlink' } | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!token) return;
    fetch(`${API_URL}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Sessão expirada.');
        setUser((await response.json()).user);
      })
      .catch(() => { localStorage.removeItem(TOKEN_KEY); setToken(null); });
  }, [token]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? 'Não foi possível entrar.');
      localStorage.setItem(TOKEN_KEY, body.accessToken);
      setToken(body.accessToken);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível entrar.');
    } finally { setLoading(false); }
  }

  function logout() { localStorage.removeItem(TOKEN_KEY); setToken(null); setUser(null); setNotice(''); }

  async function loadCustomers() {
    if (!token) return;
    setError('');
    const response = await fetch(`${API_URL}/api/v1/customers`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) { setError('Não foi possível carregar os clientes.'); return; }
    setCustomers((await response.json()).items);
    setShowCustomers(true);
  }

  async function createCustomer(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError('');
    const response = await fetch(`${API_URL}/api/v1/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ fullName: newCustomerName, email: newCustomerEmail || undefined }) });
    if (!response.ok) { setError('Não foi possível cadastrar o cliente.'); return; }
    setNewCustomerName(''); setNewCustomerEmail(''); await loadCustomers();
  }

  async function loadSchools() {
    if (!token) return;
    setError('');
    const response = await fetch(`${API_URL}/api/v1/schools`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) { setError('Não foi possível carregar as escolas.'); return; }
    const items = (await response.json()).items;
    setSchools(items);
    setNewStudentSchoolId((current) => current || items[0]?.id || '');
    setShowSchools(true);
  }

  async function createSchool(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError('');
    const response = await fetch(`${API_URL}/api/v1/schools`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ legalName: newSchoolName }) });
    if (!response.ok) { setError('Não foi possível cadastrar a escola.'); return; }
    setNewSchoolName(''); await loadSchools();
  }

  async function loadStudents() {
    if (!token) return;
    setError('');
    if (!schools.length) {
      const schoolsResponse = await fetch(`${API_URL}/api/v1/schools`, { headers: { Authorization: `Bearer ${token}` } });
      if (!schoolsResponse.ok) { setError('Não foi possível carregar as escolas para o aluno.'); return; }
      const items = (await schoolsResponse.json()).items;
      setSchools(items);
      setNewStudentSchoolId((current) => current || items[0]?.id || '');
    } else if (!newStudentSchoolId) {
      setNewStudentSchoolId(schools[0]?.id ?? '');
    }
    const response = await fetch(`${API_URL}/api/v1/students`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) { setError('Não foi possível carregar os alunos.'); return; }
    setStudents((await response.json()).items);
    setShowStudents(true);
  }

  async function createStudent(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError('');
    const response = await fetch(`${API_URL}/api/v1/students`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ fullName: newStudentName, schoolId: newStudentSchoolId }) });
    if (!response.ok) { setError('Não foi possível cadastrar o aluno.'); return; }
    setNewStudentName(''); await loadStudents();
  }

  async function loadGuardianLinks(status: GuardianLinkStatus | '' = linkStatus, offset = 0) {
    if (!token) return;
    setError('');
    setNotice('');
    setLinkLoading(true);
    try {
      const query = new URLSearchParams({ limit: String(GUARDIAN_LINK_PAGE), offset: String(offset) });
      if (status) query.set('status', status);
      const response = await fetch(`${API_URL}/api/v1/guardians/customer-candidates?${query}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) { setError('Não foi possível carregar a fila de responsáveis.'); return; }
      setLinkQueue(await response.json());
      setLinkStatus(status);
      setShowLinks(true);
    } finally {
      setLinkLoading(false);
    }
  }

  /**
   * Grava o estado de vinculo que o operador confirmou na fila: `PATCH /guardians/:id` com o par
   * `{ customerId, isVerified }`. Vincular envia `{ customerId: <uuid>, isVerified: true }` (o mesmo
   * corpo que a tela de detalhe envia quando confirma o par) e desvincular envia
   * `{ customerId: null, isVerified: false }`, porque a verificacao era **daquele** par: mante-la alta
   * depois de desfazer o vinculo deixaria um guardiao "verificado" sem cliente.
   *
   * A trava continua sendo do servidor (`customer_not_payer` recusa cliente que nao paga acordo do
   * aluno, `catalog:write` barra o viewer): aqui so evitamos procurar o cliente em outra aba.
   *
   * Em sucesso a fila e recarregada na mesma pagina, porque o item muda de `single`/`ambiguous`/
   * `linked` e sai do filtro atual. `401` e `403` ganham mensagem propria em vez de "falhou": token
   * vencido e falta de permissao sao causas diferentes e a acao do operador tambem.
   */
  async function patchGuardian(
    item: GuardianLinkItem,
    body: { customerId: string | null; isVerified: boolean },
    action: 'link' | 'unlink',
    done: string
  ) {
    if (!token) return;
    setError('');
    setNotice('');
    const offset = linkQueue?.offset ?? 0;
    setBusy({ guardianId: item.guardianId, action });
    try {
      const response = await fetch(`${API_URL}/api/v1/guardians/${item.guardianId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      if (response.ok) {
        await loadGuardianLinks(linkStatus, offset);
        setNotice(done);
        return;
      }
      if (response.status === 401) { setError('Sessão expirada. Saia e entre novamente para alterar o vínculo.'); return; }
      if (response.status === 403) { setError('Seu perfil não permite alterar vínculos: a rota exige catalog:write.'); return; }
      const problem = (await response.json().catch(() => null)) as { code?: string } | null;
      if (problem?.code === 'CUSTOMER_NOT_PAYER') {
        setError('Este cliente não paga acordo do aluno deste responsável. Recarregue a fila e escolha outro.');
        return;
      }
      setError(action === 'link' ? 'Não foi possível vincular o responsável.' : 'Não foi possível desvincular o responsável.');
    } finally {
      setBusy(null);
    }
  }

  function linkGuardian(item: GuardianLinkItem, candidate: GuardianLinkCandidate) {
    return patchGuardian(
      item,
      { customerId: candidate.customerId, isVerified: true },
      'link',
      `${item.guardianName} foi vinculado a ${candidate.fullName}.`
    );
  }

  function unlinkGuardian(item: GuardianLinkItem) {
    return patchGuardian(
      item,
      { customerId: null, isVerified: false },
      'unlink',
      `${item.guardianName} voltou para a fila de conciliação.`
    );
  }

  if (token && !user) return <main className={styles.page}><Spinner label="Validando sessão" /></main>;
  if (!user) return <main className={styles.page}><section className={styles.panel}><div className={styles.brand}><Subtitle1>VOA FINANCEIRO</Subtitle1><Title1>Acesso administrativo</Title1></div><form className={styles.form} onSubmit={login}>{error && <MessageBar intent="error">{error}</MessageBar>}<Field label="E-mail" required><Input type="email" value={email} onChange={(_, data) => setEmail(data.value)} /></Field><Field label="Senha" required><Input type="password" value={password} onChange={(_, data) => setPassword(data.value)} /></Field><div className={styles.actions}><Button appearance="primary" type="submit" disabled={loading}>{loading ? 'Entrando...' : 'Entrar'}</Button></div></form></section></main>;
  return <main className={styles.page}><section className={styles.dashboard}><header className={styles.header}><div className={styles.brand}><Subtitle1>PAINEL OPERACIONAL</Subtitle1><Title1>Olá, {user.name ?? 'administrador'}</Title1></div><Button appearance="secondary" onClick={logout}>Sair</Button></header>{error && <MessageBar intent="error">{error}</MessageBar>}{notice && <MessageBar intent="success">{notice}</MessageBar>}<div className={styles.grid}><Button className={styles.metric} appearance="subtle" onClick={loadCustomers}><Subtitle1>Clientes</Subtitle1><p>Cadastro e contatos</p></Button><Button className={styles.metric} appearance="subtle" onClick={loadStudents}><Subtitle1>Alunos</Subtitle1><p>Escolas e responsáveis</p></Button><div className={styles.metric}><Subtitle1>Cobranças</Subtitle1><p>Boletos e pagamentos</p></div><Button className={styles.metric} appearance="subtle" onClick={loadSchools}><Subtitle1>Escolas</Subtitle1><p>Alunos e acordos</p></Button><Button className={styles.metric} appearance="subtle" onClick={() => loadGuardianLinks('', 0)}><Subtitle1>Responsáveis</Subtitle1><p>Vínculo com clientes</p></Button></div>{showLinks && linkQueue && <GuardianLinkPanel queue={linkQueue} loading={linkLoading} status={linkStatus} busy={busy} onFilter={(next) => loadGuardianLinks(next, 0)} onPage={(offset) => loadGuardianLinks(linkStatus, offset)} onLink={linkGuardian} onUnlink={unlinkGuardian} onClose={() => setShowLinks(false)} />}{showCustomers && <section className={styles.customerSection}><div className={styles.header}><Subtitle1>Clientes cadastrados</Subtitle1><Button appearance="secondary" onClick={() => setShowCustomers(false)}>Fechar</Button></div><form className={styles.form} onSubmit={createCustomer}><Field label="Nome completo" required><Input value={newCustomerName} onChange={(_, data) => setNewCustomerName(data.value)} /></Field><Field label="E-mail"><Input type="email" value={newCustomerEmail} onChange={(_, data) => setNewCustomerEmail(data.value)} /></Field><div className={styles.actions}><Button appearance="primary" type="submit">Cadastrar cliente</Button></div></form><ul className={styles.list}>{customers.map((customer) => <li key={customer.id}><strong>{customer.fullName}</strong><span>{customer.email ?? 'Sem e-mail'}</span></li>)}</ul></section>}{showStudents && <section className={styles.customerSection}><div className={styles.header}><Subtitle1>Alunos cadastrados</Subtitle1><Button appearance="secondary" onClick={() => setShowStudents(false)}>Fechar</Button></div><form className={styles.form} onSubmit={createStudent}><Field label="Nome do aluno" required><Input value={newStudentName} onChange={(_, data) => setNewStudentName(data.value)} /></Field><Field label="Escola" required><select className="school-select" value={newStudentSchoolId} onChange={(event) => setNewStudentSchoolId(event.target.value)}><option value="">Selecione uma escola</option>{schools.map((school) => <option key={school.id} value={school.id}>{school.tradeName ?? school.legalName}</option>)}</select></Field><div className={styles.actions}><Button appearance="primary" type="submit" disabled={!newStudentSchoolId}>Cadastrar aluno</Button></div></form><ul className={styles.list}>{students.map((student) => <li key={student.id}><strong>{student.fullName}</strong><span>{schools.find((school) => school.id === student.schoolId)?.legalName ?? 'Escola'}</span></li>)}</ul></section>}{showSchools && <section className={styles.customerSection}><div className={styles.header}><Subtitle1>Escolas cadastradas</Subtitle1><Button appearance="secondary" onClick={() => setShowSchools(false)}>Fechar</Button></div><form className={styles.form} onSubmit={createSchool}><Field label="Razão social" required><Input value={newSchoolName} onChange={(_, data) => setNewSchoolName(data.value)} /></Field><div className={styles.actions}><Button appearance="primary" type="submit">Cadastrar escola</Button></div></form><ul className={styles.list}>{schools.map((school) => <li key={school.id}><strong>{school.tradeName ?? school.legalName}</strong><span>{school.legalName}</span></li>)}</ul></section>}</section></main>;
}

type GuardianLinkPanelProps = {
  queue: GuardianLinkQueue;
  loading: boolean;
  status: GuardianLinkStatus | '';
  busy: { guardianId: string; action: 'link' | 'unlink' } | null;
  onFilter: (status: GuardianLinkStatus | '') => void;
  onPage: (offset: number) => void;
  onLink: (item: GuardianLinkItem, candidate: GuardianLinkCandidate) => void;
  onUnlink: (item: GuardianLinkItem) => void;
  onClose: () => void;
};

/**
 * Fila de promocao responsavel -> cliente (`GET /api/v1/guardians/customer-candidates`) e os botoes que
 * gravam o par confirmado (`PATCH /guardians/:id` com `{ customerId, isVerified }`).
 *
 * O vinculo continua sendo decisao humana e a trava e do servidor: `customer_not_payer` recusa cliente
 * que nao paga acordo do aluno e `catalog:write` barra o viewer. A tela so encurta a decisao - `single`
 * confirma em um clique, `ambiguous` obriga a escolher o pagador certo entre os listados antes de
 * confirmar, porque duas linhas de pagador com o mesmo nome podem ser a mesma pessoa repetida por
 * acordo (e ai o `agreements` e o desempate).
 *
 * Desvincular exige dois toques: o primeiro arma o botao, o segundo grava. Um clique sozinho derrubaria
 * um vinculo auditado por engano, e o custo de refazer (procurar o pagador de novo) e maior que o de
 * confirmar.
 */
function GuardianLinkPanel({ queue, loading, status, busy, onFilter, onPage, onLink, onUnlink, onClose }: GuardianLinkPanelProps) {
  const styles = useStyles();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Rotulo do botao da linha enquanto o `PATCH` dela esta em voo. */
  const busyLabel = (guardianId: string, idle: string) =>
    busy?.guardianId === guardianId ? (busy.action === 'link' ? 'Vinculando...' : 'Desvinculando...') : idle;
  const total = GUARDIAN_LINK_ORDER.reduce((sum, value) => sum + queue.counts[value], 0);
  const last = queue.offset + queue.items.length;
  return (
    <section className={styles.customerSection}>
      <div className={styles.header}>
        <Subtitle1>Responsáveis e clientes</Subtitle1>
        <Button appearance="secondary" onClick={onClose}>Fechar</Button>
      </div>
      <p className={styles.linkHint}>
        Cada linha é um responsável e os pagadores dos acordos do aluno dele. Nome igual é indício, não vínculo:
        o botão grava o par que você confirmou e o servidor recusa cliente que não paga acordo do aluno.
      </p>
      <div className={styles.chips}>
        <Button size="small" appearance={status === '' ? 'primary' : 'secondary'} onClick={() => onFilter('')}>
          Todas ({total})
        </Button>
        {GUARDIAN_LINK_ORDER.map((value) => (
          <Button
            key={value}
            size="small"
            appearance={status === value ? 'primary' : 'secondary'}
            title={queue.titles[value]}
            onClick={() => onFilter(value)}
          >
            {GUARDIAN_LINK_SHORT[value]} ({queue.counts[value]})
          </Button>
        ))}
      </div>
      {loading && <Spinner label="Carregando responsáveis" />}
      {!loading && queue.items.length === 0 && <p className={styles.linkHint}>Nenhum responsável nesta situação.</p>}
      <ul className={styles.list}>
        {queue.items.map((item) => (
          <li key={item.guardianId} className={styles.linkItem}>
            <div className={styles.linkRow}>
              <strong>{item.guardianName}</strong>
              <span>{item.studentName}</span>
            </div>
            <p className={styles.linkMeta}>
              {queue.titles[item.status]} · {item.payers === 1 ? '1 pagador' : `${item.payers} pagadores`} nos acordos
            </p>
            {item.linkedCustomerId && (
              <div className={styles.linkRow}>
                <p className={styles.linkMeta}>Já vinculado ao cliente {item.linkedCustomerId}</p>
                <Button
                  size="small"
                  appearance={confirming === item.guardianId ? 'primary' : 'secondary'}
                  disabled={busy !== null}
                  onClick={() => {
                    if (confirming === item.guardianId) {
                      setConfirming(null);
                      onUnlink(item);
                      return;
                    }
                    setConfirming(item.guardianId);
                  }}
                >
                  {busyLabel(item.guardianId, confirming === item.guardianId ? 'Confirmar desvínculo' : 'Desvincular')}
                </Button>
              </div>
            )}
            {item.candidates.length > 0 && (
              <ul className={styles.linkCandidates}>
                {item.candidates.map((candidate) => (
                  <li key={candidate.customerId} className={styles.linkCandidate}>
                    <span>
                      {candidate.fullName} — {candidate.agreements === 1 ? '1 acordo pago' : `${candidate.agreements} acordos pagos`}
                      {candidate.legacyId ? ` · legado ${candidate.legacyTable} #${candidate.legacyId}` : ''}
                    </span>
                    {item.status === 'single' && (
                      <Button size="small" appearance="primary" disabled={busy !== null} onClick={() => onLink(item, candidate)}>
                        {busyLabel(item.guardianId, 'Vincular')}
                      </Button>
                    )}
                    {item.status === 'ambiguous' && (
                      <Button
                        size="small"
                        appearance={picked[item.guardianId] === candidate.customerId ? 'primary' : 'subtle'}
                        disabled={busy !== null}
                        onClick={() => setPicked((current) => ({ ...current, [item.guardianId]: candidate.customerId }))}
                      >
                        {picked[item.guardianId] === candidate.customerId ? 'Selecionado' : 'Selecionar'}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {item.status === 'ambiguous' && item.candidates.length > 0 && (
              <div className={styles.linkActions}>
                <Button
                  size="small"
                  appearance="primary"
                  disabled={busy !== null || !picked[item.guardianId]}
                  onClick={() => {
                    const candidate = item.candidates.find((value) => value.customerId === picked[item.guardianId]);
                    if (candidate) onLink(item, candidate);
                  }}
                >
                  {busyLabel(item.guardianId, 'Vincular selecionado')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {queue.items.length > 0 && (
        <div className={styles.linkPager}>
          <Button size="small" appearance="secondary" disabled={queue.offset === 0 || loading} onClick={() => onPage(Math.max(0, queue.offset - queue.limit))}>Anteriores</Button>
          <span>{queue.offset + 1}–{last} de {total}</span>
          <Button size="small" appearance="secondary" disabled={queue.items.length < queue.limit || loading} onClick={() => onPage(queue.offset + queue.limit)}>Próximos</Button>
        </div>
      )}
    </section>
  );
}

createRoot(document.getElementById('root')!).render(<FluentProvider theme={webLightTheme}><App /></FluentProvider>);