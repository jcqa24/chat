const crypto = require('crypto');
const mysql = require('mysql2/promise');

let pool;

// Primera variable con valor. Además de DB_* acepta las que crea el MySQL de Railway (MYSQLHOST, etc.).
const env = (...nombres) => nombres.map((n) => process.env[n]).find((v) => v !== undefined && v !== '');

const config = {
  host: env('DB_HOST', 'MYSQLHOST') || '127.0.0.1',
  port: Number(env('DB_PORT', 'MYSQLPORT') || 3306),
  user: env('DB_USER', 'MYSQLUSER') || 'root',
  password: env('DB_PASSWORD', 'MYSQLPASSWORD', 'MYSQL_ROOT_PASSWORD') || '',
  database: env('DB_NAME', 'MYSQLDATABASE', 'MYSQL_DATABASE') || 'chat_app',
};

function connectionOptions() {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: 'utf8mb4',
  };
}

const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

const STATS_VIEW_SQL = `
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
  GROUP BY i.id, i.slug, i.name, i.active`;

const STATS_BY_SOURCE_VIEW_SQL = `
  CREATE OR REPLACE VIEW v_influencer_referral_stats_by_source AS
  SELECT
    c.influencer_id,
    c.source,
    COUNT(*)                                       AS conversations_opened,
    SUM(c.client_first_message_at IS NOT NULL)     AS conversations_with_messages,
    SUM(c.referral_status = 'pending')             AS referrals_pending,
    SUM(c.referral_status = 'paid')                AS referrals_paid,
    COALESCE(SUM(CASE WHEN c.referral_status = 'paid' THEN c.payment_amount END), 0) AS paid_amount_total
  FROM conversations_influencers c
  WHERE c.referral_valid = 1 AND c.source IS NOT NULL
  GROUP BY c.influencer_id, c.source`;

async function tableExists(table) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return rows.length > 0;
}

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function init() {
  const dbName = config.database;
  if (!/^\w+$/.test(dbName)) throw new Error('DB_NAME inválido');

  const conn = await mysql.createConnection(connectionOptions());
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();

  pool = mysql.createPool({ ...connectionOptions(), database: dbName, connectionLimit: 10 });

  await migrateLegacySchema();

  // Influencers (los administra el CRM)
  await pool.query(`
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
    ) ${TABLE_OPTS}`);

  // Clientes del chat
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_users_influencers (
      id         VARCHAR(32) PRIMARY KEY,
      name       VARCHAR(64) NOT NULL DEFAULT 'Cliente',
      last_seen  DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ${TABLE_OPTS}`);

  // Conversación = referido (1 por influencer + cliente)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations_influencers (
      id                      INT AUTO_INCREMENT PRIMARY KEY,
      influencer_id           INT           NOT NULL,
      client_id               VARCHAR(32)   NOT NULL,
      referral_status         ENUM('pending','paid') NOT NULL DEFAULT 'pending',
      source                  ENUM('instagram','facebook','tiktok') NULL,
      detected_platform       VARCHAR(16)   NULL,
      referral_valid          TINYINT(1)    NOT NULL DEFAULT 1,
      user_agent              VARCHAR(500)  NULL,
      client_first_message_at DATETIME(3)   NULL,
      last_message_at         DATETIME(3)   NULL,
      paid_at                 DATETIME(3)   NULL,
      payment_id              VARCHAR(64)   NULL,
      payment_amount          DECIMAL(12,2) NULL,
      payment_currency        CHAR(3)       NULL,
      lead_name               VARCHAR(100)  NULL,
      app_code                VARCHAR(12)   NULL,
      app_code_at             DATETIME(3)   NULL,
      crm_lead_id             INT           NULL,
      created_at              DATETIME(3)   NOT NULL,
      UNIQUE KEY uq_conv_influencer_client (influencer_id, client_id),
      UNIQUE KEY uq_conv_app_code (app_code),
      KEY idx_conv_influencer_created (influencer_id, created_at),
      KEY idx_conv_influencer_status (influencer_id, referral_status),
      CONSTRAINT fk_conv_influencer FOREIGN KEY (influencer_id) REFERENCES influencers(id),
      CONSTRAINT fk_conv_client     FOREIGN KEY (client_id)     REFERENCES chat_users_influencers(id)
    ) ${TABLE_OPTS}`);

  // Columnas de origen añadidas después (tablas creadas con la versión anterior)
  const sourceColumns = {
    source: "ENUM('instagram','facebook','tiktok') NULL AFTER referral_status",
    detected_platform: 'VARCHAR(16) NULL AFTER source',
    referral_valid: 'TINYINT(1) NOT NULL DEFAULT 1 AFTER detected_platform',
    user_agent: 'VARCHAR(500) NULL AFTER referral_valid',
    // Registro del cliente cuando acepta continuar el trámite
    lead_name: 'VARCHAR(100) NULL AFTER payment_currency',
    app_code: 'VARCHAR(12) NULL AFTER lead_name',
    app_code_at: 'DATETIME(3) NULL AFTER app_code',
    crm_lead_id: 'INT NULL AFTER app_code_at',
  };
  for (const [col, def] of Object.entries(sourceColumns)) {
    if (!(await columnExists('conversations_influencers', col))) {
      await pool.query(`ALTER TABLE conversations_influencers ADD COLUMN ${col} ${def}`);
    }
  }
  const [[codeIndex]] = await pool.query(
    `SELECT 1 AS ok FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversations_influencers' AND INDEX_NAME = 'uq_conv_app_code' LIMIT 1`
  );
  if (!codeIndex) {
    await pool.query('ALTER TABLE conversations_influencers ADD UNIQUE KEY uq_conv_app_code (app_code)');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages_influencers (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id INT          NOT NULL,
      sender          ENUM('client','influencer','system') NOT NULL,
      type            ENUM('text','image','system') NOT NULL DEFAULT 'text',
      content         TEXT         NOT NULL,
      created_at      DATETIME(3)  NOT NULL,
      KEY idx_msg_conversation (conversation_id, id),
      CONSTRAINT fk_msg_conversation FOREIGN KEY (conversation_id) REFERENCES conversations_influencers(id)
    ) ${TABLE_OPTS}`);

  // Registro de pagos recibidos de Mercado Pago
  await pool.query(`
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
    ) ${TABLE_OPTS}`);

  // Vistas de estadísticas para el CRM (solo cuentan referidos válidos)
  await pool.query(STATS_VIEW_SQL);
  await pool.query(STATS_BY_SOURCE_VIEW_SQL);

  // Para desarrollo: si no hay influencers, crea a Sandra
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM influencers');
  if (total === 0) {
    await pool.query(
      `INSERT INTO influencers (slug, name, avatar, verified) VALUES ('sandra', 'Sandra', '/avatars/sandra.png', 1)`
    );
  }
}

// La versión anterior guardaba mensajes con sender_id/receiver_id y a la influencer como usuario.
// Se respalda esa tabla (datos de prueba) y se limpia la de usuarios.
async function migrateLegacySchema() {
  if ((await tableExists('messages_influencers')) && (await columnExists('messages_influencers', 'sender_id'))) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const backup = `messages_influencers_bak_${stamp}`;
    await pool.query(`RENAME TABLE messages_influencers TO \`${backup}\``);
    const [fks] = await pool.query(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
      [backup]
    );
    for (const { CONSTRAINT_NAME } of fks) {
      await pool.query(`ALTER TABLE \`${backup}\` DROP FOREIGN KEY \`${CONSTRAINT_NAME}\``);
    }
    console.log(`Mensajes de la versión anterior respaldados en la tabla ${backup}`);
  }

  if (await tableExists('chat_users_influencers')) {
    if (await columnExists('chat_users_influencers', 'role')) {
      await pool.query(`DELETE FROM chat_users_influencers WHERE role = 'influencer'`);
      await pool.query('ALTER TABLE chat_users_influencers DROP COLUMN role');
    }
    for (const col of ['avatar', 'verified']) {
      if (await columnExists('chat_users_influencers', col)) {
        await pool.query(`ALTER TABLE chat_users_influencers DROP COLUMN ${col}`);
      }
    }
    // Las claves foráneas exigen la misma collation que las tablas nuevas
    const [[col]] = await pool.query(
      `SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_users_influencers' AND COLUMN_NAME = 'id'`
    );
    if (col && col.c !== 'utf8mb4_unicode_ci') {
      await pool.query(
        'ALTER TABLE chat_users_influencers CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
      );
    }
    if (!(await columnExists('chat_users_influencers', 'created_at'))) {
      await pool.query(
        'ALTER TABLE chat_users_influencers ADD COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)'
      );
    }
  }
}

// ---------- DTOs ----------
const iso = (d) => (d ? new Date(d).toISOString() : null);

function toMessageDto(row) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender: row.sender,
    type: row.type,
    content: row.content,
    created_at: iso(row.created_at),
  };
}

function toInfluencerDto(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    avatar: row.avatar,
    verified: !!row.verified,
    active: !!row.active,
    last_seen: iso(row.last_seen),
  };
}

function toClientDto(row) {
  return { id: row.id, name: row.name, last_seen: iso(row.last_seen) };
}

// ---------- Influencers ----------
async function getActiveInfluencer(id) {
  const [[row]] = await pool.query('SELECT * FROM influencers WHERE id = ? AND active = 1', [id]);
  return row ? toInfluencerDto(row) : null;
}

async function getInfluencers({ onlyActive = false } = {}) {
  const [rows] = await pool.query(
    `SELECT * FROM influencers ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY id`
  );
  return rows.map(toInfluencerDto);
}

async function getInfluencer(id) {
  const [[row]] = await pool.query('SELECT * FROM influencers WHERE id = ?', [id]);
  return row ? toInfluencerDto(row) : null;
}

async function touchInfluencer(id, date) {
  await pool.query('UPDATE influencers SET last_seen = ? WHERE id = ?', [date, id]);
}

// ---------- Clientes ----------
async function ensureClient(id, name) {
  await pool.query(
    'INSERT IGNORE INTO chat_users_influencers (id, name, created_at) VALUES (?, ?, ?)',
    [id, name || 'Cliente', new Date()]
  );
  if (name) await pool.query('UPDATE chat_users_influencers SET name = ? WHERE id = ?', [name, id]);
  const [[row]] = await pool.query('SELECT * FROM chat_users_influencers WHERE id = ?', [id]);
  return toClientDto(row);
}

async function getClient(id) {
  const [[row]] = await pool.query('SELECT * FROM chat_users_influencers WHERE id = ?', [id]);
  return row ? toClientDto(row) : null;
}

async function touchClient(id, date) {
  await pool.query('UPDATE chat_users_influencers SET last_seen = ? WHERE id = ?', [date, id]);
}

// ---------- Conversaciones / referidos ----------
// Crea la conversación si no existe. created = true => conversación nueva.
// ref = { source, detectedPlatform, valid, userAgent }
// Atribución al primer origen válido: si la conversación existía pero no contaba y ahora llega
// por un link válido, pasa a contar con ese origen.
async function ensureConversation(influencerId, clientId, ref) {
  const [res] = await pool.query(
    `INSERT IGNORE INTO conversations_influencers
       (influencer_id, client_id, source, detected_platform, referral_valid, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [influencerId, clientId, ref.source, ref.detectedPlatform, ref.valid ? 1 : 0, ref.userAgent, new Date()]
  );
  const created = res.affectedRows === 1;
  if (!created && ref.valid) {
    await pool.query(
      `UPDATE conversations_influencers
       SET source = ?, detected_platform = ?, referral_valid = 1, user_agent = ?
       WHERE influencer_id = ? AND client_id = ? AND referral_valid = 0`,
      [ref.source, ref.detectedPlatform, ref.userAgent, influencerId, clientId]
    );
  }
  const [[row]] = await pool.query(
    'SELECT * FROM conversations_influencers WHERE influencer_id = ? AND client_id = ?',
    [influencerId, clientId]
  );
  return { conversation: row, created };
}

async function getConversation(id) {
  const [[row]] = await pool.query('SELECT * FROM conversations_influencers WHERE id = ?', [id]);
  return row || null;
}

async function getMessages(conversationId, limit = 200) {
  const [rows] = await pool.query(
    `SELECT * FROM (
       SELECT * FROM messages_influencers WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
     ) t ORDER BY id ASC`,
    [conversationId, limit]
  );
  return rows.map(toMessageDto);
}

async function insertMessage({ conversationId, sender, type, content }) {
  const createdAt = new Date();
  const [res] = await pool.query(
    'INSERT INTO messages_influencers (conversation_id, sender, type, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [conversationId, sender, type, content, createdAt]
  );
  if (sender === 'system') {
    // no cuenta como actividad
  } else if (sender === 'client') {
    await pool.query(
      `UPDATE conversations_influencers
       SET last_message_at = ?, client_first_message_at = COALESCE(client_first_message_at, ?)
       WHERE id = ?`,
      [createdAt, createdAt, conversationId]
    );
  } else {
    await pool.query('UPDATE conversations_influencers SET last_message_at = ? WHERE id = ?', [
      createdAt,
      conversationId,
    ]);
  }
  return toMessageDto({ id: res.insertId, conversation_id: conversationId, sender, type, content, created_at: createdAt });
}

// ---------- Pagos (Mercado Pago) ----------
// Guarda/actualiza el pago y, si es el primer pago aprobado de la conversación, marca el referido como pagado.
async function recordPayment(p) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let conversationId = p.conversationId;
    if (conversationId) {
      const [[c]] = await conn.query('SELECT id FROM conversations_influencers WHERE id = ? FOR UPDATE', [
        conversationId,
      ]);
      if (!c) conversationId = null;
    }

    const now = new Date();
    await conn.query(
      `INSERT INTO payments_influencers
         (mp_payment_id, conversation_id, external_reference, status, status_detail, amount, currency, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status), status_detail = VALUES(status_detail), amount = VALUES(amount),
         currency = VALUES(currency), approved_at = VALUES(approved_at), updated_at = VALUES(updated_at)`,
      [
        p.mpPaymentId,
        conversationId,
        p.externalReference,
        p.status,
        p.statusDetail,
        p.amount,
        p.currency,
        p.approvedAt,
        now,
        now,
      ]
    );

    let markedPaid = false;
    if (conversationId && p.status === 'approved') {
      const [res] = await conn.query(
        `UPDATE conversations_influencers
         SET referral_status = 'paid', paid_at = ?, payment_id = ?, payment_amount = ?, payment_currency = ?
         WHERE id = ? AND referral_status = 'pending'`,
        [p.approvedAt || now, p.mpPaymentId, p.amount, p.currency, conversationId]
      );
      markedPaid = res.affectedRows === 1;
    }

    await conn.commit();
    return { conversationId, markedPaid };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------- Registro del cliente (código para la app) ----------
// Sin 0/O, 1/I/L: el cliente lo copia a mano en la app.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newAppCode = () =>
  'GV' + Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');

/**
 * Guarda el nombre del cliente y le asigna un código para la app.
 * Si la conversación ya tiene código, devuelve el mismo (n8n puede llamar varias veces).
 */
async function registerLead(conversationId, name) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query('SELECT * FROM conversations_influencers WHERE id = ? FOR UPDATE', [conversationId]);
    if (!row) {
      await conn.rollback();
      return null;
    }
    let code = row.app_code;
    let created = false;
    if (!code) {
      for (let intento = 0; intento < 5 && !code; intento++) {
        const candidato = newAppCode();
        const [[existe]] = await conn.query('SELECT 1 AS ok FROM conversations_influencers WHERE app_code = ?', [candidato]);
        if (!existe) code = candidato;
      }
      if (!code) throw new Error('No se pudo generar un código único');
      created = true;
    }
    await conn.query(
      'UPDATE conversations_influencers SET lead_name = ?, app_code = ?, app_code_at = COALESCE(app_code_at, ?) WHERE id = ?',
      [name, code, new Date(), conversationId]
    );
    await conn.commit();
    const [[updated]] = await pool.query('SELECT * FROM conversations_influencers WHERE id = ?', [conversationId]);
    return { conversation: updated, created };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function setCrmLeadId(conversationId, leadId) {
  await pool.query('UPDATE conversations_influencers SET crm_lead_id = ? WHERE id = ?', [leadId, conversationId]);
}

module.exports = {
  config,
  init,
  getActiveInfluencer,
  getInfluencers,
  getInfluencer,
  touchInfluencer,
  ensureClient,
  getClient,
  touchClient,
  ensureConversation,
  getConversation,
  getMessages,
  insertMessage,
  recordPayment,
  registerLead,
  setCrmLeadId,
};
