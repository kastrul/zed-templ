---
name: templ-release
description: Bump the extension version or the pinned tree-sitter-templ grammar commit.
disable-model-invocation: true
---

# Templ Release

Each value lives in two files. Keep both in sync.

| Value | Files |
| --- | --- |
| Extension version | `Cargo.toml` `version`, `extension.toml` `version` |
| Grammar commit | `extension.toml` `[grammars.templ]` `commit`, `grammars/templ.toml` `commit` |

`Cargo.lock` is gitignored, so it needs no commit.

`grammars/templ.toml` is tracked but sits inside the gitignored `grammars/` directory. Stage it with `git add -u grammars/templ.toml`, because plain `git add` reports an ignored-path error and exits 1.

## Steps

1. Update the values in both files.
2. If the grammar commit changed, check out the same commit in `grammars/templ/` and run the checks in the `templ-syntax-change` skill.
3. Run `cargo check` and `node --test tests/`.
4. Commit with the message `Bump version to X.Y.Z` when the user asks for a commit.
