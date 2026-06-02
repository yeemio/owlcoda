# Install OwlCoda

OwlCoda is distributed publicly through npm during the trial phase.

## Requirements

- Node.js `>= 20.19.0`; Node 22+ recommended
- macOS, Linux, or Windows
- a local OpenAI-compatible runtime or a cloud provider API key

## Install

```bash
npm install -g owlcoda
owlcoda --version
owlcoda doctor
owlcoda
```

## First Run

Fresh installs do not include maintainer model configuration.

Start Admin and configure your own provider:

```bash
owlcoda admin
```

You can use a local runtime such as Ollama, LM Studio, vLLM, or owlmlx, or a
cloud API provider that speaks an OpenAI-compatible or supported
Messages-style API.

For a local OpenAI-compatible runtime, `--endpoint` is the canonical CLI setup
flag. Use the **host base URL without a trailing `/v1`** (OwlCoda appends API
paths itself):

```bash
owlcoda init --endpoint http://127.0.0.1:11434
```

### Ollama (Windows / macOS / Linux)

1. Install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull gemma3:1b`
2. Confirm: `curl http://127.0.0.1:11434/v1/models`
3. Set `routerUrl` to `http://127.0.0.1:11434` (**not** `…/v1`) and add a model
   whose `backendModel` matches `ollama list` (e.g. `gemma3:1b`)

Example `~/.owlcoda/config.json` fragment:

```json
{
  "routerUrl": "http://127.0.0.1:11434",
  "localRuntimeProtocol": "openai_chat",
  "models": [
    {
      "id": "gemma3-1b",
      "label": "Gemma 3 1B",
      "backendModel": "gemma3:1b",
      "default": true
    }
  ]
}
```

If `owlcoda doctor` reports the local runtime unreachable but `curl` works, see
[troubleshooting.md](troubleshooting.md#ollama-local-runtime-unreachable).

## npm registry

`npm install -g owlcoda` uses your configured registry (`npm config get
registry`). Mirrors can lag behind [registry.npmjs.org](https://registry.npmjs.org);
see [troubleshooting.md](troubleshooting.md#npm-registry-mirror-lag-common-in-china).

## Upgrade

```bash
npm update -g owlcoda
npm ls -g owlcoda --depth=0
owlcoda --version
```

If an old Admin page keeps showing an older version, stop the old OwlCoda
process and rerun `owlcoda`. See [troubleshooting.md](troubleshooting.md) for
port **8019** conflicts and orphan daemons.

## macOS / Linux EACCES

If global npm install fails with `EACCES`, prefer a user-local npm prefix:

```bash
npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"
npm install -g owlcoda
```

Add the `PATH` line to your shell profile if needed.

## Windows PowerShell

```powershell
npm install -g owlcoda
where.exe owlcoda
npm ls -g owlcoda --depth=0
owlcoda --version
owlcoda doctor
owlcoda
```

Windows does not need Developer Mode or Git symlink settings for the npm
package install path.

First-run checklist:

1. `npm install -g owlcoda`
2. `owlcoda` — if you see “No usable model”, Admin should open; configure a
   cloud provider or local runtime there
3. If port **8019** is busy, see
   [troubleshooting.md](troubleshooting.md#port-8019-already-in-use)

More: [troubleshooting.md](troubleshooting.md) ·
[troubleshooting.zh.md](troubleshooting.zh.md)
