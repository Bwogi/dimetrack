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

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      category TEXT NOT NULL,
      monthly_limit_cents INTEGER NOT NULL CHECK (monthly_limit_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(type, category)
    );

    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      destination TEXT NOT NULL,
      date TEXT NOT NULL,
      odometer_start REAL,
      odometer_end REAL,
      miles REAL NOT NULL DEFAULT 0 CHECK (miles >= 0),
      gas_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (gas_cost_cents >= 0),
      gas_estimated INTEGER NOT NULL DEFAULT 1,
      other_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (other_cost_cents >= 0),
      income_cents INTEGER NOT NULL DEFAULT 0 CHECK (income_cents >= 0),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trips_date ON trips(date);

    CREATE TABLE IF NOT EXISTS vehicle_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mpg REAL NOT NULL DEFAULT 25.0,
      gas_price_cents INTEGER NOT NULL DEFAULT 350
    );

    INSERT OR IGNORE INTO vehicle_settings (id, mpg, gas_price_cents) VALUES (1, 25.0, 350);

    CREATE TABLE IF NOT EXISTS allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      alloc_type TEXT NOT NULL CHECK (alloc_type IN ('fixed','percent')),
      amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
      percent REAL NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100),
      priority INTEGER NOT NULL DEFAULT 100,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add odometer columns to existing trips table if missing
  try {
    const cols = await db.all(`PRAGMA table_info(trips)`);
    const colNames = cols.map(c => c.name);
    if (!colNames.includes('odometer_start')) {
      await db.exec(`ALTER TABLE trips ADD COLUMN odometer_start REAL`);
    }
    if (!colNames.includes('odometer_end')) {
      await db.exec(`ALTER TABLE trips ADD COLUMN odometer_end REAL`);
    }
    if (!colNames.includes('gas_estimated')) {
      await db.exec(`ALTER TABLE trips ADD COLUMN gas_estimated INTEGER NOT NULL DEFAULT 1`);
    }
  } catch (_) { /* columns already exist */ }

  const row = await db.get(`SELECT COUNT(1) AS cnt FROM categories`);
  if ((row?.cnt ?? 0) === 0) {
    const defaults = [
      ['income', 'salary', 10],
      ['income', 'freelance', 20],
      ['income', 'interest', 30],
      ['income', 'refund', 40],
      ['income', 'trip-income', 50],
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
      ['expense', 'trip-expense', 115],
      ['expense', 'other', 999]
    ];
    for (const [type, name, sortOrder] of defaults) {
      await db.run(
        `INSERT OR IGNORE INTO categories (type, name, sort_order, active) VALUES (?, ?, ?, 1)`,
        [type, name, sortOrder]
      );
    }
  }

  // Ensure trip-related categories exist (for existing databases)
  await db.run(`INSERT OR IGNORE INTO categories (type, name, sort_order, active) VALUES ('income', 'trip-income', 50, 1)`);
  await db.run(`INSERT OR IGNORE INTO categories (type, name, sort_order, active) VALUES ('expense', 'trip-expense', 115, 1)`);
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

export async function autoPostOverdueRecurring(db, todayIso) {
  const overdueItems = await db.all(
    `SELECT * FROM recurring WHERE active=1 AND next_due_date <= ?`,
    [todayIso]
  );
  let posted = 0;
  for (const item of overdueItems) {
    await db.run(
      `INSERT INTO transactions (type, amount_cents, category, note, date) VALUES (?, ?, ?, ?, ?)`,
      [item.type, item.amount_cents, item.category, `Recurring: ${item.name}`, item.next_due_date]
    );
    let nextDue;
    if (item.cadence === 'weekly') {
      nextDue = addDays(item.next_due_date, 7);
    } else {
      nextDue = addMonths(item.next_due_date, 1, item.day_of_month);
    }
    await db.run(`UPDATE recurring SET next_due_date=? WHERE id=?`, [nextDue, item.id]);
    posted++;
  }
  return posted;
}

export function exportToCsv(columns, rows) {
  const escape = (s) => {
    const str = String(s ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };
  const header = columns.map(escape).join(',');
  const body = rows.map(row => row.map(escape).join(',')).join('\n');
  return header + '\n' + body;
}

export async function getMonthlySpendByCategory(db, start, end) {
  const rows = await db.all(
    `SELECT category, COALESCE(SUM(amount_cents),0) as spent_cents
     FROM transactions WHERE type='expense' AND date BETWEEN ? AND ?
     GROUP BY category ORDER BY spent_cents DESC`,
    [start, end]
  );
  return rows;
}

export const IRS_MILEAGE_RATE_CENTS = 70; // 2025 IRS standard mileage rate: $0.70/mile

export async function getVehicleSettings(db) {
  return db.get(`SELECT * FROM vehicle_settings WHERE id = 1`);
}

export function estimateGasCost(miles, mpg, gasPriceCents) {
  if (!miles || !mpg || !gasPriceCents) return 0;
  const gallons = miles / mpg;
  return Math.round(gallons * gasPriceCents);
}

export async function getMonthlyTripSummary(db, start, end) {
  const row = await db.get(
    `SELECT
       COUNT(1) AS trip_count,
       COALESCE(SUM(miles), 0) AS total_miles,
       COALESCE(SUM(gas_cost_cents), 0) AS total_gas_cents,
       COALESCE(SUM(other_cost_cents), 0) AS total_other_cents,
       COALESCE(SUM(income_cents), 0) AS total_income_cents
     FROM trips WHERE date BETWEEN ? AND ?`,
    [start, end]
  );
  const totalCost = row.total_gas_cents + row.total_other_cents;
  const netProfit = row.total_income_cents - totalCost;
  const costPerMile = row.total_miles > 0 ? Math.round(totalCost / row.total_miles) : 0;
  const profitPerMile = row.total_miles > 0 ? Math.round(netProfit / row.total_miles) : 0;
  const irsDeduction = Math.round(row.total_miles * IRS_MILEAGE_RATE_CENTS);
  return { ...row, totalCost, netProfit, costPerMile, profitPerMile, irsDeduction };
}

export async function computeAllocations(db, start, end) {
  const incomeRow = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS total
     FROM transactions WHERE type='income' AND date BETWEEN ? AND ?`,
    [start, end]
  );
  const totalIncome = incomeRow.total;

  const allocs = await db.all(
    `SELECT * FROM allocations ORDER BY priority ASC, id ASC`
  );

  let remaining = totalIncome;
  const results = [];

  for (const a of allocs) {
    let needed;
    if (a.alloc_type === 'fixed') {
      needed = a.amount_cents;
    } else {
      needed = Math.round((a.percent / 100) * totalIncome);
    }

    let funded = 0;
    if (a.active) {
      funded = Math.min(needed, Math.max(0, remaining));
      remaining -= funded;
    }

    const pct = needed > 0 ? Math.round((funded / needed) * 100) : (a.active ? 100 : 0);
    const status = !a.active ? 'off' : funded >= needed ? 'funded' : funded > 0 ? 'partial' : 'unfunded';

    results.push({
      ...a,
      needed,
      funded,
      shortfall: Math.max(0, needed - funded),
      pct,
      status
    });
  }

  return { totalIncome, allocated: totalIncome - remaining, unallocated: remaining, items: results };
}

export async function autoGenerateAllocations(db) {
  const existing = await db.all(`SELECT name FROM allocations`);
  const existingNames = new Set(existing.map(a => a.name.toLowerCase()));

  let priority = 10;
  let added = 0;

  // 1. From active recurring expenses (known fixed bills)
  const recurring = await db.all(
    `SELECT name, amount_cents, cadence FROM recurring WHERE active=1 AND type='expense' ORDER BY amount_cents DESC`
  );
  for (const r of recurring) {
    const allocName = r.name;
    if (existingNames.has(allocName.toLowerCase())) continue;
    // Normalize to monthly amount
    const monthlyCents = r.cadence === 'weekly' ? Math.round(r.amount_cents * 4.33) : r.amount_cents;
    await db.run(
      `INSERT INTO allocations (name, alloc_type, amount_cents, percent, priority) VALUES (?, 'fixed', ?, 0, ?)`,
      [allocName, monthlyCents, priority]
    );
    existingNames.add(allocName.toLowerCase());
    priority += 10;
    added++;
  }

  // 2. From budget limits (categories you've explicitly budgeted)
  const budgets = await db.all(
    `SELECT category, monthly_limit_cents FROM budgets WHERE type='expense' ORDER BY monthly_limit_cents DESC`
  );
  for (const b of budgets) {
    const allocName = b.category;
    if (existingNames.has(allocName.toLowerCase())) continue;
    await db.run(
      `INSERT INTO allocations (name, alloc_type, amount_cents, percent, priority) VALUES (?, 'fixed', ?, 0, ?)`,
      [allocName, b.monthly_limit_cents, priority]
    );
    existingNames.add(allocName.toLowerCase());
    priority += 10;
    added++;
  }

  // 3. From top spending categories (3-month average) not already covered
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const since = isoDateOnly(threeMonthsAgo);
  const today = isoDateOnly(new Date());
  const spending = await db.all(
    `SELECT category, COALESCE(SUM(amount_cents),0) AS total
     FROM transactions WHERE type='expense' AND date >= ? AND date <= ?
     GROUP BY category ORDER BY total DESC`,
    [since, today]
  );
  for (const s of spending) {
    if (existingNames.has(s.category.toLowerCase())) continue;
    const monthlyAvg = Math.round(s.total / 3);
    if (monthlyAvg < 100) continue; // skip < $1/mo
    await db.run(
      `INSERT INTO allocations (name, alloc_type, amount_cents, percent, priority) VALUES (?, 'fixed', ?, 0, ?)`,
      [s.category, monthlyAvg, priority]
    );
    existingNames.add(s.category.toLowerCase());
    priority += 10;
    added++;
  }

  // 4. Add a savings envelope for the remainder if none exists
  if (!existingNames.has('savings')) {
    await db.run(
      `INSERT INTO allocations (name, alloc_type, amount_cents, percent, priority) VALUES ('Savings', 'percent', 0, 20, ?)`,
      [priority]
    );
    added++;
  }

  return added;
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
