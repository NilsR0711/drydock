# ADR 013: Server-side directory picker

- **Status:** accepted
- **Date:** 2026-05-27

## Context

Adding a repo requires an absolute local path. Typing it by hand is error-prone,
but a browser cannot return a real filesystem path: the File System Access API
(`showDirectoryPicker`) yields an opaque handle, not a path usable as a
subprocess `cwd`.

## Decision

Provide a server-backed picker. `browseDirectory(target?)` (node:fs) lists the
immediate subdirectories of a path (default: home dir), skipping hidden folders
and unreadable entries, and flags which are git repos (`.git` present). It is
exposed via the `browseDirectoryAction` Server Action and driven by a
`DirectoryPicker` client dialog that navigates folder-by-folder. The browse
helper is server-only; the client computes a suggested name from the basename
inline so node:fs never enters the client bundle.

## Consequences

- Real absolute paths without manual typing; git repos are visually marked.
- No native OS dialog (browser limitation) — navigation is in-app.
- Filesystem browsing is acceptable for a localhost single-user tool; it is read
  -only and tolerates permission errors gracefully.
