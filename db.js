import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let dbPromise;

export async function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: new URL('./data.db', import.meta.url).pathname,
      driver: sqlite3.Database
    });
  }
  return dbPromise;
}

export async function initDb() {
  const db = await getDb();
  await db.exec('PRAGMA foreign_keys = ON;');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      category TEXT NOT NULL,
      note TEXT,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      name TEXT NOT NULL,
      sort_order INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(type, name)
    );

    CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type);

    CREATE TABLE IF NOT EXISTS recurring (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      category TEXT NOT NULL,
      cadence TEXT NOT NULL CHECK (cadence IN ('weekly','monthly')),
      day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
      day_of_month INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
      next_due_date TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_recurring_next_due ON recurring(next_due_date);

    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_cents INTEGER NOT NULL CHECK (target_cents >= 0),
      current_cents INTEGER NOT NULL DEFAULT 0 CHECK (current_cents >= 0),
      due_date TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const row = await db.get(`SELECT COUNT(1) AS cnt FROM categories`);
  if ((row?.cnt ?? 0) === 0) {
    const defaults = [
      ['income', 'salary', 10],
      ['income', 'freelance', 20],
      ['income', 'interest', 30],
      ['income', 'refund', 40],
      ['income', 'other', 999],
      ['expense', 'rent', 10],
      ['expense', 'utilities', 20],
      ['expense', 'groceries', 30],
      ['expense', 'food', 40],
      ['expense', 'car', 50],
      ['expense', 'gas', 60],
      ['expense', 'insurance', 70],
      ['expense', 'subscriptions', 80],
      ['expense', 'medical', 90],
      ['expense', 'travel', 100],
      ['expense', 'shopping', 110],
      ['expense', 'other', 999]
    ];
    for (const [type, name, sortOrder] of defaults) {
      await db.run(
        `INSERT OR IGNORE INTO categories (type, name, sort_order, active) VALUES (?, ?, ?, 1)`,
        [type, name, sortOrder]
      );
    }
  }
}

export function parseAmountToCents(amountStr) {
  const cleaned = String(amountStr ?? '').trim().replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  const cents = Math.round(num * 100);
  if (cents < 0) return null;
  return cents;
}

export function formatCents(cents) {
  const dollars = (Number(cents || 0) / 100).toFixed(2);
  return `$${dollars}`;
}

export function isoDateOnly(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return isoDateOnly(d);
}

export function addMonths(dateStr, months, dayOfMonth) {
  const d = new Date(`${dateStr}T00:00:00`);
  const targetMonth = d.getMonth() + months;
  const y = d.getFullYear();
  const m = d.getMonth();
  const curDom = dayOfMonth ?? d.getDate();

  const first = new Date(y, targetMonth, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const dom = Math.min(curDom, lastDay);
  const out = new Date(first.getFullYear(), first.getMonth(), dom);
  return isoDateOnly(out);
}
