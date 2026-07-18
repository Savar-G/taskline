# Contributing

Bug reports and focused pull requests are welcome.

## Develop Locally

1. Fork and clone the repository.
2. Install dependencies with `npm ci`.
3. Run `npm test`.
4. Run `npm run build`.
5. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/vault-tasks/` to test in Obsidian.

Keep task parsing and write logic in pure modules where possible. Add a regression test for every behavior change. Do not include real vault content, personal paths, credentials, or generated `data.json` settings in commits.
