# Release process

`release` is the persistent integration and publication branch. `main` receives
completed releases through PR merges only. Never push a commit directly to `main`,
modify its files with the Contents API, or bypass its protection rules.

## Events and responsibilities

| Event | Result |
| --- | --- |
| Commit/push on a feature branch without an open PR | No CI run and no package build. |
| Open, reopen, or update a PR targeting `release` | Full CI on Node 22 and 24, including native TUI rendering with the pinned Bun test dependency, build and isolated package installation. |
| Merge that PR into `release` | Automatic patch version, tag, package publication, README commit on `release`, and promotion PR. |
| Close that PR without merging | No publication. |
| Push a version tag pointing to code on `release` | Publish that exact version, without an automatic bump. |
| Push a version/README commit without a tag | No publication; automation cannot trigger itself in a loop. |
| Open/update the PR from `release` into `main` | `Release ready` validates publication and README without rebuilding the package. |
| Merge the promotion PR into `main` | Update `main` only; no new release or package build. |

## Automatic patch release

1. Create the feature branch from current `release`. Add accurate bullet points
   under `## Unreleased` in `CHANGELOG.md`; do not pre-bump the package version.
2. Open a PR into `release`. Its current revision must pass `Checks (Node 22)`
   and `Checks (Node 24)` before the maintainer accepts and merges it. CI also
   verifies that manifests agree and `Unreleased` has notes for the next patch.
3. The merged-PR workflow increments the current package's patch version. It
   updates both manifests using npm, moves `Unreleased` into the exact new version
   section, and records the source PR, merge SHA, and version in
   `.github/release-state.json` for retries.
4. The workflow commits these files on `release`, creates an annotated `vVERSION`
   tag, and pushes the branch and tag atomically. An existing tag is never moved.
5. In the same workflow run, it checks out the tag, builds the package, verifies
   its installation and checksum, and creates a draft GitHub Release. It uploads
   both assets before publishing the draft with the exact changelog notes.
   Publication does not depend on a second workflow being triggered by the bot's tag.
6. After GitHub confirms publication and uploaded assets, it returns to `release`,
   commits the versioned README block there, and opens or updates the single
   `release` → `main` PR. Publication failure never advances README or creates a PR.
7. Approve the promotion's checks and review, then use **Create a merge commit**.
   Preserve the long-lived `release` branch; do not delete it after merging.

## Manual version release

Use this path for a specific version such as `1.0.0`, including minor/major bumps.
Finish any running publication first, then update local `release`:

```bash
git switch release
git pull --ff-only origin release
```

Move the relevant unreleased notes into an exact `## 1.0.0` section and commit them.
Then create and push the version commit and tag:

```bash
git add CHANGELOG.md
git commit -m "Document release 1.0.0"
npm version 1.0.0
git push --atomic origin release v1.0.0
```

The tag workflow publishes `1.0.0` without bumping it again. Unprefixed tags such
as `1.0.0` are also accepted if created manually. The tag version must exactly
match `package.json` and both root versions in `package-lock.json`. A new release
must be newer than GitHub's latest stable release. The next automatic patch after
manual `1.0.0` is `1.0.1`.

A manual prerelease such as `1.1.0-beta.1` is published as a prerelease; it does
not replace the stable README link or open a promotion PR. It must also originate
on `release` and have its own exact changelog section.

## README and protected main

The version tag identifies the package source. The later README commit is on
`release` and enters `main` with the same promotion PR as all released code.
Consequently, the README inside the tag/archive remains a build-time snapshot.
While the PR awaits review, `main` can still show the previous stable download;
the README on `release` contains the newly published one.

The `Release ready` check requires a same-repository `release` → `main` PR. It
verifies that the PR version is published with the expected assets, that its code
matches the tag (only README may differ), and that README contains the new links.
This also prevents a pending promotion from silently accepting new, unpublished
feature commits added to `release`. It does not build another package or check
whether a tag belongs to `main`.

## Repository setup

- Create `release` once from the current `main`, then target feature PRs there.
  Bootstrap this workflow through the first feature PR into `release`.
- Protect `main`: require a PR, review of the current revision, and the
  `Release ready` status check. Apply protection to administrators as well;
  disable force pushes and deletion. Automation needs no bypass permission.
- The publisher needs `contents: write` for commits/tags on `release` and release
  assets, and `pull-requests: write` to create/update its promotion PR. If `release`
  has additional protection, it must permit the publisher's version and README
  commits. Feature changes still enter through reviewed, passing PRs.
- In **Settings → Actions → General → Workflow permissions**, enable
  **Allow GitHub Actions to create and approve pull requests**. The workflow only
  creates/updates PRs; it never approves or merges them. Keep default token
  permissions read-only; the publisher grants only its required permissions.
- GitHub may require **Approve workflows to run** on a PR created/updated with
  `GITHUB_TOKEN`. A maintainer approves those runs before review/merge. Do not
  disable the required promotion check to avoid that approval.
- Keep merge commits enabled and preserve `release` after promotion. Avoid squash
  or rebase merging the long-lived release branch into `main`.

## Concurrency and recovery

Merge one feature PR at a time and wait for publication/README/PR preparation to
finish before the next merge or manual version bump. Automatic and manual runs
share a concurrency group and never cancel a running publication. GitHub retains
only one pending run per group; several overlapping triggers can replace pending
runs. Do not use the concurrency queue as a release backlog.

The script requires the merged PR to still be the release tip when starting a new
patch. On retry it recognizes the committed PR/version record. Manual tags and
resumed runs must still match the code on `release`, allowing only a subsequent
README change. A concurrent branch change stops the run rather than overwriting
commits, including untagged code in a package, or moving an existing tag.

Use **Re-run all jobs** on the original failed Release run:

- Before the version/tag push: no remote version was created; the retry prepares it.
- After the atomic push: reuse the recorded version/tag; never bump a second time.
- During packaging/upload: rebuild from the same tag and repair assets only while
  the GitHub Release is still a draft.
- After publication: verify and reuse the published assets without overwriting or
  rebuilding them, then finish README and PR preparation.
- After the README commit or a lost PR response: reuse that commit and discover the
  existing open promotion PR before creating another one.

If a newer feature merge or manual version has already advanced `release`, an old
run may refuse to resume. Inspect the current branch and latest release before
continuing; do not reset `release` or force-move tags to make an old run succeed.
Any unresolved changes remain in Git. Draft releases are not complete publications.
If abandoning a failed, tagged version in favor of a later one, include its still
unpublished changes in the later version's changelog notes as part of the repair PR.
