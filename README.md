# DimeTrack

Local-first revenue + expense tracker built with Node.js, Express, and SQLite.

DimeTrack is intentionally simple: your data lives in a local SQLite database (`data.db`) and you can manage it through a web UI, a terminal UI (TUI), or a CLI.

## Features

- **Transactions**: track income and expenses with category, note, and date.
- **Recurring items**: track rent/subscriptions/paychecks and “post” them into transactions.
- **Goals**: set payoff goals and track progress.
- **PDF reports**: export transactions as a PDF.
- **Multiple interfaces**:
  - Web UI (Express + EJS)
  - TUI (Blessed)
  - CLI

## Screens / Interfaces

- **Web UI**: great for day-to-day usage.
- **TUI**: `npm run tui` (terminal-first workflow).
- **CLI**: `npm run cli` (scripting / quick checks).

## Quickstart

### Requirements

- Node.js (LTS recommended)

### Install

```bash
npm install
```

### Run the web app

```bash
npm start
```

Then open:

- http://localhost:3000

### Run the TUI

```bash
npm run tui
```

### Run the CLI

```bash
npm run cli
```

## PDF Reports

Download a transactions report PDF:

- `GET /reports/transactions.pdf`

Optional date-range parameters:

- `/reports/transactions.pdf?start=YYYY-MM-DD&end=YYYY-MM-DD`

If `start`/`end` aren’t provided, the report defaults to the current month.

## Data & Storage

- The SQLite database lives at `data.db` in the project directory.
- This repo’s `.gitignore` ignores `*.db` so your personal data doesn’t get committed.

## Project Structure

- `server.js`: Express web app (routes + rendering)
- `db.js`: SQLite schema + shared DB helpers
- `views/`: EJS templates
- `tui.js`: terminal UI
- `cli.js`: command-line interface

## Roadmap

- Add report exports for recurring items and goals
- Better category management UI
- Import/export (CSV)
- Automated tests

## Contributing

Contributions are welcome — especially:

- Bug fixes
- UI/UX improvements
- New report formats (PDF/CSV)
- Test coverage
- Docs improvements

If you’re looking for a place to start:

1. Open an issue describing what you want to change
2. Submit a PR with a clear description and screenshots/notes when relevant

See `CONTRIBUTING.md` for dev workflow and guidelines.

## License

MIT License. See `LICENSE`.
