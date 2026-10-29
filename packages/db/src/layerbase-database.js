import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';

export function toPostgresParameters(sql) {
  let output = '';
  let parameterIndex = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      output += character;
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      output += character;
      if (character === '*' && next === '/') {
        output += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      output += character;
      if (character === quote) {
        if (next === quote) {
          output += next;
          index += 1;
        } else {
          quote = null;
        }
      } else if (character === '\\' && next && quote === "'") {
        output += next;
        index += 1;
      }
      continue;
    }

    if (character === '-' && next === '-') {
      output += `${character}${next}`;
      index += 1;
      lineComment = true;
    } else if (character === '/' && next === '*') {
      output += `${character}${next}`;
      index += 1;
      blockComment = true;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
      output += character;
    } else if (character === '?') {
      parameterIndex += 1;
      output += `$${parameterIndex}`;
    } else {
      output += character;
    }
  }

  return output;
}

export class LayerbaseDatabase {
  constructor({ connectionString = process.env.DATABASE_URL, pool = null } = {}) {
    if (!pool && !connectionString) {
      throw new Error('DATABASE_URL is required for the Layerbase database.');
    }

    this.pool = pool || new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX || 5),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
    this.isLayerbase = true;
    this.transactionStorage = new AsyncLocalStorage();
  }

  async execute(sql, params = []) {
    const result = await this._query(sql, params);
    return {
      changes: result.rowCount || 0,
      lastInsertRowid: result.rows?.[0]?.id ?? 0
    };
  }

  async run(sql, params = []) {
    return this.execute(sql, params);
  }

  async query(sql, params = []) {
    const result = await this._query(sql, params);
    return result.rows;
  }

  async queryOne(sql, params = []) {
    const result = await this._query(sql, params);
    return result.rows[0] ?? null;
  }

  async exec(sql) {
    const client = this.transactionStorage.getStore()?.client;
    const target = client || this.pool;
    return target.query({ text: sql, queryMode: 'simple' });
  }

  async transaction(callback) {
    const current = this.transactionStorage.getStore();
    if (current) {
      const savepoint = `youpi_sp_${++current.depth}`;
      await current.client.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await callback();
        await current.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await current.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        current.depth -= 1;
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      return await this.transactionStorage.run({ client, depth: 0 }, async () => {
        try {
          const result = await callback();
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    } finally {
      client.release();
    }
  }

  async close() {
    if (typeof this.pool.end === 'function') {
      await this.pool.end();
    }
  }

  async _query(sql, params) {
    const target = this.transactionStorage.getStore()?.client || this.pool;
    return target.query(toPostgresParameters(sql), params);
  }
}