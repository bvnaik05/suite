# Suite

Frappe app with a Vue frontend and separate realtime services.

- Prefer deep modules. For module design or refactoring, use the `improve-codebase-architecture` skill.
- Test observable behavior against independent expectations, not implementation details or assertions derived from the code under test.
- Load only context relevant to the task; don't read whole documentation trees.

## Context

- Frontend work: `frontend/AGENTS.md`. Python backend work: `suite/AGENTS.md`.
- For app behavior changes, read relevant specs under `specs/<app>/`, domain context at `suite/<app>/CONTEXT.md`, and decisions under `suite/<app>/docs/adr/`, where present.

## Sheets and parallel work

- For Sheets work intended for Suite, use this monorepo. The frontend is in `frontend/src/apps/sheets` and the Frappe module is in `suite/sheets`.
- `frappe/sheets` is a separate standalone app with its own build and release path. Changes do not sync into Suite. Use it only when the task targets that app or maintainers request it.
- Keep independent app branches in separate Suite worktrees. Do not switch branches or clean a worktree with uncommitted work.
- A Bench serves the Suite checkout under its `apps/suite` directory. It does not serve another worktree. Use a second Suite Bench when both checkouts need to run at the same time.

## Local development

- In separate PowerShell terminals, start the backend and then the frontend:
  - `wsl.exe -d Ubuntu -- bash /home/bvnaik05/frappe-bench-dir/suite-bench/config/start-suite-bench.sh`
  - `wsl.exe -d Ubuntu -- bash /home/bvnaik05/frappe-bench-dir/suite-bench/config/start-suite-frontend.sh`
- Keep both terminals running and open Draw at `http://localhost:8085/draw/`.

## Draw

- Suite is Draw's only source of truth. Edit `frontend/src/apps/draw` and `suite/draw` here.
- Serve Draw only through the Suite frontend at `http://localhost:8085/draw/`.
- Keep the existing toolbar and property bar. Do not add a side panel.
- Save drawings through authenticated Frappe APIs. Use IndexedDB only for unsynced drafts.
- Use user testing for Draw. Do not run automated tests unless the user asks.

## Suite contributions

- Follow the Suite onboarding guidelines at https://md.netchamp.dev/suite-onboarding for every contribution.
- Build dependent PRs on the head of the PR they depend on. For Draw, base the branch on PR #880 and target that branch; PR #880 is based on PR #881.
