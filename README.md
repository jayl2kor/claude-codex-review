# Claude-Codex Review Loop for cmux

A small hook-based workflow for running Claude Code and Codex side by side inside
cmux: one agent works, the other reviews, and the loop repeats until `PASS`.

## 📖 Documentation / 문서

Read the full README in your language:

- **[English](docs/i18n/README.en.md)** (default)
- **[한국어](docs/i18n/README.ko.md)**

## Quick start

```sh
npm i -g https://github.com/jayl2kor/claude-codex-review/releases/download/v0.1.0/claude-codex-review-0.1.0.tgz
```

A global install runs the setup automatically. If it was skipped (CI, or `bun`
not yet installed), finish with `ccr install`. To track the latest commit on
`master` instead of a pinned release, use
`npm i -g github:jayl2kor/claude-codex-review`.

See [English](docs/i18n/README.en.md) · [한국어](docs/i18n/README.ko.md) for setup,
daily use, the full command reference, configuration, and troubleshooting.
