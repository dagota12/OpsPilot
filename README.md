# OpsPilot

Local-first AI DevOps incident investigation CLI.

## Prerequisites

- **Package Manager:** [Bun](https://bun.sh/) `v1.3+` (`bun install`, `bun.lock`)
- **Runtime Environment:** [Node.js](https://nodejs.org/) `v20+` or `v24+` (Required for native C++ N-API modules like `better-sqlite3`)

## Architecture (Clean / Hexagonal)

OpsPilot decouples the investigation core from any specific AI provider, presentation layer, or Kubernetes backend:

- `src/core/models/`: Domain models (`IncidentReport`, `Evidence`, `Fact`, `Hypothesis`, `InvestigationRun`).
- `src/core/tools/`: Tool definition, execution contexts, and registry enforcing read-only constraints.
- `src/core/policy/`: Safety policy enforcing read-only verification, Zod schema validation, namespace allowlists, and output truncation limits.
- `src/core/providers/`: Normalized `AIProvider` contract, deterministic `MockAIProvider`, and `GeminiProvider` adapter.
- `src/providers/gemini.ts`: Google Gemini Adapter using `@google/genai` (maps Gemini function calling to the normalized `AIProvider` contract).
- `src/diagnostics/`: `DiagnosticBackend` interface, 3 representative mock scenarios (`crashloop-missing-env`, `oom-killed`, `failed-readiness-probe`), and 5 standard read-only diagnostic tools.
- `src/core/engine/`: Bounded investigation loop with tool-call budgets, per-tool timeouts, cooperative cancellation, and explicit termination states.
- `src/cli/`: Command-line interface with structured terminal reporting.

## Running Tests

Execute the full Vitest suite (21 automated tests covering engine loop, policy rules, timeouts, cancellation, evidence checks, and mocked Gemini adapter):

```bash
bun run typecheck && bun run test
```

> **Note:** Tests use mocked API responses. No API key or network access is required to run the test suite.

## Interactive REPL Mode

Launch the interactive investigation assistant without typing complex flags:

```bash
npx tsx src/index.ts
# or
npx tsx src/index.ts interactive
```

Features:
- **Interactive Cluster & Namespace Discovery**: Detects active contexts in `~/.kube/config` and lets you pick target namespaces with keyboard arrows.
- **Continuous Investigation Loop**: Keep asking follow-up questions about workload health without restarting the CLI.
- **Live Tool Spinners**: Visual progress showing real-time diagnostic calls (`get_pod_status`, `get_container_logs`).
- **In-Session Slash Commands**:
  - `/ns <namespace>`: Switch target namespace on the fly.
  - `/model <model>`: Switch Gemini model.
  - `/context <context>`: Switch Kubernetes cluster context.
  - `/status`: Show active session environment.
  - `/clear`: Clear the screen.
  - `/exit`: End the session.

## Gemini Provider Setup

To run live investigations with Google Gemini:

1. Obtain a Gemini API key from Google AI Studio.
2. Export the key in your shell:

```bash
export GEMINI_API_KEY="AIzaSy..."
```

3. Run an investigation specifying `--provider gemini`:

```bash
# CrashLoopBackOff scenario
npx tsx src/index.ts investigate "Why is auth-service restarting?" --provider gemini --scenario crashloop-missing-env

# OOMKilled scenario
npx tsx src/index.ts investigate "Why did image-processor terminate?" --provider gemini --scenario oom-killed

# Failed readiness probe scenario
npx tsx src/index.ts investigate "Why is payment-gateway 0/1 ready?" --provider gemini --scenario failed-readiness-probe
```

Optionally specify a custom model name with `-m` or `--model` (defaults to `gemini-2.5-flash`):

```bash
npx tsx src/index.ts investigate "Why is auth-service restarting?" --provider gemini --model gemini-3.5-flash --scenario crashloop-missing-env
```

## Live Kubernetes Cluster Investigation

To investigate actual workloads running on your local machine (`kind`, `minikube`, `k3s`, Docker Desktop, or any cluster in `~/.kube/config`):

```bash
# Inspect your default namespace on your active cluster context
npx tsx src/index.ts investigate "What is the status of pods in default namespace?" --provider gemini --backend k8s --namespace default

# Investigate an application namespace (e.g. zcinema)
npx tsx src/index.ts investigate "Are there any failing pods or migrations?" --provider gemini --backend k8s --namespace zcinema

# Target a specific cluster context
npx tsx src/index.ts investigate "Why is my service failing?" --provider gemini --backend k8s --context kind-first-cluster --namespace default
```

## Running the Mock Demo

Run an end-to-end investigation against the mock cluster environment without an API key:

```bash
bun run demo
# or
npx tsx src/index.ts investigate "Why is auth-service restarting?" --provider mock --scenario crashloop-missing-env
```

Available mock scenarios:
1. `crashloop-missing-env`: Pod in CrashLoopBackOff due to undefined `JWT_SECRET_KEY`.
2. `oom-killed`: Container terminated with exit code 137 (`OOMKilled`) exceeding 512Mi memory limit.
3. `failed-readiness-probe`: Pod unready (0/1 Ready) due to readiness probe HTTP 500 when database connection fails.
