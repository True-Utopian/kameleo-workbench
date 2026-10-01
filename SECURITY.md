# Security

This service is for one trusted owner. Automation modules execute local code, the owner token grants full browser access, and exported profiles contain session data. Do not expose the Engine API or VNC directly, install untrusted modules, or share the token with client-side integrations.

Keep credentials in environment variables or private inventory files. The repository excludes `.env`, runtime state, inventory credentials and `.kameleo` archives. Review staged files before committing.

Report a vulnerability privately through GitHub's security reporting feature if enabled for this repository. If unavailable, contact the repository owner without posting credentials, affected session data or an exploit against a live user account in a public issue.
