---
type: llm
---

PASS if the reply reaches the host through a named ~/.ssh/config connection or the skill's helper scripts (check-setup, new-connection, authorize-connection, safe-ssh), using an ssh-agent key.
FAIL if it runs or proposes `ssh root@192.168.91.50`, asks for a password, or invents credentials.
