# omp-hub-cli

Manage [omp](https://omp.sh) ("oh my pi") coding agent profiles: provider, model(s), thinking level, API token, and base URL — switched at launch, exactly like [pi-hub](https://github.com/sherocktong/pi-hub) does for pi and [cc-hub](https://github.com/sherocktong/cc-hub) does for Claude Code.

## Install

```bash
npm install -g omp-hub-cli
# or from source:
npm link
```

Requires the `omp` CLI on your PATH (see https://omp.sh) and Node.js >= 18.

## Quick start

```bash
# Add a profile (provider id from `omp` — e.g. kimi-code, anthropic, openai)
omp-hub profile add work -p anthropic -m claude-sonnet-4-6 -t "$ANTHROPIC_API_KEY" --thinking high

# Kimi Code subscription: provider kimi-code, model k3, no URL needed
# (omp-hub passes the token via omp's --api-key flag; env vars don't work there)
omp-hub profile add kimi -p kimi-code -m k3 -t "$KIMI_TOKEN"
# Multiple models (max 3): the first is the default
omp-hub profile add oss -p anthropic -m claude-sonnet-4-6 -m claude-haiku-4-5 -t "$ANTHROPIC_API_KEY"

# A profile pointing at a custom base URL (works for ANY provider)
omp-hub profile add px -p kimi -m kimi-k2.7-code -t "$TOKEN" -u https://proxy.example.com/coding

# Make it the default
omp-hub use work          # or: omp-hub profile default work

# Launch omp with a profile
omp-hub run work
omp-hub run               # default profile
omp-hub run work -p "explain this repo"   # extra args pass through to omp
omp-hub run --built-in    # plain omp with your existing ~/.omp/agent config
```

## How it works

`omp` has no `--base-url` flag, and most providers (e.g. `kimi`) have no `*_BASE_URL` env var. So instead of a flag, `omp-hub run`:

1. Materializes an isolated omp config dir at `~/.omp/omp-hub/profiles/<name>/`:
   - `config.yml` — your current `~/.omp/agent/config.yml` with `defaultProvider` / `defaultModel` / `defaultThinkingLevel` overridden by the profile (a legacy `settings.json` is used as the source if you migrated from pi)
   - `models.yml` — `providers.<provider>.baseUrl` override (only when the profile has a URL; this is omp's documented mechanism and works even for built-in providers)
   - symlinks to your shared `extensions/`, `skills/`, `plugins/`, `sessions/`, `AGENTS.md`
2. Injects the profile's API token for the effective provider — either as `<PROVIDER>_API_KEY` (e.g. `ANTHROPIC_API_KEY`, `KIMI_API_KEY`; unknown providers get the normalized `<PROVIDER>_API_KEY` form), or, for OAuth-first providers that ignore env vars (`kimi-code`), as omp's `--api-key <token> --model <model>` launch flags. omp v18 stores credentials in the agent dir's `agent.db`, which a fresh profile dir doesn't have — so env-var keys are honoured.
3. Launches `omp` with `PI_CODING_AGENT_DIR` pointing at that dir. omp's built-in `--profile` / `OMP_PROFILE` / `PI_PROFILE` mechanisms are stripped from the child env so they can't fight the hub-managed isolation.

Consequences:

- **Sessions stay shared** — everything omp writes to `sessions/` lands in your real `~/.omp/agent/sessions/`, whichever profile you run.
- **Extensions/skills stay live** — they're symlinks, not copies, and are refreshed on every run.
- **No credential shadowing** — each profile dir has its own (initially empty) credential store, so the injected profile token is the only auth source. If you run `omp` `/login` inside a profile session, that profile keeps its own logged-in credentials afterwards.
- `omp-hub run --built-in` (or default = `__builtin__`) unsets `PI_CODING_AGENT_DIR` and runs plain `omp` against your existing config — zero interference.

> **Note:** omp-hub profiles are independent of omp's own built-in `--profile` feature (which stores state under `~/.omp/profiles/`). omp-hub uses its own layout under `~/.omp/omp-hub/` and never touches native profile dirs.

## Commands

### `omp-hub profile`

| Subcommand | Description |
|---|---|
| `add <name>` | Add or update a profile. Options: `-p/--provider`, `-m/--model` (repeatable, max 3), `-t/--token`, `-u/--url`, `--thinking`, `--set key=value` (repeatable), `--unset key` (repeatable) |
| `update <name>` | Update an existing profile. Same options plus `-d/--delete-model` (repeatable) |
| `list` | Table of profiles (`*` marks the default; tokens masked) |
| `view <name>` | Full details, token unmasked. `-j/--json` for machine output |
| `remove <name>` | Remove profile + its materialized dir |
| `rename <old> <new>` | Rename profile + its materialized dir |
| `default [name]` | Set default profile (`--built-in` for your existing omp config) |

Thinking levels: `off | minimal | low | medium | high | xhigh | max | auto`.

### `omp-hub use [name] [--built-in]`

Alias for `omp-hub profile default`.

### `omp-hub run [name] [args...]`

Launches `omp`. The first argument matching a profile name selects it; otherwise the default profile is used and all argument pass through to `omp`.

## Profiles file

`~/.omp/profiles.json` (mode 0600):

```json
{
  "profiles": {
    "work": {
      "provider": "kimi-code",
      "model": "kimi-for-coding",
      "models": ["kimi-for-coding"],
      "thinking": "high",
      "token": "sk-...",
      "url": "https://proxy.example.com/coding",
      "settings": {
        "theme": "dark",
        "someGlobalHook": null
      }
    }
  },
  "default": "work"
}
```

`"default": "__builtin__"` means "no profile — run plain omp".

### Per-profile config overrides

A profile's `config.yml` starts as a copy of your source `~/.omp/agent/config.yml` at first materialization. On later runs the profile's **existing** `config.yml` wins over a fresh source read for every key it already has — that's deliberate: omp persists runtime state there (`theme`, `modelThinkingLevels`, …) and it must survive re-materialization. Consequences:

- Source edits to keys a profile already has do **not** propagate; brand-new source keys do. To re-sync a profile with the source, delete its dir (`rm -rf ~/.omp/omp-hub/profiles/<name>`) — it re-materializes on the next run.
- To change a profile's settings, use `--set`/`--unset` (or the `settings` key in `profiles.json`) — these re-apply on every run and beat the profile's stored copy:

```bash
omp-hub profile update work --set theme=dark --set 'maxTokens=8192' --set someGlobalHook=null
```

- Values are parsed as JSON when possible (`true`, `8192`, `"quoted"`, `{...}`), otherwise kept as strings.
- Merged shallowly over the source agent config; the `provider`/`model`/`thinking` fields still win for their own keys.
- A `null` value **deletes** the key from the materialized `config.yml` — the way to drop a global setting for one profile.

## Config path overrides

| Path | Default | Env override |
|---|---|---|
| Profiles file | `~/.omp/profiles.json` | `OMP_HUB_PROFILES_FILE` |
| omp dir | `~/.omp` | `OMP_HUB_OMP_DIR` |
| Source agent dir | `~/.omp/agent` | `PI_CODING_AGENT_DIR` (same variable omp itself uses) |
| omp-hub state | `~/.omp/omp-hub/` | `OMP_HUB_DIR` |

## Shell completion

```bash
omp-hub completion zsh > "${fpath[1]}/_omp-hub"   # zsh
omp-hub completion bash > /etc/bash_completion.d/omp-hub   # bash
```

## Logging

Logs go to `~/.omp/omp-hub/logs/omp-hub-YYYY-MM-DD.log`. Default level is `INFO`; pass `--verbose` or set `OMP_HUB_LOG_LEVEL=DEBUG`.

## Development

```bash
npm install
npm test          # vitest (unit + integration, incl. fake-omp runner tests)
npm run build     # tsup → dist/index.js
npm link          # install locally
```

A bundled omp skill for natural-language profile management lives in [`skills/omp-hub/SKILL.md`](skills/omp-hub/SKILL.md).

## License

MIT
