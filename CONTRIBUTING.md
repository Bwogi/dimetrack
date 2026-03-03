# Contributing to DimeTrack

Thanks for your interest in improving DimeTrack.

## Ways to contribute

- Bug reports and reproducible issues
- Documentation improvements
- UI/UX improvements (Web UI and TUI)
- Feature work (reports, categories, exports)
- Refactors and test coverage

## Development setup

1. Install dependencies

```bash
npm install
```

2. Start the web server

```bash
npm run dev
```

Then open:

- http://localhost:3000

## Terminal UI (TUI)

```bash
npm run tui
```

## CLI

```bash
npm run cli
```

## Data

- The app stores data in a local SQLite database (`data.db`).
- `data.db` is ignored by git (see `.gitignore`).

## Pull request guidelines

- Keep PRs focused (one feature/fix per PR)
- Include a clear description of the change
- Add screenshots/recordings for UI changes when possible
- Avoid committing personal databases (`*.db`) or `node_modules/`

## Code style

- JavaScript (ESM)
- Prefer small functions and clear naming
- Don’t introduce large new dependencies without discussion

## Reporting security issues

If you believe you’ve found a security issue, please open a GitHub issue with minimal details and note that it is security-related.
