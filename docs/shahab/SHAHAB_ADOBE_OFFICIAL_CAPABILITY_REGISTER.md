# Adobe Audition Official Capability Evidence Register (SHAHAB-024)

| ID | Category | State | Source | Checked | Consequence |
|---|---|---|---|---|---|
| AUD-CAP-01 | AUDIO_PLUGIN | `OFFICIALLY_DOCUMENTED` | [Adobe Audition User Guide — Audio Plug-in Manager (VST3, VST, Audio Units)](https://helpx.adobe.com/audition/using/effects-controls.html) | 2026-11-21 | REJECTED as primary transcript integration mechanism; strictly reserved for non-blocking audio DSP use cases. |
| AUD-CAP-02 | HOST_EXTENSION | `NOT_SUPPORTED` | [Adobe Developer Portal — Creative Cloud Extensibility (UXP vs CEP)](https://developer.adobe.com/) | 2026-11-21 | REJECTED native UXP panel option; prevents relying on nonexistent APIs. |
| AUD-CAP-03 | HOST_EXTENSION | `VERSION_DEPENDENT` | [Adobe CEP Samples — Audition Legacy ExtendScript/CEP Samples](https://github.com/Adobe-CEP/Samples/tree/master/Audition) | 2026-11-21 | Not selected as primary foundation; kept strictly optional only if a future verified Windows/macOS Audition host validates CEP availability. |
| AUD-CAP-04 | MEDIA_INTERCHANGE | `OFFICIALLY_DOCUMENTED` | [Adobe Audition — Export Selected Markers as CSV & Import Markers from File](https://helpx.adobe.com/audition/using/markers.html) | 2026-11-21 | APPROVED primary Audition-native timeline interchange format paired with SRT and full-provenance JSON Sidecar. |
| AUD-CAP-05 | INTER_APP_COMM | `OFFICIALLY_DOCUMENTED` | [Adobe HelpX — Speech to Text in Premiere Pro vs Audition](https://helpx.adobe.com/premiere-pro/using/speech-to-text.html) | 2026-11-21 | Confirms Companion App + Audition Marker CSV / SRT / Sidecar interchange (`COMPANION_APP_APPROVED`) as the only honest, officially maintainable integration architecture. |
