# Contributing to TitanX

Thank you for your interest in contributing to TitanX! This document provides guidelines for contributing.


## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/TitanX.git`
3. Install dependencies: `bun install`
4. Start development: `bun start`

## Development Guidelines

- **TypeScript strict mode** — no `any`, no implicit returns
- **Arco Design** components — no raw HTML interactive elements
- **UnoCSS** for styling — semantic color tokens from `uno.config.ts`
- **English** for code comments; JSDoc for public functions
- **Commit format**: `<type>(<scope>): <subject>` (feat, fix, refactor, chore, docs, test)

## Code Quality

```bash
bun run lint:fix    # Auto-fix lint issues
bun run format      # Auto-format code
bunx tsc --noEmit   # Type check
bun run test        # Run tests
```

## Architecture

- `src/process/` — Main process (Node.js, no DOM APIs)
- `src/renderer/` — Renderer process (React, no Node.js APIs)
- `src/common/` — Shared types and IPC bridge definitions

Cross-process communication goes through the IPC bridge (`src/preload.ts`).

## Pull Requests

- Branch from `main`
- Include tests for new features
- Ensure `tsc --noEmit` passes with zero errors
- Run `bun run lint:fix` and `bun run format` before submitting

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 License.
