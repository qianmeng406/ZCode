# WSL Agent Benchmark CLI Spec (Phase 1)

Status: approved phase-1 implementation scope. Owner: benchmark scripts under `scripts/` + this spec.

## Goal

Provide a dependency-free Node >= 24 CLI that measures raw execution latency of
short shell commands, workspace git/rg commands, and (optionally) the public
ZCode exec adapter, identically usable from Windows (Git Bash) and Linux
(incl. WSL). The output JSON is the only contract between this tool and later
analysis; the main thread runs real benchmarks and owns isolation copies,
dependency preparation, and interpretation.

## Non-goals / honesty boundary

- WSL boundary measurement (Windows invoking `wsl.exe` to run an empty bash,
  Linux workspace cwd, no WSL shutdown so first observed sample is not labeled
  cold-boot) is owned by the main thread's separate
  `scripts/bench-wsl-boundary.mjs`; this CLI intentionally does not duplicate
  it. Both tools share `scripts/lib/bench-agent-linux-stats.mjs` for stats.

- Shell-native timings (`mode: "spawn shell directly"`) are **not** a
  full-agent measurement. Every result carries `method` and a fixed
  `methodCaveat` string stating this. Analysis must not compare shell-native
  numbers against full agent runs without this caveat.
- The tool never prints or persists `process.env` values. Metadata contains
  only: platform, node version of the CLI itself, explicitly passed binary
  paths, shell path, workspace path, samples counts, timestamps.
- Non-zero exit codes are **failures**, never counted as passing samples.
  Timed-out / cancelled / spawn-error runs are excluded from stats and
  reported in a `failures` list.

## Files (single allowed file set)

- `docs/research/wsl-agent-benchmark.spec.md` (this file)
- `scripts/bench-agent-linux.mjs` — CLI entry (arg orchestration, run loop, JSON emit)
- `scripts/lib/bench-agent-linux-args.mjs` — parsing + validation
- `scripts/lib/bench-agent-linux-stats.mjs` — statistics (pure)
- `scripts/lib/bench-agent-linux-probes.mjs` — scenario definitions, shell spawn and correctness checks
- `scripts/lib/bench-agent-linux-adapter.mjs` — public adapter import, request construction, adapter scenarios and probes
- `scripts/bench-wsl-boundary.mjs` / `scripts/test/bench-wsl-boundary.test.mjs` — Windows-to-WSL wrapper benchmark and argument tests
- `scripts/test/bench-agent-linux.test.mjs` — node:test coverage

Each module stays < 400 lines. No runtime npm dependencies.

## CLI

```
node scripts/bench-agent-linux.mjs \
  --workspace <absolute dir> \
  --output <absolute dir> \
  --shell <explicit bash path>            # win: S:/Git/usr/bin/bash.exe, linux: /bin/bash
  [--adapter-module <absolute path>]      # @zcode/adapters/exec dist/index.js public entry
  [--node <path>] [--git <path>] [--rg <path>]
  [--samples-short 30] [--samples-workspace 5]
  [--task-command-file <absolute JSON path>]
```

Validation (exit code 2 on invalid args, message on stderr, no stack):

- `--workspace`, `--output` required and must be absolute; workspace must
  exist and be a directory. Output dir is created if missing.
- `--shell` required; must be an absolute path to an existing file.
- `--samples-short`, `--samples-workspace` integers 1..1000.
- `--task-command-file` must exist, parse as JSON array of
  `{name: string, file: string, args?: string[], cwd?: string, env?: Record<string,string>}`;
  `file` must be absolute; task `cwd` defaults to workspace. `env` is passed
  to spawn (merged over `process.env` for that child only) but is never
  serialized into the result JSON.
- `--adapter-module` optional; when set it must be an absolute path. The
  module is imported with `pathToFileURL(...)` through the public
  `@zcode/adapters/exec` dist entry or an experiment bundle built from its
  public source entry. The experiment owner records provenance and hashes;
  the tool never reaches into source-internal files of other packages.
  Import failure is reported as `adapter.importError`, **recorded in
  `failures` and makes the CLI exit 1** —
  explicitly requesting the adapter and failing to load it is an error, not a
  skip. When `--adapter-module` is NOT specified, adapter scenarios are
  reported as `skipped` and no failure is recorded; shell scenarios always
  run regardless.

## Semantics

### Spawn

- Asynchronous spawn (`child_process.spawn`), per-run timeout (default
  60000 ms; probes may pass shorter explicit timeouts), kill process on
  timeout, record `timedOut`/`cancelled` explicitly.
- Shell scenarios: `bash --noprofile --norc -c <script>` (no-profile) and
  `bash -l -c <script>` (login) — both are measured as separate scenario
  variants. `login` uses the same explicit `--shell` path. Shell quoting uses
  a POSIX single-quote helper, never `JSON.stringify`.
- Timing uses `performance.now()` around the awaited operation (sub-ms
  resolution); `Date.now` (1 ms granularity) under-counts fast Linux runs.
- Task-file scenarios: direct argv spawn of `{file, args}` with task `cwd` and
  optional env overlay; never routed through the shell.

### Scenarios and correctness

Short scenarios run once for warmup, then the configured measured batch,
then one unmeasured correctness/fingerprint probe. The first measured sample
is additionally recorded as `firstSample`.

| id                 | script                       | correctness            |
| ------------------ | ---------------------------- | ---------------------- |
| `noop`             | `:`                          | exit 0                 |
| `printf-marker`    | `printf marker`              | stdout === `marker`    |
| `printf-pipe-grep` | `printf 'a\nb\nc' \| grep b` | trimmed stdout === `b` |

Each short scenario runs under both `no-profile` and `login` shell variants.

Workspace scenarios (cwd = workspace, samples from `--samples-workspace`):

| id                     | command                                                                                                                            | correctness                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `git-status-porcelain` | `git status --porcelain --untracked-files=normal`                                                                                  | exit 0                      |
| `git-ls-files`         | `git ls-files`                                                                                                                     | exit 0 and non-empty output |
| `rg-tracked-sources`   | `rg <fixed pattern> <fixed tracked source files>`                                                                                  | exit 0                      |
| `rg-large-dirs`        | `rg -l "export" packages/rpc/src apps/zcode-cli/packages/adapters/src packages/shared/src` (fixed dirs + pattern, no hidden files) | exit 0                      |

Every workspace scenario records the exact `script` string plus
`stdoutHash` (sha256) and `stdoutBytes` in its stats entry for cross-side
comparison. The experiment owner must verify input bytes across workspaces;
`core.autocrlf=false` alone does not prove an existing checkout was rewritten.
This run uses a Git archive rewrite plus index renormalization and a complete
tracked-file SHA-256 manifest. Search output ordering can differ, so canonical
line comparison is recorded separately from the raw output fingerprints.
`git-status-porcelain` additionally asserts empty stdout (clean repo);
non-empty output is a correctness failure.

Fixed input for `rg`: tracked source files (`git ls-files '*.ts'`-style, plus
a source-extension filter on `git ls-files` output) become the fixed file
list; the pattern is fixed (`import|export` chosen so tracked source files
match); the file list and an output hash are recorded. If fewer than 1
tracked source file exists, the scenario is reported as `skipped` with
reason. Non-zero rg exit (including "no matches") is a failure, not a pass.

Adapter scenarios (only when `--adapter-module` imports successfully; use
`createNodeExecutionAdapter` / `NodeExecutionAdapter` public export):

- `createNodeExecutionAdapter` is a **factory**: the module import yields the
  factory function, so the port instance is created as
  `createNodeExecutionAdapter({ outputRootDir: <run temp dir>, processEnv: process.env })`
  so adapter output files never land in the shared `~/.zcode`.
- `port.run(request, options)` timing uses `performance.now()` around the
  awaited `run` — it must include the adapter's prepare/snapshot/persist work,
  not trust `result.durationMs` alone. The first real run (after zero
  warmups) is recorded as `firstSample` = the cold-init sample; subsequent
  measured runs form the hot samples. No post-warmup batch may be labeled
  "cold-init".
- Each `run` gets a **fresh request object** (never reused across calls) with
  `trace: { sessionId: "bench", attributes: { toolCallId: <unique> } }` —
  reusing a request can hit adapter-internal caching of output paths.
  `timeoutMs` belongs on the `ExecutionRequest`, not the run options.
- Correctness: stdout for the marker command must equal `marker`;
  `resolvedCwd` must equal the workspace on success. Probe results that are
  incorrect are pushed into `failures`. The port is closed in `finally`.

- Options: `outputRootDir` = dedicated temp dir under output, platform/env
  default. Requests use `mode: "shell"`, `command.shellProfile: "posix-bash"`,
  `command.shellOverride` = `{ id: "bench", path: <shell>, dialect: <git-bash
on win32 else posix>, source: "auto-detected", display: { name: "bash" } }`,
  `cwd` = workspace, `outputLimit: { persistOutput: "always" }`,
  `captureCwdAfterSuccess: true`, unique per-run `trace` as described above.
- `adapter-cold-init` (`:` command): exactly **1** run, no warmups; that run's
  timing is the only sample (`n = 1`, reported via `firstSample`). Reports
  must quote this single cold sample, never mix it into a 30-sample median.
- `adapter-hot-run`: additional measured samples of `:` and a small-output
  command (`printf marker`), each with its own fresh request.
- Probes — implemented strictly against the read contract, each recorded with
  its observed correctness, never invented:
  - `probe-timeout`: `sleep 5` with `timeoutMs: 200`; expect
    `timedOut === true` / status `timed_out`.
  - `probe-cancel`: start `sleep 5` via `run` with an `AbortSignal` aborted
    after 200 ms; expect `cancelled === true`.
  - `probe-background`: if `start`, `getBackgroundTask` and
    `cancelBackgroundTask` exist on the port, start `sleep 5`, poll
    `getBackgroundTask` once, then `cancelBackgroundTask`; record the
    observed snapshot status transitions. If any method is missing the probe
    is `skipped` with the missing method name — no guessing.
  - Probe failures (wrong observed state) are recorded as probe `correct: false`
    entries **and pushed into `failures`, which makes the CLI exit 1** — a
    lying probe is a real failure, not a warning.

Task-file scenarios (`--task-command-file`): each entry runs 3 samples
(warmup 1). Correctness: exit 0. Stats computed per entry. `env` values and
`process.env` never appear in the JSON.

### Statistics

Per scenario/variant: `samples` (raw ms array, measured runs only), `n`,
`median`, `min`, `max`, `mean` (1 decimal), `p95` **only when n >= 20**
(omitted otherwise), `firstSample` (first measured run after warmups; adapter
cold-init has no warmup). Shell/task scenarios run one unmeasured warmup;
adapter hot scenarios follow the cold-init call. Warmup count is a protocol
rule, not a serialized field. Pure function in
`scripts/lib/bench-agent-linux-stats.mjs`; unit-tested.

### Output

- JSON written to `<output>/bench-agent-linux-result.json` (pretty, 2-space).
- Shape:

```jsonc
{
  "schema": "bench-agent-linux/v1",
  "method": "shell-native-spawn+task-file-spawn",
  // adapter.scenarios is timed separately; method is a legacy shell/task label.
  "methodCaveat": "shell-native timings are not full agent measurements",
  "startedAt": "ISO", "finishedAt": "ISO",
  "platform": { "platform": "win32|linux", "nodeVersion": "v24.x", "arch": "..." },
  "binaries": { "shell": "...", "node": "...", "git": "...", "rg": "..." },
  "workspace": "/abs/path",
  "samples": {
    "short": { "<scenarioId>": { "<variant>": { ...stats } } },
    "workspace": { "<scenarioId>": { "no-profile": { ...stats } } }
  },
  "adapter": { "module": "...", "imported": true, "importError": null, "probes": [...] },
  "taskCommands": { "<name>": { ...stats } },
  "failures": [ { "scenario": "...", "variant": "...", "kind": "nonzero-exit|timeout|cancelled|spawn-error|correctness", "detail": "..." } ],
  "tempDir": "/abs/output/.bench-agent-linux-tmp-<pid>-<ts>"
}
```

- Temp files (adapter `outputRootDir`, fixed-input cache) live in a dedicated
  sibling directory of the output JSON: `<output>/.bench-agent-linux-tmp-<pid>-<ts>`.
  Cleanup removes **only that directory** (created this run), never siblings.
  When the adapter persisted output artifacts into it, the directory is
  **kept** and its path is recorded in the result JSON (`tempDir`) for
  cross-side comparison; an empty temp dir is removed and `tempDir` is null.
- Exit code: 0 only when `failures` is empty (all executed scenarios passed;
  skipped scenarios without `--adapter-module` / unavailable rg are not
  failures); exit 1 if any failure is recorded (including adapter import
  failure, probe `correct: false`, truncated output); exit 2 for arg errors.

### Secrets hygiene

No env printing, no env serialization, metadata whitelist as above. Test
asserts a planted env sentinel never appears in the output JSON.

## Tests (`node --test scripts/test/bench-agent-linux.test.mjs`)

1. Args: missing/relative workspace-output, bad samples, non-absolute shell
   path, invalid task-command JSON shapes.
2. Stats: median/min/max/mean, p95 presence at n>=20 and absence below,
   firstSample passthrough, failures excluded.
3. Task-command parsing: valid file loads, env overlay accepted, env values
   never serialized.
4. End-to-end (real run): tiny temp git workspace, real `--shell`
   (platform bash), `--samples-short 2 --samples-workspace 1`, assert JSON
   schema fields, correctness pass, failures empty, planted env sentinel
   absent, temp dir removed.

## Verification commands

```
node --test scripts/test/bench-agent-linux.test.mjs
node scripts/bench-agent-linux.mjs --workspace <abs> --output <abs> --shell <bash> --samples-short 2 --samples-workspace 1
```

## Known limitations

- Adapter import through `dist/exec/index.js` requires the workspace's
  runtime dependency state to be prepared (built dist, resolvable
  `@zcode/shared` etc.). When `--adapter-module` is explicitly passed and the
  import fails, the CLI records `adapter.importError` and a `failures` entry, then exits
  1; dependency preparation is owned by the main thread, not this CLI.
- Windows Git Bash login mode (`-l`) sources profile files; their cost is
  part of the measured value by design.
- p95 needs n >= 20; smaller samples only report median/min/max/mean.
