// Shared test helpers: a fresh PGlite database with the Supabase stubs and schema.sql applied (twice),
// plus a way to run SQL "as a client" exactly like PostgREST does it:
//   set role authenticated + set_config('request.jwt.claims', '<json>') -> auth.uid() / auth.jwt() work.
// asService() / asRole('anon') run SQL as the service_role / anon API roles (no user).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_SQL = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
export const SEED_SQL = readFileSync(join(here, '..', 'seed_news.sql'), 'utf8');
export const STUB_SQL = readFileSync(join(here, 'supabase_stub.sql'), 'utf8');

export const CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;

/** Build JWT claims like Supabase puts them in request.jwt.claims. */
export function claims(uid, { age = 3600, method = 'password', aal = 'aal1', amr } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const c = { sub: uid, role: 'authenticated', aal, email: `${uid}@example.test` };
  if (amr !== undefined) c.amr = amr;            // explicit (null = no claim at all)
  else c.amr = [{ method, timestamp: now - age }];
  if (c.amr === null) delete c.amr;
  return c;
}

export async function freshDb({ runs = 2 } = {}) {
  const db = new PGlite();
  await db.exec(STUB_SQL);
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await db.exec(SCHEMA_SQL));
  return new Ctx(db, results);
}

class Ctx {
  constructor(db, results) {
    this.db = db;
    this.schemaRuns = results;   // array of exec() result arrays, one per run
  }

  /** Last result set of a schema run = the bootstrap select. */
  bootstrapRow(run = this.schemaRuns.length - 1) {
    return this.schemaRuns[run].at(-1).rows[0];
  }

  async runSchemaAgain() {
    const r = await this.db.exec(SCHEMA_SQL);
    this.schemaRuns.push(r);
    return r.at(-1).rows[0];
  }

  async reset() {
    await this.db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
  }

  /** Run SQL as postgres (the SQL editor / owner). */
  async sql(text, params = []) {
    await this.reset();
    return (await this.db.query(text, params)).rows;
  }

  /**
   * Run SQL as a client. `who` is a uid string (stale password sign-in, aal1) or
   * {uid, age, method, aal, amr} or {claims: <object>}.
   */
  async as(who, text, params = []) {
    const c = typeof who === 'string' ? claims(who) : (who.claims ?? claims(who.uid, who));
    await this.reset();
    await this.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(c)]);
    await this.db.exec('set role authenticated');
    try {
      return (await this.db.query(text, params)).rows;
    } finally {
      await this.reset();
    }
  }

  /** Same as as(), but several statements in one exec (no params); returns the last result's rows. */
  async asExec(who, text) {
    const c = typeof who === 'string' ? claims(who) : (who.claims ?? claims(who.uid, who));
    await this.reset();
    await this.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(c)]);
    await this.db.exec('set role authenticated');
    try {
      const r = await this.db.exec(text);
      return r.at(-1).rows;
    } finally {
      await this.reset();
    }
  }

  /**
   * Run SQL as an API role without a signed-in user, like PostgREST does with that key:
   * 'service_role' (the Edge Function's service key) or 'anon'. auth.uid() is null.
   */
  async asRole(role, text, params = []) {
    if (!['service_role', 'anon'].includes(role)) throw new Error(`asRole: unexpected role ${role}`);
    await this.reset();
    await this.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role })]);
    await this.db.exec(`set role ${role}`);
    try {
      return (await this.db.query(text, params)).rows;
    } finally {
      await this.reset();
    }
  }

  /** Run SQL as service_role (see asRole). */
  asService(text, params = []) {
    return this.asRole('service_role', text, params);
  }

  /** Create an auth user (the profile comes from the trigger). */
  async createUser(email) {
    const id = randomUUID();
    await this.sql(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
    return id;
  }

  /** Create a user and approve it directly as postgres (test setup shortcut). */
  async approvedUser(email, role = 'member') {
    const id = await this.createUser(email);
    await this.sql(`update public.profiles set approved = true, role = $2 where id = $1`, [id, role]);
    return id;
  }

  async registerBot(uid, name = 'Main PC', desired = { live: false, control: { mode: 'run' } }) {
    const rows = await this.as(uid, `select public.register_bot($1, $2::jsonb) as id`, [name, JSON.stringify(desired)]);
    return rows[0].id;
  }
}
