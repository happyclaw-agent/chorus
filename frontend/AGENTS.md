# Chorus frontend

React 19, TypeScript, Vite, React Query, Tailwind CSS, and Radix UI.

## Commands

Run inside `frontend/`:

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
```

`npm run build` writes the production bundle into `../src/chorus/static`, where
the FastAPI application serves it.

## Boundaries

- Keep API calls in `src/api/`; components should not make raw requests.
- Keep request and response types in `src/api/types.ts`.
- Use React Query for server state.
- Update MSW handlers when an API contract changes.
- Preserve the complete Chorus quality workflow and navigation.
- Keep Chorus provider-neutral: no provider-specific authentication, entity
  picker, deployment API, or proprietary trace envelope.
- Treat OTLP as the canonical trace contract. Product-specific data belongs in
  standard span/resource attributes or linked Abbrivio sidecars.
