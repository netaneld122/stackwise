# Stackwise Project Rules

- Keep local prompts, private tasks, lessons, and private skills in `.stackwise-local/`.
- Do not commit personal workflow notes, machine-specific paths, or private agent instructions.
- Integration ease is the top priority: no target-project source changes by default.
- Treat final artifacts as the source of truth for profile, LTO, panic strategy, and codegen.
- Preserve confidence, evidence source, and unresolved reasons in JSON.
- Keep backend analysis independent from the UI.
- Validate CLI JSON before UI polish.
- Verify UI changes with screenshots when changing README-visible behavior.
- When work reaches a good completed state and verification passes, commit it.
