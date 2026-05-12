# Changelog

This public changelog tracks user-facing npm releases and public-router
changes. It does not mirror private implementation history or source commits.

Runtime version truth is the installed npm package:

```bash
owlcoda --version
npm view owlcoda version
```

## [0.14.14] - 2026-05-12

Admin version-truth hotfix.

- Admin now reads its header version from the running runtime snapshot
  instead of a stale frontend build constant.
- Historical run/report package labels are presented as historical report
  package versions, not the current Admin version.
- If a browser tab still shows an older localhost Admin after upgrading,
  stop the old OwlCoda process and start `owlcoda` again.

## [0.14.13] - 2026-05-12

Trial npm distribution update.

- OwlCoda is publicly installable through npm.
- Fresh installs do not include maintainer model configuration; users configure
  their own local runtime or cloud provider in Admin.
- The public repository is now a router for install docs, issues, changelog,
  security contact, and website links rather than the product source tree.
