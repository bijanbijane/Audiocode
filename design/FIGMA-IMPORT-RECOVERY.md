# Figma SVG Import — Recovery Checkpoint

**Status:** destination Draft created; original SVG is ready; vector placement is still pending  
**Scope:** design asset and handoff documentation only. Application source code is intentionally untouched.

## Verified GitHub source

- Repository: `bijanbijane/Audiocode`
- Default branch checkpoint before this recovery branch: `c980c3460d16c875a9c0c3d0a893ae780fdfde3d`
- Original SVG: [`design/avapardaz-wav-export-modal.svg`](./avapardaz-wav-export-modal.svg)
- Original SVG blob: `0096373e8b74b437e496e814f0ba489f33e7fd2b`
- Canvas dimensions: 1440 × 1080
- The local upload candidate was verified as valid SVG XML and its Git blob hash matched the original repository blob exactly. No reconstruction or re-export was used.

## Figma destination created

A new Design file was successfully created in the connected account's Starter Drafts:

- File: **AvaPardaz — WAV Export Modal (Editable SVG)**
- URL: https://www.figma.com/design/VBRAGgIuuFvEFGgTJ2qKCF
- File key: `VBRAGgIuuFvEFGgTJ2qKCF`
- A Figma file session was created for this target.

This confirms that the destination exists. It does **not** mean the SVG has been placed in the file.

## Figma access and rate-limit diagnosis

The connected identity reports a Starter plan, Admin team role, and a View seat. Admin is a team-management role; it does not, by itself, grant edit access to shared team Design files. Starter Drafts are the supported private workspace for creating and iterating on one's own designs.

The Figma MCP server then returned this explicit error on the native vector-import attempt:

`You've reached the Figma MCP tool call limit on the Starter plan.`

The connected identity was rechecked with `whoami`; the plan and View seat remain unchanged. Figma's current MCP rate-limit documentation says Starter accounts receive up to 20 read-tool calls per month, while Full/Dev seats on paid plans receive higher limits. It also says the Starter allowance follows the plan's monthly cycle and that creating a new file does not reset the account-level allowance. See:
- https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/
- https://help.figma.com/hc/en-us/articles/39252411778583-Figma-MCP-server-FAQs

## Import attempts and outcome

1. `upload_assets` accepted the Draft file key and returned a one-time SVG upload URL. That URL requires a POST of the source bytes as `image/svg+xml` and expires after 10 minutes.
2. The runtime environment could not resolve `mcp.figma.com` when posting the file (DNS resolution failure). No successful upload response was received.
3. A native `use_figma` import using the exact SVG string was attempted. Figma refused the call with the Starter MCP tool-call-limit error before the script executed.
4. No vector nodes or canvas screenshot were returned, so import remains unverified and is not claimed as complete.

## Next supported paths

**Automated path:** resume after the Figma MCP monthly allowance becomes available, or after upgrading to a plan/seat with higher MCP limits. Reuse the exact file key above and the original SVG blob. Do not create more duplicate drafts.

**Immediate manual fallback:** open the Draft URL above and import the original SVG from this repository using Figma's canvas import/drag-and-drop. Figma documents that imported SVG files are converted into editable vector layers rather than remaining raster images:
https://help.figma.com/hc/en-us/articles/360040028034-Add-images-and-videos-to-designs

After import, verify the layer tree contains vector nodes and visually confirm the full 1440 × 1080 composition. Record the resulting node ID(s) and a screenshot or other direct evidence here.

## Checkpoint evidence

| Check | Result |
|---|---|
| Original SVG exists on GitHub | PASS |
| Local SVG XML validation | PASS |
| Local SVG Git blob hash matches original | PASS — exact blob SHA |
| Figma Starter Draft created | PASS |
| Figma file session created | PASS |
| SVG upload slot requested | PASS |
| SVG bytes posted to Figma | BLOCKED — runtime DNS failure |
| Native vector import via Figma MCP | BLOCKED — Starter MCP tool-call limit |
| SVG present as editable vectors in destination | PENDING — not verified |
| Application code modified | NO |

## Change control

This recovery branch changes design handoff documentation only. Do not modify application code, reconstruct the SVG, or replace the original asset as part of this import-recovery task.
