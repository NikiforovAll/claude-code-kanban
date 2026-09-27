---
description: Bump version, tag, push, and create a GitHub release with auto-generated notes
argument-hint: "[version e.g. 1.13.0 or rc4]"
---

# Release

Create a new release for this project.

## Inputs

- `$ARGUMENTS` — target version or shorthand. Examples:
  - `1.13.0` — full version
  - `rc4` — shorthand for next RC (e.g. if current is `1.19.0-rc.3`, becomes `1.19.0-rc.4`)
  - If not provided, ask the user.

## Steps

1. **Determine version**: Use `$ARGUMENTS` or ask user. Handle `rc<N>` shorthand by reading current version from `package.json` and replacing/appending the RC suffix. Validate it's different from the current version.

2. **Detect prerelease**: If version contains `-rc.`, `-alpha.`, `-beta.`, treat as prerelease.

3. **Check working tree**: Run `git status`. If there are uncommitted changes, warn the user and stop.

4. **Bump version**:
   ```
   npm version <version> --no-git-tag-version
   ```

5. **Commit & push** (push to current branch, not hardcoded `main`):
   ```
   git add package.json package-lock.json
   git commit -m "🔖 chore: Bump version to <version>"
   git push origin HEAD
   ```

6. **Tag & push tag**:
   ```
   git tag v<version>
   git push origin v<version>
   ```

7. **Generate release notes**: Collect commits since the previous tag using `git log --oneline <prev-tag>..HEAD`. Write a **user-facing summary** grouped by:
   - Features (✨) — describe what was added, not raw commit messages
   - Fixes (🐛)
   - Other notable changes
   Include a "Full Changelog" compare link at the bottom.

8. **Create GitHub release** (add `--prerelease` flag for RC/alpha/beta):
   ```
   gh release create v<version> --title "v<version>" --notes "<notes>" [--prerelease]
   ```

9. **Watch the publish**: The tag push starts `.github/workflows/release.yml`, which publishes to npm through trusted publishing (a version with `-` goes to the `rc` dist-tag) and then deploys the docs site for a stable version. Nobody runs `npm publish` locally.
   ```
   gh run list --workflow release.yml --limit 1
   gh run watch <run-id> --exit-status
   ```
   If a run fails, fix the cause, then run it again from the tag: `gh workflow run release.yml --ref v<version>`. The publish step skips a version that is already on the registry.

10. **Report**: Show the release URL, the workflow run URL, and the published npm version.
