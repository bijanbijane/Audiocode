# SHAHAB-027 Persian RTL & Mixed-Script Layout Specification

- Supports `PLAIN_UNICODE_LOGICAL`, `RLM_ANCHORED`, and `ISOLATE_FSI_PDI` (wraps Latin runs in `\u2068...\u2069` with RLM anchor).
- Guarantees reversibility (`reversibleCleanTextVerified`): stripping directional marks restores exact logical Persian string.
- Checks unbalanced parentheses/brackets and preserves configurable Persian/Western numeral policies.
