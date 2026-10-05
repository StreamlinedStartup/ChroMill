const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const source = readFileSync('.bb/workflows/deliver-slices.js', 'utf8');
const runSource = new (Object.getPrototypeOf(async function () {}).constructor)(
  'args', 'agent', 'pipeline', 'log', source.replace('export const meta', 'const meta'));
const item = { taskId: 'WMLC-005', worktree: '/retained/005', branch: 'slice', baseCommit: 'base', ownedPaths: ['pins.ts'] };
const worker = { ready: true, commits: ['slice'], evidence: ['browser.json'], documentUpdates: ['doc-003: pin limits'], blockers: [] };
const review = { verdict: 'approve', findings: [], evidence: ['review.json'], productCriteriaReviewed: true, documentationProposalsReviewed: true };
const applied = { ready: true, documentsApplied: true, commit: 'integrated', evidence: ['docs.json'], blockers: [] };
const final = { taskId: item.taskId, completed: true, automatedTestsPassed: true, chromeChecked: true, commit: 'final', evidence: ['integrated-browser.json'], blockers: [], findings: [] };

async function simulate(overrides = {}) {
  const calls = [], logs = [];
  let picks = 0, docs = false, fixes = 0;
  const agent = async (prompt, options) => {
    calls.push({ prompt, ...options });
    const phase = options.phase;
    const count = calls.filter(call => call.phase === phase).length;
    if (overrides[phase]) return overrides[phase]({ prompt, options, count, docs, fixes });
    if (phase === 'Prepare') return { ready: true, integrationRoot: '/integration', integrationBranch: 'feature/example', baseCommit: 'base', items: [item], reason: '' };
    if (phase === 'Implement' || phase === 'Fix') return structuredClone(worker);
    if (phase === 'Review') {
      // Model a documentation criterion that is pending until serial application.
      if (!prompt.includes('reviewed proposals')) return { ...review, verdict: 'changes', findings: ['Documentation is pending'] };
      return structuredClone(review);
    }
    if (phase === 'Integrate') {
      picks++;
      docs = true;
      return structuredClone(applied);
    }
    if (phase === 'Integration fix') { fixes++; return structuredClone(applied); }
    if (phase === 'Integration review') {
      assert.equal(docs, true, 'Final gate requires applied documentation');
      return structuredClone(final);
    }
    throw new Error('Unexpected phase: ' + phase);
  };
  const result = await runSource({ tasks: [item.taskId] }, agent,
    async (items, stage) => Promise.all(items.map(stage)), message => logs.push(message));
  return { result, calls, logs, picks };
}

test('pending documentation reaches serial application before final completion', async () => {
  const run = await simulate();
  assert.equal(run.result.status, 'complete');
  assert.equal(run.picks, 1);
  assert.deepEqual(run.calls.map(c => c.phase), ['Prepare', 'Implement', 'Review', 'Integrate', 'Integration review']);
  assert.match(run.calls.find(c => c.phase === 'Review').prompt, /Do not waive product behavior or testing criteria/);
  assert.match(run.calls.find(c => c.phase === 'Integration review').prompt, /actual applied documentation/);
});

test('integration-only finding fixes and retests retained source without another preparation or cherry-pick', async () => {
  const run = await simulate({ 'Integration review': ({ count, fixes }) => count === 1
    ? { ...final, completed: false, findings: ['Accepted: integration race'] }
    : (assert.equal(fixes, 1), final) });
  assert.equal(run.result.status, 'complete');
  assert.equal(run.picks, 1);
  assert.deepEqual(run.calls.map(c => c.phase), ['Prepare', 'Implement', 'Review', 'Integrate', 'Integration review', 'Integration fix', 'Integration review']);
  const fix = run.calls.find(c => c.phase === 'Integration fix');
  assert.equal(fix.model, 'gpt-6.1-sol');
  assert.equal(fix.reasoningLevel, 'medium');
  assert.match(fix.prompt, /Repeat affected tests and browser actions/);
  assert.match(fix.prompt, /Do not cherry-pick/);
  for (const call of run.calls.filter(c => c.phase === 'Integration review')) {
    assert.equal(call.model, 'gpt-6-astra');
    assert.equal(call.reasoningLevel, 'medium');
    assert.match(call.prompt, /Run the full test suite, lint, typecheck, build once/);
    assert.match(call.prompt, /Do not cherry-pick/);
  }
  assert.equal(run.result.results[0].reviews[0].findings[0], 'Accepted: integration race');
});

test('integration fix limit leaves findings visible and tasks open', async () => {
  const run = await simulate({ 'Integration review': () => ({ ...final, completed: false, findings: ['Accepted: still broken'] }) });
  assert.equal(run.result.status, 'incomplete');
  assert.equal(run.calls.filter(c => c.phase === 'Integration fix').length, 2);
  assert.equal(run.calls.filter(c => c.phase === 'Integration review').length, 3);
  assert.equal(run.picks, 1);
  assert.match(run.logs.join('\n'), /Integration fix limit reached/);
  assert.deepEqual(run.result.results[0].findings, ['Accepted: still broken']);
});

test('missing evidence and unapplied documentation never complete', async () => {
  for (const overrides of [
    { Implement: () => ({ ...worker, evidence: [] }) },
    { Review: () => ({ ...review, evidence: [] }) },
    { Review: () => ({ ...review, productCriteriaReviewed: false }) },
    { Review: () => ({ ...review, documentationProposalsReviewed: false }) },
    { Integrate: () => ({ ...applied, documentsApplied: false }) },
    { Integrate: () => ({ ...applied, evidence: [] }) },
    { 'Integration review': () => ({ ...final, evidence: [] }) },
    { 'Integration review': () => ({ ...final, automatedTestsPassed: false }) },
    { 'Integration review': () => ({ ...final, chromeChecked: false }) },
    { 'Integration review': () => ({ ...final, automatedTestsPassed: undefined }) },
    { 'Integration review': () => ({ ...final, chromeChecked: undefined }) },
    { 'Integration review': () => ({ ...final, blockers: ['Browser unavailable'] }) },
    { 'Integration review': () => ({ ...final, completed: true, findings: ['Unresolved: race'] }) },
    { 'Integration review': () => ({ ...final, taskId: 'WMLC-006' }) },
    { 'Integration review': () => ({ ...final, commit: '' }) },
  ]) {
    const run = await simulate(overrides);
    assert.equal(run.result.status, 'incomplete');
    assert.ok(run.result.results.every(result => !result.completed));
  }
});

test('worker findings use the existing bounded fix and review path', async () => {
  const run = await simulate({ Review: ({ count }) => count === 1 ? { ...review, verdict: 'changes', findings: ['Accepted: pin bug'] } : review });
  assert.equal(run.result.status, 'complete');
  assert.deepEqual(run.calls.map(c => c.phase), ['Prepare', 'Implement', 'Review', 'Fix', 'Review', 'Integrate', 'Integration review']);
});

test('failed integration retest retains findings and prevents further review or completion', async () => {
  const run = await simulate({
    'Integration review': () => ({ ...final, completed: false, findings: ['Accepted: integration race'] }),
    'Integration fix': () => ({ ...applied, ready: false, evidence: ['failed-retest.json'], blockers: ['Race test failed'] }),
  });
  assert.equal(run.result.status, 'incomplete');
  assert.equal(run.picks, 1);
  assert.equal(run.calls.filter(c => c.phase === 'Integration review').length, 1);
  assert.deepEqual(run.result.results[0].findings, ['Accepted: integration race']);
  assert.ok(run.result.results[0].blockers.includes('Race test failed'));
  assert.equal(run.result.results[0].fixes[0].evidence[0], 'failed-retest.json');
});

test('worker failure limit is explicit and never integrates', async () => {
  const run = await simulate({ Review: () => ({ ...review, verdict: 'changes', findings: ['Accepted: worker bug'] }) });
  assert.equal(run.result.status, 'incomplete');
  assert.equal(run.picks, 0);
  assert.equal(run.calls.filter(c => c.phase === 'Fix').length, 2);
  assert.equal(run.calls.filter(c => c.phase === 'Review').length, 3);
  assert.match(run.logs.join('\n'), /Fix limit reached/);
  assert.deepEqual(run.result.results[0].review.findings, ['Accepted: worker bug']);
});


test('only the final integrated gate requests a full suite and actual Chrome proof', async () => {
  const run = await simulate();
  const full = run.calls.filter(call => call.prompt.includes('Run the full test suite'));
  assert.equal(full.length, 1);
  assert.equal(full[0].phase, 'Integration review');
  assert.match(full[0].prompt, /actual built Chrome extension/);
  assert.match(full[0].prompt, /A normal browser tab or mockup is insufficient/);
  assert.match(full[0].prompt, /Reuse passing results on unchanged source/);
  assert.match(run.calls.find(call => call.phase === 'Integrate').prompt, /feature\/example/);
  assert.ok(!run.calls.some(call => call.prompt.includes('on feature/run-radar')));
});


test('preparation shares one feature branch and integration does not replay same-checkout commits', async () => {
  const run = await simulate();
  const prepare = run.calls.find(call => call.phase === 'Prepare').prompt;
  assert.match(prepare, /Do not create a branch per task/);
  assert.match(prepare, /For a single task, use the integration checkout directly/);
  assert.match(prepare, /temporary detached worktrees/);
  assert.ok(!prepare.includes('feature/run-radar-<task-id>'));
  assert.match(prepare, /After an authorized successful merge/);
  const integrate = run.calls.find(call => call.phase === 'Integrate').prompt;
  assert.match(integrate, /its commits are already present. Do not cherry-pick them/);
  assert.match(integrate, /commits that are not already present/);
});
