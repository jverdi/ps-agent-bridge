# Docs Publishing and Domain (Internal)

Goal: publish docs automatically from this repo and serve them at:

- `https://agent-bridge-for-photoshop.jaredverdi.com`

## Automation model

- Use Mintlify GitHub integration for deployment automation.
- Ongoing auto-publish on pushes to the connected branch (typically `main`).
- GitHub Actions CI (`docs-validate`) blocks bad docs/links before publish.

## Validation before push

Run locally:

```bash
npm run docs:validate
```

CI runs:

- `mint validate`
- `mint broken-links`
