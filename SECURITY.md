# Security Policy

## Supported Versions

This repository is a personal OpenCode configuration workspace. There are no
release versions — security updates are applied directly to `main` as
dependencies are updated.

## Reporting a Vulnerability

This is a personal configuration repository. Security issues are handled via Dependabot PRs.

If you find a vulnerability, open an [issue](https://github.com/MrJmpl3/opencode_____data_____configuration/issues).

## Dependencies

Dependencies are automatically monitored via GitHub Dependabot:

- **npm** dependencies are scanned weekly on Mondays
- Dependabot creates PRs with security patches when vulnerabilities are found
- All dependency PRs should be reviewed and merged promptly

## Security Best Practices

- No secrets, tokens, or credentials are stored in this repository
- `package-lock.json` files are kept in sync with their `package.json`
- CI-like dependency updates run through Dependabot automation
