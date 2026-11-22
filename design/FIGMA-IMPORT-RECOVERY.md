# Figma SVG Import — Recovery Checkpoint

**Status:** source ready; Figma placement not yet verified  
**Scope:** design asset and handoff documentation only. Application source code is intentionally untouched.

## Verified GitHub source

- Repository: `bijanbijane/Audiocode`
- Default branch checkpoint before this recovery branch: `c980c3460d16c875a9c0c3d0a893ae780fdfde3d`
- Original SVG: [`design/avapardaz-wav-export-modal.svg`](./avapardaz-wav-export-modal.svg)
- SVG blob at the checkpoint: `0096373e8b74b437e496e814f0ba489f33e7fd2b`
- Canvas dimensions: 1440 × 1080
- The fetched file begins with an SVG root element and contains editable vector markup. The repository history records it as the original design asset, not a reconstructed approximation.

## Figma access diagnosis

The connected Figma identity reports a Starter team plan, the account's team role as Admin, and a **View** seat. The distinction matters: the team role does not grant canvas-edit permissions when the assigned seat is View. Code Layers being enabled does not change that seat limitation.

No Figma file URL or file key was present in the connected repository's design documentation or the current handoff context. Consequently, this checkpoint does not claim that the SVG has been imported or placed on a Figma canvas.

## Next supported import path

Once the destination Figma Design URL is available:

1. Extract and verify its file key from the URL; do not guess a destination.
2. Open a file session for that file.
3. Request one SVG upload slot through the Figma asset-upload workflow.
4. Upload the exact repository SVG bytes as `image/svg+xml`.
5. Verify that Figma created vector nodes (not a raster screenshot) and inspect the resulting canvas.
6. Record the destination URL, imported node IDs, and verification evidence here in a later commit.

The upload attempt must stop if Figma denies write access. No API workaround, seat circumvention, or claim of success is permitted. If write access is denied, the remaining requirement is a destination where the connected account has **Can edit** permission (and the appropriate editable seat if Figma requires it).

## Checkpoint evidence

| Check | Result |
|---|---|
| Original SVG exists on GitHub | PASS |
| SVG content fetched from repository | PASS |
| Figma identity and assigned seat inspected | PASS — View seat |
| Destination Design file key available in this handoff | BLOCKED — not supplied or discoverable from repository |
| SVG imported as editable Figma vectors | PENDING |
| Application code modified | NO |

## Change control

This recovery branch changes documentation only. Do not modify application code, reconstruct the SVG, or replace the original asset as part of this import-recovery task.
