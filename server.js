import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import {
  addDays,
  addMonths,
  formatCents,
  getDb,
  initDb,
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

  res.render('dashboard', {
    today,
    dash,
    formatCents
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

const PORT = process.env.PORT || 3000;

await initDb();

app.listen(PORT, () => {
  console.log(`DimeTrack running on http://localhost:${PORT}`);
});
