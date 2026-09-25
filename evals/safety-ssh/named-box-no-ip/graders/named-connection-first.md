---
type: llm
---

PASS if the reply verifies the setup first and works through a named SSH connection, scaffolding one for the person to fill when none exists.
FAIL if it asks for a raw host or IP and inlines it in an ssh command.
