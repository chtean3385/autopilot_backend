// Creates a throwaway local test DB (default "autoagent_overnight") next to the dev DB, using the same
// Postgres server/credentials as DATABASE_URL, and loads database/schema.sql into it. Boot the server
// against it with scripts/run_test_server.sh — initDB() then brings it fully up to date.
// Why: the local dev DB mirrors prod (real leads, live Brevo sender), so feature testing must not
// touch it. Pass --reset to drop and recreate.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';

function urlFor(dbName) {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

(async () => {
  const devDb = new URL(process.env.DATABASE_URL).pathname.slice(1);
  if (devDb === TEST_DB) throw new Error('TEST_DB_NAME must differ from the dev DB');

  const admin = new Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  if (process.argv.includes('--reset')) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    console.log(`Dropped ${TEST_DB}`);
  }
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (exists.rows.length === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    console.log(`Created ${TEST_DB}`);
  }
  await admin.end();

  const db = new Client({ connectionString: urlFor(TEST_DB) });
  await db.connect();
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await db.end();
  console.log(`Loaded schema.sql into ${TEST_DB}`);
  console.log(`TEST_DATABASE_URL=${urlFor(TEST_DB).replace(/:[^:@/]+@/, ':***@')}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
