export const meta = {
  name: "deliver-slices",
  description: "Implement vertical Backlog slices with Sol workers, Astra artifact review, and serial evidence-based integration",
  phases: [
    { title: "Prepare" },
    { title: "Implement" },
    { title: "Review" },
    { title: "Fix" },
    { title: "Integrate" },
    { title: "Integration review" },
    { title: "Integration fix" },
  ],
  inputSchema: {
    type: "object",
    required: ["tasks"],
    additionalProperties: false,
    properties: {
      tasks: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1 } },
    },
  },
};

const common = `Read AGENTS.md, Backlog overview, the matching lifecycle guide, and doc-001 through doc-003.
This is a Plasmo Framework Chrome MV3 extension, not a generic web application.
Follow the credential-choice gate before wiring configuration. Do not bundle secrets.
Use mise tasks and named tmux sessions for servers and test suites. Capture exit codes and sanitized output.
Use CodeGraph before code exploration if indexed. Use the Backlog CLI for every task or document change.
No push, publication, upload, or extra task scope. Never claim missing evidence is a pass.`;

function sol(prompt, label, phase, schema) {
  return agent(common + "\n" + prompt, {
    provider: "codex", model: "gpt-6.1-sol", reasoningLevel: "medium",
    label, phase, schema,
  });
}

function astra(prompt, label, phase, schema) {
  return agent(common + "\n" + prompt, {
    provider: "codex", model: "gpt-6-astra", reasoningLevel: "medium",
    label, phase, schema,
  });
}

const itemSchema = {
  type: "object", additionalProperties: false,
  required: ["taskId", "worktree", "branch", "baseCommit", "ownedPaths"],
  properties: {
    taskId: { type: "string" }, worktree: { type: "string" },
    branch: { type: "string" }, baseCommit: { type: "string" },
    ownedPaths: { type: "array", items: { type: "string" }, minItems: 1 },
  },
};
const workerSchema = {
  type: "object", additionalProperties: false,
  required: ["ready", "commits", "evidence", "documentUpdates", "blockers"],
  properties: {
    ready: { type: "boolean" },
    commits: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    documentUpdates: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
  },
};
const reviewSchema = {
  type: "object", additionalProperties: false,
  required: ["verdict", "findings", "evidence", "productCriteriaReviewed", "documentationProposalsReviewed"],
  properties: {
    verdict: { enum: ["approve", "changes", "blocked"] },
    findings: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    productCriteriaReviewed: { type: "boolean" },
    documentationProposalsReviewed: { type: "boolean" },
  },
};
const integrationSchema = {
  type: "object", additionalProperties: false,
  required: ["ready", "documentsApplied", "commit", "evidence", "blockers"],
  properties: {
    ready: { type: "boolean" }, documentsApplied: { type: "boolean" }, commit: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
  },
};
const integratedReviewSchema = {
  type: "object", additionalProperties: false,
  required: ["taskId", "completed", "commit", "evidence", "blockers", "findings", "automatedTestsPassed", "chromeChecked"],
  properties: {
    taskId: { type: "string" }, completed: { type: "boolean" }, automatedTestsPassed: { type: "boolean" }, chromeChecked: { type: "boolean" }, commit: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: { type: "string" } },
  },
};

function workerReady(implementation) {
  return implementation.ready && implementation.evidence.length > 0 && implementation.blockers.length === 0;
}

function integrationReady(integration) {
  return integration.ready && integration.documentsApplied && integration.commit.length > 0
    && integration.evidence.length > 0 && integration.blockers.length === 0;
}

if (new Set(args.tasks).size !== args.tasks.length) throw new Error("Duplicate task IDs are not a valid batch");
const prepared = await sol(`Prepare this exact task batch: ${JSON.stringify(args.tasks)}.
Do not implement product code. Read each real task and dependency graph.
Require every dependency Done with evidence, a clean committed integration checkout on the current authorized feature branch,
and no conflicting active worker checkout for these tasks. Return the current authorized feature branch as integrationBranch. Reject the entire batch if a requirement fails.
Research and assign non-overlapping file ownership. Reject this batch if separation requires speculative abstractions.
Activate tasks, assign workers, and record current plans through Backlog. Commit dispatch metadata serially.
Use one named feature branch for all tasks. Do not create a branch per task.
For a single task, use the integration checkout directly. For concurrent tasks, create temporary detached worktrees from the committed base.
Report the feature branch in each item. The worktree field identifies its actual checkout. Never delete active, dirty, or unmerged work.
After an authorized successful merge, remove clean temporary worktrees and delete merged local feature branches without force.
Return absolute integrationRoot, baseCommit, and an item for every requested ID, or ready=false with a reason.
Do not leave a partially prepared batch unreported.`, "Prepare task worktrees", "Prepare", {
  type: "object", additionalProperties: false,
  required: ["ready", "integrationRoot", "integrationBranch", "baseCommit", "items", "reason"],
  properties: {
    ready: { type: "boolean" }, integrationRoot: { type: "string" }, integrationBranch: { type: "string" },
    baseCommit: { type: "string" }, items: { type: "array", items: itemSchema },
    reason: { type: "string" },
  },
});
if (!prepared.ready) return { status: "blocked", reason: prepared.reason };
if (prepared.items.length !== args.tasks.length || args.tasks.some(id => !prepared.items.some(item => item.taskId === id))) {
  throw new Error("Preparation did not cover the exact requested batch");
}

const reviewed = await pipeline(prepared.items, async (item) => {
  const context = JSON.stringify(item);
  const workerPrompt = `Work only in this assigned checkout and its assigned paths: ${context}.
Use explicit command working directories and absolute file paths. Do not switch the BB thread environment.
Read the task and its current plan. Implement the complete vertical slice with regression tests.
Add tests for uncovered behavior. Run affected tests during implementation. Exercise Chrome as needed to develop the feature. The full suite and final actual Chrome journey belong to the integrated gate.
Do not create global Backlog IDs or edit shared documents. Record task-local decisions and return proposed doc updates.
Commit the slice, evidence, and task notes. Leave the task In Progress with criteria unchecked.
Return concise proposed shared-document edits. One task note with command outcomes is sufficient; no extra evidence directory is required. Pending final integrated tests or proposed documentation alone do not prevent ready=true for source review.
Return ready=false for missing inputs, failed affected checks, missing coverage, or unfinished implementation.
Do not waive product behavior or testing criteria. Write the integration checkout only when it is your assigned checkout. Do not create a task branch.`;
  let implementation = await sol(workerPrompt, "Implement " + item.taskId, "Implement", workerSchema);
  if (!workerReady(implementation)) return { item, status: "blocked", implementation };
  let review;
  for (let attempt = 0; attempt < 3; attempt++) {
    review = await astra(`Review actual artifacts in this worktree: ${context}.
The worker result is only a navigation hint: ${JSON.stringify(implementation)}.
Inspect the task, actual diff, source, and test coverage. Read normal test outcomes. Reuse passing results on unchanged source; run affected checks only for changes or unresolved concerns. Apply /ponytail:ponytail-review to the actual diff.
Review correctness, security, races, permissions, accessibility, and missing tests alongside complexity.
Record accepted findings with file and line, reproduction, and required test. Record rejected findings with evidence.
Record a concise review verdict and finding dispositions in task notes. A task note path satisfies the evidence field. Do not edit implementation, task status, or acceptance checks.
At this pre-integration gate, permit pending shared documentation only as reviewed proposals.
Review the proposed text before setting documentationProposalsReviewed=true.
Set productCriteriaReviewed=true only after actual code and tests cover the product criteria. Final integrated automated and Chrome checks remain mandatory before Done.
Do not waive product behavior or testing criteria. Pending proposals do not prove applied documentation or permit Done.
Approve only with both proof fields true. Use blocked for missing inputs or capabilities.
Return task-note references and current actionable findings only. Keep resolved and historical dispositions in notes.`, "Astra review " + item.taskId, "Review", reviewSchema);
    if (review.verdict !== "changes") break;
    if (attempt === 2) {
      log("Fix limit reached for " + item.taskId + "; task remains open with findings");
      break;
    }
    implementation = await sol(workerPrompt + `\nFix every accepted finding in this actual Astra review: ${JSON.stringify(review)}.
Inspect the current source and review receipt. Repeat affected tests and browser actions after fixes.
Commit the fixes and evidence, and return the full ordered commit list from baseCommit.
Keep unresolved criteria and blockers explicit.`, "Fix " + item.taskId, "Fix", workerSchema);
    if (!workerReady(implementation)) break;
  }
  const approved = workerReady(implementation) && review?.verdict === "approve" && review.evidence.length > 0
    && review.findings.length === 0 && review.productCriteriaReviewed && review.documentationProposalsReviewed
    && implementation.commits.length > 0;
  return { item, status: approved ? "approved" : "blocked", implementation, review };
});

const results = [];
for (let index = 0; index < reviewed.length; index++) {
  const result = reviewed[index];
  if (!result || result.status !== "approved") {
    log("No integration for " + prepared.items[index].taskId + "; worker or review evidence is incomplete");
    results.push(result || { taskId: prepared.items[index].taskId, status: "blocked", reason: "Pipeline failed" });
    continue;
  }
  let integration = await sol(`Integrate only this reviewed slice serially into ${prepared.integrationRoot} on ${prepared.integrationBranch}:
${JSON.stringify(result)}.
Inspect the actual worker commits and review notes. Require a clean integration checkout.
If the worker used the integration checkout, its commits are already present. Do not cherry-pick them.
For a detached worker checkout, cherry-pick only reported commits that are not already present. Stop and leave the task open if conflicts or unrelated files appear.
Apply the reviewed shared-document proposals serially through the Backlog CLI before the final all-criteria gate.
Make sure that the required documentation edits are applied. Record this briefly in the task. Set documentsApplied=true only after every required update is applied.
Commit integrated source, docs, and concise task notes. Do not repeat the full suite here; the final Astra gate runs it once. Do not create speculative follow-up scope.
Leave the task In Progress and criteria unchecked. Never push. Keep worktrees for inspection.
Return ready=false on conflicts, missing evidence, or unapplied docs. This is the only cherry-pick stage.`,
    "Apply reviewed slice " + result.item.taskId, "Integrate", integrationSchema);
  const reviews = [];
  const fixes = [];
  let integrated = { taskId: result.item.taskId, completed: false, findings: [], blockers: integration.blockers, evidence: integration.evidence };
  for (let attempt = 0; integrationReady(integration) && attempt < 3; attempt++) {
    integrated = await astra(`Review the already integrated slice ${result.item.taskId} in ${prepared.integrationRoot} on ${prepared.integrationBranch}.
Reviewed worker context: ${JSON.stringify(result)}. Integration receipts: ${JSON.stringify(integration)}.
Previous integrated reviews and fix receipts: ${JSON.stringify({ reviews, fixes })}.
Do not cherry-pick or recreate worktrees. Inspect the actual applied documentation, integrated source, diff,
generated manifest, built artifacts, and concise task notes. Pending proposals cannot satisfy documentation criteria.
Run the full test suite, lint, typecheck, build once on the final integrated source. Codex must drive the actual built Chrome extension for the changed journey and inspect results, including toolbar popup, native panel, and background behavior as relevant. A normal browser tab or mockup is insufficient. Set automatedTestsPassed and chromeChecked only after passing automated checks and actual Chrome actions. Reuse passing results on unchanged source after metadata-only edits. After fixes repeat affected checks; repeat the full suite only for new changes or unresolved concerns that justify it.
Apply /ponytail:ponytail-review again. Record command outcomes, Chrome actions/results, limitations, and verdict in one concise task note. No fingerprints, inventories, screenshots, tool-version dumps, or per-phase receipts are mandatory.
Return accepted or unresolved findings for Sol repair. Missing inputs, capabilities, or evidence are blockers.
If any criterion or DoD item is unproven, return completed=false and keep the task In Progress with criteria unchecked.
Only when every criterion has actual integrated proof, including actual applied documentation, read task-finalization,
check proven AC and DoD, list modified files, and write the final summary through Backlog.
Mark Done only after this all-criteria gate. You are the serial final reviewer and must apply final Backlog metadata yourself. Commit final metadata and evidence references. Never push.`,
      "Astra integrated review " + result.item.taskId, "Integration review", integratedReviewSchema);
    reviews.push(integrated);
    const complete = integrated.completed && integrated.automatedTestsPassed === true && integrated.chromeChecked === true && integrated.taskId === result.item.taskId && integrated.commit.length > 0
      && integrated.evidence.length > 0 && integrated.findings.length === 0 && integrated.blockers.length === 0;
    integrated = { ...integrated, completed: complete };
    if (complete || integrated.blockers.length > 0 || integrated.evidence.length === 0 || integrated.findings.length === 0) break;
    if (attempt === 2) {
      log("Integration fix limit reached for " + result.item.taskId + "; task remains open with findings");
      break;
    }
    integration = await sol(`Fix accepted integration findings directly in ${prepared.integrationRoot} on ${prepared.integrationBranch}.
Use the retained worktree ${result.item.worktree} and reviewed commits for inspection, without fresh preparation.
Do not cherry-pick or recreate worktrees. Do not edit another slice or invent follow-up scope.
Actual Astra review: ${JSON.stringify(integrated)}. Prior integration receipt: ${JSON.stringify(integration)}.
Inspect current integrated source and actual review findings. Record accepted, rejected-with-evidence, and unresolved dispositions.
Repeat affected tests and browser actions after fixes. Apply any required documentation repairs serially through Backlog.
Commit fixes and concise test outcomes. Return documentsApplied=true only after reading the actual required docs.
Leave tasks In Progress with criteria unchecked. Return ready=false with explicit blockers for missing evidence or failed retests.`,
      "Fix integrated " + result.item.taskId, "Integration fix", integrationSchema);
    fixes.push(integration);
  }
  if (!integrationReady(integration)) {
    integrated = { ...integrated, completed: false, blockers: [...integrated.blockers, ...integration.blockers,
      "Integration or repair lacks applied documentation, commit, or evidence"] };
  }
  integrated = { ...integrated, integration, reviews, fixes };
  results.push(integrated);
  if (!integrated.completed) {
    log("Integration stopped at " + result.item.taskId + "; retain worktrees, receipts, and findings for recovery");
    for (let next = index + 1; next < reviewed.length; next++) {
      results.push({ taskId: prepared.items[next].taskId, status: "not-integrated" });
    }
    break;
  }
}
return { status: results.every(r => r.completed) ? "complete" : "incomplete", results };
