-- Post Pigeon — MySQL schema
-- Run this once against an empty database, or use setup.php which applies it idempotently.
-- Charset choice (utf8mb4) supports the full Unicode range, including emoji in names/descriptions.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  email         VARCHAR(190)  NOT NULL,
  username      VARCHAR(64)   NOT NULL,
  password_hash VARCHAR(255)  NOT NULL,
  is_admin      TINYINT(1)    NOT NULL DEFAULT 0,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_users_email    (email),
  UNIQUE KEY uniq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token       CHAR(64)      NOT NULL,
  user_id     INT UNSIGNED  NOT NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME      NOT NULL,
  ip_address  VARCHAR(45)   NULL,
  user_agent  VARCHAR(255)  NULL,
  PRIMARY KEY (token),
  KEY idx_sessions_user    (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS environments (
  id          CHAR(16)      NOT NULL,
  user_id     INT UNSIGNED  NOT NULL,
  name        VARCHAR(128)  NOT NULL,
  variables   JSON          NOT NULL,
  sort_order  INT           NOT NULL DEFAULT 0,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id, user_id),
  KEY idx_environments_user (user_id),
  CONSTRAINT fk_environments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS collections (
  id          CHAR(16)      NOT NULL,
  user_id     INT UNSIGNED  NOT NULL,
  name        VARCHAR(128)  NOT NULL,
  is_open     TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order  INT           NOT NULL DEFAULT 0,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id, user_id),
  KEY idx_collections_user (user_id),
  CONSTRAINT fk_collections_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS saved_requests (
  id            CHAR(16)      NOT NULL,
  user_id       INT UNSIGNED  NOT NULL,
  collection_id CHAR(16)      NOT NULL,
  name          VARCHAR(255)  NOT NULL,
  method        VARCHAR(10)   NOT NULL,
  url           TEXT          NOT NULL,
  payload       JSON          NOT NULL,
  sort_order    INT           NOT NULL DEFAULT 0,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id, user_id),
  KEY idx_saved_requests_user (user_id),
  KEY idx_saved_requests_collection (user_id, collection_id),
  CONSTRAINT fk_saved_requests_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS history (
  id        CHAR(16)      NOT NULL,
  user_id   INT UNSIGNED  NOT NULL,
  ts        BIGINT        NOT NULL,
  method    VARCHAR(10)   NOT NULL,
  url       TEXT          NOT NULL,
  status    SMALLINT      NOT NULL DEFAULT 0,
  time_ms   INT           NOT NULL DEFAULT 0,
  snapshot  JSON          NULL,
  PRIMARY KEY (id, user_id),
  KEY idx_history_user_ts (user_id, ts),
  CONSTRAINT fk_history_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id        INT UNSIGNED  NOT NULL,
  active_env_id  CHAR(16)      NULL,
  preferences    JSON          NULL,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_throttle (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ip_address   VARCHAR(45)     NOT NULL,
  email        VARCHAR(190)    NULL,
  succeeded    TINYINT(1)      NOT NULL DEFAULT 0,
  attempted_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_throttle_ip       (ip_address, attempted_at),
  KEY idx_throttle_email    (email, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
