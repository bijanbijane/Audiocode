# SHAHAB Editing Conflict Policy (SHAHAB-023)

Uses canonical `SHAHABEditorStreamingBridge`: once a segment enters `USER_EDITED_PROTECTED` or `USER_AUTHORIZED_FINAL`, subsequent recognition revisions cannot overwrite user text, and raw acoustic layers remain preserved reversibly.
