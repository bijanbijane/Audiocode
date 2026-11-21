# Adobe Audition Integration Privacy & Security (SHAHAB-024)

- Authenticated local companion bridge (`AuditionLocalBridgeSecurityGuard`) using constant-time token verification, payload size limits, and strict workspace path confinement.
- Explicit Cloud consent enforced via `SHAHAB-022` SDK; zero automatic project directory scanning; zero private memory/API manipulation.
