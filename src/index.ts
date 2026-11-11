import fs from 'fs';
import path from 'path';
import { pool } from './config/database.js';
import { redis } from './config/redis.js';

async function bootstrap() {
  console.log('🚀 [Principal SWE] Initializing System Verification...');

  try {
    const pgRes = await pool.query('SELECT NOW() as current_time, version();');
    console.log(`✅ [PostgreSQL] Connected successfully. Engine: ${pgRes.rows[0].version.split(' ')[0]} at ${pgRes.rows[0].current_time}`);

    const redisRes = await redis.ping();
    console.log(`✅ [Redis] Connected successfully. Ping: ${redisRes}`);

    console.log('📦 [PostgreSQL] Executing Double-Entry Schema DDL...');
    const schemaSql = fs.readFileSync(path.join(process.cwd(), 'src/sql/schema.sql'), 'utf-8');
    await pool.query(schemaSql);
    console.log('✅ [PostgreSQL] Ledger tables and constraint checks applied.');

    console.log('🎯 [Verification] All distributed infrastructure components operational.');
  } catch (error) {
    console.error('❌ [Failure] Bootstrap verification aborted:', error);
    process.exit(1);
  } finally {
    await pool.end();
    await redis.quit();
  }
}

bootstrap();

