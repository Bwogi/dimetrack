import {
  addDays,
  addMonths,
  formatCents,
  getDb,
  initDb,
  isoDateOnly,
  parseAmountToCents
} from './db.js';

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

function usage(exitCode = 0) {
  const msg = `DimeTrack CLI\n\nCommands:\n  dashboard\n  tx list [--limit N]\n  tx add --type income|expense --amount 12.34 --category foo [--note text] [--date YYYY-MM-DD]\n  recurring list\n  recurring post --id N\n  recurring toggle --id N\n  goals list\n  goals add --name "Trip" --target 1000 [--due YYYY-MM-DD] [--note text]\n  goals progress --id N --amount 25.00\n\nExamples:\n  npm run cli -- dashboard\n  npm run cli -- tx add --type expense --amount 12.50 --category food --note "lunch"\n  npm run cli -- tx list --limit 50\n`;
  if (exitCode === 0) {
    console.log(msg);
  } else {
    console.error(msg);
  }
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur === '--help' || cur === '-h') {
      flags.help = true;
      continue;
    }
    if (cur.startsWith('--')) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
      continue;
    }
    args.push(cur);
  }

  return { args, flags };
}

function requireNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${name}`);
  }
  return n;
}

function requireString(value, name) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`Missing ${name}`);
  return s;
}

async function cmdDashboard(db) {
  const today = isoDateOnly(new Date());
  const dash = await computeDashboard(db, today);

  console.log(`Today: ${today}`);
  console.log(`Month: ${dash.monthStart} .. ${dash.monthEnd}`);
  console.log(`Income: ${formatCents(dash.incomeCents)}`);
  console.log(`Expense: ${formatCents(dash.expenseCents)}`);
  console.log(`Net: ${formatCents(dash.netCents)}`);

  console.log('');
  console.log('Goals:');
  if (!dash.goals.length) console.log('  (none)');
  for (const g of dash.goals) {
    const pct = g.target_cents ? Math.round((g.current_cents / g.target_cents) * 100) : 0;
    console.log(
      `  #${g.id} ${g.name} ${formatCents(g.current_cents)}/${formatCents(g.target_cents)} (${pct}%)` +
        (g.due_date ? ` due ${g.due_date}` : '')
    );
  }

  console.log('');
  console.log('Upcoming recurring:');
  if (!dash.upcomingRecurring.length) console.log('  (none)');
  for (const r of dash.upcomingRecurring) {
    console.log(
      `  #${r.id} ${r.name} ${r.type} ${formatCents(r.amount_cents)} ${r.category} next ${r.next_due_date}`
    );
  }
}

async function cmdTxList(db, flags) {
  const limit = flags.limit == null ? 200 : requireNumber(flags.limit, 'limit');
  const rows = await db.all(
    `SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT ?`,
    [limit]
  );

  for (const t of rows) {
    const note = t.note ? ` - ${t.note}` : '';
    console.log(
      `#${t.id} ${t.date} ${t.type} ${formatCents(t.amount_cents)} ${t.category}${note}`
    );
  }
  if (!rows.length) console.log('(none)');
}

async function cmdTxAdd(db, flags) {
  const type = requireString(flags.type, 'type');
  if (!['income', 'expense'].includes(type)) throw new Error('type must be income|expense');

  const amountCents = parseAmountToCents(flags.amount);
  if (amountCents === null) throw new Error('Invalid amount');

  const category = requireString(flags.category, 'category');
  const note = flags.note == null ? null : String(flags.note);
  const dt = (flags.date && String(flags.date).trim()) || isoDateOnly(new Date());

  await db.run(
    `INSERT INTO transactions (type, amount_cents, category, note, date) VALUES (?, ?, ?, ?, ?)`,
    [type, amountCents, category, note, dt]
  );

  console.log(`Added transaction: ${dt} ${type} ${formatCents(amountCents)} ${category}`);
}

async function cmdRecurringList(db) {
  const rows = await db.all(
    `SELECT * FROM recurring ORDER BY active DESC, next_due_date ASC, id DESC`
  );

  for (const r of rows) {
    const active = r.active ? 'active' : 'inactive';
    console.log(
      `#${r.id} ${active} ${r.next_due_date} ${r.name} ${r.type} ${formatCents(r.amount_cents)} ${r.category} (${r.cadence})`
    );
  }
  if (!rows.length) console.log('(none)');
}

async function cmdRecurringToggle(db, flags) {
  const id = requireNumber(flags.id, 'id');
  await db.run(`UPDATE recurring SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?`, [id]);
  console.log(`Toggled recurring #${id}`);
}

async function cmdRecurringPost(db, flags) {
  const id = requireNumber(flags.id, 'id');
  const item = await db.get(`SELECT * FROM recurring WHERE id=?`, [id]);
  if (!item) throw new Error('Not found');

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
  console.log(`Posted recurring #${id} on ${postDate}; next due ${nextDue}`);
}

async function cmdGoalsList(db) {
  const rows = await db.all(`SELECT * FROM goals ORDER BY created_at DESC`);
  for (const g of rows) {
    const pct = g.target_cents ? Math.round((g.current_cents / g.target_cents) * 100) : 0;
    console.log(
      `#${g.id} ${g.name} ${formatCents(g.current_cents)}/${formatCents(g.target_cents)} (${pct}%)` +
        (g.due_date ? ` due ${g.due_date}` : '')
    );
  }
  if (!rows.length) console.log('(none)');
}

async function cmdGoalsAdd(db, flags) {
  const name = requireString(flags.name, 'name');
  const targetCents = parseAmountToCents(flags.target);
  if (targetCents === null) throw new Error('Invalid target');

  const due = flags.due == null ? null : String(flags.due).trim() || null;
  const note = flags.note == null ? null : String(flags.note);

  await db.run(
    `INSERT INTO goals (name, target_cents, due_date, note) VALUES (?, ?, ?, ?)`,
    [name, targetCents, due, note]
  );
  console.log(`Added goal: ${name} target ${formatCents(targetCents)}`);
}

async function cmdGoalsProgress(db, flags) {
  const id = requireNumber(flags.id, 'id');
  const deltaCents = parseAmountToCents(flags.amount);
  if (deltaCents === null) throw new Error('Invalid amount');

  await db.run(
    `UPDATE goals SET current_cents = MAX(0, current_cents + ?) WHERE id=?`,
    [deltaCents, id]
  );
  console.log(`Updated goal #${id} by ${formatCents(deltaCents)}`);
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) usage(0);

  const [cmd, subcmd] = args;
  if (!cmd) usage(1);

  await initDb();
  const db = await getDb();

  if (cmd === 'dashboard') {
    await cmdDashboard(db);
    return;
  }

  if (cmd === 'tx') {
    if (subcmd === 'list') {
      await cmdTxList(db, flags);
      return;
    }
    if (subcmd === 'add') {
      await cmdTxAdd(db, flags);
      return;
    }
    usage(1);
  }

  if (cmd === 'recurring') {
    if (subcmd === 'list') {
      await cmdRecurringList(db);
      return;
    }
    if (subcmd === 'toggle') {
      await cmdRecurringToggle(db, flags);
      return;
    }
    if (subcmd === 'post') {
      await cmdRecurringPost(db, flags);
      return;
    }
    usage(1);
  }

  if (cmd === 'goals') {
    if (subcmd === 'list') {
      await cmdGoalsList(db);
      return;
    }
    if (subcmd === 'add') {
      await cmdGoalsAdd(db, flags);
      return;
    }
    if (subcmd === 'progress') {
      await cmdGoalsProgress(db, flags);
      return;
    }
    usage(1);
  }

  usage(1);
}

try {
  await main();
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
