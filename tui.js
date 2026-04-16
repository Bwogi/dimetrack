import blessed from 'blessed';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  addDays,
  addMonths,
  autoPostOverdueRecurring,
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
  warn: '#ffd24d',
  income: '#4dff91',
  expense: '#ff6b6b',
  dimmed: '#555555'
};

function progressBar(pct, width = 20, filled = '█', empty = '░') {
  const clamped = Math.max(0, Math.min(100, pct));
  const fill = Math.round((clamped / 100) * width);
  return filled.repeat(fill) + empty.repeat(width - fill);
}

function sparkBar(value, maxValue, width = 15) {
  if (!maxValue || maxValue <= 0) return '░'.repeat(width);
  const pct = Math.min(1, Math.abs(value) / maxValue);
  const fill = Math.round(pct * width);
  return '▓'.repeat(fill) + '░'.repeat(width - fill);
}

function boxLine(label, value, width = 30) {
  const pad = width - label.length - value.length;
  return label + (pad > 0 ? ' '.repeat(pad) : ' ') + value;
}

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
  screen.saveFocus();
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

    inputs[f.name].key(['escape'], () => {
      box.destroy();
      screen.restoreFocus();
      screen.render();
    });

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
    screen.restoreFocus();
    screen.render();
  });

  box.on('submit', () => {
    const values = {};
    for (const f of fields) {
      values[f.name] = inputs[f.name].getValue();
    }
    box.destroy();
    screen.restoreFocus();
    screen.render();
    onSubmit(values);
  });

  inputs[order[0]]?.focus();
  screen.render();
}

function createConfirm({ screen, title, message, onYes }) {
  screen.saveFocus();
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
    screen.restoreFocus();
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
  screen.saveFocus();
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
    screen.restoreFocus();
    screen.render();
  };

  box.key(['escape'], close);
  list.key(['escape'], close);

  list.on('select', (item, index) => {
    const value = options[index];
    box.destroy();
    screen.render();
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
  screen.saveFocus();
  const lineCount = message.split('\n').length;
  const boxHeight = Math.max(7, lineCount + 5);
  const box = blessed.box({
    parent: screen,
    label: ` ${title} `,
    border: 'line',
    keys: true,
    input: true,
    focusable: true,
    width: '80%',
    height: boxHeight,
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
    top: lineCount + 2,
    left: 2,
    fg: THEME.muted,
    content: 'Press Esc or Enter to close'
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    screen.unkey(['escape', 'enter'], screenClose);
    box.destroy();
    screen.restoreFocus();
    screen.render();
  };
  const screenClose = () => close();

  box.key(['escape', 'enter', 'q'], close);
  screen.key(['escape', 'enter'], screenClose);

  process.nextTick(() => {
    box.focus();
    screen.render();
  });
}

async function main() {
  await initDb();
  const db = await getDb();

  const screen = blessed.screen({
    smartCSR: true,
    title: 'DimeTrack',
    useBCE: true
  });

  screen.key(['C-c'], () => process.exit(0));

  screen.key(['q'], () => {
    createConfirm({
      screen,
      title: 'Quit',
      message: 'Are you sure you want to quit DimeTrack?',
      onYes: () => process.exit(0)
    });
  });

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
    content: ''
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    height: 2,
    width: '100%',
    tags: true,
    style: { bg: THEME.footerBg, fg: THEME.footerFg },
    content: ''
  });

  const navItems = [
    { key: 'd', name: 'Dashboard', view: 'dashboard' },
    { key: 't', name: 'Transactions', view: 'tx' },
    { key: 'r', name: 'Recurring', view: 'recurring' },
    { key: 'g', name: 'Goals', view: 'goals' },
    { key: 'b', name: 'Budgets', view: 'budgets' },
    { key: 'm', name: 'Trips', view: 'trips' },
    { key: 'h', name: 'Help', view: null }
  ];

  const footerShortcuts = {
    dashboard: 'Scroll: ↑↓  Navigate: d t r g b m  Tab:cycle  q:quit',
    tx:        'a:add  enter:edit  del:delete  /:search  f:date range  e:export  Tab:cycle  q:quit',
    recurring: 'a:add  enter:edit  del:toggle  p:post  /:search  e:export  Tab:cycle  q:quit',
    goals:     'a:add  enter:edit(+$)  del:delete  /:search  e:export  Tab:cycle  q:quit',
    budgets:   'a:add  enter:edit  del:delete  /:search  e:export  Tab:cycle  q:quit',
    trips:     'a:add  enter:edit  del:delete  v:vehicle  /:search  e:export  Tab:cycle  q:quit'
  };

  function updateChrome() {
    const now = new Date();
    const clock = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const nav = navItems.map(n => {
      if (n.view === currentView) {
        return `{bold}{black-fg}{green-bg} ${n.name}(${n.key}) {/green-bg}{/black-fg}{/bold}`;
      }
      return `{gray-fg} ${n.name}(${n.key}) {/gray-fg}`;
    }).join('');
    header.setContent(` {bold}{green-fg}◆ DimeTrack{/green-fg}{/bold} ${nav}  {gray-fg}${clock}{/gray-fg}`);

    const shortcuts = footerShortcuts[currentView] || footerShortcuts.dashboard;
    footer.setContent(` {bold}Shortcuts{/bold}  ${shortcuts}`);
  }

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
    goals: createTableView({ parent: mainBox, label: 'Goals' }),
    budgets: createTableView({ parent: mainBox, label: 'Budgets' }),
    trips: createTableView({ parent: mainBox, label: 'Trips & Mileage' })
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

    if (name === 'tx' || name === 'recurring' || name === 'goals' || name === 'budgets' || name === 'trips') {
      view[name].list.focus();
    } else {
      view.dashboard.focus();
    }

    updateChrome();
    screen.render();
    void refresh();
  }

  let txFilter = '';
  let txDateFrom = '';
  let txDateTo = '';
  let recurringFilter = '';
  let goalsFilter = '';
  let tripsFilter = '';

  async function refreshDashboard() {
    const today = isoDateOnly(new Date());
    const dash = await computeDashboard(db, today);
    const sep = '{gray-fg}' + '─'.repeat(52) + '{/gray-fg}';

    const lines = [];
    lines.push(`{bold}{green-fg}┌─ DimeTrack Dashboard ─┐{/green-fg}{/bold}  ${today}`);
    lines.push(`{gray-fg}│{/gray-fg} Month: ${dash.monthStart} .. ${dash.monthEnd}`);
    lines.push('');

    const maxAmt = Math.max(dash.incomeCents, dash.expenseCents, 1);
    lines.push('{bold}  Monthly Overview{/bold}');
    lines.push(`  {green-fg}▲ Income {/green-fg} ${formatCents(dash.incomeCents).padStart(10)}  {green-fg}${sparkBar(dash.incomeCents, maxAmt)}{/green-fg}`);
    lines.push(`  {red-fg}▼ Expense{/red-fg} ${formatCents(dash.expenseCents).padStart(10)}  {red-fg}${sparkBar(dash.expenseCents, maxAmt)}{/red-fg}`);
    const netColor = dash.netCents >= 0 ? 'green' : 'red';
    const netIcon = dash.netCents >= 0 ? '◆' : '◇';
    lines.push(`  {${netColor}-fg}${netIcon} Net    {/${netColor}-fg} ${formatCents(dash.netCents).padStart(10)}  {${netColor}-fg}${sparkBar(dash.netCents, maxAmt)}{/${netColor}-fg}`);

    lines.push('');
    lines.push(sep);

    lines.push('');
    lines.push('{bold}  🎯 Goals{/bold}');
    if (!dash.goals.length) {
      lines.push('  {gray-fg}No goals yet — press g then a to add one{/gray-fg}');
    } else {
      for (const g of dash.goals) {
        const pct = g.target_cents ? Math.round((g.current_cents / g.target_cents) * 100) : 0;
        const barColor = pct >= 100 ? 'green' : pct >= 60 ? 'yellow' : 'white';
        const bar = progressBar(pct, 20);
        lines.push(`  {bold}${g.name}{/bold}` + (g.due_date ? `  {gray-fg}due ${g.due_date}{/gray-fg}` : ''));
        lines.push(`  {${barColor}-fg}${bar}{/${barColor}-fg} ${pct}%  ${formatCents(g.current_cents)} / ${formatCents(g.target_cents)}`);
      }
    }

    lines.push('');
    lines.push(sep);

    lines.push('');
    lines.push('{bold}  📅 Upcoming Recurring{/bold}');
    if (!dash.upcomingRecurring.length) {
      lines.push('  {gray-fg}No upcoming items{/gray-fg}');
    } else {
      for (const r of dash.upcomingRecurring) {
        const typeTag = r.type === 'expense' ? '{red-fg}expense{/red-fg}' : '{green-fg}income{/green-fg}';
        const daysLeft = Math.round((new Date(`${r.next_due_date}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000);
        const urgency = daysLeft <= 3 ? '{red-fg}' : daysLeft <= 7 ? '{yellow-fg}' : '{gray-fg}';
        const urgencyClose = daysLeft <= 3 ? '{/red-fg}' : daysLeft <= 7 ? '{/yellow-fg}' : '{/gray-fg}';
        lines.push(`  ${urgency}${r.next_due_date}${urgencyClose}  ${r.name.padEnd(18)}  ${typeTag}  ${formatCents(r.amount_cents).padStart(10)}  {gray-fg}${r.cadence}{/gray-fg}`);
      }
    }

    const budgets = await db.all(`SELECT * FROM budgets ORDER BY type ASC, category ASC`);
    if (budgets.length) {
      const spending = await getMonthlySpendByCategory(db, dash.monthStart, dash.monthEnd);
      const spendMap = {};
      for (const s of spending) spendMap[s.category] = s.spent_cents;

      lines.push('');
      lines.push(sep);
      lines.push('');
      lines.push('{bold}  💰 Budget Tracking{/bold}');

      for (const b of budgets) {
        const spent = spendMap[b.category] || 0;
        const pct = b.monthly_limit_cents ? Math.round((spent / b.monthly_limit_cents) * 100) : 0;
        const barColor = pct >= 100 ? 'red' : pct >= 80 ? 'yellow' : 'green';
        const bar = progressBar(pct, 16);
        const tag = pct >= 100 ? ' {red-fg}OVER{/red-fg}' : pct >= 80 ? ' {yellow-fg}WARN{/yellow-fg}' : '';
        lines.push(`  ${b.category.padEnd(14)} {${barColor}-fg}${bar}{/${barColor}-fg} ${String(pct).padStart(3)}%  ${formatCents(spent).padStart(9)} / ${formatCents(b.monthly_limit_cents)}${tag}`);
      }
    }

    const tripStats = await getMonthlyTripSummary(db, dash.monthStart, dash.monthEnd);
    if (tripStats.trip_count > 0) {
      lines.push('');
      lines.push(sep);
      lines.push('');
      lines.push('{bold}  🚗 Trips & Mileage (this month){/bold}');
      lines.push('');
      lines.push(`  Trips: {bold}${tripStats.trip_count}{/bold}     Miles: {bold}${tripStats.total_miles.toFixed(1)}{/bold}`);
      lines.push('');
      lines.push(`  {gray-fg}Costs:{/gray-fg}  Gas ${formatCents(tripStats.total_gas_cents)}  +  Other ${formatCents(tripStats.total_other_cents)}  =  {bold}${formatCents(tripStats.totalCost)}{/bold}`);
      lines.push(`  {gray-fg}Earned:{/gray-fg} {green-fg}${formatCents(tripStats.total_income_cents)}{/green-fg}`);
      lines.push('');

      const netTag = tripStats.netProfit >= 0 ? '{green-fg}' : '{red-fg}';
      const netClose = tripStats.netProfit >= 0 ? '{/green-fg}' : '{/red-fg}';
      lines.push(`  ${boxLine('Net Profit:', `${netTag}${formatCents(tripStats.netProfit)}${netClose}`)}`);
      lines.push(`  ${boxLine('Cost / mile:', formatCents(tripStats.costPerMile))}`);
      lines.push(`  ${boxLine('Profit / mile:', `${netTag}${formatCents(tripStats.profitPerMile)}${netClose}`)}`);
      lines.push(`  ${boxLine(`IRS deduction (${formatCents(IRS_MILEAGE_RATE_CENTS)}/mi):`, formatCents(tripStats.irsDeduction))}`);
      lines.push('');
      const verdictIcon = tripStats.netProfit > 0 ? '✓' : '✗';
      const verdictColor = tripStats.netProfit > 0 ? 'green' : 'red';
      const verdictText = tripStats.netProfit > 0 ? 'Trips are profitable this month' : 'Trips are costing more than they earn';
      lines.push(`  {${verdictColor}-fg}{bold}${verdictIcon} ${verdictText}{/bold}{/${verdictColor}-fg}`);
    }

    lines.push('');
    view.dashboard.setContent(lines.join('\n'));
  }

  function matchesFilter(row) {
    if (!txFilter) return true;
    const blob = `${row.type} ${row.category} ${row.note || ''} ${row.date}`.toLowerCase();
    return blob.includes(txFilter.toLowerCase());
  }

  async function refreshTx() {
    let query = `SELECT * FROM transactions`;
    const params = [];
    const clauses = [];
    if (txDateFrom) { clauses.push(`date >= ?`); params.push(txDateFrom); }
    if (txDateTo) { clauses.push(`date <= ?`); params.push(txDateTo); }
    if (clauses.length) query += ` WHERE ` + clauses.join(' AND ');
    query += ` ORDER BY date DESC, id DESC LIMIT 500`;

    const rows = await db.all(query, params);
    const filtered = rows.filter(matchesFilter);

    let totalIncome = 0, totalExpense = 0;
    for (const t of filtered) {
      if (t.type === 'income') totalIncome += t.amount_cents;
      else totalExpense += t.amount_cents;
    }

    view.tx.setData({
      columns: [
        { title: 'ID', minWidth: 3, maxWidth: 6, weight: 1 },
        { title: 'Date', minWidth: 10, maxWidth: 12, weight: 2 },
        { title: 'Type', minWidth: 6, maxWidth: 8, weight: 1 },
        { title: 'Amount', minWidth: 8, maxWidth: 12, weight: 1 },
        { title: 'Category', minWidth: 10, maxWidth: 18, weight: 2 },
        { title: 'Note', minWidth: 10, maxWidth: 60, weight: 4 }
      ],
      rows: filtered.map((t) => {
        const prefix = t.type === 'expense' ? '-' : '+';
        return [
          String(t.id),
          t.date,
          t.type === 'expense' ? '{red-fg}expense{/red-fg}' : '{green-fg}income{/green-fg}',
          t.type === 'expense' ? `{red-fg}${prefix}${formatCents(t.amount_cents)}{/red-fg}` : `{green-fg}${prefix}${formatCents(t.amount_cents)}{/green-fg}`,
          t.category,
          `{gray-fg}${t.note || ''}{/gray-fg}`
        ];
      })
    });
    if (!filtered.length) {
      view.tx.list.setItems(['  (no transactions — press "a" to add one)']);
    }
    const net = totalIncome - totalExpense;
    const netColor = net >= 0 ? '{green-fg}' : '{red-fg}';
    const netClose = net >= 0 ? '{/green-fg}' : '{/red-fg}';
    const parts = [];
    if (txFilter) parts.push(`search: ${txFilter}`);
    if (txDateFrom || txDateTo) parts.push(`date: ${txDateFrom || '*'} .. ${txDateTo || '*'}`);
    const summary = `▲ ${formatCents(totalIncome)}  ▼ ${formatCents(totalExpense)}  ◆ ${formatCents(net)}`;
    const filterLabel = parts.length ? parts.join('  ') + ` (${filtered.length}/${rows.length})` : '';
    setStatus((filterLabel || `Transactions: ${rows.length}`) + `  │  ${summary}`);
  }

  async function refreshRecurring() {
    const rows = await db.all(
      `SELECT * FROM recurring ORDER BY active DESC, next_due_date ASC, id DESC`
    );

    const filtered = recurringFilter
      ? rows.filter(r => {
          const blob = `${r.name} ${r.type} ${r.category} ${r.cadence} ${r.next_due_date}`.toLowerCase();
          return blob.includes(recurringFilter.toLowerCase());
        })
      : rows;

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
      rows: filtered.map((r) => {
        const today = isoDateOnly(new Date());
        const daysLeft = Math.round((new Date(`${r.next_due_date}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000);
        const activeLabel = r.active ? '{green-fg}✓{/green-fg}' : '{gray-fg}✗{/gray-fg}';
        const dateColor = !r.active ? 'gray' : daysLeft <= 3 ? 'red' : daysLeft <= 7 ? 'yellow' : 'white';
        const typeTag = r.type === 'expense' ? '{red-fg}expense{/red-fg}' : '{green-fg}income{/green-fg}';
        const dim = !r.active ? '{gray-fg}' : '';
        const dimC = !r.active ? '{/gray-fg}' : '';
        return [
          String(r.id),
          activeLabel,
          `{${dateColor}-fg}${r.next_due_date}{/${dateColor}-fg}`,
          `${dim}${r.name}${dimC}`,
          typeTag,
          `${dim}${formatCents(r.amount_cents)}${dimC}`,
          `${dim}${r.category}${dimC}`,
          `{gray-fg}${r.cadence}{/gray-fg}`
        ];
      })
    });
    if (!filtered.length) {
      view.recurring.list.setItems(['  (no recurring items — press "a" to add one)']);
    }
    setStatus(recurringFilter ? `Filter: ${recurringFilter} (${filtered.length}/${rows.length})` : `Recurring: ${rows.length}`);
  }

  async function refreshGoals() {
    const rows = await db.all(`SELECT * FROM goals ORDER BY created_at DESC`);

    const filtered = goalsFilter
      ? rows.filter(g => {
          const blob = `${g.name} ${g.due_date || ''} ${g.note || ''}`.toLowerCase();
          return blob.includes(goalsFilter.toLowerCase());
        })
      : rows;

    view.goals.setData({
      columns: [
        { title: 'ID', minWidth: 3, maxWidth: 6, weight: 1 },
        { title: 'Name', minWidth: 12, maxWidth: 26, weight: 3 },
        { title: 'Progress', minWidth: 12, maxWidth: 14, weight: 2 },
        { title: 'Current', minWidth: 8, maxWidth: 12, weight: 1 },
        { title: 'Target', minWidth: 8, maxWidth: 12, weight: 1 },
        { title: '%', minWidth: 4, maxWidth: 5, weight: 1 },
        { title: 'Due', minWidth: 10, maxWidth: 12, weight: 2 }
      ],
      rows: filtered.map((g) => {
        const pct = g.target_cents ? Math.round((g.current_cents / g.target_cents) * 100) : 0;
        const barColor = pct >= 100 ? 'green' : pct >= 60 ? 'yellow' : 'white';
        const bar = progressBar(Math.min(pct, 100), 10);
        return [
          String(g.id),
          `{bold}${g.name}{/bold}`,
          `{${barColor}-fg}${bar}{/${barColor}-fg}`,
          `{green-fg}${formatCents(g.current_cents)}{/green-fg}`,
          formatCents(g.target_cents),
          `{${barColor}-fg}${pct}%{/${barColor}-fg}`,
          g.due_date ? `{gray-fg}${g.due_date}{/gray-fg}` : ''
        ];
      })
    });
    if (!filtered.length) {
      view.goals.list.setItems(['  (no goals — press "a" to add one)']);
    }
    setStatus(goalsFilter ? `Filter: ${goalsFilter} (${filtered.length}/${rows.length})` : `Goals: ${rows.length}`);
  }

  async function refreshBudgets() {
    const today = isoDateOnly(new Date());
    const { start, end } = monthRange(today);
    const budgets = await db.all(`SELECT * FROM budgets ORDER BY type ASC, category ASC`);
    const spending = await getMonthlySpendByCategory(db, start, end);
    const spendMap = {};
    for (const s of spending) spendMap[s.category] = s.spent_cents;

    view.budgets.setData({
      columns: [
        { title: 'ID', minWidth: 3, maxWidth: 5, weight: 1 },
        { title: 'Type', minWidth: 6, maxWidth: 8, weight: 1 },
        { title: 'Category', minWidth: 10, maxWidth: 18, weight: 2 },
        { title: 'Usage', minWidth: 10, maxWidth: 12, weight: 2 },
        { title: 'Spent', minWidth: 8, maxWidth: 12, weight: 1 },
        { title: 'Limit', minWidth: 8, maxWidth: 12, weight: 1 },
        { title: 'Left', minWidth: 8, maxWidth: 12, weight: 1 },
        { title: 'Status', minWidth: 6, maxWidth: 10, weight: 1 }
      ],
      rows: budgets.map((b) => {
        const spent = spendMap[b.category] || 0;
        const remaining = b.monthly_limit_cents - spent;
        const pct = b.monthly_limit_cents ? Math.round((spent / b.monthly_limit_cents) * 100) : 0;
        const barColor = pct >= 100 ? 'red' : pct >= 80 ? 'yellow' : 'green';
        const bar = progressBar(Math.min(pct, 100), 8);
        const statusTag = pct >= 100 ? '{red-fg}OVER{/red-fg}' : pct >= 80 ? '{yellow-fg}WARN{/yellow-fg}' : '{green-fg}OK{/green-fg}';
        const remColor = remaining < 0 ? 'red' : 'green';
        return [
          String(b.id),
          b.type,
          `{bold}${b.category}{/bold}`,
          `{${barColor}-fg}${bar}{/${barColor}-fg}`,
          formatCents(spent),
          formatCents(b.monthly_limit_cents),
          `{${remColor}-fg}${formatCents(remaining)}{/${remColor}-fg}`,
          `${statusTag} ${pct}%`
        ];
      })
    });
    if (!budgets.length) {
      view.budgets.list.setItems(['  (no budgets — press "a" to set one)']);
    }
    setStatus(`Budgets: ${budgets.length} (${start} .. ${end})`);
  }

  async function refreshTrips() {
    const rows = await db.all(`SELECT * FROM trips ORDER BY date DESC, id DESC LIMIT 500`);

    const filtered = tripsFilter
      ? rows.filter(t => {
          const blob = `${t.destination} ${t.date} ${t.note || ''}`.toLowerCase();
          return blob.includes(tripsFilter.toLowerCase());
        })
      : rows;

    const vs = await getVehicleSettings(db);
    let totMiles = 0, totGas = 0, totOther = 0, totIncome = 0;
    for (const t of filtered) {
      totMiles += t.miles;
      totGas += t.gas_cost_cents;
      totOther += t.other_cost_cents;
      totIncome += t.income_cents;
    }
    const totNet = totIncome - totGas - totOther;

    view.trips.setData({
      columns: [
        { title: 'ID', minWidth: 3, maxWidth: 5, weight: 1 },
        { title: 'Date', minWidth: 10, maxWidth: 11, weight: 2 },
        { title: 'Destination', minWidth: 10, maxWidth: 22, weight: 3 },
        { title: 'Odo Start', minWidth: 7, maxWidth: 9, weight: 1 },
        { title: 'Odo End', minWidth: 7, maxWidth: 9, weight: 1 },
        { title: 'Miles', minWidth: 5, maxWidth: 7, weight: 1 },
        { title: 'Gas$', minWidth: 7, maxWidth: 10, weight: 1 },
        { title: 'Income', minWidth: 7, maxWidth: 10, weight: 1 },
        { title: 'Net', minWidth: 7, maxWidth: 10, weight: 1 }
      ],
      rows: filtered.map((t) => {
        const totalCost = t.gas_cost_cents + t.other_cost_cents;
        const net = t.income_cents - totalCost;
        const netColor = net >= 0 ? 'green' : 'red';
        const gasLabel = t.gas_estimated ? `{gray-fg}~${formatCents(t.gas_cost_cents)}{/gray-fg}` : `{red-fg}${formatCents(t.gas_cost_cents)}{/red-fg}`;
        return [
          String(t.id),
          t.date,
          `{bold}${t.destination}{/bold}`,
          t.odometer_start != null ? `{gray-fg}${t.odometer_start.toFixed(0)}{/gray-fg}` : '{gray-fg}-{/gray-fg}',
          t.odometer_end != null ? `{gray-fg}${t.odometer_end.toFixed(0)}{/gray-fg}` : '{gray-fg}-{/gray-fg}',
          `{yellow-fg}${t.miles.toFixed(1)}{/yellow-fg}`,
          gasLabel,
          `{green-fg}${formatCents(t.income_cents)}{/green-fg}`,
          `{${netColor}-fg}${formatCents(net)}{/${netColor}-fg}`
        ];
      })
    });
    if (!filtered.length) {
      view.trips.list.setItems(['  (no trips — press "a" to log one)']);
    }
    const totNetColor = totNet >= 0 ? '✓' : '✗';
    const tripSummary = filtered.length ? `  │  ${totMiles.toFixed(0)}mi  gas:${formatCents(totGas)}  earned:${formatCents(totIncome)}  net:${formatCents(totNet)} ${totNetColor}` : '';
    const vInfo = vs ? `  │  ${vs.mpg}MPG ${formatCents(vs.gas_price_cents)}/gal [v:settings]` : '';
    setStatus((tripsFilter ? `Filter: ${tripsFilter} (${filtered.length}/${rows.length})` : `Trips: ${rows.length}`) + tripSummary + vInfo);
  }

  async function refresh() {
    try {
      if (currentView === 'dashboard') await refreshDashboard();
      if (currentView === 'tx') await refreshTx();
      if (currentView === 'recurring') await refreshRecurring();
      if (currentView === 'goals') await refreshGoals();
      if (currentView === 'budgets') await refreshBudgets();
      if (currentView === 'trips') await refreshTrips();
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

  function selectRowById(table, id) {
    const list = table?.list ?? table;
    const data = list?._rowData;
    if (!Array.isArray(data) || !data.length) return;
    const idx = data.findIndex(r => Number(r?.[0]) === Number(id));
    if (idx >= 0) list.select(idx);
  }

  function centsToAmountInput(cents) {
    const n = Number(cents ?? 0);
    if (!Number.isFinite(n)) return '';
    return (n / 100).toFixed(2);
  }

  // Navigation
  screen.key(['d'], () => showView('dashboard'));
  screen.key(['t'], () => showView('tx'));
  screen.key(['r'], () => showView('recurring'));
  screen.key(['g'], () => showView('goals'));
  screen.key(['b'], () => showView('budgets'));
  screen.key(['m'], () => showView('trips'));

  const viewOrder = ['dashboard', 'tx', 'recurring', 'goals', 'budgets', 'trips'];
  screen.key(['tab'], () => {
    const idx = viewOrder.indexOf(currentView);
    showView(viewOrder[(idx + 1) % viewOrder.length]);
  });
  screen.key(['S-tab'], () => {
    const idx = viewOrder.indexOf(currentView);
    showView(viewOrder[(idx - 1 + viewOrder.length) % viewOrder.length]);
  });

  screen.key(['h', '?'], () => {
    createMessage({
      screen,
      title: ' DimeTrack Help ',
      message:
        '◆ Navigation ─ d:Dashboard  t:Transactions  r:Recurring  g:Goals  b:Budgets  m:Trips\n' +
        '               Tab / Shift+Tab to cycle views\n' +
        '◆ Actions ──── a:add  enter:edit  del:delete/toggle  p:post recurring  v:vehicle(trips)\n' +
        '◆ Search ───── /:search text  f:date range (transactions only)\n' +
        '◆ Export ───── e:export current view to CSV\n' +
        '◆ Quit ─────── q:confirm quit   Ctrl+C:immediate'
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
      fields: [
        { name: 'filter', label: 'contains', initial: txFilter },
        { name: 'from', label: 'from (YYYY-MM-DD)', initial: txDateFrom },
        { name: 'to', label: 'to (YYYY-MM-DD)', initial: txDateTo }
      ],
      onSubmit: async (v) => {
        txFilter = String(v.filter || '').trim();
        txDateFrom = String(v.from || '').trim();
        txDateTo = String(v.to || '').trim();
        await refreshTx();
      }
    });
  });

  view.tx.list.key(['enter'], () => {
    const id = selectedIdFromTable(view.tx);
    if (!id) return;

    (async () => {
      try {
        const tx = await db.get(`SELECT * FROM transactions WHERE id = ?`, [id]);
        if (!tx) return;

        const typeOptions = ['expense', 'income'];
        const initialTypeIndex = Math.max(0, typeOptions.indexOf(tx.type));

        createSelectPrompt({
          screen,
          title: `Edit Transaction #${id} (type)`,
          options: typeOptions,
          initialIndex: initialTypeIndex,
          onSelect: async (type) => {
            try {
              const categories = await getCategories(db, type);
              if (!categories.length) throw new Error(`No categories for ${type}`);
              const initialCategoryIndex = Math.max(0, categories.indexOf(tx.category));

              createSelectPrompt({
                screen,
                title: `Edit Transaction #${id} (category)`,
                options: categories,
                initialIndex: initialCategoryIndex,
                onSelect: (category) => {
                  createFormPrompt({
                    screen,
                    title: `Edit Transaction #${id} (${type} / ${category})`,
                    fields: [
                      { name: 'amount', label: 'amount', initial: centsToAmountInput(tx.amount_cents) },
                      { name: 'note', label: 'note', initial: tx.note || '' },
                      { name: 'date', label: 'date (YYYY-MM-DD)', initial: tx.date || isoDateOnly(new Date()) }
                    ],
                    onSubmit: async (v) => {
                      try {
                        const amountCents = parseAmountToCents(v.amount);
                        if (amountCents === null) throw new Error('invalid amount');

                        const note = String(v.note || '').trim() || null;
                        const date = String(v.date || '').trim() || isoDateOnly(new Date());

                        await db.run(
                          `UPDATE transactions SET type=?, amount_cents=?, category=?, note=?, date=? WHERE id=?`,
                          [type, amountCents, category, note, date, id]
                        );
                        await refreshTx();
                        selectRowById(view.tx, id);
                        screen.render();
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
      } catch (e) {
        createMessage({ screen, title: 'Error', message: e?.message || String(e) });
      }
    })();
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

  view.recurring.list.key(['enter'], () => {
    const id = selectedIdFromTable(view.recurring);
    if (!id) return;

    (async () => {
      try {
        const item = await db.get(`SELECT * FROM recurring WHERE id = ?`, [id]);
        if (!item) return;

        const typeOptions = ['expense', 'income'];
        const initialTypeIndex = Math.max(0, typeOptions.indexOf(item.type));

        createSelectPrompt({
          screen,
          title: `Edit Recurring #${id} (type)`,
          options: typeOptions,
          initialIndex: initialTypeIndex,
          onSelect: async (type) => {
            try {
              const categories = await getCategories(db, type);
              if (!categories.length) throw new Error(`No categories for ${type}`);
              const initialCategoryIndex = Math.max(0, categories.indexOf(item.category));

              createSelectPrompt({
                screen,
                title: `Edit Recurring #${id} (category)`,
                options: categories,
                initialIndex: initialCategoryIndex,
                onSelect: (category) => {
                  createFormPrompt({
                    screen,
                    title: `Edit Recurring #${id} (${type} / ${category})`,
                    fields: [
                      { name: 'name', label: 'name', initial: item.name || '' },
                      { name: 'amount', label: 'amount', initial: centsToAmountInput(item.amount_cents) },
                      { name: 'cadence', label: 'cadence (weekly|monthly)', initial: item.cadence || 'monthly' },
                      { name: 'day_of_week', label: 'day_of_week (0-6)', initial: item.day_of_week != null ? String(item.day_of_week) : '' },
                      { name: 'day_of_month', label: 'day_of_month (1-31)', initial: item.day_of_month != null ? String(item.day_of_month) : '1' },
                      { name: 'next_due_date', label: 'next_due_date (YYYY-MM-DD)', initial: item.next_due_date || isoDateOnly(new Date()) }
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
                          `UPDATE recurring SET name=?, type=?, amount_cents=?, category=?, cadence=?, day_of_week=?, day_of_month=?, next_due_date=? WHERE id=?`,
                          [name, type, amountCents, category, cadence, dow, dom, nextDue, id]
                        );
                        await refreshRecurring();
                        selectRowById(view.recurring, id);
                        screen.render();
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
      } catch (e) {
        createMessage({ screen, title: 'Error', message: e?.message || String(e) });
      }
    })();
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

  view.recurring.list.key(['/'], () => {
    createFormPrompt({
      screen,
      title: 'Filter Recurring',
      fields: [{ name: 'filter', label: 'contains', initial: recurringFilter }],
      onSubmit: async (v) => {
        recurringFilter = String(v.filter || '').trim();
        await refreshRecurring();
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

  view.goals.list.key(['/'], () => {
    createFormPrompt({
      screen,
      title: 'Filter Goals',
      fields: [{ name: 'filter', label: 'contains', initial: goalsFilter }],
      onSubmit: async (v) => {
        goalsFilter = String(v.filter || '').trim();
        await refreshGoals();
      }
    });
  });

  view.goals.list.key(['delete', 'backspace'], () => {
    const id = selectedIdFromTable(view.goals);
    if (!id) return;
    createConfirm({
      screen,
      title: 'Delete Goal',
      message: `Delete goal #${id}?`,
      onYes: async () => {
        try {
          await db.run(`DELETE FROM goals WHERE id = ?`, [id]);
          await refreshGoals();
        } catch (e) {
          createMessage({ screen, title: 'Error', message: e?.message || String(e) });
        }
      }
    });
  });

  // Budget actions
  view.budgets.list.key(['a'], () => {
    createSelectPrompt({
      screen,
      title: 'Budget Type',
      options: ['expense', 'income'],
      initialIndex: 0,
      onSelect: async (type) => {
        try {
          const categories = await getCategories(db, type);
          if (!categories.length) throw new Error(`No categories for ${type}`);

          createSelectPrompt({
            screen,
            title: `Budget Category (${type})`,
            options: categories,
            initialIndex: 0,
            onSelect: (category) => {
              createFormPrompt({
                screen,
                title: `Set Budget (${type} / ${category})`,
                fields: [
                  { name: 'limit', label: 'monthly limit', initial: '' }
                ],
                onSubmit: async (v) => {
                  try {
                    const limitCents = parseAmountToCents(v.limit);
                    if (limitCents === null) throw new Error('invalid amount');

                    await db.run(
                      `INSERT OR REPLACE INTO budgets (type, category, monthly_limit_cents) VALUES (?, ?, ?)`,
                      [type, category, limitCents]
                    );
                    await refreshBudgets();
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

  view.budgets.list.key(['enter'], () => {
    const id = selectedIdFromTable(view.budgets);
    if (!id) return;

    (async () => {
      try {
        const budget = await db.get(`SELECT * FROM budgets WHERE id = ?`, [id]);
        if (!budget) return;

        createFormPrompt({
          screen,
          title: `Edit Budget #${id} (${budget.type} / ${budget.category})`,
          fields: [
            { name: 'limit', label: 'monthly limit', initial: centsToAmountInput(budget.monthly_limit_cents) }
          ],
          onSubmit: async (v) => {
            try {
              const limitCents = parseAmountToCents(v.limit);
              if (limitCents === null) throw new Error('invalid amount');

              await db.run(
                `UPDATE budgets SET monthly_limit_cents=? WHERE id=?`,
                [limitCents, id]
              );
              await refreshBudgets();
              selectRowById(view.budgets, id);
              screen.render();
            } catch (e) {
              createMessage({ screen, title: 'Invalid', message: e?.message || String(e) });
            }
          }
        });
      } catch (e) {
        createMessage({ screen, title: 'Error', message: e?.message || String(e) });
      }
    })();
  });

  view.budgets.list.key(['delete', 'backspace'], () => {
    const id = selectedIdFromTable(view.budgets);
    if (!id) return;
    createConfirm({
      screen,
      title: 'Delete Budget',
      message: `Delete budget #${id}?`,
      onYes: async () => {
        try {
          await db.run(`DELETE FROM budgets WHERE id = ?`, [id]);
          await refreshBudgets();
        } catch (e) {
          createMessage({ screen, title: 'Error', message: e?.message || String(e) });
        }
      }
    });
  });

  // Trips actions
  view.trips.list.key(['a'], () => {
    (async () => {
      const vs = await getVehicleSettings(db);
      const lastTrip = await db.get(`SELECT odometer_end FROM trips ORDER BY date DESC, id DESC LIMIT 1`);
      const lastOdo = lastTrip?.odometer_end != null ? String(lastTrip.odometer_end) : '';

      createFormPrompt({
        screen,
        title: `Log Trip  (${vs.mpg} MPG, gas ${formatCents(vs.gas_price_cents)}/gal)`,
        fields: [
          { name: 'destination', label: 'destination', initial: '' },
          { name: 'date', label: 'date (YYYY-MM-DD)', initial: isoDateOnly(new Date()) },
          { name: 'odo_start', label: 'odometer start', initial: lastOdo },
          { name: 'odo_end', label: 'odometer end', initial: '' },
          { name: 'gas_cost', label: 'gas cost (blank=auto)', initial: '' },
          { name: 'other_cost', label: 'other costs', initial: '0' },
          { name: 'income', label: 'income earned', initial: '' },
          { name: 'note', label: 'note', initial: '' }
        ],
        onSubmit: async (v) => {
          try {
            const destination = String(v.destination || '').trim();
            if (!destination) throw new Error('missing destination');

            const date = String(v.date || '').trim() || isoDateOnly(new Date());

            const odoStart = Number(String(v.odo_start || '').trim());
            const odoEnd = Number(String(v.odo_end || '').trim());
            if (!Number.isFinite(odoStart) || !Number.isFinite(odoEnd)) throw new Error('invalid odometer reading');
            if (odoEnd < odoStart) throw new Error('odometer end must be >= start');
            const miles = odoEnd - odoStart;

            let gasCents;
            let gasEstimated;
            const gasRaw = String(v.gas_cost || '').trim();
            if (gasRaw === '') {
              gasCents = estimateGasCost(miles, vs.mpg, vs.gas_price_cents);
              gasEstimated = 1;
            } else {
              gasCents = parseAmountToCents(gasRaw);
              if (gasCents === null) throw new Error('invalid gas cost');
              gasEstimated = 0;
            }

            const otherCents = parseAmountToCents(v.other_cost) ?? 0;
            const incomeCents = parseAmountToCents(v.income);
            if (incomeCents === null) throw new Error('invalid income');

            const note = String(v.note || '').trim() || null;

            await db.run(
              `INSERT INTO trips (destination, date, odometer_start, odometer_end, miles, gas_cost_cents, gas_estimated, other_cost_cents, income_cents, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [destination, date, odoStart, odoEnd, miles, gasCents, gasEstimated, otherCents, incomeCents, note]
            );
            await refreshTrips();
          } catch (e) {
            createMessage({ screen, title: 'Invalid', message: e?.message || String(e) });
          }
        }
      });
    })();
  });

  view.trips.list.key(['enter'], () => {
    const id = selectedIdFromTable(view.trips);
    if (!id) return;

    (async () => {
      try {
        const trip = await db.get(`SELECT * FROM trips WHERE id = ?`, [id]);
        if (!trip) return;

        const vs = await getVehicleSettings(db);
        const gasInitial = trip.gas_estimated ? '' : centsToAmountInput(trip.gas_cost_cents);

        createFormPrompt({
          screen,
          title: `Edit Trip #${id}  (${vs.mpg} MPG, gas ${formatCents(vs.gas_price_cents)}/gal)`,
          fields: [
            { name: 'destination', label: 'destination', initial: trip.destination },
            { name: 'date', label: 'date (YYYY-MM-DD)', initial: trip.date },
            { name: 'odo_start', label: 'odometer start', initial: trip.odometer_start != null ? String(trip.odometer_start) : '' },
            { name: 'odo_end', label: 'odometer end', initial: trip.odometer_end != null ? String(trip.odometer_end) : '' },
            { name: 'gas_cost', label: 'gas cost (blank=auto)', initial: gasInitial },
            { name: 'other_cost', label: 'other costs', initial: centsToAmountInput(trip.other_cost_cents) },
            { name: 'income', label: 'income earned', initial: centsToAmountInput(trip.income_cents) },
            { name: 'note', label: 'note', initial: trip.note || '' }
          ],
          onSubmit: async (v) => {
            try {
              const destination = String(v.destination || '').trim();
              if (!destination) throw new Error('missing destination');

              const date = String(v.date || '').trim() || isoDateOnly(new Date());

              const odoStart = Number(String(v.odo_start || '').trim());
              const odoEnd = Number(String(v.odo_end || '').trim());
              if (!Number.isFinite(odoStart) || !Number.isFinite(odoEnd)) throw new Error('invalid odometer reading');
              if (odoEnd < odoStart) throw new Error('odometer end must be >= start');
              const miles = odoEnd - odoStart;

              let gasCents;
              let gasEstimated;
              const gasRaw = String(v.gas_cost || '').trim();
              if (gasRaw === '') {
                gasCents = estimateGasCost(miles, vs.mpg, vs.gas_price_cents);
                gasEstimated = 1;
              } else {
                gasCents = parseAmountToCents(gasRaw);
                if (gasCents === null) throw new Error('invalid gas cost');
                gasEstimated = 0;
              }

              const otherCents = parseAmountToCents(v.other_cost) ?? 0;
              const incomeCents = parseAmountToCents(v.income);
              if (incomeCents === null) throw new Error('invalid income');

              const note = String(v.note || '').trim() || null;

              await db.run(
                `UPDATE trips SET destination=?, date=?, odometer_start=?, odometer_end=?, miles=?, gas_cost_cents=?, gas_estimated=?, other_cost_cents=?, income_cents=?, note=? WHERE id=?`,
                [destination, date, odoStart, odoEnd, miles, gasCents, gasEstimated, otherCents, incomeCents, note, id]
              );
              await refreshTrips();
              selectRowById(view.trips, id);
              screen.render();
            } catch (e) {
              createMessage({ screen, title: 'Invalid', message: e?.message || String(e) });
            }
          }
        });
      } catch (e) {
        createMessage({ screen, title: 'Error', message: e?.message || String(e) });
      }
    })();
  });

  view.trips.list.key(['delete', 'backspace'], () => {
    const id = selectedIdFromTable(view.trips);
    if (!id) return;
    createConfirm({
      screen,
      title: 'Delete Trip',
      message: `Delete trip #${id}?`,
      onYes: async () => {
        try {
          await db.run(`DELETE FROM trips WHERE id = ?`, [id]);
          await refreshTrips();
        } catch (e) {
          createMessage({ screen, title: 'Error', message: e?.message || String(e) });
        }
      }
    });
  });

  view.trips.list.key(['v'], () => {
    (async () => {
      try {
        const vs = await getVehicleSettings(db);
        createFormPrompt({
          screen,
          title: 'Vehicle Settings',
          fields: [
            { name: 'mpg', label: 'MPG (miles/gallon)', initial: String(vs.mpg) },
            { name: 'gas_price', label: 'gas price $/gallon', initial: centsToAmountInput(vs.gas_price_cents) }
          ],
          onSubmit: async (v) => {
            try {
              const mpg = Number(String(v.mpg || '').trim());
              if (!Number.isFinite(mpg) || mpg <= 0) throw new Error('invalid MPG');

              const priceCents = parseAmountToCents(v.gas_price);
              if (priceCents === null || priceCents <= 0) throw new Error('invalid gas price');

              await db.run(
                `UPDATE vehicle_settings SET mpg=?, gas_price_cents=? WHERE id=1`,
                [mpg, priceCents]
              );
              await refreshTrips();
              createMessage({ screen, title: 'Saved', message: `Vehicle: ${mpg} MPG, gas ${formatCents(priceCents)}/gal` });
            } catch (e) {
              createMessage({ screen, title: 'Invalid', message: e?.message || String(e) });
            }
          }
        });
      } catch (e) {
        createMessage({ screen, title: 'Error', message: e?.message || String(e) });
      }
    })();
  });

  view.trips.list.key(['/'], () => {
    createFormPrompt({
      screen,
      title: 'Filter Trips',
      fields: [{ name: 'filter', label: 'contains', initial: tripsFilter }],
      onSubmit: async (v) => {
        tripsFilter = String(v.filter || '').trim();
        await refreshTrips();
      }
    });
  });

  // CSV Export
  screen.key(['e'], () => {
    if (currentView === 'dashboard') {
      createMessage({ screen, title: 'Export', message: 'Export is available from list views (t, r, g, b, m).' });
      return;
    }

    (async () => {
      try {
        let columns, rows, filename;

        if (currentView === 'tx') {
          let query = `SELECT * FROM transactions`;
          const params = [];
          const clauses = [];
          if (txDateFrom) { clauses.push(`date >= ?`); params.push(txDateFrom); }
          if (txDateTo) { clauses.push(`date <= ?`); params.push(txDateTo); }
          if (clauses.length) query += ` WHERE ` + clauses.join(' AND ');
          query += ` ORDER BY date DESC, id DESC LIMIT 500`;
          const data = await db.all(query, params);
          const filtered = data.filter(matchesFilter);
          columns = ['ID', 'Date', 'Type', 'Amount', 'Category', 'Note'];
          rows = filtered.map(t => [t.id, t.date, t.type, formatCents(t.amount_cents), t.category, t.note || '']);
          filename = 'transactions.csv';
        } else if (currentView === 'recurring') {
          const data = await db.all(`SELECT * FROM recurring ORDER BY active DESC, next_due_date ASC`);
          columns = ['ID', 'Active', 'Next Due', 'Name', 'Type', 'Amount', 'Category', 'Cadence'];
          rows = data.map(r => [r.id, r.active ? 'yes' : 'no', r.next_due_date, r.name, r.type, formatCents(r.amount_cents), r.category, r.cadence]);
          filename = 'recurring.csv';
        } else if (currentView === 'goals') {
          const data = await db.all(`SELECT * FROM goals ORDER BY created_at DESC`);
          columns = ['ID', 'Name', 'Current', 'Target', '%', 'Due'];
          rows = data.map(g => {
            const pct = g.target_cents ? Math.round((g.current_cents / g.target_cents) * 100) : 0;
            return [g.id, g.name, formatCents(g.current_cents), formatCents(g.target_cents), `${pct}%`, g.due_date || ''];
          });
          filename = 'goals.csv';
        } else if (currentView === 'budgets') {
          const today = isoDateOnly(new Date());
          const { start, end } = monthRange(today);
          const budgets = await db.all(`SELECT * FROM budgets ORDER BY type ASC, category ASC`);
          const spending = await getMonthlySpendByCategory(db, start, end);
          const spendMap = {};
          for (const s of spending) spendMap[s.category] = s.spent_cents;
          columns = ['ID', 'Type', 'Category', 'Limit', 'Spent', 'Remaining', 'Status'];
          rows = budgets.map(b => {
            const spent = spendMap[b.category] || 0;
            const remaining = b.monthly_limit_cents - spent;
            const pct = b.monthly_limit_cents ? Math.round((spent / b.monthly_limit_cents) * 100) : 0;
            let status = 'OK';
            if (pct >= 100) status = 'OVER';
            else if (pct >= 80) status = 'WARN';
            return [b.id, b.type, b.category, formatCents(b.monthly_limit_cents), formatCents(spent), formatCents(remaining), `${status} (${pct}%)`];
          });
          filename = 'budgets.csv';
        } else if (currentView === 'trips') {
          const data = await db.all(`SELECT * FROM trips ORDER BY date DESC, id DESC`);
          columns = ['ID', 'Date', 'Destination', 'Miles', 'Gas', 'Other Costs', 'Income', 'Net', 'Note'];
          rows = data.map(t => {
            const net = t.income_cents - t.gas_cost_cents - t.other_cost_cents;
            return [t.id, t.date, t.destination, t.miles, formatCents(t.gas_cost_cents), formatCents(t.other_cost_cents), formatCents(t.income_cents), formatCents(net), t.note || ''];
          });
          filename = 'trips.csv';
        } else {
          return;
        }

        const csv = exportToCsv(columns, rows);
        const outPath = path.join(__dirname, filename);
        fs.writeFileSync(outPath, csv, 'utf8');
        createMessage({ screen, title: 'Exported', message: `${rows.length} rows written to ${outPath}` });
      } catch (e) {
        createMessage({ screen, title: 'Export Error', message: e?.message || String(e) });
      }
    })();
  });

  // Auto-post overdue recurring on startup
  let autoPostCount = 0;
  let autoPostError = null;
  try {
    const today = isoDateOnly(new Date());
    autoPostCount = await autoPostOverdueRecurring(db, today);
  } catch (e) {
    autoPostError = e?.message || String(e);
  }

  // Refresh clock in header every 60s
  setInterval(() => { updateChrome(); screen.render(); }, 60000);

  // Initial view
  showView('dashboard');
  await refreshDashboard();
  screen.render();

  // Show auto-post notification after initial render so focus isn't stolen
  if (autoPostError) {
    createMessage({ screen, title: 'Auto-Post Error', message: autoPostError });
  } else if (autoPostCount > 0) {
    createMessage({
      screen,
      title: 'Auto-Posted Recurring',
      message: `${autoPostCount} overdue recurring item(s) were automatically posted as transactions.`
    });
  }
}

try {
  await main();
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
