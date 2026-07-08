CREATE TABLE IF NOT EXISTS commands (
  command_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  command_type VARCHAR(32) NOT NULL,
  command_text LONGTEXT NULL,
  accepted TINYINT(1) NULL,
  status VARCHAR(32) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (command_id),
  KEY commands_session_created_idx (session_id, created_at_ms),
  KEY commands_status_updated_idx (status, updated_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
