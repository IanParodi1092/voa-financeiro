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
  list: { margin: '24px 0 0', padding: 0, listStyleType: 'none' }
});

type User = { sub?: string; name?: string; roles?: string[] };

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

  function logout() { localStorage.removeItem(TOKEN_KEY); setToken(null); setUser(null); }

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

  if (token && !user) return <main className={styles.page}><Spinner label="Validando sessão" /></main>;
  if (!user) return <main className={styles.page}><section className={styles.panel}><div className={styles.brand}><Subtitle1>VOA FINANCEIRO</Subtitle1><Title1>Acesso administrativo</Title1></div><form className={styles.form} onSubmit={login}>{error && <MessageBar intent="error">{error}</MessageBar>}<Field label="E-mail" required><Input type="email" value={email} onChange={(_, data) => setEmail(data.value)} /></Field><Field label="Senha" required><Input type="password" value={password} onChange={(_, data) => setPassword(data.value)} /></Field><div className={styles.actions}><Button appearance="primary" type="submit" disabled={loading}>{loading ? 'Entrando...' : 'Entrar'}</Button></div></form></section></main>;
  return <main className={styles.page}><section className={styles.dashboard}><header className={styles.header}><div className={styles.brand}><Subtitle1>PAINEL OPERACIONAL</Subtitle1><Title1>Olá, {user.name ?? 'administrador'}</Title1></div><Button appearance="secondary" onClick={logout}>Sair</Button></header>{error && <MessageBar intent="error">{error}</MessageBar>}<div className={styles.grid}><Button className={styles.metric} appearance="subtle" onClick={loadCustomers}><Subtitle1>Clientes</Subtitle1><p>Cadastro e contatos</p></Button><Button className={styles.metric} appearance="subtle" onClick={loadStudents}><Subtitle1>Alunos</Subtitle1><p>Escolas e responsáveis</p></Button><div className={styles.metric}><Subtitle1>Cobranças</Subtitle1><p>Boletos e pagamentos</p></div><Button className={styles.metric} appearance="subtle" onClick={loadSchools}><Subtitle1>Escolas</Subtitle1><p>Alunos e acordos</p></Button></div>{showCustomers && <section className={styles.customerSection}><div className={styles.header}><Subtitle1>Clientes cadastrados</Subtitle1><Button appearance="secondary" onClick={() => setShowCustomers(false)}>Fechar</Button></div><form className={styles.form} onSubmit={createCustomer}><Field label="Nome completo" required><Input value={newCustomerName} onChange={(_, data) => setNewCustomerName(data.value)} /></Field><Field label="E-mail"><Input type="email" value={newCustomerEmail} onChange={(_, data) => setNewCustomerEmail(data.value)} /></Field><div className={styles.actions}><Button appearance="primary" type="submit">Cadastrar cliente</Button></div></form><ul className={styles.list}>{customers.map((customer) => <li key={customer.id}><strong>{customer.fullName}</strong><span>{customer.email ?? 'Sem e-mail'}</span></li>)}</ul></section>}{showStudents && <section className={styles.customerSection}><div className={styles.header}><Subtitle1>Alunos cadastrados</Subtitle1><Button appearance="secondary" onClick={() => setShowStudents(false)}>Fechar</Button></div><form className={styles.form} onSubmit={createStudent}><Field label="Nome do aluno" required><Input value={newStudentName} onChange={(_, data) => setNewStudentName(data.value)} /></Field><Field label="Escola" required><select className="school-select" value={newStudentSchoolId} onChange={(event) => setNewStudentSchoolId(event.target.value)}><option value="">Selecione uma escola</option>{schools.map((school) => <option key={school.id} value={school.id}>{school.tradeName ?? school.legalName}</option>)}</select></Field><div className={styles.actions}><Button appearance="primary" type="submit" disabled={!newStudentSchoolId}>Cadastrar aluno</Button></div></form><ul className={styles.list}>{students.map((student) => <li key={student.id}><strong>{student.fullName}</strong><span>{schools.find((school) => school.id === student.schoolId)?.legalName ?? 'Escola'}</span></li>)}</ul></section>}{showSchools && <section className={styles.customerSection}><div className={styles.header}><Subtitle1>Escolas cadastradas</Subtitle1><Button appearance="secondary" onClick={() => setShowSchools(false)}>Fechar</Button></div><form className={styles.form} onSubmit={createSchool}><Field label="Razão social" required><Input value={newSchoolName} onChange={(_, data) => setNewSchoolName(data.value)} /></Field><div className={styles.actions}><Button appearance="primary" type="submit">Cadastrar escola</Button></div></form><ul className={styles.list}>{schools.map((school) => <li key={school.id}><strong>{school.tradeName ?? school.legalName}</strong><span>{school.legalName}</span></li>)}</ul></section>}</section></main>;
}

createRoot(document.getElementById('root')!).render(<FluentProvider theme={webLightTheme}><App /></FluentProvider>);