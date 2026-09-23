# Agent Note: Codex opens a local read-only Devflow board in its browser pane

Status: implemented

## Problem

The first Codex adapter returned text from `devflow_list` but gave people no visual picture of seven stages, blocked work, or card detail. Harness's native sidebar registration is host-specific. A Codex plugin has no equivalent native right-sidebar slot for a persistent project board.

## Decision

The Codex plugin exposes `devflow_board_open`. It lazily starts a loopback HTTP server for the canonical `projectRoot` named in the tool call and caches one board per project in the MCP process. The tool returns its URL for the Codex in-app browser pane. The board calls the same `DevflowStore` to list and read active cards, refreshes while visible, and displays seven stage columns, blocked markers on the interrupted stage, title search, card body, and artifact registrations. It exposes only GET routes and serves no project file bytes. The process exits with its MCP host; a new session can obtain another URL.

The UI uses DOM text nodes for card-controlled content and ships a restrictive content security policy. The HTTP server binds `127.0.0.1` on a random port, checks the Host header, and disables caching. The board is deliberately read-only while the adapter's stage gates and human-action surface have not migrated.

## Alternatives considered

**Register a Harness sidebar page.** That API is not present in Codex. The resulting plugin could load tools but its panel would never mount.

**Add a full MCP Apps iframe first.** The standard presents UI alongside conversation and can support a rich card, but it does not grant ownership of Codex's permanent right browser area. A loopback board can be opened directly in that browser area and reads the same local workspace as the stdio server.

**Add drag-and-drop stage changes now.** This would invite transitions while server-side policies still fail closed. The board stays observational until the transition gates have been migrated.

## Consequences

People can inspect project work visually in the Codex browser pane without a separate deployment. They must open the URL once per MCP process and the page is available only while that process lives. It is not a fixed native sidebar tab or a remote ChatGPT UI. The UI can later use the same read model if a remote service or MCP Apps presentation is added.
