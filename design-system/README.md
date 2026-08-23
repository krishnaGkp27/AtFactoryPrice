# AtFactoryPrice design system (DSN-1)

Component kit for the claude.ai/design design-system project, chosen by
the owner 23-Aug-2026 as the design↔code bridge: designs are staged and
refined visually in Claude Design, GitHub stays the source of truth, and
DesignSync moves components between the two one at a time.

Two visual families, both extracted from SHIPPED pages, not invented:

- **Site family** — css/tokens.css (`--afp-*`): red #D8262C brand, warm
  ink/paper neutrals, Inter + JetBrains Mono, ok/warn/crit semantics.
- **Ledger family** — the SLG-1 supply-ledger web page's dark registry:
  #0d0d0f ground, #d4af5f gold, green quantities, the owner's
  hand-drawn Date|Particular|Debit|Credit|Balance grid.

Cards in this kit (first-line `@dsCard` markers name their group):
Foundations (_tokens, _type) · Ledger (supply table with the Option B
reserved money columns; finance table — the §15b instance with the grid
filled; header/net strip) · Components (pills, buttons).

## Sync workflow

1. Authorization is interactive: run a LOCAL Claude Code session and
   `/design-login`, or use Claude Design's "Send to Claude Code Web".
2. Then, in any authorized session: DesignSync list_projects →
   create/pick "AtFactoryPrice" → finalize_plan (writes:
   `design-system/**`) → write_files with these paths.
3. Owner refines in Claude Design; changed components come back via
   get_file, one component at a time — never a wholesale replace —
   and land here as a normal reviewed commit.

Rules that bind any finance-ledger design work: BUSINESS_RULES §15b
(customer money renders on the website, fed from the authoritative
ledger; the bot only decides), §12/Option B (the supply ledger's money
columns stay empty), §15 (the web DISPLAYS; Telegram DECIDES — no write
endpoints).
