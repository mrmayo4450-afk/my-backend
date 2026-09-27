CREATE TABLE IF NOT EXISTS admin_actions (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id varchar NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_id varchar,
  target_username text,
  target_email text,
  details text NOT NULL DEFAULT '',
  created_at timestamp NOT NULL DEFAULT now()
);

-- The application reads this table only through its server-side PostgreSQL
-- connection; never expose audit entries via Supabase's public API.
ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS admin_actions_created_at_idx
  ON admin_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_actions_actor_created_at_idx
  ON admin_actions (actor_id, created_at DESC);