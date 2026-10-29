-- 009: server-side session records so sign-out (and "sign out everywhere") actually revokes a
-- cookie instead of only deleting it from one browser. Additive. Cookies issued before this
-- migration carry no session id and stop working, so everyone signs in once more.
CREATE TABLE IF NOT EXISTS user_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT CHECK (revoke_reason IN ('logout', 'logout_all', 'admin', 'account_status'))
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_live ON user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions (expires_at);
