# Pulse Metric Studio interface

The React frontend owns Tableau Pulse authoring and management views.
Start with the [product README](../../README.md) for installation and connection setup.
Use the [maintainer guide](../../docs/PULSE_MAINTAINER_GUIDE.md) for architecture, feature locations, and contracts.
Use [CONTRIBUTING.md](../../CONTRIBUTING.md) for development, validation, and desktop packaging.

From the repository root, `npm run dev` starts Vite and backend watchers.
Run `npm test -w @pulse-metric-studio/web` for frontend unit tests after building shared dependencies.
Desktop development composes bundled resources instead of using those watchers.
