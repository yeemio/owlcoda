# Security Policy

[English](SECURITY.md) · [中文](SECURITY.zh.md)

## Supported Versions

OwlCoda is pre-1.0. Only the latest npm release receives security fixes.

| Version | Supported |
| --- | --- |
| latest npm release | yes |
| older releases | upgrade first |

Check your installed version:

```bash
owlcoda --version
npm view owlcoda version
```

## Reporting a Vulnerability

Please do **not** file a public GitHub issue for security vulnerabilities.

Email **yeemio@gmail.com** with:

- a clear description of the issue and impact
- reproduction steps or a minimal proof of concept
- the affected version from `owlcoda --version`
- your preferred disclosure timeline, if any

You should receive an acknowledgement within 72 hours.

## Scope

OwlCoda is local-first. Reports are especially useful around:

- localhost Admin/API authorization
- command/tool execution safety
- workspace boundary handling
- config and API-key handling
- session data handling under `~/.owlcoda/`
- npm package supply-chain concerns

## Out Of Scope

- Vulnerabilities in third-party local inference runtimes.
- Physical access to an unlocked developer machine.
- User-approved destructive commands where the user explicitly opted out of
  prompts or safety checks.

