# SHAHAB–Avapardaz Integration Test Report (SHAHAB-023)

- **Status:** `VERIFIED` (5/5 passed)
- **AVP-MEDIA-TIMELINE-01 (Non-Destructive Media Input & Flick/Sample Timeline Mapping)**: PASS — hashUnchanged=true, srcSamples=[16000,96000), timelineStartSec=10
- **AVP-TIMESTRETCH-01 (Playback-Rate & Time-Stretch Honest Mapping Guard)**: PASS — status=MAPPING_UNAVAILABLE_TIME_STRETCHED
- **AVP-EDITOR-AUTH-01 (User Edit Protection, Reversible Layers & P0-009/010/012 Authority)**: PASS — editProtected=true, rawPreserved=true
- **AVP-PRIVACY-ISO-01 (Project Isolation & Explicit Cloud Consent Boundary)**: PASS — crossProjectBlocked=true, unauthorizedCloudBlocked=true
- **AVP-EXPORT-REV-01 (Persian UTF-8/ZWNJ Exports, JSON Sidecar Round-Trip & Media Revision Staleness)**: PASS — exports=TXT/SRT/JSON, invalidatedOnRev2=2, validity=STALE_SOURCE_REVISION_CHANGED
