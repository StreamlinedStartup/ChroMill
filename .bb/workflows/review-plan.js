export const meta = {
  name: "review-plan",
  description: "Astra inspects actual Backlog planning artifacts and delivery workflow source",
  phases: [{ title: "Artifact review" }],
};
return await agent(`Review the actual artifacts in this repository for WMLC-001. Do not implement the extension.
Read AGENTS.md, resolve CLAUDE.md, inspect every Backlog task and doc, decisions, mise.toml,
.gitignore, .bb/workflows/deliver-slices.js, and this review workflow.
Read Backlog overview and relevant lifecycle guides. Use CodeGraph first if indexed.
Read /ponytail:ponytail-review SKILL.md and apply it to the actual workflow and planning diff.
Make sure that the plan describes a Plasmo Framework Chrome MV3 extension with genuinely vertical,
committable, individually testable slices. Inspect dependencies, ownership, secrets gate, and evidence-based completion.
Inspect whether workflow preparation, worktree isolation, review/fix loops, and serial integration enforce the requested rules.
Run mise run plan-check yourself and inspect the real symlink and current branch.
Do not rely on the parent or worker summaries. Record file-and-line accepted findings and their reproduction.
Save a sanitized review receipt in evidence/WMLC-001/astra-review.json. You can write only that receipt.
Do not change task status, acceptance criteria, implementation source, or shared planning documents.
Return verdict, findings, and evidence paths.`, {
  provider: "codex", model: "gpt-6-astra", reasoningLevel: "medium",
  label: "Astra planning artifact review", phase: "Artifact review",
  schema: {
    type: "object", additionalProperties: false,
    required: ["verdict", "findings", "evidence"],
    properties: {
      verdict: { enum: ["approve", "changes", "blocked"] },
      findings: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
    },
  },
});
