# Backend — Hotel Outreach CRM

Node.js + Express + PostgreSQL API. See the root `README.md` (one level up) for full project setup, environment variables, and API reference. This file covers backend-specific process notes.

---

## Database Schema Changes — Required Process

A manually-run `psql -f migrate_x.sql` only reaches whichever database you happened to point it at. It's easy to run it against local dev, forget production entirely, and not find out until the first request that touches the new table crashes in prod. Every schema change must go through all three steps below, not just the first one:

1. **Migration file** — add a new `database/migrate_<name>.sql` (or extend an existing one). Only additive/idempotent SQL: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Never `DROP` / `TRUNCATE` / destructive statements in one of these files.
2. **Fresh installs** — append the same statements to `database/schema.sql` so a brand-new `npm run db:setup` still ends up complete.
3. **Auto-heal on boot** — inline the same statements into `initDB()` in `server.js` (or a service's own startup block, the way `schedulerService.js` creates `agent_tasks` on require). This step is the one that actually matters for production: Render runs `initDB()` on every boot regardless of who remembers to run a migration file by hand, so this is what keeps a live database in sync with the code being deployed.

Before committing: run the new SQL against your local DB directly (e.g. `node -e` with the `pg` pool, or `psql`) to catch syntax errors early — a broken statement in `initDB()` won't surface until the next deploy tries to boot and everything goes down.
