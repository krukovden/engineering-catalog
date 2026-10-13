---
type: regex
target: trace
flags: s
pattern: '\nend task\(\{[^\n]*"(?:subagent_type|agent_type)":"(?:[\w-]+:)?memory-writer"[^\n]*\}\) -> true[\s\S]*\nstart bash\(\{"command":"git (?:(?:diff --stat)(?: -- [^"\n]*)?|show(?: --stat)?(?: -- [^"\n]*memory[^\n"]*)?)"[^)]*\}\) -> true'
---
