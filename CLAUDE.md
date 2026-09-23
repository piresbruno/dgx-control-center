# Claude Code Adapter

@AGENTS.md

Claude Code should treat `AGENTS.md` as the provider-neutral project instruction core. Claude-specific skills are available under `.claude/skills/`; load them only when relevant.

Do not infer that optional MCP servers, permissions, or custom agents are installed unless their configuration files exist.
