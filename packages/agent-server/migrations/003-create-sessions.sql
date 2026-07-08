CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  agent_state LONGTEXT NULL,
  agent_state_schema_version INT NULL,
  message_count INT UNSIGNED NOT NULL DEFAULT 0,
  version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  executing_command_id VARCHAR(128) NULL,
  lease_owner VARCHAR(128) NULL,
  lease_until_ms BIGINT NULL,
  created_at_ms BIGINT NOT NULL,
  last_active_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  closed_at_ms BIGINT NULL,
  PRIMARY KEY (session_id),
  KEY sessions_status_updated_idx (status, updated_at_ms),
  KEY sessions_execution_lease_idx (status, lease_until_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
