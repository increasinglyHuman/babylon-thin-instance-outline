# Publishing @poqpoq/babylon-thin-instance-outline

Releases are published by `.github/workflows/publish.yml` using npm
**trusted publishing** (OIDC). There is no npm token in this repo or in GitHub
secrets, and the published package carries a provenance attestation.

## Releasing

1. Bump `version` in `package.json` (and the changelog), merge to `main`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The workflow checks the tag equals `v` + package.json version, runs the
   checks, and runs `npm publish --provenance --access public`.

## One-time setup (maintainer, manual)

1. npmjs.com -> `@poqpoq/babylon-thin-instance-outline` -> **Settings** -> **Trusted Publisher** -> **GitHub Actions**:
   - Organization or user: `increasinglyHuman`
   - Repository: `babylon-thin-instance-outline`
   - Workflow filename: `publish.yml`
   - Environment: (leave empty)
2. Cut one release through the workflow and confirm it publishes with provenance.
3. Then, on the same Settings page, set publishing access to
   **Require two-factor authentication and disallow tokens**.
4. Revoke the old npm automation/publish tokens (npmjs.com -> Access Tokens),
   and delete any `NPM_TOKEN` secrets in GitHub.
