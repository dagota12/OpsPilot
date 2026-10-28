# OpsPilot

Local-first AI DevOps incident investigation CLI.

## Prerequisites

- **Package Manager:** [Bun](https://bun.sh/) `v1.3+` (`bun install`, `bun.lock`)
- **Runtime Environment:** [Node.js](https://nodejs.org/) `v20+` or `v24+` (Required for native C++ N-API modules like `better-sqlite3`)

## Architecture & Design (Milestone 1)

OpsPilot adopts Hexagonal / Clean Architecture to decouple the investigation core from any specific AI provider, presentation layer, or Kubernetes backend:

- `src/core/models/`: Domain models (`IncidentReport`, `Evidence`, `Fact`, `Hypothesis`, `InvestigationRun`).
- `src/core/tools/`: Tool definition, execution contexts, and registry enforcing read-only constraints.
- `src/core/policy/`: Safety policy enforcing read-only verification, Zod schema validation, namespace allowlists, and output truncation limits.
- `src/core/providers/`: Normalized `AIProvider` contract and deterministic `MockAIProvider`.
- `src/diagnostics/`: `DiagnosticBackend` interface, 3 representative mock scenarios (`crashloop-missing-env`, `oom-killed`, `failed-readiness-probe`), and 5 standard read-only diagnostic tools.
- `src/core/engine/`: Bounded investigation loop with tool-call budgets, per-tool timeouts, and explicit termination states.
- `src/cli/`: Command-line interface with structured terminal reporting.

## Running Tests

Execute the full Vitest suite (all 9 multi-step scenario and safety tests):

```bash
bun run test
# or
bunx vitest run
```

## Running the Demo CLI

Run an end-to-end investigation against the mock cluster environment:

```bash
bun run demo
# or
npx tsx src/index.ts investigate "Why is auth-service restarting?" --scenario crashloop-missing-env
```

Available scenarios:
1. `crashloop-missing-env`: Pod in CrashLoopBackOff due to undefined `JWT_SECRET_KEY`.
2. `oom-killed`: Container terminated with exit code 137 (`OOMKilled`) exceeding 512Mi memory limit.
3. `failed-readiness-probe`: Pod unready (0/1 Ready) due to readiness probe HTTP 500 when database connection fails.
