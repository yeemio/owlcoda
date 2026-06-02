# Troubleshooting

## First run: “No usable model is configured yet”

Fresh installs do not include maintainer model configuration. This message is
expected until you add a provider.

Recommended order:

1. `npm install -g owlcoda`
2. `owlcoda` (or `owlcoda admin`) — Admin opens so you can add a **cloud
   provider** or **local runtime**
3. Optional: `owlcoda init --endpoint http://127.0.0.1:11434` if you already
   have a local OpenAI-compatible endpoint (host base URL, **no** trailing `/v1`)

```bash
owlcoda admin
owlcoda doctor
```

## `owlcoda` still shows an old version

A stale daemon, an outdated npm registry mirror, or an old global install may
be involved.

```bash
npm config get registry
npm update -g owlcoda
npm ls -g owlcoda --depth=0
owlcoda --version
```

Then stop any old OwlCoda process and start `owlcoda` again.

### npm registry mirror lag (common in China)

If you use a mirror such as `https://registry.npmmirror.com`, its `latest` tag
for `owlcoda` can lag behind [registry.npmjs.org](https://registry.npmjs.org)
by hours or days.

Check what your registry reports:

```bash
npm config get registry
npm view owlcoda version
npm view owlcoda version --registry https://registry.npmjs.org
```

To install or upgrade from the official registry once:

```bash
npm install -g owlcoda@latest --registry https://registry.npmjs.org
```

To switch permanently:

```bash
npm config set registry https://registry.npmjs.org
```

## Port 8019 already in use

Default OwlCoda proxy/admin listens on `http://127.0.0.1:8019`.

### Check what owns the port

**Windows (PowerShell):**

```powershell
Get-NetTCPConnection -LocalPort 8019 | Select-Object OwningProcess
Get-Process -Id <pid> | Select-Object Id, ProcessName, Path
```

**macOS / Linux:**

```bash
lsof -i :8019
# or: ss -ltnp 'sport = :8019'
```

If the process command line includes `owlcoda` and `cli.js server`, it is a
**stale OwlCoda daemon**, not a random application — even when the CLI says
“non-OwlCoda process”.

### Stop OwlCoda cleanly

```bash
owlcoda stop
owlcoda stop --force
```

If `owlcoda stop` reports “not running” but port 8019 is still listening, the
daemon is an **orphan** (no PID file). End the process by PID, then start
again:

**Windows:**

```powershell
taskkill /PID <pid> /F
```

**macOS / Linux:**

```bash
kill <pid>
# if needed: kill -9 <pid>
```

Verify the port is free, then run `owlcoda` again.

### Confirm it is OwlCoda (optional)

```bash
curl -s http://127.0.0.1:8019/healthz
```

A JSON body with `"version"` and `"runtimeToken"` indicates an OwlCoda daemon.

## Admin opens but no model is configured

Same as [first run](#first-run-no-usable-model-is-configured-yet). Open Admin
and configure your own local runtime or cloud provider:

```bash
owlcoda admin
```

For a local OpenAI-compatible runtime:

```bash
owlcoda init --endpoint http://127.0.0.1:11434
```

## Ollama: local runtime “unreachable” but `curl` works

**Symptoms:**

- Ollama is running; `curl http://127.0.0.1:11434/v1/models` returns your models
- `owlcoda doctor` / Admin says local runtime unreachable, or `models: []` after setup

**Common causes:**

1. **`routerUrl` includes `/v1`** — e.g. `http://127.0.0.1:11434/v1`. OwlCoda
   probes `${routerUrl}/v1/models`, which becomes `…/v1/v1/models` (404).
   **Fix:** set `routerUrl` to `http://127.0.0.1:11434` (no `/v1` suffix).

2. **No model entries in `config.json`** — Admin may set the runtime URL but leave
   `models` empty. Add at least one model with `backendModel` equal to the exact
   id from `ollama list` (e.g. `gemma3:1b`).

**Verify:**

```bash
owlcoda doctor
owlcoda models
```

## Clean reinstall (global npm package)

To remove user state and reinstall:

```bash
# 1. Stop daemon if possible
owlcoda stop --force

# 2. Kill orphan on 8019 if still listening (see above)

# 3. Uninstall global CLI
npm uninstall -g owlcoda

# 4. Remove user profile (models, sessions, config)
#    macOS / Linux: rm -rf ~/.owlcoda
#    Windows:       Remove-Item -Recurse -Force $env:USERPROFILE\.owlcoda

# 5. Reinstall
npm install -g owlcoda
owlcoda doctor
owlcoda
```

Deleting only a cloned source folder under `D:\AI\owlcoda` does **not**
remove the global `npm` install or `~/.owlcoda` / `%USERPROFILE%\.owlcoda`.

## `npm install -g owlcoda` fails with `EACCES`

Use a user-local npm prefix:

```bash
npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"
npm install -g owlcoda
```

## Security issue

Do not open a public issue for security vulnerabilities. See
[SECURITY.md](../SECURITY.md).

## Product feedback (daemon messages, Windows UX)

This public repository accepts **documentation** pull requests. Runtime
behavior changes (for example clearer orphan-daemon detection or improved port
conflict messages) are tracked via
[GitHub Issues](https://github.com/yeemio/owlcoda/issues). Please include
`owlcoda --version`, OS, terminal, and `npm config get registry` in reports.
