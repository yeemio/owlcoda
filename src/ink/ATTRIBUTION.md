# Ink Fork Attribution

The `src/ink/` directory in OwlCoda is a fork of the upstream
[Ink](https://github.com/vadimdemedes/ink) terminal-UI library. OwlCoda
extends Ink with ScrollBox / viewport-culling / sticky-scroll primitives
needed by the native REPL, but the underlying reconciler, layout,
renderer, DOM, event, and component code remain derivative of upstream
Ink.

The original MIT license is reproduced below as required by its terms.
This file is also copied into `dist/ink/ATTRIBUTION.md` at build time so
the attribution travels with every published copy of the fork.

---

```
MIT License

Copyright (c) Vadim Demedes <vadimdemedes@hey.com> (vadimdemedes.com)

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```
