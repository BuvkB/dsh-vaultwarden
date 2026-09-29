# Third-party notices

`dsh-vaultwarden` is an independent implementation. It is not a fork of any
other project, and its source is its own.

Its design was informed by two MIT-licensed projects, credited below. Both are
included here to satisfy their license terms and to record the provenance of
the ideas that were borrowed. No source file was copied verbatim; the
implementations differ (notably: this plugin talks to the Bitwarden/Vaultwarden
REST + SignalR protocols directly, ships its own WebSocket sync engine, its own
write-back layer and its own settings panel).

---

## Jindom/dsh-bitwarden

- Source: https://github.com/Jindom/dsh-bitwarden
- License: MIT
- Referenced for: the minimal DSH credential-plugin skeleton, the system-prompt
  injection approach, and the mock-server testing methodology.

```
MIT License

Copyright (c) 2026 dsh-bitwarden contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Ox0400/dsh-vault

- Source: https://github.com/Ox0400/dsh-vault
- License: MIT
- Referenced for: `--dsw-alias-*` theme-token usage and the visual/interaction
  baseline of the settings panel.

```
MIT License

Copyright (c) 2026 Ox0400

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Bitwarden protocol references

The client implements the Bitwarden/Vaultwarden server API. For protocol
details the following upstream sources were consulted (no code copied):

- [dani-garcia/vaultwarden](https://github.com/dani-garcia/vaultwarden) — the
  server half of the API contract, especially `src/api/identity.rs` for the
  two-factor flow.
- [bitwarden/clients](https://github.com/bitwarden/clients) — the official
  client's request shapes and crypto conventions.

Bitwarden and Vaultwarden are trademarks of their respective owners. This
project is not affiliated with or endorsed by either.
