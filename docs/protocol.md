---
title: Local MCP Protocol
order: 2
tags: [api, mcp]
---

# Local MCP Protocol

The desktop plugin serves Streamable HTTP MCP at `http://127.0.0.1:27123/mcp` by default.
It does not listen on external interfaces.

> [!WARNING]
> The first release trusts local processes and does not authenticate MCP clients.
> Do not expose the port through a proxy or bind it to another interface.

## `get_selection`

Call this tool for every request that refers to “this,” highlighted text, the selection, or the focused proposal in Obsidian.
Never reuse a selection from an earlier turn.

The result identifies one of these contexts:

- `document`: selected Markdown text, its vault path, and its editor range.
- `proposal_explanation`: selected rationale associated with a pending change.
- `proposed_change`: the focused red and green change.
- `none`: no relevant selection exists.

## `propose_changes`

Submit one file-scoped review transaction containing one or more non-overlapping changes.
The request contains one Markdown filename, its complete-document SHA-256 hash, and its changes.
Change identifiers must be unique within the proposal.
Each edit includes stable character offsets, exact original text, replacement text, and an explanation field.
A semantic change explains its code-level necessity.
A meaning-preserving clarity or formatting edit uses an empty explanation, which the interface does not render.
An explanation never enters the saved document.

The request includes the SHA-256 hash of the complete source document.
The plugin rejects approval when the file hash or anchored source text no longer matches.
For a new repository document, submit the SHA-256 hash of an empty string and anchor additions at offset zero.
The plugin creates and opens the empty Markdown file so the user can review its proposed content.

The plugin returns a proposal identifier immediately.
Use `proposal_status` when Era Code needs the final proposal decision.
Use `update_proposal` to revise unresolved changes, including their replacement text, explanation, or source range.
An anchor revision supplies `from`, `to`, and `before` together and cannot overlap another change.
The update preserves the proposal identifier.
A resolved proposal cannot be revised.

## Review behavior

The editor shows deleted text in red with a strike-through.
It shows added text in green at the replacement location.
The user accepts or rejects the complete file-scoped proposal from the bottom banner.
The plugin opens the proposal file when a proposal arrives.
The user controls change navigation with the previous and next controls.
While the proposal remains pending, a bottom banner shows its change count and file.
Accept and Reject resolve the complete proposal from the center of this banner.
Its previous and next controls cycle through the proposed changes in that file.
Both controls return to the same change when only one remains.

Each non-empty technical explanation appears inline below its related change.

The document outline appears in the unused left gutter when at least 180 pixels are available.
It uses the full gutter width and truncates headings only at the gutter boundary.
It shows the document filename above the heading links.
Selecting the filename sets the document scroller to its absolute top.
It preserves Markdown heading depth and scrolls to a heading when selected.
Each deeper heading uses a larger left indent.
Backtick spans use monospace, double-star and double-underscore spans use bold, and double-tilde spans use strikethrough.
Single-star and boundary-delimited single-underscore spans use italics.
The outline and its links use transparent backgrounds.
The outline measures the visible top edge during CodeMirror's layout cycle and highlights the preceding heading.
It activates a selected heading immediately and uses a 40-pixel threshold during manual scrolling.
Before the first heading, the outline highlights the page title.
The outline hides instead of covering document text when the pane is narrow.
The Markdown view toolbar includes a button that shows or hides the outline.
The plugin remembers this visibility setting across restarts.

Accepted changes update the Markdown file through Obsidian's vault API.
Rejected changes do not modify the file.
