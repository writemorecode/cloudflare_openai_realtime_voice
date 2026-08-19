# Vendored fix-webm-duration

This directory contains the parser and duration-fixing source from
[fix-webm-duration](https://github.com/yusitnikov/fix-webm-duration), vendored from upstream commit
`7bbd85d3d42e29f3c0f7225588cf1b553309550b` under the MIT license in `LICENSE`.

Applied upstream change:

- PR [#28](https://github.com/yusitnikov/fix-webm-duration/pull/28), commit
  `9124d811ef9eff237903227e2cbf425075d8a5b9`: parse section data with `Uint8Array.subarray()`
  instead of copying it with `slice()`.

Local adaptations:

- Package imports use relative paths, and unused package entry barrels are omitted.
- Float parsing uses `DataView` rather than reversing section bytes in place. This is required after
  PR #28 because parsed sections are views into the original recording buffer.
- Parser failures return the original Blob and are reported when a logger is provided.
- Source formatting follows this repository's formatter.
- The demo and React viewer packages are not included.
