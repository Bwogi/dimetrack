import blessed from 'blessed';
import {
  addDays,
  addMonths,
  formatCents,
  getDb,
  initDb,
  isoDateOnly,
  parseAmountToCents
} from './db.js';

const THEME = {
  bg: '#000000',
  fg: '#00ff66',
  muted: '#ffffff',
  border: '#2b2b2b',
  borderActive: '#66ff99',
  headerBg: '#000000',
  headerFg: '#66ff99',
  footerBg: '#000000',
  footerFg: '#9aa0a6',
  accentBg: '#66ff99',
  accentFg: '#000000',
  danger: '#ff4d4d',
  warn: '#ffd24d'
};

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

function createFormPrompt({ screen, title, fields, onSubmit }) {
  const box = blessed.form({
    parent: screen,
    label: ` ${title} `,
    keys: true,
    vi: true,
    autoNext: true,
    width: '80%',
    height: Math.min(3 + fields.length * 3 + 4, 28),
    top: 'center',
    left: 'center',
    border: 'line',
    style: {
      fg: THEME.fg,
      bg: THEME.bg,
      border: { fg: THEME.borderActive }
    }
  });

  const inputs = {};
  const order = fields.map((f) => f.name);
  let y = 1;
  for (const f of fields) {
    blessed.text({
      parent: box,
      top: y + 1,
      left: 2,
      content: `${f.label}:`,
      style: { fg: THEME.fg, bg: THEME.bg }
    });

    inputs[f.name] = blessed.textbox({
      parent: box,
      name: f.name,
      inputOnFocus: true,
      top: y,
      left: 18,
      height: 3,
      width: '70%-20',
      style: {
        fg: THEME.fg,
        bg: THEME.bg,
        border: { fg: THEME.border },
        focus: {
          fg: THEME.fg,
          bg: THEME.bg,
          border: { fg: THEME.borderActive }
        }
      },
      border: { type: 'line' },
      cursor: THEME.fg,
      cursorBlink: true,
      value: f.initial ?? ''
    });

    if (f.name === order[order.length - 1]) {
      inputs[f.name].on('submit', () => box.submit());
    }

    y += 3;
  }

  const hint = blessed.text({
    parent: box,
    top: y,
    left: 2,
    fg: THEME.muted,
    content: 'Enter: next/submit   Esc: cancel   Tab/Shift+Tab: next/prev'
  });
  void hint;

  box.key(['escape'], () => {
    box.destroy();
    screen.render();
  });

  box.on('submit', () => {
    const values = {};
    for (const f of fields) {
      values[f.name] = inputs[f.name].getValue();
    }
    box.destroy();
    screen.render();
    onSubmit(values);
  });

  inputs[order[0]]?.focus();
  screen.render();
}

function createConfirm({ screen, title, message, onYes }) {
  const box = blessed.box({
    parent: screen,
    label: ` ${title} `,
    border: 'line',
    keys: true,
    width: '70%',
    height: 7,
    top: 'center',
    left: 'center',
    style: {
      fg: THEME.fg,
      bg: THEME.bg,
      border: { fg: THEME.warn }
    }
  });

  blessed.text({
    parent: box,
    top: 1,
    left: 2,
    width: '95%-4',
    fg: THEME.fg,
    content: message
  });

  blessed.text({
    parent: box,
    top: 4,
    left: 2,
    fg: THEME.muted,
    content: 'y: yes   n/Esc: cancel'
  });

  const close = () => {
    box.destroy();
    screen.render();
  };

  box.key(['escape', 'n'], close);
  box.key(['y'], () => {
    close();
    onYes();
  });

  box.focus();
  screen.render();
}

function createSelectPrompt({ screen, title, options, initialIndex = 0, onSelect }) {
  const box = blessed.box({
    parent: screen,
    label: ` ${title} `,
    border: 'line',
    keys: true,
    vi: true,
    width: '60%',
    height: Math.min(6 + options.length, 20),
    top: 'center',
    left: 'center',
    style: {
      fg: THEME.fg,
      bg: THEME.bg,
      border: { fg: THEME.borderActive }
    }
  });

  const list = blessed.list({
    parent: box,
    top: 1,
    left: 1,
    right: 1,
    bottom: 2,
    keys: true,
    vi: true,
    mouse: true,
    items: options,
    style: {
      fg: THEME.fg,
      bg: THEME.bg,
      selected: { bg: THEME.accentBg, fg: THEME.accentFg },
      item: { fg: THEME.fg, bg: THEME.bg }
    }
  });

  blessed.text({
    parent: box,
    bottom: 0,
    left: 2,
    fg: THEME.muted,
    content: 'Enter: select   Esc: cancel'
  });

  const close = () => {
    box.destroy();
    screen.render();
  };

  box.key(['escape'], close);
  list.key(['escape'], close);

  list.on('select', (item, index) => {
    const value = options[index];
    close();
    onSelect(value, index);
  });

  list.select(Math.max(0, Math.min(initialIndex, options.length - 1)));
  list.focus();
  screen.render();
}

async function getCategories(db, type) {
  const rows = await db.all(
    `SELECT name FROM categories WHERE active=1 AND type=? ORDER BY COALESCE(sort_order, 999999) ASC, name ASC`,
    [type]
  );
  return rows.map((r) => r.name);
}

function createTableView({ parent, label }) {
  const box = blessed.box({
    parent,
    top: 0,
    left: 0,
    bottom: 1,
    width: '100%',
    label: label ? ` ${label} ` : undefined,
    border: 'line',
    tags: true,
    style: {
      bg: THEME.bg,
      fg: THEME.fg,
      border: { fg: THEME.border }
    }
  });

  const header = blessed.box({
    parent: box,
    top: 0,
    left: 1,
    height: 1,
    width: '100%-2',
    tags: true,
    style: {
      bg: THEME.bg,
      fg: THEME.borderActive
    },
    content: ''
  });

  const list = blessed.list({
    parent: box,
    top: 1,
    left: 1,
    right: 1,
    bottom: 0,
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    style: {
      bg: THEME.bg,
      fg: THEME.fg,
      selected: { bg: THEME.accentBg, fg: THEME.accentFg },
      item: { bg: THEME.bg, fg: THEME.fg }
    }
  });

  const state = {
    columns: [],
    rows: []
  };

  const fitWidths = (cols, totalWidth) => {
    const min = cols.map((c) => Math.max(3, c.minWidth ?? 3));
    const max = cols.map((c) => Math.max(min[0], c.maxWidth ?? 60));
    const weights = cols.map((c) => c.weight ?? 1);

    const sepCount = cols.length - 1;
    const available = Math.max(10, totalWidth - sepCount * 3);
    let widths = [...min];
    let used = widths.reduce((a, b) => a + b, 0);
    let remaining = available - used;
    if (remaining <= 0) return widths.map((w, i) => Math.max(3, Math.min(w, max[i])));

    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < cols.length; i++) {
      const add = Math.floor((remaining * weights[i]) / totalWeight);
      widths[i] = Math.min(max[i], widths[i] + add);
    }
    used = widths.reduce((a, b) => a + b, 0);
    remaining = available - used;
    let idx = 0;
    while (remaining > 0 && idx < 5000) {
      const i = idx % cols.length;
      if (widths[i] < max[i]) {
        widths[i] += 1;
        remaining -= 1;
      }
      idx++;
    }
    return widths;
  };

  const formatRow = (cells, widths) => {
    const parts = cells.map((c, i) => {
      const s = String(c ?? '');
      const w = widths[i] ?? 8;
      const trimmed = s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s;
      return trimmed.padEnd(w, ' ');
    });
    return parts.join(' | ');
  };

  const refresh = () => {
    const innerWidth = Math.max(20, box.width - 2);
    const widths = fitWidths(state.columns, innerWidth);
    header.setContent(`{bold}${formatRow(state.columns.map((c) => c.title), widths)}{/bold}`);
    list.setItems(state.rows.map((r) => formatRow(r, widths)));
    list._rowData = state.rows;
  };

  box.on('resize', () => {
    refresh();
    box.screen.render();
  });

  return {
    box,
    list,
    setData: ({ columns, rows }) => {
      state.columns = columns;
      state.rows = rows;
      refresh();
    }
  };
}

function createMessage({ screen, title, message }) {
  const box = blessed.box({
    parent: screen,
    label: ` ${title} `,
    border: 'line',
    keys: true,
    width: '70%',
    height: 7,
    top: 'center',
    left: 'center',
    style: {
      fg: THEME.fg,
      bg: THEME.bg,
      border: { fg: THEME.borderActive }
    }
  });

  blessed.text({
    parent: box,
    top: 1,
    left: 2,
    width: '95%-4',
    fg: THEME.fg,
    content: message
  });

  blessed.text({
    parent: box,
    top: 4,
    left: 2,
    fg: THEME.muted,
    content: 'Press Esc to close'
  });

  box.key(['escape', 'enter'], () => {
    box.destroy();
    screen.render();
  });

  box.focus();
  screen.render();
}

async function main() {
  await initDb();
  const db = await getDb();

  const screen = blessed.screen({
    smartCSR: true,
    title: 'DimeTrack',
    useBCE: true
  });

  screen.key(['C-c', 'q'], () => process.exit(0));

  const backdrop = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    style: { bg: THEME.bg, fg: THEME.fg }
  });
  backdrop.setBack();

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    height: 3,
    width: '100%',
    tags: true,
    style: { bg: THEME.headerBg, fg: THEME.headerFg },
    content:
      ' {bold}DimeTrack{/bold}  ' +
      '{gray-fg}Dashboard(d)  Transactions(t)  Recurring(r)  Goals(g)  Help(h)  Quit(q){/gray-fg}'
  });
  void header;

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    height: 2,
    width: '100%',
    tags: true,
    style: { bg: THEME.footerBg, fg: THEME.footerFg },
    content:
      ` {${THEME.footerFg}-fg}{bold}Shortcuts{/bold}{/${THEME.footerFg}-fg}  ` +
      'a:add  del:delete/toggle  p:post recurring  Enter:view  /:filter (tx)'
  });
  void footer;

  const mainBox = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    bottom: 2,
    width: '100%',
    style: { bg: THEME.bg, fg: THEME.fg }
  });

  const status = blessed.box({
    parent: mainBox,
    bottom: 0,
    left: 0,
    height: 1,
    width: '100%',
    style: { fg: THEME.muted, bg: THEME.bg },
    content: ''
  });

  function setStatus(text) {
    status.setContent(text || '');
    screen.render();
  }

  let currentView = 'dashboard';

  const view = {
    dashboard: blessed.box({
      parent: mainBox,
      top: 0,
      left: 0,
      bottom: 1,
      width: '100%',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: ' ', inverse: true },
      style: { bg: THEME.bg, fg: THEME.fg }
    }),

    tx: createTableView({ parent: mainBox, label: 'Transactions' }),
    recurring: createTableView({ parent: mainBox, label: 'Recurring' }),
    goals: createTableView({ parent: mainBox, label: 'Goals' })
  };

  function showView(name) {
    currentView = name;
    for (const [k, el] of Object.entries(view)) {
      if (k === 'dashboard') {
        el.hidden = k !== name;
      } else {
        el.box.hidden = k !== name;
      }
    }

    if (name === 'tx' || name === 'recurring' || name === 'goals') {
      view[name].list.focus();
    } else {
      view.dashboard.focus();
    }

    screen.render();
    void refresh();
  }

  let txFilter = '';

  async function refreshDashboard() {
    const today = isoDateOnly(new Date());
    const dash = await computeDashboard(db, today);

    const lines = [];
    lines.push(`{bold}Today{/bold}: ${today}`);
    lines.push(`{bold}Month{/bold}: ${dash.monthStart} .. ${dash.monthEnd}`);
    lines.push('');
    lines.push(`{bold}Income{/bold}:  ${formatCents(dash.incomeCents)}`);
    lines.push(`{bold}Expense{/bold}: ${formatCents(dash.expenseCents)}`);
    lines.push(`{bold}Net{/bold}:     ${formatCents(dash.netCents)}`);

    lines.push('');
    lines.push('{bold}Goals{/bold}:');
    if (!dash.goals.length) lines.push('  (none)');
    for (const g of dash.goals) {
      const pct = g.target_cents ? Math.round((g.current_cents / g.target_cents) * 100) : 0;
      lines.push(
        `  #${g.id} ${g.name} ${formatCents(g.current_cents)}/${formatCents(g.target_cents)} (${pct}%)` +
          (g.due_date ? ` due ${g.due_date}` : '')
      );
    }

    lines.push('');
    lines.push('{bold}Upcoming recurring{/bold}:');
    if (!dash.upcomingRecurring.length) lines.push('  (none)');
    for (const r of dash.upcomingRecurring) {
      lines.push(
        `  #${r.id} ${r.name} ${r.type} ${formatCents(r.amount_cents)} ${r.category} next ${r.next_due_date}`
      );
    }

    view.dashboard.setContent(lines.join('\n'));
  }

  function matchesFilter(row) {
    if (!txFilter) return true;
    const blob = `${row.type} ${row.category} ${row.note || ''} ${row.date}`.toLowerCase();
    return blob.includes(txFilter.toLowerCase());
  }

  async function refreshTx() {
    const rows = await db.all(`SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT 500`);
    const filtered = rows.filter(matchesFilter);

    view.tx.setData({
      columns: [
        { title: 'ID', minWidth: 3, maxWidth: 6, weight: 1 },
        { title: 'Date', minWidth: 10, maxWidth: 12, weight: 2 },
        { title: 'Type', minWidth: 6, maxWidth: 8, weight: 1 },
        { title: 'Amount', minWidth: 8, maxWidth: 12, weight: 1 },
        { title: 'Category', minWidth: 10, maxWidth: 18, weight: 2 },
        { title: 'Note', minWidth: 10, maxWidth: 60, weight: 4 }
      ],
      rows: filtered.map((t) => [
        String(t.id),
        t.date,
        t.type,
        formatCents(t.amount_cents),
        t.category,
        t.note || ''
      ])
    });
    setStatus(txFilter ? `Filter: ${txFilter} (${filtered.length}/${rows.length})` : `Transactions: ${rows.length}`);
  }

  async function refreshRecurring() {
    const rows = await db.all(
      `SELECT * FROM recurring ORDER BY active DESC, next_due_date ASC, id DESC`
    );

    view.recurring.setData({
      columns: [
        { title: 'ID', minWidth: 3, maxWidth: 6, weight: 1 },
        { title: 'Active', minWidth: 6, maxWidth: 7, weight: 1 },
        { title: 'Next Due', minWidth: 10, maxWidth: 12, weight: 2 },
        { title: 'Name', minWidth: 10, maxWidth: 22, weight: 3 },
        { title: 'Type', minWidth: 6, maxWidth: 8, weight: 1 },
        { title: 'Amount', minWidth: 8, maxWidth: 12, weight: 1 },
        { title: 'Category', minWidth: 10, maxWidth: 18, weight: 2 },
        { title: 'Cadence', minWidth: 7, maxWidth: 8, weight: 1 }
      ],
      rows: rows.map((r) => [
        String(r.id),
        r.active ? 'yes' : 'no',
        r.next_due_date,
        r.name,
        r.type,
        formatCents(r.amount_cents),
        r.category,
        r.cadence
      ])
    });
    setStatus(`Recurring: ${rows.length}`);
  }

  async function refreshGoals() {
    const rows = await db.all(`SELECT * FROM goals ORDER BY created_at DESC`);

    view.goals.setData({
      columns: [
        { title: 'ID', minWidth: 3, maxWidth: 6, weight: 1 },
        { title: 'Name', minWidth: 12, maxWidth: 30, weight: 4 },
        { title: 'Current', minWidth: 10, maxWidth: 12, weight: 2 },
        { title: 'Target', minWidth: 10, maxWidth: 12, weight: 2 },
        { title: '%', minWidth: 3, maxWidth: 4, weight: 1 },
        { title: 'Due', minWidth: 10, maxWidth: 12, weight: 2 }
      ],
      rows: rows.map((g) => {
        const pct = g.target_cents ? Math.round((g.current_cents / g.target_cents) * 100) : 0;
        return [
          String(g.id),
          g.name,
          formatCents(g.current_cents),
          formatCents(g.target_cents),
          `${pct}%`,
          g.due_date || ''
        ];
      })
    });
    setStatus(`Goals: ${rows.length}`);
  }

  async function refresh() {
    try {
      if (currentView === 'dashboard') await refreshDashboard();
      if (currentView === 'tx') await refreshTx();
      if (currentView === 'recurring') await refreshRecurring();
      if (currentView === 'goals') await refreshGoals();
      screen.render();
    } catch (e) {
      createMessage({ screen, title: 'Error', message: e?.message || String(e) });
    }
  }

  function selectedIdFromTable(table) {
    const list = table?.list ?? table;
    const idx = list.selected;
    if (idx == null || idx < 0) return null;
    const row = list._rowData?.[idx];
    if (!row || !row[0]) return null;
    const id = Number(row[0]);
    if (!Number.isFinite(id)) return null;
    return id;
  }

  // Navigation
  screen.key(['d'], () => showView('dashboard'));
  screen.key(['t'], () => showView('tx'));
  screen.key(['r'], () => showView('recurring'));
  screen.key(['g'], () => showView('goals'));

  screen.key(['h', '?'], () => {
    createMessage({
      screen,
      title: 'Help',
      message:
        'Navigation: d dashboard, t transactions, r recurring, g goals\n' +
        'Actions: a add, del delete/toggle, p post recurring\n' +
        'Transactions: / filter\n' +
        'Quit: q or Ctrl+C'
    });
  });

  // Transactions actions
  view.tx.list.key(['a'], () => {
    createSelectPrompt({
      screen,
      title: 'Transaction Type',
      options: ['expense', 'income'],
      initialIndex: 0,
      onSelect: async (type) => {
        try {
          const categories = await getCategories(db, type);
          if (!categories.length) throw new Error(`No categories for ${type}`);

          createSelectPrompt({
            screen,
            title: `Category (${type})`,
            options: categories,
            initialIndex: 0,
            onSelect: (category) => {
              createFormPrompt({
                screen,
                title: `Add Transaction (${type} / ${category})`,
                fields: [
                  { name: 'amount', label: 'amount', initial: '' },
                  { name: 'note', label: 'note', initial: '' },
                  { name: 'date', label: 'date (YYYY-MM-DD)', initial: isoDateOnly(new Date()) }
                ],
                onSubmit: async (v) => {
                  try {
                    const amountCents = parseAmountToCents(v.amount);
                    if (amountCents === null) throw new Error('invalid amount');

                    const note = String(v.note || '').trim() || null;
                    const date = String(v.date || '').trim() || isoDateOnly(new Date());

                    await db.run(
                      `INSERT INTO transactions (type, amount_cents, category, note, date) VALUES (?, ?, ?, ?, ?)`,
                      [type, amountCents, category, note, date]
                    );
                    await refreshTx();
                  } catch (e) {
                    createMessage({ screen, title: 'Invalid', message: e?.message || String(e) });
                  }
                }
              });
            }
          });
        } catch (e) {
          createMessage({ screen, title: 'Error', message: e?.message || String(e) });
        }
      }
    });
  });

  view.tx.list.key(['/'], () => {
    createFormPrompt({
      screen,
      title: 'Filter Transactions',
      fields: [{ name: 'filter', label: 'contains', initial: txFilter }],
      onSubmit: async (v) => {
        txFilter = String(v.filter || '').trim();
        await refreshTx();
      }
    });
  });

  view.tx.list.key(['delete', 'backspace'], () => {
    const id = selectedIdFromTable(view.tx);
    if (!id) return;
    createConfirm({
      screen,
      title: 'Delete Transaction',
      message: `Delete transaction #${id}?`,
      onYes: async () => {
        try {
          await db.run(`DELETE FROM transactions WHERE id = ?`, [id]);
          await refreshTx();
        } catch (e) {
          createMessage({ screen, title: 'Error', message: e?.message || String(e) });
        }
      }
    });
  });

  // Recurring actions
  view.recurring.list.key(['a'], () => {
    createSelectPrompt({
      screen,
      title: 'Recurring Type',
      options: ['expense', 'income'],
      initialIndex: 0,
      onSelect: async (type) => {
        try {
          const categories = await getCategories(db, type);
          if (!categories.length) throw new Error(`No categories for ${type}`);

          createSelectPrompt({
            screen,
            title: `Category (${type})`,
            options: categories,
            initialIndex: 0,
            onSelect: (category) => {
              createFormPrompt({
                screen,
                title: `Add Recurring (${type} / ${category})`,
                fields: [
                  { name: 'name', label: 'name', initial: '' },
                  { name: 'amount', label: 'amount', initial: '' },
                  { name: 'cadence', label: 'cadence (weekly|monthly)', initial: 'monthly' },
                  { name: 'day_of_week', label: 'day_of_week (0-6)', initial: '' },
                  { name: 'day_of_month', label: 'day_of_month (1-31)', initial: '1' },
                  { name: 'next_due_date', label: 'next_due_date (YYYY-MM-DD)', initial: isoDateOnly(new Date()) }
                ],
                onSubmit: async (v) => {
                  try {
                    const name = String(v.name || '').trim();
                    if (!name) throw new Error('missing name');

                    const amountCents = parseAmountToCents(v.amount);
                    if (amountCents === null) throw new Error('invalid amount');

                    const cadence = String(v.cadence || '').trim();
                    if (!['weekly', 'monthly'].includes(cadence)) throw new Error('cadence must be weekly|monthly');

                    const nextDue = String(v.next_due_date || '').trim() || isoDateOnly(new Date());

                    const dowRaw = String(v.day_of_week ?? '').trim();
                    const domRaw = String(v.day_of_month ?? '').trim();

                    const dow = dowRaw === '' ? null : Number(dowRaw);
                    const dom = domRaw === '' ? null : Number(domRaw);

                    if (cadence === 'weekly') {
                      if (!(Number.isInteger(dow) && dow >= 0 && dow <= 6)) {
                        throw new Error('weekly requires day_of_week 0-6');
                      }
                    }
                    if (cadence === 'monthly') {
                      if (!(Number.isInteger(dom) && dom >= 1 && dom <= 31)) {
                        throw new Error('monthly requires day_of_month 1-31');
                      }
                    }

                    await db.run(
                      `INSERT INTO recurring (name, type, amount_cents, category, cadence, day_of_week, day_of_month, next_due_date)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                      [name, type, amountCents, category, cadence, dow, dom, nextDue]
                    );

                    await refreshRecurring();
                  } catch (e) {
                    createMessage({ screen, title: 'Invalid', message: e?.message || String(e) });
                  }
                }
              });
            }
          });
        } catch (e) {
          createMessage({ screen, title: 'Error', message: e?.message || String(e) });
        }
      }
    });
  });

  view.recurring.list.key(['p'], () => {
    const id = selectedIdFromTable(view.recurring);
    if (!id) return;
    createConfirm({
      screen,
      title: 'Post Recurring',
      message: `Post recurring #${id} as a transaction and advance next due date?`,
      onYes: async () => {
        try {
          const item = await db.get(`SELECT * FROM recurring WHERE id=?`, [id]);
          if (!item) throw new Error('not found');

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

          await refreshRecurring();
        } catch (e) {
          createMessage({ screen, title: 'Error', message: e?.message || String(e) });
        }
      }
    });
  });

  view.recurring.list.key(['delete', 'backspace'], () => {
    const id = selectedIdFromTable(view.recurring);
    if (!id) return;
    createConfirm({
      screen,
      title: 'Toggle Recurring',
      message: `Toggle active/inactive for recurring #${id}?`,
      onYes: async () => {
        try {
          await db.run(
            `UPDATE recurring SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?`,
            [id]
          );
          await refreshRecurring();
        } catch (e) {
          createMessage({ screen, title: 'Error', message: e?.message || String(e) });
        }
      }
    });
  });

  // Goals actions
  view.goals.list.key(['a'], () => {
    createFormPrompt({
      screen,
      title: 'Add Goal',
      fields: [
        { name: 'name', label: 'name', initial: '' },
        { name: 'target', label: 'target amount', initial: '' },
        { name: 'due', label: 'due date (YYYY-MM-DD)', initial: '' },
        { name: 'note', label: 'note', initial: '' }
      ],
      onSubmit: async (v) => {
        try {
          const name = String(v.name || '').trim();
          if (!name) throw new Error('missing name');

          const targetCents = parseAmountToCents(v.target);
          if (targetCents === null) throw new Error('invalid target');

          const due = String(v.due || '').trim() || null;
          const note = String(v.note || '').trim() || null;

          await db.run(
            `INSERT INTO goals (name, target_cents, due_date, note) VALUES (?, ?, ?, ?)` ,
            [name, targetCents, due, note]
          );

          await refreshGoals();
        } catch (e) {
          createMessage({ screen, title: 'Invalid', message: e?.message || String(e) });
        }
      }
    });
  });

  view.goals.list.key(['enter'], () => {
    const id = selectedIdFromTable(view.goals);
    if (!id) return;
    createFormPrompt({
      screen,
      title: `Add Progress to Goal #${id}`,
      fields: [{ name: 'amount', label: 'amount', initial: '' }],
      onSubmit: async (v) => {
        try {
          const deltaCents = parseAmountToCents(v.amount);
          if (deltaCents === null) throw new Error('invalid amount');

          await db.run(
            `UPDATE goals SET current_cents = MAX(0, current_cents + ?) WHERE id=?`,
            [deltaCents, id]
          );

          await refreshGoals();
        } catch (e) {
          createMessage({ screen, title: 'Invalid', message: e?.message || String(e) });
        }
      }
    });
  });

  // Initial view
  showView('dashboard');
  await refreshDashboard();
  screen.render();
}

try {
  await main();
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
