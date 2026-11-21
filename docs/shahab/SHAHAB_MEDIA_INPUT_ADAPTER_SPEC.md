# SHAHAB Media Input Adapter Specification (SHAHAB-023)

Extracts half-open integer sample intervals `[sourceStartSample, sourceEndSample)` into copied immutable Float32 buffers, verifying pre/post source SHA-256 identity so source media is never modified destructively.
