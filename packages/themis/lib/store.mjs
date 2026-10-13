import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const parse = row => row ? JSON.parse(row.data) : null;

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_grant ON grants(status) WHERE status='active';
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_in_flight ON requests((1)) WHERE status IN ('checking','pending','authorizing');`);
  }
  close() { this.db.close(); }
  grant(id) { return parse(this.db.prepare('SELECT data FROM grants WHERE id=?').get(id)); }
  active() { return parse(this.db.prepare("SELECT data FROM grants WHERE status='active'").get()); }
  grants() { return this.db.prepare('SELECT data FROM grants').all().map(parse); }
  putGrant(grant) { this.db.prepare('INSERT INTO grants VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(grant.id, grant.status, JSON.stringify(grant)); }
  activate(grant) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.active();
      if (old && old.id !== grant.id) this.putGrant({ ...old, status: 'expired' });
      this.putGrant({ ...grant, status: 'active' }); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  request(id) { return parse(this.db.prepare('SELECT data FROM requests WHERE id=?').get(id)); }
  pending() { return this.db.prepare("SELECT data FROM requests WHERE status IN ('checking','pending','authorizing')").all().map(parse); }
  insert(row) { this.db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(row.id, row.fingerprint, row.status, JSON.stringify(row)); }
  update(row) { this.db.prepare('UPDATE requests SET status=?,data=? WHERE id=?').run(row.status, JSON.stringify(row), row.id); }
  log(limit = 100) { return this.db.prepare('SELECT data FROM requests ORDER BY rowid DESC LIMIT ?').all(limit).map(parse); }
  spent(grant) {
    const rows = this.db.prepare("SELECT data FROM requests WHERE status='executed'").all().map(parse);
    return BigInt(grant.initialSpent || '0') + rows.filter(row => row.grantId === grant.id).reduce((sum, row) => sum + BigInt(row.amountUnits || '0'), 0n);
  }
}
