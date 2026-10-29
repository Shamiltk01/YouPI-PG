import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerbaseDatabase, toPostgresParameters } from '../layerbase-database.js';
import { createDatabase, Database } from '../database.js';
import { MerchantRepository } from '../repositories/merchant.repository.js';
import { splitLayerbaseSchemaStatements } from '../migrate.js';
import { PaymentSessionRepository } from '../repositories/payment-session.repository.js';
import { runMaybe } from '../maybe.js';

test('selects Layerbase when configured and preserves explicit in-memory SQLite', () => {
  const pool = { query() {}, connect() {}, end() {} };
  const remote = createDatabase({ connectionString: 'postgresql://layerbase.example/db', pool });
  const local = createDatabase({ inMemory: true, connectionString: 'postgresql://layerbase.example/db', pool });

  assert.ok(remote instanceof LayerbaseDatabase);
  assert.ok(local instanceof Database);
});

test('requires a remote database URL on Vercel instead of silently using ephemeral SQLite', () => {
  assert.throws(
    () => createDatabase({}, { VERCEL: '1' }),
    /DATABASE_URL must be configured on Vercel/
  );
  assert.ok(createDatabase({}, {}).constructor === Database);
});

test('splits Layerbase schema statements without breaking quoted semicolons or trigger bodies', () => {
  const statements = splitLayerbaseSchemaStatements(`
    -- schema comment
    CREATE TABLE entries (id TEXT PRIMARY KEY, label TEXT DEFAULT 'a;b');
    CREATE TRIGGER outbox AFTER UPDATE ON entries
    BEGIN
      INSERT OR IGNORE INTO entries (id, label) VALUES (NEW.id, 'trigger;body');
    END;
    CREATE INDEX idx_entries_label ON entries (label);
  `);

  assert.equal(statements.length, 3);
  assert.match(statements[0], /CREATE TABLE entries/);
  assert.match(statements[1], /CREATE TRIGGER outbox[\s\S]*END$/);
  assert.match(statements[2], /CREATE INDEX idx_entries_label/);
});

test('converts SQLite placeholders without changing quoted text or comments', () => {
  assert.equal(
    toPostgresParameters("SELECT '?' AS literal, value FROM entries WHERE key = ? -- ?\nAND label = ?"),
    "SELECT '?' AS literal, value FROM entries WHERE key = $1 -- ?\nAND label = $2"
  );
});

test('merchant repository awaits remote database results while keeping secret mapping intact', async () => {
  let merchantRow = null;
  const db = {
    async execute(_sql, params) {
      merchantRow = {
        id: params[0],
        business_name: params[1],
        slug: params[2],
        contact_email: params[3],
        contact_phone: params[4],
        webhook_url: params[5],
        webhook_secret: params[6],
        api_key_hash: params[7],
        branding: params[8],
        created_at: params[9],
        updated_at: params[10]
      };
      return { changes: 1 };
    },
    async queryOne() {
      return merchantRow;
    }
  };
  const repository = new MerchantRepository(db);

  const merchant = await repository.create({
    businessName: 'Layerbase Merchant',
    slug: 'layerbase-merchant',
    contactEmail: 'owner@example.test',
    contactPhone: '9876543210',
    webhookSecret: 'test-secret'
  });

  assert.equal(merchant.businessName, 'Layerbase Merchant');
  assert.equal(merchant.webhookSecret, 'test-secret');
});

test('runMaybe preserves synchronous results and sequences asynchronous results', async () => {
  const synchronous = runMaybe(function* () {
    const value = yield 4;
    return value + 1;
  });
  const asynchronous = await runMaybe(function* () {
    const value = yield Promise.resolve(4);
    return value + 1;
  });

  assert.equal(synchronous, 5);
  assert.equal(asynchronous, 5);
});

test('routes nested async transactions through one checked-out connection', async () => {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
    release() {
      statements.push({ sql: 'RELEASE_CLIENT' });
    }
  };
  const pool = {
    async connect() {
      return client;
    },
    async query(sql, values) {
      statements.push({ sql, values });
      return { rows: [], rowCount: 1 };
    }
  };
  const db = new LayerbaseDatabase({ pool });

  await db.transaction(async () => {
    await db.execute('INSERT INTO entries (name) VALUES (?)', ['first']);
    await db.transaction(async () => {
      await db.execute('INSERT INTO entries (name) VALUES (?)', ['nested']);
    });
  });

  assert.deepEqual(statements.map(({ sql }) => sql), [
    'BEGIN',
    'INSERT INTO entries (name) VALUES ($1)',
    'SAVEPOINT youpi_sp_1',
    'INSERT INTO entries (name) VALUES ($1)',
    'RELEASE SAVEPOINT youpi_sp_1',
    'COMMIT',
    'RELEASE_CLIENT'
  ]);
  assert.deepEqual(statements[1].values, ['first']);
  await db.close();
});

test('acquires a UPI slot atomically through the async Layerbase connection', async () => {
  const statements = [];
  const sessionRow = {
    id: 'session-1',
    merchant_id: 'merchant-1',
    customer_id: null,
    receiving_account_id: 'account-1',
    order_id: 'ORDER-1',
    attempt_id: 'attempt-1',
    amount_paise: 12500,
    currency: 'INR',
    method: 'UPI',
    status: 'INITIATED',
    queue_position: 0,
    slot_acquired_at: null,
    expires_at: null,
    processing_started_at: null,
    processing_expires_at: null,
    completed_at: null,
    return_url: null,
    attributed_observation_id: null,
    idempotency_key: null,
    device_id: null,
    verification_level: 0,
    verification_sources: '[]',
    verification_tag: 'UNVERIFIED',
    metadata: '{}',
    created_at: '2026-10-29T00:00:00.000Z',
    updated_at: '2026-10-29T00:00:00.000Z'
  };
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT * FROM payment_sessions WHERE id =')) {
        return { rows: [sessionRow], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id, status, expires_at, processing_expires_at')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      statements.push({ sql: 'RELEASE_CLIENT' });
    }
  };
  const pool = {
    async connect() {
      return client;
    },
    async query(sql, values) {
      statements.push({ sql, values });
      return { rows: [], rowCount: 1 };
    }
  };
  const db = new LayerbaseDatabase({ pool });
  const sessions = new PaymentSessionRepository(db);

  const result = await sessions.acquireSlotAtomic('session-1', 'account-1', 300000);

  assert.equal(result.status, 'ACTIVE');
  assert.equal(result.queuePosition, 0);
  assert.ok(result.expiresAt instanceof Date);
  assert.equal(statements[0].sql, 'BEGIN');
  assert.ok(statements.some(statement => statement.sql.trimStart().startsWith('UPDATE payment_sessions')));
  assert.ok(statements.some(statement => statement.sql.trimStart().startsWith('UPDATE payment_receiving_accounts')));
  assert.equal(statements.at(-2).sql, 'COMMIT');
  assert.equal(statements.at(-1).sql, 'RELEASE_CLIENT');
  await db.close();
});