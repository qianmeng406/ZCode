# ZCode (Personal Fork)

> **This repository is a community fork / secondary development of the official ZCode open-source project. It is NOT an official release.**
>
> This project has **no affiliation, sponsorship, partnership, or endorsement** from Z.ai, Zhipu, or the official ZCode team. See [Fork notice](#fork-notice) and [Disclaimer](#disclaimer) below. For the full documentation, see the Chinese [README.md](README.md).

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>
<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

This repository is a personal customization of ZCode, an AI coding workspace with desktop, browser, and terminal interfaces. It contains the clients, backend services, shared UI, and Agent CLI and runtime source code.

## Upstream Version and Sync Status

- **2026-10-21**: Added goal controls (pause/resume, deleting the current goal, and continuing from a specific iteration), per-subagent stop, and moved prompt-optimizer/review settings into the Settings page; the session execution environment can now use the WSL distribution's default user and shows the active environment in the composer.
- **2026-10-16**: Updated to ZCode v3.16.1.
- 2026-10-16: Added three session-experience features: **upstream model fetching** (the add-model dialog pulls model IDs from the provider's `/models` endpoint into a searchable picker), a **compact-context button** in the context usage panel (one click triggers the existing `/compact` flow), and a **composer main-turn metrics capsule** (persistent TTFT, generation speed, and output tokens below the input box, counting main-turn requests only); produced a new `ZCode Preview` installer.
- 2026-10-15: Added **Beta mode** (prompt-fusion mode test version), then revised it into an independent work mode (minimal-mode entry removed; Beta uses full-access permissions) and produced a new `ZCode Preview` installer (`dist-new/`; the running old instance is untouched).
- 2026-10-13: Migrated the Myzcode customizations onto this repository, based on official v3.15.1.
- 2026-10-10: Updated to ZCode v3.15.1.
- 2026-9-23: Updated to ZCode v3.14.3.

- **Latest official source**: As of 2026-10-20, official `main` points to [the v3.16.1 commit `0a1fc56d`](https://github.com/zai-org/ZCode/commit/0a1fc56d279fd1001f78387bd81aec1c26767411) (Source-Commit `1f4d7f01`). Upstream does not tag v3.16.1; it is published from `main`.
- **This fork's upstream baseline**: This repository is based on the official v3.16.1 commit `0a1fc56d`; the root `package.json` version is `3.16.1`. The customizations are applied as a series of commits on top of the official baseline (migration plus later feature commits); see [docs/upstream-sync.md](docs/upstream-sync.md) for the follow-up sync workflow.
- **Official documentation**: [Chinese README](https://github.com/zai-org/ZCode/blob/main/README.md), [English README](https://github.com/zai-org/ZCode/blob/main/README.en.md), and [UI Plugin development guide](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/UI_PLUGIN.en.md). Features, directories, and commands in newer official versions may not exist in this fork. Use the checked-out source and `package.json` as the source of truth.

## Fork Customizations

This fork adds dual-model review (Oracle), execution-model selection during plan approval, turn navigation, goal controls, per-subagent stop, permission modes, prompt optimization, and a per-session WSL execution environment. See [README.md](README.md) for details.

**Beta mode (prompt-fusion mode test version)** is an independent, mutually exclusive work mode (`mode=beta`) in the composer menu, alongside the confirmation, autonomous, research, and full-access modes. It combines progress within authorization, minimal complete changes, purposeful delegation, and evidence-based verification while retaining skills, memory, and project instructions. It uses full-access permissions with fewer confirmations. Plan remains an independent switch (read-only while on); selecting another work mode exits Beta. See the [Beta mode specification](apps/zcode-cli/docs/design/v2/loop/fusion-context-profile.md).

**Upstream model fetching** lets the add-model dialog pull model IDs from the current provider's OpenAI-compatible `/models` endpoint into a searchable picker. Selecting an entry only fills the draft; saving still requires confirmation. Built-in official account providers are explicitly unsupported, and failures keep manual input intact. Credentials never cross the protocol boundary, and errors are reported as redacted categories.

**Compact-context button** adds a one-click action inside the context usage panel that triggers the existing `/compact` flow. It is disabled while a compaction is already running or the session cannot accept input; no second compaction protocol is introduced.

**Composer main-turn metrics capsule** persistently shows the latest main-turn (`main_turn`) request's time to first token, generation speed (tok/s), and output tokens below the input box. Subagents, compaction, and title generation never affect the metrics; missing facts render an `--` placeholder instead of an estimate. Specifications live in [docs/features/](docs/features/).

**Goal controls** add pause/resume, deletion of the current goal, and "continue from this iteration" to the goal panel. A running goal cannot be deleted; continuing a historical iteration restarts the goal with that iteration's title, and pause/resume retries a bounded number of times when the snapshot revision is stale instead of silently doing nothing.

**Per-subagent stop** lets foreground subagents be stopped individually from the status panel. The action appears only for rows that resolve to a background handle or runtime task id; rows explicitly marked non-cancellable stay disabled.

**Settings consolidation** moves the prompt optimizer (model, reasoning level, optimization method, and context range) and the review model into the Settings page. The composer keeps only the optimize, standard-review, and deep-review actions, and the previous locally stored model selection is migrated once.

**Session execution environment** can run a single chat session in a local WSL distribution while the project files remain the same files on disk. The WSL user is optional: leaving it empty uses the distribution's default user without changing the system-wide default, and the composer/header shows the currently effective environment.

These customizations are described relative to the official v3.16.1 baseline, not as a claim of exclusive features. Later official versions may offer similar capabilities.

The development and packaging instructions below describe this fork's current commands, including its runtime asset preparation changes; they are not a complete mirror of the latest official README.

## Setup

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) is the source of truth for tool versions. Run all development and packaging commands below from the repository root.

```bash
pnpm bootstrap
```

`pnpm bootstrap` installs workspace dependencies, prepares local desktop runtime assets, and runs `build:bootstrap`.

The Agent CLI and runtime source code lives in [apps/zcode-cli/](apps/zcode-cli/) as a regular directory included when you clone this repository. No separate checkout or Git submodule initialization is required.

Additional setup and build commands:

| Command                            | Purpose                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                     | Install dependencies                                                                                                                |
| `pnpm prepare:desktop-runtime`     | Prepare desktop runtime assets, including remote assets by default                                                                  |
| `pnpm prepare:remote-assets`       | Prepare remote runtime assets separately                                                                                            |
| `pnpm prepare:local-remote-assets` | Trim `mock-cdn` into the platform assets that ship inside the installer (`resources/remote-assets`)                                 |
| `pnpm bootstrap:with-remote`       | Set up dependencies and local and remote assets, then build the relevant packages sequentially; skip the desktop application bundle |
| `pnpm build`                       | Recursively run each workspace package's build script, including its asset preparation steps                                        |

The default `bootstrap` skips remote asset preparation and is suitable for local desktop development. Run the corresponding preparation command when working with remote workspaces or validating remote distribution assets.

Packaged builds do not need a CDN: SSH/WSL remote runtime assets (server bundle, Node runtime, agent runtime, search tools) are trimmed to the target platforms and shipped inside the installer, then uploaded over SFTP at deploy time. `ZCODE_REMOTE_ASSET_LOCAL_DIR` overrides the bundled directory at runtime; `ZCODE_SKIP_LOCAL_REMOTE_ASSETS=1` skips bundling them. The opt-in "download on remote server" mode pulls official ZCode artifacts from `cdn-zcode.z.ai` by default (official artifacts do not include this fork's remote changes, so resident mode is unavailable and rejected in that mode). End-to-end verification: `npx tsx packages/server/scripts/remote-local-assets-check.ts --wsl`.

## Development and Usage

### Desktop

```bash
pnpm dev:desktop

# Use the test environment
pnpm dev:desktop:test
```

`pnpm dev:desktop` defaults to `pnpm dev:desktop:prod` and uses production service configuration. The startup script prepares local runtime assets, builds the desktop Agent, then starts Electron and source watchers.

Set `ZCODE_DATA_BASE_DIR` to use a separate development data directory. For example, on macOS / Linux:

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

### Web Development

Use development mode when editing Web or backend source code:

```bash
pnpm dev:web

# Set the backend workspace (macOS / Linux)
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

This starts both the Web development server (default: `http://localhost:5173`) and the backend (default: `http://localhost:3030`). Open the Web development server in your browser. `/ws` and general `/api` requests are proxied to the local backend; `/api/v1/oauth/token` is proxied separately to the configured product service.

After changing Agent source code, run `pnpm --filter @zcode/cli... build` and restart the service. To validate the complete distribution, extract and run it as described under Packaging → ZCode CLI distribution below.

### ZCode CLI distribution

The command-line distribution includes the TUI, Web client, and Agent behind one `zcode` command. With no arguments it starts the TUI; a leading `--web` starts Web mode; all other arguments go to the existing Agent CLI. Both modes run locally without Electron.

```bash
# Start the terminal UI by default
zcode

# Start the Web interface
zcode --web

# Set the project and port without opening a browser automatically
zcode --web --workspace /path/to/project --port 3030 --no-open

# Show CLI or Web options
zcode --help
zcode --web --help
```

In Web mode, it uses the current directory as the workspace, listens on `127.0.0.1` without token authentication by default, selects an available port, and opens a browser. Use the URL printed in the terminal and press `Ctrl+C` to stop the service. For LAN access, use `--host 0.0.0.0`; listening on a non-local address generates an access token by default. Use the token-bearing URL printed in the terminal. Set a token with `--token`, or disable token authentication with `--no-token`.

When starting the general Web service's HTTP entry directly, configure API/WebSocket authentication with `ZCODE_SERVER_AUTH_TOKEN`. When creating the service programmatically, use the `authToken` option.

See Packaging below for build instructions. `pnpm build:zcode` only creates the distribution; it does not replace an existing `zcode` on `PATH`. If the command still points to an older installation or another checkout, check it with `command -v zcode` on macOS / Linux or `where.exe zcode` on Windows.

### CLI Source Development

See the [CLI usage guide (Chinese)](apps/zcode-cli/docs/usage/README.md) for model configuration, non-interactive runs, tools and extensions, batch evaluation, and trajectory capture.

Use the source entry when developing the TUI or Agent:

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# Build the CLI and its workspace dependencies
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

This entry runs the Agent CLI directly and does not handle the distribution's `--web` switch. Use `pnpm dev:web` for Web development, or the extracted `bin/zcode.mjs` shown below to test the unified command.

### UI Plugin development

See the [UI Plugin guide](UI_PLUGIN.en.md) for the Excalidraw workflow, supported APIs, plugin installation and updates, and host debugging.

**Plugin PRs in `zcode-plugins` must declare whether they affect a UI Plugin and list the plugin names in the PR template.** See the [required plugin-type declaration](UI_PLUGIN.en.md#declare-the-plugin-type-in-pull-requests).

## Configuration

The root [.env.example](.env.example) provides sample service URLs and build configuration. Copy it to `.env` as needed and place local overrides in `.env.local`. Select the Desktop development environment with `dev:desktop:test` or `dev:desktop:prod`.

| Setting                              | Purpose                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `ZCODE_DATA_BASE_DIR`                | Base directory for application data, stored under its `.zcode/` subdirectory            |
| `ZCODE_SERVER_WORKSPACE`             | Workspace path for the Web backend                                                      |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Path to a local provider configuration file; uses the built-in configuration when unset |
| `ZCODE_DIST_BASE_URL`                | Download base URL used by the CLI distribution installer                                |

Runtime variables can be set explicitly in the environment of the startup command. See [config/README.md](config/README.md) for the default configuration shipped with the client.

## Packaging

See [third-party/README.md](third-party/README.md) for notice generation, distribution checks, and where the notices are included in each distribution.

### Desktop

```bash
pnpm bundle:desktop

# Set the target platform and CPU architecture
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

The default target is macOS arm64, and the default output directory is `packages/desktop/dist/`. `--os` accepts `mac`, `win`, or `linux`; `--arch` accepts `x64` or `arm64`. Packaging and signing require the tools and configuration for the target platform.

### ZCode CLI distribution

Run `pnpm build:zcode` to build the CLI/TUI, backend, and Web client, collect the TUI native libraries, workers, and runtime dependencies, then assemble the distribution. Running the distribution still requires Node.js; use the version specified in `mise.toml`.

Before packaging, set the download base URL with `ZCODE_DIST_BASE_URL` in `.env`, `.env.local`, or the process environment, or pass it through `--base-url`. The URL below is a placeholder; replace it with your hosting URL when publishing:

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# When ZCODE_DIST_BASE_URL is already configured
pnpm build:zcode

# Repackage existing Agent, backend, and Web build outputs
pnpm build:zcode --skip-build

# Show options for the version, output directory, and more
pnpm build:zcode --help
```

The version defaults to the root `package.json` version. Output is written to `dist/zcode/`:

- `releases/<version>/zcode-<version>.tar.gz`: runtime package.
- `releases/<version>/sha256.txt`: checksum file.
- `latest.json` and `install.sh`: version index and installer.

Upload the entire directory to the configured download base URL. The installer downloads the runtime package from that URL, installs it to `~/.zcode/runtime` by default, and creates the `zcode` command in `~/.local/bin`. Override these directories with `ZCODE_DIST_HOME` and `ZCODE_DIST_BIN_DIR`, respectively.

Existing Lite users should switch to the new build command, environment variables, and installer. Installation does not remove old Lite directories or migrate/delete session data.

To test a packaged build locally, extract and run it directly without uploading or installing it:

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# Start the TUI by default
node dist/zcode/debug/zcode/bin/zcode.mjs

# Start Web mode
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

Open `http://127.0.0.1:3030` to validate the complete flow, with one backend serving the Web pages and running the Agent. The port must be available; if `pnpm dev:web` is already running, choose another `--port`.

## Repository Structure

The following lists this fork's main directories, not the complete latest upstream source tree. Fork additions are identified relative to the v3.16.1 baseline.

| Directory                                            | Responsibility                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/desktop`                                   | Electron Main, Host, Renderer, and desktop packaging                                    |
| `packages/web`                                       | Web client                                                                              |
| `packages/server`                                    | HTTP / WebSocket services and remote connections                                        |
| `packages/zcode-server-cli`                          | Standalone server startup and process management                                        |
| `packages/ui`                                        | Shared React components, hooks, and Zustand state                                       |
| `packages/services`                                  | Business services and persistence                                                       |
| `packages/shared`, `packages/rpc`, `packages/client` | Shared protocols and types, RPC framework, and Agent client SDK                         |
| `packages/provider`, `packages/provider-node`        | Common provider capabilities and Node implementations                                   |
| `apps/zcode-cli`                                     | Agent CLI, TUI, runtime, and tools                                                      |
| `scripts`, `config`, `third-party`                   | Build and maintenance scripts, built-in configuration, and third-party notice materials |

## Fork notice

1. **Origin**: This project is a secondary development (fork) of the open-source [zai-org/ZCode](https://github.com/zai-org/ZCode) repository, under the upstream Apache-2.0 license. Copyright in the original upstream code, documentation, and assets belongs to their respective authors and the zai-org/ZCode project.
2. **Not official**: This project is maintained by an individual. It is **not** an official product and has **no affiliation, sponsorship, partnership, or endorsement** from Z.ai, Zhipu, or the official ZCode team. Any installer or bundle produced from this repository is not an official release.
3. **Scope of changes**: On top of upstream, this fork adds a user-managed model channel and dual-model turn review, among other changes. Feature details are documented in the Chinese [README.md](README.md).
4. **Protocols and compatibility**: This project does **not** copy official minified code, does **not** connect to the official private relay or account backend, and does **not** claim protocol compatibility or official certification. Do not describe this project as an official release or an official partner product.
5. **Names and marks**: The "ZCode" name and logo appear here only to indicate the code's origin and purpose. They do not imply official authorization.

## Disclaimer

1. **No warranty**: This project is provided "AS IS", without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, and non-infringement. The authors are not liable for any direct or indirect damages arising from the use of, or inability to use, this project (including data loss, service interruption, device damage, or lost profits).
2. **Use at your own risk**: This fork includes capabilities that can perform side-effecting actions on the ZCode instance running on your computer (creating tasks, sending input, stopping execution, resolving approvals, and so on). Assess the risks first, use it only on **your own devices** and in environments where you have **lawful authorization**, and keep credentials secure. You are responsible for the consequences of misuse, misconfiguration, or credential leakage.
3. **No data collection**: This project provides no official backend service and the authors collect no data from you.
4. **Lawful use**: You are responsible for ensuring your use complies with applicable laws and regulations, the upstream project's terms, and the terms of any third-party services (model providers, cloud providers, etc.). Using this project for unauthorized intrusion, surveillance, data theft, or any other illegal purpose is **strictly prohibited**.
5. **Models and costs**: This project may call third-party model services. Accounts, quotas, costs, and content compliance are your own responsibility; no official keys or quota are bundled with this repository.
6. **Relationship with upstream**: This fork may lag behind upstream, may contain changes not merged upstream or already removed upstream, and may contain defects. Do not hold the upstream project or the official team responsible for problems in this fork.
7. **No maintenance commitment**: The authors make no commitment to ongoing maintenance, timely fixes, or long-term compatibility with any upstream version.

> If you do not agree with any of the terms above, stop using this project and delete all copies immediately.

## Project Notice

See [NOTICE.md](NOTICE.md) for feature and promotion scope, maintenance policy, execution and data risks, licensing, and third-party copyright information (inherited from upstream).
