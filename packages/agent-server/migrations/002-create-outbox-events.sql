CREATE TABLE IF NOT EXISTS outbox_events (
  event_id VARCHAR(191) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  payload LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  available_at_ms BIGINT NOT NULL,
  locked_by VARCHAR(128) NULL,
  locked_until_ms BIGINT NULL,
  last_error TEXT NULL,
  created_at_ms BIGINT NOT NULL,
  published_at_ms BIGINT NULL,
  PRIMARY KEY (event_id),
  UNIQUE KEY outbox_command_event_unique (aggregate_id, event_type),
  KEY outbox_delivery_idx (status, available_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
