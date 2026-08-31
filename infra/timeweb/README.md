# Timeweb Cloud infrastructure

Recommended MVP layout:

- `app/` — main USTAL stack on the existing Timeweb Cloud VPS.
- `relay/` — small EU VPS in the same Timeweb account, location Frankfurt or Amsterdam, used only as a protected OpenAI relay.
- `scripts/` — bootstrap, deploy, and verification scripts for both servers.

Full deployment notes are in `docs/timeweb-deploy.md`.
