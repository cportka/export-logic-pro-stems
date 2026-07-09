<!-- BEGIN portka-standard (managed by repo-bootstrap — edit between the markers, or re-run to refresh) -->
# Portka standard workflow

Standing conventions for how Claude Code works here. Follow them for every change, without being
asked, so our back-and-forth stays on the code — not on process.

For each change you make **in this repository**:

1. **Update `main` first.** Begin by switching to `main` and pulling the latest. A previous
   change's branch being gone is the user's confirmation that they saw it (see step 5).
   *Branch-pinned session?* In a hosted/branch-pinned environment (e.g. Claude Code on the web) the
   harness assigns you a feature branch and forbids pushing to `main` — then **skip the `main`
   checkout**: commit to your assigned branch, open the PR from it, and stop at step 3; a human
   merges.
2. **Branch for everything (in this repo).** Every fix, update, or change goes on a new branch here —
   never commit to `main` directly. If another repo is open in the same session (e.g. a plugin
   marketplace you installed tools from), it is **read-only reference**: do all your branches and PRs
   on *this* repo, never on it.
3. **Tests + CI, then a PR.** Update the relevant tests, keep CI running them, and open a pull
   request. If the repo has no CI yet, add a basic workflow that runs the test suite.
4. **Green, then merge.** Wait until every check passes, then merge the PR automatically. Never
   merge on red.
5. **Hand back a short PR link.** Give the user a short link to the merged PR as confirmation. They
   delete the branch when satisfied — which you pick up next time you update `main` (step 1).

**Releasing is the user's manual step — don't tag or cut releases.** Prepare the release *in the
PR* (bump the version, update `CHANGELOG.md`), but do **not** create or push a git tag and do **not**
run `gh release` / publish a GitHub Release. Hosted/sandbox environments block tag pushes, so it
just fails. After the PR merges, the user tags the release and cuts it from the GitHub web UI.

## Reporting feedback on the tools you use

Hit a bug or rough edge in a plugin you installed (or in this standard)? **File it as a GitHub issue
on the marketplace repo the tool came from — `cportka/claude-plugins` — using the "Plugin feedback"
template.** Do **not** open a branch, commit, or PR on that repo: you don't have write access there
and it isn't how feedback is collected. One command:

```
gh issue create --repo cportka/claude-plugins --label feedback \
  --title "[feedback] <plugin>: <one-line summary>" \
  --body "What you ran, expected vs. actual, environment, and a concrete suggestion."
```

Keep *this* repo's branches and PRs about *your* code; route tool feedback to the marketplace's
issue tracker, where it gets triaged into a fix and a new version.

## Versioning — SemVer (enforced)

Versions follow [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH` — **MAJOR** for
breaking changes, **MINOR** for backward-compatible features, **PATCH** for backward-compatible
fixes. Keep one source of truth and the other places in agreement, and bump the right part:

- the **version source of truth** — your project manifest (`package.json` / `pyproject.toml` /
  `Cargo.toml`), or a bare `VERSION` file if the repo has no manifest.
- `CHANGELOG.md` — a section for each released version (Keep a Changelog).
- `README.md` — a `**Version:**` line, if you keep one, that matches.

`tests/run-tests.sh` checks the version is valid SemVer and that these agree; CI runs it on every
push/PR, so they can't drift.
<!-- END portka-standard -->
