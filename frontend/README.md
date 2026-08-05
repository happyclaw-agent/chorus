# Chorus quality UI

This is Chorus's React, TypeScript, and Vite frontend. It preserves the full
Project Runway quality workflow—Agent Groups, Traces, Lookbooks, Runway,
Monitor, and Sources—while reading generic OpenTelemetry traces and Abbrivio
sidecars from the standalone Chorus API.

## Development

```bash
npm install
npm run dev       # Vite development server on http://127.0.0.1:5173
npm test          # Vitest suite
npm run lint
npm run build     # embeds the production bundle in ../src/chorus/static
```

Run the Chorus API separately from the repository root:

```bash
uv run chorus --data-dir .chorus --port 8010
```

Vite proxies `/api` and `/v1/traces` to the local Chorus server. The production
bundle is served directly by Chorus.

OTLP remains the canonical trace format. The UI is a projection over the OTLP
store and linked Abbrivio sidecars; it does not require a particular model
provider, eval framework, agent runtime, or deployment platform.
