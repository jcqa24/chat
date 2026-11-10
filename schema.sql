USE crm_grupogevhe_test;

-- =========================================================
-- Influencers (las administra el CRM)
--   Links de referido: {PUBLIC_URL}/{RED}{ID}{FIRMA}, p. ej. /IG07x4Kp (IG, FB, TT; firma de 4 caracteres).
--   Los genera el chat (GET /api/referral-links) porque llevan una firma secreta.
--   El id del influencer debe ser menor que 3844. slug ya no se usa en los links.
--   crm_user_id: usuario del CRM dueño de este perfil (para que vea solo sus estadísticas)
-- =========================================================
CREATE TABLE IF NOT EXISTS influencers (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  slug        VARCHAR(50)  NOT NULL,
  name        VARCHAR(100) NOT NULL,
  avatar      VARCHAR(500) NOT NULL DEFAULT '',
  verified    TINYINT(1)   NOT NULL DEFAULT 0,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  crm_user_id INT          NULL,
  last_seen   DATETIME(3)  NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_influencers_slug (slug),
  KEY idx_influencers_crm_user (crm_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================
-- Clientes del chat (se crean solos al abrir un link)
-- =========================================================
CREATE TABLE IF NOT EXISTS chat_users_influencers (
  id         VARCHAR(32) PRIMARY KEY,
  name       VARCHAR(64) NOT NULL DEFAULT 'Cliente',
  last_seen  DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================
-- Conversaciones = referidos
--   Se crea 1 fila la primera vez que un cliente abre el link de un influencer.
--   referral_status: 'pending' hasta el primer pago aprobado en Mercado Pago, luego 'paid'.
--   Para cobrar, el CRM debe crear el pago en Mercado Pago con
--   external_reference = 'chat-{id}'   (id de esta tabla)
-- =========================================================
CREATE TABLE IF NOT EXISTS conversations_influencers (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  influencer_id           INT           NOT NULL,
  client_id               VARCHAR(32)   NOT NULL,
  referral_status         ENUM('pending','paid') NOT NULL DEFAULT 'pending',
  source                  ENUM('instagram','facebook','tiktok') NULL,  -- red del link (IG/FB/TT)
  detected_platform       VARCHAR(16)   NULL,  -- app desde la que se abrió (NULL = navegador normal)
  referral_valid          TINYINT(1)    NOT NULL DEFAULT 1,  -- 0 = se abrió desde otra app: no cuenta
  user_agent              VARCHAR(500)  NULL,
  client_first_message_at DATETIME(3)   NULL,
  last_message_at         DATETIME(3)   NULL,
  paid_at                 DATETIME(3)   NULL,
  payment_id              VARCHAR(64)   NULL,
  payment_amount          DECIMAL(12,2) NULL,
  payment_currency        CHAR(3)       NULL,
  created_at              DATETIME(3)   NOT NULL,
  UNIQUE KEY uq_conv_influencer_client (influencer_id, client_id),
  KEY idx_conv_influencer_created (influencer_id, created_at),
  KEY idx_conv_influencer_status (influencer_id, referral_status),
  CONSTRAINT fk_conv_influencer FOREIGN KEY (influencer_id) REFERENCES influencers(id),
  CONSTRAINT fk_conv_client     FOREIGN KEY (client_id)     REFERENCES chat_users_influencers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================
-- Mensajes
--   sender: 'client' | 'influencer' | 'system'
--   type = 'text'   -> content es el texto
--   type = 'image'  -> content es la URL (/uploads/xxxx.jpg o https://...)
--   type = 'system' -> content es un código ('accepted' = "Iniciaste una conversación con ...")
-- =========================================================
CREATE TABLE IF NOT EXISTS messages_influencers (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT          NOT NULL,
  sender          ENUM('client','influencer','system') NOT NULL,
  type            ENUM('text','image','system') NOT NULL DEFAULT 'text',
  content         TEXT         NOT NULL,
  created_at      DATETIME(3)  NOT NULL,
  KEY idx_msg_conversation (conversation_id, id),
  CONSTRAINT fk_msg_conversation FOREIGN KEY (conversation_id) REFERENCES conversations_influencers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================
-- Pagos recibidos por el webhook de Mercado Pago (todos, para auditoría)
-- =========================================================
CREATE TABLE IF NOT EXISTS payments_influencers (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  mp_payment_id      VARCHAR(64)   NOT NULL,
  conversation_id    INT           NULL,
  external_reference VARCHAR(255)  NULL,
  status             VARCHAR(32)   NOT NULL,
  status_detail      VARCHAR(64)   NULL,
  amount             DECIMAL(12,2) NULL,
  currency           CHAR(3)       NULL,
  approved_at        DATETIME(3)   NULL,
  created_at         DATETIME(3)   NOT NULL,
  updated_at         DATETIME(3)   NOT NULL,
  UNIQUE KEY uq_pay_mp_id (mp_payment_id),
  KEY idx_pay_conversation (conversation_id),
  CONSTRAINT fk_pay_conversation FOREIGN KEY (conversation_id) REFERENCES conversations_influencers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================
-- Vistas de estadísticas (solo cuentan referidos válidos: referral_valid = 1)
-- =========================================================
CREATE OR REPLACE VIEW v_influencer_referral_stats AS
SELECT
  i.id   AS influencer_id,
  i.slug,
  i.name,
  i.active,
  COALESCE(SUM(c.referral_valid = 1), 0)                                       AS conversations_opened,
  COALESCE(SUM(c.referral_valid = 1 AND c.source = 'instagram'), 0)            AS opened_instagram,
  COALESCE(SUM(c.referral_valid = 1 AND c.source = 'facebook'), 0)             AS opened_facebook,
  COALESCE(SUM(c.referral_valid = 1 AND c.source = 'tiktok'), 0)               AS opened_tiktok,
  COALESCE(SUM(c.referral_valid = 1 AND c.client_first_message_at IS NOT NULL), 0) AS conversations_with_messages,
  COALESCE(SUM(c.referral_valid = 1 AND c.referral_status = 'pending'), 0)     AS referrals_pending,
  COALESCE(SUM(c.referral_valid = 1 AND c.referral_status = 'paid'), 0)        AS referrals_paid,
  COALESCE(SUM(CASE WHEN c.referral_valid = 1 AND c.referral_status = 'paid' THEN c.payment_amount END), 0) AS paid_amount_total,
  COALESCE(SUM(c.referral_valid = 0), 0)                                       AS conversations_not_counted
FROM influencers i
LEFT JOIN conversations_influencers c ON c.influencer_id = i.id
GROUP BY i.id, i.slug, i.name, i.active;

CREATE OR REPLACE VIEW v_influencer_referral_stats_by_source AS
SELECT
  c.influencer_id,
  c.source,
  COUNT(*)                                   AS conversations_opened,
  SUM(c.client_first_message_at IS NOT NULL) AS conversations_with_messages,
  SUM(c.referral_status = 'pending')         AS referrals_pending,
  SUM(c.referral_status = 'paid')            AS referrals_paid,
  COALESCE(SUM(CASE WHEN c.referral_status = 'paid' THEN c.payment_amount END), 0) AS paid_amount_total
FROM conversations_influencers c
WHERE c.referral_valid = 1 AND c.source IS NOT NULL
GROUP BY c.influencer_id, c.source;

-- Influencer de ejemplo
INSERT IGNORE INTO influencers (slug, name, avatar, verified)
VALUES ('sandra', 'Sandra', '/avatars/sandra.png', 1);

-- =========================================================
-- Consultas de ejemplo para el CRM
-- =========================================================

-- Administrador: todos los influencers
--   SELECT * FROM v_influencer_referral_stats ORDER BY conversations_opened DESC;

-- Influencer: solo sus estadísticas
--   SELECT s.* FROM v_influencer_referral_stats s
--   JOIN influencers i ON i.id = s.influencer_id
--   WHERE i.crm_user_id = ?;

-- Por rango de fechas (conversaciones abiertas en el periodo)
--   SELECT influencer_id,
--          COUNT(*)                        AS conversations_opened,
--          SUM(referral_status = 'pending') AS referrals_pending,
--          SUM(referral_status = 'paid')    AS referrals_paid
--   FROM conversations_influencers
--   WHERE referral_valid = 1 AND created_at >= ? AND created_at < ?
--   GROUP BY influencer_id;

-- Por red social de un influencer
--   SELECT * FROM v_influencer_referral_stats_by_source WHERE influencer_id = ?;

-- Detalle de referidos de un influencer
--   SELECT c.id AS conversation_id, c.client_id, u.name AS client_name, c.created_at, c.source,
--          c.detected_platform, c.referral_valid,
--          c.client_first_message_at, c.referral_status, c.paid_at, c.payment_amount, c.payment_currency
--   FROM conversations_influencers c
--   JOIN chat_users_influencers u ON u.id = c.client_id
--   WHERE c.influencer_id = ?
--   ORDER BY c.created_at DESC;
