INSERT INTO permissions(key,description) VALUES
  ('notifications.manage','Send and manage in-app notifications'),
  ('security.manage','Manage sessions and security controls'),
  ('data.read','View Data Hub operational events')
ON CONFLICT(key) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.key='owner' AND r.organisation_id IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.key IN('notifications.manage','security.manage','data.read')
WHERE r.key='admin' AND r.organisation_id IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.key IN('data.read')
WHERE r.key IN('member','auditor') AND r.organisation_id IS NULL
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS sessions_org_active_idx
  ON sessions(organisation_id,expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_org_created_idx
  ON notifications(organisation_id,created_at DESC);

CREATE INDEX IF NOT EXISTS outbox_org_created_idx
  ON outbox_events(organisation_id,created_at DESC);
