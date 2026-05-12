# Troubleshooting

## `owlcoda` still shows an old version

A stale daemon or old global install may still be on your PATH.

```bash
npm update -g owlcoda
npm ls -g owlcoda --depth=0
owlcoda --version
```

Then stop any old OwlCoda process and start `owlcoda` again.

## Admin opens but no model is configured

Fresh installs do not include maintainer model configuration. Open Admin and
configure your own local runtime or cloud provider:

```bash
owlcoda admin
```

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

