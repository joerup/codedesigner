---
title: Code Design
order: 1
tags: [obsidian, mcp, design-docs]
---

# Code Design

Code Design is the review layer between Era Code and local design documents in `~/.codedesign`.

Era Code owns repository inspection, Git operations, document generation, synchronization, and Linear ticket creation.
The plugin owns selection context, transient proposals, inline review, and accepted Markdown writes.

## Data lifecycle

A proposal can span several repository files and exists only in memory while Obsidian runs.
Acceptance writes the selected change into the Markdown file.
Rejection discards the proposed change.
The plugin creates no document history or repository metadata.

## Document convention

Store one Markdown file per source repository.
Era Code must generate each file with the configured Mneme-style design-document instructions.
The stored document describes the current or intended system state.
Proposal explanations state the code-level need for semantic changes and remain outside the file.
The plugin hides the explanation row for meaning-preserving edits.

See [Protocol](./protocol.md) for the local tool contract.
