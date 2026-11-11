-- Customer onboarding tracker · Aurora MySQL (Beau, 2026-11-11)
--
-- One schema, two kinds of tables:
--   * CATALOG (ob_phase, ob_step, ob_role, ob_document_type, ob_training_session):
--     the onboarding program itself, the same phases and steps the customer sees on
--     their instance's Onboarding tab.
--   * PER CUSTOMER (ob_customer, ob_customer_phase, ob_customer_step, ...): where each
--     customer is. Seeded now by the dashboard's reverse-engineering build
--     (_etl_scripts/build_onboarding.mjs) from HubSpot, Jira, Harvest, Stripe and the
--     order warehouse. When Jake's instance-level Onboarding tab ships, it writes these
--     same rows with source = 'instance', and a seeded row is never allowed to overwrite
--     an instance row (see the `source` and `confidence` columns).
--
-- Keyed on allmoxy_customer_id (allmoxy_core.customers), the id every dashboard
-- source already joins on.

CREATE SCHEMA IF NOT EXISTS allmoxy_onboarding;
USE allmoxy_onboarding;

-- ── catalog ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ob_phase (
  phase_id      TINYINT      NOT NULL PRIMARY KEY,          -- 1..6
  phase_key     VARCHAR(40)  NOT NULL UNIQUE,               -- kickoff, initial_settings, validate, configure, go_live, grow
  name          VARCHAR(80)  NOT NULL,                      -- "Phase 3: Validate (10-order proof)"
  sort_order    TINYINT      NOT NULL,
  plans         VARCHAR(40)  NOT NULL DEFAULT 'full,self',  -- which plans include it (self-build skips Validate)
  description   VARCHAR(400) NULL
);

CREATE TABLE IF NOT EXISTS ob_step (
  step_key      VARCHAR(60)  NOT NULL PRIMARY KEY,          -- connect_payment_gateway
  phase_id      TINYINT      NOT NULL,
  name          VARCHAR(120) NOT NULL,                      -- "Connect Payment Gateway"
  sort_order    TINYINT      NOT NULL,
  is_optional   BOOLEAN      NOT NULL DEFAULT FALSE,        -- Custom domain, etc.
  default_owner ENUM('customer','allmoxy','both') NOT NULL DEFAULT 'customer',
  settings_area VARCHAR(80)  NULL,                          -- Allmoxy settings page it links to (Theme, Financial, ...)
  target_count  SMALLINT     NULL,                          -- 10 for validation orders / live orders
  CONSTRAINT fk_step_phase FOREIGN KEY (phase_id) REFERENCES ob_phase(phase_id)
);

CREATE TABLE IF NOT EXISTS ob_role (
  role_key      VARCHAR(40)  NOT NULL PRIMARY KEY,          -- project_champion
  name          VARCHAR(80)  NOT NULL,
  description   VARCHAR(300) NULL,
  sort_order    TINYINT      NOT NULL
);

CREATE TABLE IF NOT EXISTS ob_document_type (
  doc_key       VARCHAR(60)  NOT NULL PRIMARY KEY,          -- product_specifications
  name          VARCHAR(120) NOT NULL,
  description   VARCHAR(400) NULL,
  sort_order    TINYINT      NOT NULL                       -- priority order
);

CREATE TABLE IF NOT EXISTS ob_training_session (
  session_key   VARCHAR(60)  NOT NULL PRIMARY KEY,          -- welcome_platform_overview
  phase_id      TINYINT      NOT NULL,
  name          VARCHAR(120) NOT NULL,
  covers        VARCHAR(300) NULL,
  audience      VARCHAR(120) NULL,                          -- "Owner / Manager"
  sort_order    TINYINT      NOT NULL,
  CONSTRAINT fk_session_phase FOREIGN KEY (phase_id) REFERENCES ob_phase(phase_id)
);

-- ── per customer ────────────────────────────────────────────────────────────────

-- One row per customer in the program: the header the dashboard lists.
CREATE TABLE IF NOT EXISTS ob_customer (
  allmoxy_customer_id INT          NOT NULL PRIMARY KEY,
  plan                ENUM('full','self','unknown') NOT NULL DEFAULT 'unknown',  -- implementation services vs self build
  program_status      ENUM('onboarding','live','on_hold','abandoned','churned') NOT NULL,
  current_phase_id    TINYINT      NULL,
  kickoff_date        DATE         NULL,
  target_launch_date  DATE         NULL,
  go_live_date        DATE         NULL,                    -- first verified live order
  csm_name            VARCHAR(120) NULL,
  waiting_on          ENUM('customer','allmoxy','nobody','unknown') NOT NULL DEFAULT 'unknown',
  next_step_key       VARCHAR(60)  NULL,
  blocker             VARCHAR(400) NULL,
  jira_epic_key       VARCHAR(20)  NULL,
  source              ENUM('seed','instance','manual') NOT NULL DEFAULT 'seed',
  seeded_at           DATETIME     NULL,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cust_phase FOREIGN KEY (current_phase_id) REFERENCES ob_phase(phase_id),
  CONSTRAINT fk_cust_next  FOREIGN KEY (next_step_key) REFERENCES ob_step(step_key)
);

CREATE TABLE IF NOT EXISTS ob_customer_phase (
  allmoxy_customer_id INT     NOT NULL,
  phase_id            TINYINT NOT NULL,
  status              ENUM('not_started','in_progress','complete','not_applicable','unknown') NOT NULL,
  started_date        DATE    NULL,
  completed_date      DATE    NULL,
  target_date         DATE    NULL,
  steps_done          SMALLINT NOT NULL DEFAULT 0,
  steps_total         SMALLINT NOT NULL DEFAULT 0,
  source              ENUM('seed','instance','manual') NOT NULL DEFAULT 'seed',
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (allmoxy_customer_id, phase_id),
  CONSTRAINT fk_cp_cust  FOREIGN KEY (allmoxy_customer_id) REFERENCES ob_customer(allmoxy_customer_id),
  CONSTRAINT fk_cp_phase FOREIGN KEY (phase_id) REFERENCES ob_phase(phase_id)
);

-- Every step for every customer, with the evidence behind its status.
--   confidence = 'confirmed' : a source records the step itself (e.g. Stripe Connect account)
--                'inferred'  : implied by a later milestone (live with orders => settings were done)
--                'unknown'   : no source can tell yet; Jake's tab will
CREATE TABLE IF NOT EXISTS ob_customer_step (
  allmoxy_customer_id INT         NOT NULL,
  step_key            VARCHAR(60) NOT NULL,
  status              ENUM('not_started','in_progress','done','not_applicable','unknown') NOT NULL,
  progress_count      SMALLINT    NULL,                     -- e.g. 4 (of target_count 10)
  completed_date      DATE        NULL,
  owner               ENUM('customer','allmoxy','both') NULL,
  confidence          ENUM('confirmed','inferred','unknown') NOT NULL,
  evidence_source     VARCHAR(40) NULL,                     -- hubspot, jira, harvest, stripe, orders, instance
  evidence_detail     VARCHAR(400) NULL,
  source              ENUM('seed','instance','manual') NOT NULL DEFAULT 'seed',
  updated_at          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (allmoxy_customer_id, step_key),
  CONSTRAINT fk_cs_cust FOREIGN KEY (allmoxy_customer_id) REFERENCES ob_customer(allmoxy_customer_id),
  CONSTRAINT fk_cs_step FOREIGN KEY (step_key) REFERENCES ob_step(step_key)
);

-- Filled by the instance tab (who holds each role); the seed leaves it empty.
CREATE TABLE IF NOT EXISTS ob_customer_role (
  allmoxy_customer_id INT          NOT NULL,
  role_key            VARCHAR(40)  NOT NULL,
  contact_name        VARCHAR(120) NOT NULL,
  contact_ref         VARCHAR(300) NULL,                    -- Allmoxy contact link
  source              ENUM('seed','instance','manual') NOT NULL DEFAULT 'instance',
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (allmoxy_customer_id, role_key, contact_name),
  CONSTRAINT fk_cr_role FOREIGN KEY (role_key) REFERENCES ob_role(role_key)
);

CREATE TABLE IF NOT EXISTS ob_customer_document (
  allmoxy_customer_id INT         NOT NULL,
  doc_key             VARCHAR(60) NOT NULL,
  status              ENUM('received','not_sent','not_applicable','unknown') NOT NULL,
  last_received_date  DATE        NULL,
  file_count          SMALLINT    NOT NULL DEFAULT 0,
  source              ENUM('seed','instance','manual') NOT NULL DEFAULT 'instance',
  updated_at          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (allmoxy_customer_id, doc_key),
  CONSTRAINT fk_cd_doc FOREIGN KEY (doc_key) REFERENCES ob_document_type(doc_key)
);

-- Phase 3: the 10 test orders and what was found on each.
CREATE TABLE IF NOT EXISTS ob_validation_order (
  allmoxy_customer_id INT          NOT NULL,
  order_number        VARCHAR(30)  NOT NULL,
  description         VARCHAR(200) NULL,
  status              ENUM('added','ready_for_review','adjustment_reported','approved') NOT NULL,
  adjustments_open    SMALLINT     NOT NULL DEFAULT 0,
  adjustments_fixed   SMALLINT     NOT NULL DEFAULT 0,
  approved_date       DATE         NULL,
  source              ENUM('seed','instance','manual') NOT NULL DEFAULT 'instance',
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (allmoxy_customer_id, order_number)
);

CREATE TABLE IF NOT EXISTS ob_customer_training (
  allmoxy_customer_id INT         NOT NULL,
  session_key         VARCHAR(60) NOT NULL,
  status              ENUM('held','scheduled','not_scheduled','not_applicable') NOT NULL,
  session_date        DATE        NULL,
  recording_url       VARCHAR(400) NULL,
  source              ENUM('seed','instance','manual') NOT NULL DEFAULT 'instance',
  updated_at          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (allmoxy_customer_id, session_key),
  CONSTRAINT fk_ct_session FOREIGN KEY (session_key) REFERENCES ob_training_session(session_key)
);

-- Load rule for the seed: never overwrite a row the instance (or a person) wrote.
--   INSERT ... ON DUPLICATE KEY UPDATE col = IF(source = 'seed', VALUES(col), col), ...
-- seed.sql is generated in that form by build_onboarding.mjs.
