# Suite

Frappe app with a Vue frontend and separate realtime services.

- Prefer deep modules. For module design or refactoring, use the `improve-codebase-architecture` skill.
- Test observable behavior against independent expectations, not implementation details or assertions derived from the code under test.
- Load only context relevant to the task; don't read whole documentation trees.

## Context

- Frontend work: `frontend/AGENTS.md`. Python backend work: `suite/AGENTS.md`.
- For app behavior changes, read relevant specs under `specs/<app>/`, domain context at `suite/<app>/CONTEXT.md`, and decisions under `suite/<app>/docs/adr/`, where present.

## Draw

- Suite is Draw's only source of truth. Edit `frontend/src/apps/draw` and `suite/draw` here.
- Serve Draw only through the Suite frontend at `http://localhost:8085/draw/`.
- Keep the existing toolbar and property bar. Do not add a side panel.
- Save drawings through authenticated Frappe APIs. Use IndexedDB only for unsynced drafts.
- Use user testing for Draw. Do not run automated tests unless the user asks.

## Suite contributions

- Follow the Suite onboarding guidelines at https://md.netchamp.dev/suite-onboarding for every contribution.
- Build dependent PRs on the head of the PR they depend on. For Draw, base the branch on PR #880 and target that branch; PR #880 is based on PR #881.
