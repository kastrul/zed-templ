---
name: templ-release
description: Bump the extension version or the pinned tree-sitter-templ grammar commit.
disable-model-invocation: true
---

# Templ Release

| Value | Files |
| --- | --- |
| Extension version | `Cargo.toml` `version`, `extension.toml` `version` |
| Grammar commit | `extension.toml` `[grammars.templ]` `commit` |

A version bump also changes `Cargo.lock` when `cargo check` runs. Commit it with the bump, because CI builds with `--locked`.

## Steps

1. Update the values. Keep both version files in sync.
2. If the grammar commit changed, check out the same commit in `grammars/templ/` and run the checks in the `templ-syntax-change` skill.
3. Run `cargo check`, `cargo test`, and `node --test tests/`.
4. Commit with the message `Bump version to X.Y.Z` when the user asks for a commit.
