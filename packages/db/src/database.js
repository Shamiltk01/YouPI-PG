import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { LayerbaseDatabase } from './layerbase-database.js';
import { runMigrations } from './migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

/**
 * Checks if core tables exist and executes migrations if not yet initialized.
 * @param {Database} db
 */
export function ensureDatabaseInitialized(db) {
  try {
    const row = db.queryOne("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='merchants'");
    if (!row || Number(row.count) === 0) {
      return runMigrations(db);
    }
  } catch {
    return runMigrations(db);
  }
}

export class DatabaseBusyError extends Error {
  constructor(message = 'Database lock contention timeout after bounded retries', originalError = null) {
    super(message);
    this.name = 'DatabaseBusyError';
    this.code = 'DATABASE_BUSY';
    this.isRetryable = true;
    this.originalError = originalError;
  }
}

export function isRetryableSqliteError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toUpperCase();
  return (
    msg.includes('database is locked') ||
    msg.includes('busy') ||
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED'
  );
}

/**
 * Universal Database Client for YOUPI PG.
 * Uses native node:sqlite for high-performance, embedded zero-dependency local operation
 * with full transactional ACID guarantees.
 */
export class Database {
  /**
   * @param {{ dbPath?: string, inMemory?: boolean, autoMigrate?: boolean }} [options={}]
   */
  constructor(options = {}) {
    if (options.inMemory) {
      this.db = new DatabaseSync(':memory:');
    } else {
      let dbPath;
      if (options.dbPath) {
        dbPath = path.isAbsolute(options.dbPath)
          ? options.dbPath
          : path.resolve(process.cwd(), options.dbPath);
      } else if (process.env.SQLITE_DB_PATH) {
        dbPath = path.isAbsolute(process.env.SQLITE_DB_PATH)
          ? process.env.SQLITE_DB_PATH
          : path.resolve(repoRoot, process.env.SQLITE_DB_PATH);
      } else {
        dbPath = path.resolve(repoRoot, 'data/youpi_pg.sqlite');
      }
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(dbPath);
    }

    // Enable foreign keys, busy timeout, and WAL mode for maximum concurrency and integrity
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch {}

    // Auto-initialize SQLite on first boot if core tables do not exist
    if (!options.inMemory && options.autoMigrate !== false) {
      ensureDatabaseInitialized(this);
    }
  }

  /**
   * Normalizes parameter markers from PostgreSQL style ($1, $2) to SQLite style (?, ?).
   * @param {string} sql
   * @returns {string}
   */
  normalizeSql(sql) {
    return sql.replace(/\$\d+/g, '?');
  }

  /**
   * Executes a statement (INSERT, UPDATE, DELETE, DDL).
   * @param {string} sql
   * @param {any[]} [params=[]]
   * @returns {{ changes: number, lastInsertRowid: number | bigint }}
   */
  execute(sql, params = []) {
    const normalized = this.normalizeSql(sql);
    const stmt = this.db.prepare(normalized);
    return stmt.run(...params);
  }

  run(sql, params = []) {
    return this.execute(sql, params);
  }

  /**
   * Queries multiple rows.
   * @param {string} sql
   * @param {any[]} [params=[]]
   * @returns {any[]}
   */
  query(sql, params = []) {
    const normalized = this.normalizeSql(sql);
    const stmt = this.db.prepare(normalized);
    return stmt.all(...params);
  }

  /**
   * Queries a single row.
   * @param {string} sql
   * @param {any[]} [params=[]]
   * @returns {any | null}
   */
  queryOne(sql, params = []) {
    const normalized = this.normalizeSql(sql);
    const stmt = this.db.prepare(normalized);
    const res = stmt.get(...params);
    return res !== undefined ? res : null;
  }

  /**
   * Executes a batch of DDL or SQL statements.
   * @param {string} sql
   */
  exec(sql) {
    this.db.exec(sql);
  }


  /**
   * Executes a callback within an ACID database transaction.
   * Automatically rolls back on exception.
   * Defaults to BEGIN IMMEDIATE to acquire write intent upfront and avoid lock upgrade deadlocks.
   * @template T
   * @param {() => T} callback
   * @param {{ mode?: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE' }} [options={}]
   * @returns {T}
   */
  transaction(callback, options = {}) {
    const mode = options.mode || 'IMMEDIATE';
    const isNested = (this._transactionDepth || 0) > 0;
    const nextDepth = (this._transactionDepth || 0) + 1;
    const savepointName = `sp_${nextDepth}`;

    if (isNested) {
      this.db.exec(`SAVEPOINT ${savepointName};`);
    } else {
      this.db.exec(`BEGIN ${mode} TRANSACTION;`);
    }
    // A rejected BEGIN or SAVEPOINT must not leave a phantom nested transaction.
    this._transactionDepth = nextDepth;

    let asyncResult = false;
    const commit = () => {
      if (isNested) {
        this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      } else {
        this.db.exec('COMMIT;');
      }
    };
    const rollback = () => {
      try {
        if (isNested) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
        } else {
          this.db.exec('ROLLBACK;');
        }
      } catch {
        // Ignore rollback error if already rolled back
      }
    };

    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        asyncResult = true;
        return result.then(value => {
          try {
            commit();
            return value;
          } catch (err) {
            rollback();
            throw err;
          }
        }, err => {
          rollback();
          throw err;
        }).finally(() => {
          this._transactionDepth--;
        });
      }
      commit();
      return result;
    } catch (err) {
      rollback();
      throw err;
    } finally {
      if (!asyncResult) this._transactionDepth--;
    }
  }

  /**
   * Executes a database operation with bounded retries and exponential backoff on retryable lock contention.
   * @template T
   * @param {() => T} operation
   * @param {number} [maxRetries=3]
   * @param {number} [baseDelayMs=50]
   * @returns {T}
   */
  withRetry(operation, maxRetries = 3, baseDelayMs = 50) {
    let attempt = 0;
    const run = () => {
      try {
        const result = operation();
        if (result && typeof result.then === 'function') {
          return result.catch(err => retryOrThrow(err, true));
        }
        return result;
      } catch (err) {
        return retryOrThrow(err, false);
      }
    };
    const retryOrThrow = (err, asynchronous) => {
      attempt++;
      if (attempt > maxRetries || !isRetryableSqliteError(err)) {
        if (isRetryableSqliteError(err)) {
          throw new DatabaseBusyError(`Database lock contention after ${attempt} retry attempt(s): ${err.message}`, err);
        }
        throw err;
      }
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 500) + Math.floor(Math.random() * 20);
      if (asynchronous) return new Promise(resolve => setTimeout(resolve, delay)).then(run);
      const end = Date.now() + delay;
      while (Date.now() < end) {}
      return run();
    }
    return run();
  }

  /**
   * Closes the database connection.
   */
  close() {
    this.db.close();
  }
}

let defaultDbInstance = null;

export function createDatabase(options = {}, env = process.env) {
  const config = options && typeof options === 'object' ? options : {};
  const connectionString = config.connectionString || env.DATABASE_URL;
  if (!config.inMemory && connectionString) {
    return new LayerbaseDatabase({
      connectionString,
      pool: config.pool || null
    });
  }
  if (!config.inMemory && env.VERCEL && !connectionString) {
    throw new Error('DATABASE_URL must be configured on Vercel; local SQLite is not persistent in serverless functions.');
  }
  return new Database(options);
}

/**
 * Returns the singleton database instance.
 * @param {{ dbPath?: string, inMemory?: boolean }} [options={}]
 * @returns {Database}
 */
export function getDatabase(options = {}) {
  if (!defaultDbInstance) {
    defaultDbInstance = createDatabase(options);
    if (!defaultDbInstance.isLayerbase) {
      ensureDatabaseInitialized(defaultDbInstance);
    }
  }
  return defaultDbInstance;
}
