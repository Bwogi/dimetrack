import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import {
  addDays,
  addMonths,
  estimateGasCost,
  exportToCsv,
  formatCents,
  getDb,
  getMonthlySpendByCategory,
  getMonthlyTripSummary,
  getVehicleSettings,
  initDb,
  IRS_MILEAGE_RATE_CENTS,
  isoDateOnly,
  parseAmountToCents
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));

function monthRange(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: isoDateOnly(start), end: isoDateOnly(end) };
}

async function computeDashboard(db, todayIso) {
  const { start, end } = monthRange(todayIso);

  const incomeRow = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) as total FROM transactions WHERE type='income' AND date BETWEEN ? AND ?`,
    [start, end]
  );
  const expenseRow = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) as total FROM transactions WHERE type='expense' AND date BETWEEN ? AND ?`,
    [start, end]
  );

  const goals = await db.all(`SELECT * FROM goals ORDER BY created_at DESC`);
  const upcomingRecurring = await db.all(
    `SELECT * FROM recurring WHERE active=1 AND next_due_date >= ? ORDER BY next_due_date ASC LIMIT 10`,
    [todayIso]
  );

  return {
    monthStart: start,
    monthEnd: end,
    incomeCents: incomeRow.total,
    expenseCents: expenseRow.total,
    netCents: incomeRow.total - expenseRow.total,
    goals,
    upcomingRecurring
  };
}

app.get('/', async (req, res) => {
  const db = await getDb();
  const today = isoDateOnly(new Date());
  const dash = await computeDashboard(db, today);
  const { start, end } = monthRange(today);

  const budgets = await db.all(`SELECT * FROM budgets ORDER BY type ASC, category ASC`);
  const spending = await getMonthlySpendByCategory(db, start, end);
  const spendMap = {};
  for (const s of spending) spendMap[s.category] = s.spent_cents;
  const budgetAlerts = budgets.map(b => {
    const spent = spendMap[b.category] || 0;
    const pct = b.monthly_limit_cents ? Math.round((spent / b.monthly_limit_cents) * 100) : 0;
    return { ...b, spent, pct, over: pct >= 100, warn: pct >= 80 };
  }).filter(b => b.warn || b.over);

  const tripStats = await getMonthlyTripSummary(db, start, end);

  res.render('dashboard', {
    today,
    dash,
    budgetAlerts,
    tripStats,
    formatCents,
    IRS_MILEAGE_RATE_CENTS
  });
});

app.post('/setup/defaults', async (req, res) => {
  const rentCents = parseAmountToCents(req.body.rent_amount);
  if (rentCents === null) return res.status(400).send('Invalid rent amount');

  const db = await getDb();
  const todayIso = isoDateOnly(new Date());

  const today = new Date(`${todayIso}T00:00:00`);
  const nextRentDate = (() => {
    const y = today.getFullYear();
    const m = today.getMonth();
    const d = today.getDate();
    const rentThisMonth = new Date(y, m, 1);
    if (d <= 1) return isoDateOnly(rentThisMonth);
    return isoDateOnly(new Date(y, m + 1, 1));
  })();

  const carNextDue = addDays(todayIso, 14);
  const carDom = new Date(`${carNextDue}T00:00:00`).getDate();

  const upsertRecurring = async (name, fields) => {
    const existing = await db.get(`SELECT id FROM recurring WHERE name = ?`, [name]);
    if (existing?.id) {
      await db.run(
        `UPDATE recurring
         SET type=?, amount_cents=?, category=?, cadence=?, day_of_week=?, day_of_month=?, next_due_date=?, active=1
         WHERE id=?`,
        [
          fields.type,
          fields.amount_cents,
          fields.category,
          fields.cadence,
          fields.day_of_week,
          fields.day_of_month,
          fields.next_due_date,
          existing.id
        ]
      );
    } else {
      await db.run(
        `INSERT INTO recurring (name, type, amount_cents, category, cadence, day_of_week, day_of_month, next_due_date, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          name,
          fields.type,
          fields.amount_cents,
          fields.category,
          fields.cadence,
          fields.day_of_week,
          fields.day_of_month,
          fields.next_due_date
        ]
      );
    }
  };

  await upsertRecurring('Rent', {
    type: 'expense',
    amount_cents: rentCents,
    category: 'rent',
    cadence: 'monthly',
    day_of_week: null,
    day_of_month: 1,
    next_due_date: nextRentDate
  });

  await upsertRecurring('Car Payment', {
    type: 'expense',
    amount_cents: 47000,
    category: 'car',
    cadence: 'monthly',
    day_of_week: null,
    day_of_month: carDom,
    next_due_date: carNextDue
  });

  res.redirect('/');
});

app.get('/transactions', async (req, res) => {
  const db = await getDb();
  const rows = await db.all(
    `SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT 200`
  );
  res.render('transactions', {
    today: isoDateOnly(new Date()),
    rows,
    formatCents
  });
});

app.post('/transactions', async (req, res) => {
  const { type, amount, category, note, date } = req.body;
  const amountCents = parseAmountToCents(amount);
  const dt = (date && String(date).trim()) || isoDateOnly(new Date());

  if (!['income', 'expense'].includes(type) || amountCents === null || !category) {
    return res.status(400).send('Invalid transaction');
  }

  const db = await getDb();
  await db.run(
    `INSERT INTO transactions (type, amount_cents, category, note, date) VALUES (?, ?, ?, ?, ?)` ,
    [type, amountCents, category, note || null, dt]
  );

  res.redirect('/transactions');
});

app.post('/transactions/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).send('Invalid id');
  const db = await getDb();
  await db.run(`DELETE FROM transactions WHERE id = ?`, [id]);
  res.redirect('/transactions');
});

app.get('/reports/transactions.pdf', async (req, res) => {
  const startQ = String(req.query.start || '').trim();
  const endQ = String(req.query.end || '').trim();

  const todayIso = isoDateOnly(new Date());
  const { start: monthStart, end: monthEnd } = monthRange(todayIso);

  const start = /^\d{4}-\d{2}-\d{2}$/.test(startQ) ? startQ : monthStart;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(endQ) ? endQ : monthEnd;

  const db = await getDb();
  const rows = await db.all(
    `SELECT * FROM transactions WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC`,
    [start, end]
  );

  const incomeCents = rows
    .filter(r => r.type === 'income')
    .reduce((sum, r) => sum + (r.amount_cents || 0), 0);
  const expenseCents = rows
    .filter(r => r.type === 'expense')
    .reduce((sum, r) => sum + (r.amount_cents || 0), 0);
  const netCents = incomeCents - expenseCents;

  const filename = `dimetrack-transactions-${start}-to-${end}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).text('DimeTrack Transactions Report', { align: 'left' });
  doc.moveDown(0.25);
  doc.fontSize(11).fillColor('#555555').text(`Range: ${start} to ${end}`);
  doc.moveDown(0.75);

  doc.fillColor('#000000');
  doc.fontSize(12);
  doc.text(`Income: ${formatCents(incomeCents)}`);
  doc.text(`Expenses: ${formatCents(expenseCents)}`);
  doc.text(`Net: ${formatCents(netCents)}`);
  doc.moveDown(1);

  const drawRow = (y, cols, opts = {}) => {
    const {
      fontSize = 10,
      color = '#000000',
      bold = false
    } = opts;
    const x = doc.page.margins.left;
    const widths = [80, 60, 110, 220, 70];
    const aligns = ['left', 'left', 'left', 'left', 'right'];

    doc.fontSize(fontSize).fillColor(color);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');

    let cx = x;
    for (let i = 0; i < cols.length; i++) {
      doc.text(String(cols[i] ?? ''), cx, y, {
        width: widths[i],
        align: aligns[i]
      });
      cx += widths[i];
    }
  };

  let y = doc.y;
  drawRow(y, ['Date', 'Type', 'Category', 'Note', 'Amount'], {
    bold: true,
    color: '#111111'
  });
  y += 18;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .strokeColor('#dddddd')
    .stroke();
  y += 10;

  for (const r of rows) {
    const amountStr = `${r.type === 'expense' ? '-' : '+'}${formatCents(r.amount_cents)}`;
    const note = (r.note || '').replace(/\s+/g, ' ').trim();
    drawRow(y, [r.date, r.type, r.category, note, amountStr], {
      color: r.type === 'expense' ? '#8a1f1f' : '#0a6b2f'
    });
    y += 16;

    if (y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  }

  doc.end();
});

app.get('/recurring', async (req, res) => {
  const db = await getDb();
  const rows = await db.all(`SELECT * FROM recurring ORDER BY active DESC, next_due_date ASC, id DESC`);
  res.render('recurring', {
    today: isoDateOnly(new Date()),
    rows,
    formatCents
  });
});

app.post('/recurring', async (req, res) => {
  const { name, type, amount, category, cadence, day_of_week, day_of_month, next_due_date } = req.body;
  const amountCents = parseAmountToCents(amount);
  const nextDue = (next_due_date && String(next_due_date).trim()) || isoDateOnly(new Date());

  if (!name || !['income', 'expense'].includes(type) || amountCents === null || !category) {
    return res.status(400).send('Invalid recurring item');
  }
  if (!['weekly', 'monthly'].includes(cadence)) return res.status(400).send('Invalid cadence');

  const dow = day_of_week === '' || day_of_week == null ? null : Number(day_of_week);
  const dom = day_of_month === '' || day_of_month == null ? null : Number(day_of_month);

  if (cadence === 'weekly' && !(Number.isInteger(dow) && dow >= 0 && dow <= 6)) {
    return res.status(400).send('Weekly requires day_of_week (0-6)');
  }
  if (cadence === 'monthly' && !(Number.isInteger(dom) && dom >= 1 && dom <= 31)) {
    return res.status(400).send('Monthly requires day_of_month (1-31)');
  }

  const db = await getDb();
  await db.run(
    `INSERT INTO recurring (name, type, amount_cents, category, cadence, day_of_week, day_of_month, next_due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, type, amountCents, category, cadence, dow, dom, nextDue]
  );

  res.redirect('/recurring');
});

app.post('/recurring/:id/toggle', async (req, res) => {
  const id = Number(req.params.id);
  const db = await getDb();
  await db.run(`UPDATE recurring SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?`, [id]);
  res.redirect('/recurring');
});

app.post('/recurring/:id/post', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).send('Invalid id');

  const db = await getDb();
  const item = await db.get(`SELECT * FROM recurring WHERE id=?`, [id]);
  if (!item) return res.status(404).send('Not found');

  const postDate = item.next_due_date;

  await db.run(
    `INSERT INTO transactions (type, amount_cents, category, note, date) VALUES (?, ?, ?, ?, ?)`,
    [item.type, item.amount_cents, item.category, `Recurring: ${item.name}`, postDate]
  );

  let nextDue = item.next_due_date;
  if (item.cadence === 'weekly') {
    nextDue = addDays(item.next_due_date, 7);
  } else {
    nextDue = addMonths(item.next_due_date, 1, item.day_of_month);
  }

  await db.run(`UPDATE recurring SET next_due_date=? WHERE id=?`, [nextDue, id]);

  res.redirect('/recurring');
});

app.get('/goals', async (req, res) => {
  const db = await getDb();
  const rows = await db.all(`SELECT * FROM goals ORDER BY created_at DESC`);
  res.render('goals', {
    today: isoDateOnly(new Date()),
    rows,
    formatCents
  });
});

app.post('/goals', async (req, res) => {
  const { name, target, due_date, note } = req.body;
  const targetCents = parseAmountToCents(target);
  if (!name || targetCents === null) return res.status(400).send('Invalid goal');

  const db = await getDb();
  await db.run(
    `INSERT INTO goals (name, target_cents, due_date, note) VALUES (?, ?, ?, ?)` ,
    [name, targetCents, (due_date || '').trim() || null, note || null]
  );
  res.redirect('/goals');
});

app.post('/goals/:id/progress', async (req, res) => {
  const id = Number(req.params.id);
  const deltaCents = parseAmountToCents(req.body.amount);
  if (!Number.isFinite(id) || deltaCents === null) return res.status(400).send('Invalid');

  const db = await getDb();
  await db.run(
    `UPDATE goals SET current_cents = MAX(0, current_cents + ?) WHERE id=?`,
    [deltaCents, id]
  );
  res.redirect('/goals');
});

app.post('/goals/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).send('Invalid id');
  const db = await getDb();
  await db.run(`DELETE FROM goals WHERE id=?`, [id]);
  res.redirect('/goals');
});

// ── Budgets ──────────────────────────────────────────────────
app.get('/budgets', async (req, res) => {
  const db = await getDb();
  const today = isoDateOnly(new Date());
  const { start, end } = monthRange(today);
  const budgets = await db.all(`SELECT * FROM budgets ORDER BY type ASC, category ASC`);
  const spending = await getMonthlySpendByCategory(db, start, end);
  const spendMap = {};
  for (const s of spending) spendMap[s.category] = s.spent_cents;
  const rows = budgets.map(b => {
    const spent = spendMap[b.category] || 0;
    const remaining = b.monthly_limit_cents - spent;
    const pct = b.monthly_limit_cents ? Math.round((spent / b.monthly_limit_cents) * 100) : 0;
    return { ...b, spent, remaining, pct };
  });
  res.render('budgets', { today, rows, formatCents, start, end });
});

app.post('/budgets', async (req, res) => {
  const { type, category, monthly_limit } = req.body;
  if (!['income', 'expense'].includes(type) || !category) return res.status(400).send('Invalid budget');
  const limitCents = parseAmountToCents(monthly_limit);
  if (limitCents === null || limitCents <= 0) return res.status(400).send('Invalid limit');
  const db = await getDb();
  await db.run(
    `INSERT OR REPLACE INTO budgets (type, category, monthly_limit_cents) VALUES (?, ?, ?)`,
    [type, category.trim(), limitCents]
  );
  res.redirect('/budgets');
});

app.post('/budgets/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).send('Invalid id');
  const db = await getDb();
  await db.run(`DELETE FROM budgets WHERE id = ?`, [id]);
  res.redirect('/budgets');
});

// ── Trips & Mileage ─────────────────────────────────────────
app.get('/trips', async (req, res) => {
  const db = await getDb();
  const today = isoDateOnly(new Date());
  const rows = await db.all(`SELECT * FROM trips ORDER BY date DESC, id DESC LIMIT 500`);
  const vs = await getVehicleSettings(db);
  res.render('trips', { today, rows, vs, formatCents, estimateGasCost, IRS_MILEAGE_RATE_CENTS });
});

app.post('/trips', async (req, res) => {
  const { destination, date, odo_start, odo_end, gas_cost, other_cost, income, note } = req.body;
  if (!destination || !String(destination).trim()) return res.status(400).send('Missing destination');

  const dt = (date && String(date).trim()) || isoDateOnly(new Date());
  const odoStart = Number(odo_start);
  const odoEnd = Number(odo_end);
  if (!Number.isFinite(odoStart) || !Number.isFinite(odoEnd)) return res.status(400).send('Invalid odometer');
  if (odoEnd < odoStart) return res.status(400).send('Odometer end must be >= start');
  const miles = odoEnd - odoStart;

  const db = await getDb();
  const vs = await getVehicleSettings(db);
  let gasCents;
  let gasEstimated;
  const gasRaw = String(gas_cost || '').trim();
  if (gasRaw === '') {
    gasCents = estimateGasCost(miles, vs.mpg, vs.gas_price_cents);
    gasEstimated = 1;
  } else {
    gasCents = parseAmountToCents(gasRaw);
    if (gasCents === null) return res.status(400).send('Invalid gas cost');
    gasEstimated = 0;
  }

  const otherCents = parseAmountToCents(other_cost) ?? 0;
  const incomeCents = parseAmountToCents(income);
  if (incomeCents === null) return res.status(400).send('Invalid income');

  await db.run(
    `INSERT INTO trips (destination, date, odometer_start, odometer_end, miles, gas_cost_cents, gas_estimated, other_cost_cents, income_cents, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [destination.trim(), dt, odoStart, odoEnd, miles, gasCents, gasEstimated, otherCents, incomeCents, note || null]
  );
  res.redirect('/trips');
});

app.post('/trips/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).send('Invalid id');
  const db = await getDb();
  await db.run(`DELETE FROM trips WHERE id = ?`, [id]);
  res.redirect('/trips');
});

app.post('/vehicle-settings', async (req, res) => {
  const mpg = Number(req.body.mpg);
  const priceCents = parseAmountToCents(req.body.gas_price);
  if (!Number.isFinite(mpg) || mpg <= 0) return res.status(400).send('Invalid MPG');
  if (priceCents === null || priceCents <= 0) return res.status(400).send('Invalid gas price');
  const db = await getDb();
  await db.run(`UPDATE vehicle_settings SET mpg=?, gas_price_cents=? WHERE id=1`, [mpg, priceCents]);
  res.redirect('/trips');
});

// ── CSV Export ───────────────────────────────────────────────
app.get('/export/:section.csv', async (req, res) => {
  const db = await getDb();
  const section = req.params.section;
  let columns, rows;

  if (section === 'transactions') {
    const data = await db.all(`SELECT * FROM transactions ORDER BY date DESC, id DESC`);
    columns = ['ID', 'Date', 'Type', 'Category', 'Amount', 'Note'];
    rows = data.map(r => [r.id, r.date, r.type, r.category, formatCents(r.amount_cents), r.note || '']);
  } else if (section === 'recurring') {
    const data = await db.all(`SELECT * FROM recurring ORDER BY active DESC, next_due_date ASC`);
    columns = ['ID', 'Name', 'Type', 'Amount', 'Category', 'Cadence', 'Next Due', 'Active'];
    rows = data.map(r => [r.id, r.name, r.type, formatCents(r.amount_cents), r.category, r.cadence, r.next_due_date, r.active ? 'Yes' : 'No']);
  } else if (section === 'goals') {
    const data = await db.all(`SELECT * FROM goals ORDER BY created_at DESC`);
    columns = ['ID', 'Name', 'Target', 'Current', 'Progress', 'Due Date'];
    rows = data.map(g => {
      const pct = g.target_cents ? Math.round((g.current_cents / g.target_cents) * 100) : 0;
      return [g.id, g.name, formatCents(g.target_cents), formatCents(g.current_cents), `${pct}%`, g.due_date || ''];
    });
  } else if (section === 'budgets') {
    const today = isoDateOnly(new Date());
    const { start, end } = monthRange(today);
    const data = await db.all(`SELECT * FROM budgets ORDER BY type, category`);
    const spending = await getMonthlySpendByCategory(db, start, end);
    const spendMap = {};
    for (const s of spending) spendMap[s.category] = s.spent_cents;
    columns = ['ID', 'Type', 'Category', 'Limit', 'Spent', 'Remaining', 'Status'];
    rows = data.map(b => {
      const spent = spendMap[b.category] || 0;
      const pct = b.monthly_limit_cents ? Math.round((spent / b.monthly_limit_cents) * 100) : 0;
      const status = pct >= 100 ? 'OVER' : pct >= 80 ? 'WARN' : 'OK';
      return [b.id, b.type, b.category, formatCents(b.monthly_limit_cents), formatCents(spent), formatCents(b.monthly_limit_cents - spent), `${status} (${pct}%)`];
    });
  } else if (section === 'trips') {
    const data = await db.all(`SELECT * FROM trips ORDER BY date DESC, id DESC`);
    columns = ['ID', 'Date', 'Destination', 'Odo Start', 'Odo End', 'Miles', 'Gas', 'Other Costs', 'Income', 'Net', 'Note'];
    rows = data.map(t => {
      const net = t.income_cents - t.gas_cost_cents - t.other_cost_cents;
      return [t.id, t.date, t.destination, t.odometer_start ?? '', t.odometer_end ?? '', t.miles, formatCents(t.gas_cost_cents), formatCents(t.other_cost_cents), formatCents(t.income_cents), formatCents(net), t.note || ''];
    });
  } else {
    return res.status(404).send('Unknown section');
  }

  const csv = exportToCsv(columns, rows);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${section}.csv"`);
  res.send(csv);
});

const PORT = process.env.PORT || 3000;

await initDb();

app.listen(PORT, () => {
  console.log(`DimeTrack running on http://localhost:${PORT}`);
});
