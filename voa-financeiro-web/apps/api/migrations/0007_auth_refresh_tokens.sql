-- Sessao de acesso curta (access token de 15 min) com refresh opaco de 30 dias e rotacao.
--
-- `auth_sessions.expires_at` passa a ser o fim da **sessao** (janela do refresh), nao o `exp` do
-- access token: o JWT continua curto pelo seu proprio `exp` e o refresh e o que mantem a sessao
-- viva. O token de refresh nunca e guardado em claro - so o HMAC-SHA256 (com
-- `AUTH_REFRESH_SECRET`) vai para o banco, e o indice unico permite invalidar/rotacionar por hash.
ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS refresh_token_hash text,
  ADD COLUMN IF NOT EXISTS refresh_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_refresh_token_idx
  ON auth_sessions (refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_refresh_expiry_idx
  ON auth_sessions (refresh_expires_at) WHERE revoked_at IS NULL;
