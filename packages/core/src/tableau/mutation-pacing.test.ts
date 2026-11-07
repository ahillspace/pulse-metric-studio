import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TABLEAU_MUTATION_BLOCK_PAUSE_MS,
  TABLEAU_MUTATION_BLOCK_SIZE,
  TableauMutationPacer,
  currentTableauMutationJob,
  runPacedMutationBlocks,
  runTableauMutationJob,
  tableauMutationProgress,
  type TableauMutationJob,
} from './mutation-pacing.js';

function testJob() {
  const controller = new AbortController();
  const progress = { total: 0, completed: 0, throttled: 0 };
  const job: TableauMutationJob = {
    signal: controller.signal,
    throttled: () => { progress.throttled++; },
    total: (count) => { progress.total = count; },
    completed: (count) => { progress.completed += count; },
  };
  return { job, controller, progress };
}

test('paced blocks send at most one block at a time and pause between blocks', async () => {
  const items = Array.from({ length: TABLEAU_MUTATION_BLOCK_SIZE * 2 + 2 }, (_, index) => index);
  const starts: number[] = [];
  const finishes: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const results = await runPacedMutationBlocks(items, async (item, index) => {
    assert.equal(index, item);
    starts[item] = performance.now();
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5 + (item % 3)));
    inFlight--;
    finishes[item] = performance.now();
    return item * 10;
  });

  assert.deepEqual(results, items.map((item) => item * 10));
  assert.equal(peak, TABLEAU_MUTATION_BLOCK_SIZE);
  for (let block = 1; block * TABLEAU_MUTATION_BLOCK_SIZE < items.length; block++) {
    const previous = items.slice((block - 1) * TABLEAU_MUTATION_BLOCK_SIZE, block * TABLEAU_MUTATION_BLOCK_SIZE);
    const previousDone = Math.max(...previous.map((item) => finishes[item]));
    const nextStart = Math.min(...items.slice(block * TABLEAU_MUTATION_BLOCK_SIZE, (block + 1) * TABLEAU_MUTATION_BLOCK_SIZE).map((item) => starts[item]));
    assert.ok(nextStart - previousDone >= TABLEAU_MUTATION_BLOCK_PAUSE_MS - 5, `block ${block} started ${nextStart - previousDone} ms after the previous block finished`);
  }
});

test('a single block runs without any pause', async () => {
  const started = performance.now();
  assert.deepEqual(await runPacedMutationBlocks([1, 2, 3], async (item) => item), [1, 2, 3]);
  assert.deepEqual(await runPacedMutationBlocks([], async (item: number) => item), []);
  assert.ok(performance.now() - started < TABLEAU_MUTATION_BLOCK_PAUSE_MS);
});

test('a single block failure rejects the batch and does not start later blocks', async () => {
  const seen: number[] = [];
  await assert.rejects(runPacedMutationBlocks(Array.from({ length: 8 }, (_, index) => index), async (item) => {
    seen.push(item);
    if (item === 2) throw new Error('boom');
    return item;
  }), /boom/);
  await new Promise((resolve) => setTimeout(resolve, TABLEAU_MUTATION_BLOCK_PAUSE_MS + 20));
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
});

test('sequential pacer pauses before every block after the first', async () => {
  const pacer = new TableauMutationPacer();
  const gaps: number[] = [];
  let last = performance.now();
  for (let send = 0; send < TABLEAU_MUTATION_BLOCK_SIZE * 2 + 1; send++) {
    await pacer.send(async () => undefined);
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }
  gaps.forEach((gap, send) => {
    if (send > 0 && send % TABLEAU_MUTATION_BLOCK_SIZE === 0) assert.ok(gap >= TABLEAU_MUTATION_BLOCK_PAUSE_MS - 5, `send ${send} gap ${gap}`);
    else assert.ok(gap < TABLEAU_MUTATION_BLOCK_PAUSE_MS / 2, `send ${send} gap ${gap}`);
  });
});

test('every pacer and block run inside one job continues the same pacing sequence', async () => {
  const { job } = testJob();
  const sends: Array<{ kind: string; at: number }> = [];
  const record = (kind: string) => async () => { sends.push({ kind, at: performance.now() }); };
  await runTableauMutationJob(job, async () => {
    const creates = new TableauMutationPacer();
    for (let send = 0; send < TABLEAU_MUTATION_BLOCK_SIZE; send++) await creates.send(record('create'));
    // A later phase with its own pacer is still the sixth write of the job.
    const follows = new TableauMutationPacer();
    await follows.send(record('follow'));
    // A block run after sequential writes also waits before its first block.
    await runPacedMutationBlocks([1, 2], async () => record('block')());
  });
  const at = (index: number) => sends[index]!.at;
  assert.deepEqual(sends.map((send) => send.kind), [...Array(TABLEAU_MUTATION_BLOCK_SIZE).fill('create'), 'follow', 'block', 'block']);
  assert.ok(at(TABLEAU_MUTATION_BLOCK_SIZE - 1) - at(0) < TABLEAU_MUTATION_BLOCK_PAUSE_MS / 2, 'the first block goes out without a pause');
  assert.ok(at(TABLEAU_MUTATION_BLOCK_SIZE) - at(TABLEAU_MUTATION_BLOCK_SIZE - 1) >= TABLEAU_MUTATION_BLOCK_PAUSE_MS - 5, 'the first follow waits for the pause owed after five creates');
  assert.ok(at(TABLEAU_MUTATION_BLOCK_SIZE + 1) - at(TABLEAU_MUTATION_BLOCK_SIZE) >= TABLEAU_MUTATION_BLOCK_PAUSE_MS - 5, 'a block after earlier writes pauses first');
});

test('pacers outside a job keep their own sequences', async () => {
  const first = new TableauMutationPacer();
  for (let send = 0; send < TABLEAU_MUTATION_BLOCK_SIZE; send++) await first.send(async () => undefined);
  const started = performance.now();
  await new TableauMutationPacer().send(async () => undefined);
  assert.ok(performance.now() - started < TABLEAU_MUTATION_BLOCK_PAUSE_MS / 2, 'unrelated writes outside a job are not held by each other');
});

test('workers inside a job see the job and report progress to it', async () => {
  const { job, progress } = testJob();
  assert.equal(currentTableauMutationJob(), undefined);
  tableauMutationProgress.total(3);
  tableauMutationProgress.completed();
  const seen = await runTableauMutationJob(job, async () => {
    tableauMutationProgress.total(3);
    return runPacedMutationBlocks([1, 2, 3], async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      tableauMutationProgress.completed();
      return currentTableauMutationJob() === job ? item : -1;
    });
  });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(progress, { total: 3, completed: 3, throttled: 0 });
  assert.equal(currentTableauMutationJob(), undefined, 'the job context ends with its work');
});

test('a stopped job skips the pause between blocks and sequential sends', async () => {
  const { job, controller } = testJob();
  const items = Array.from({ length: TABLEAU_MUTATION_BLOCK_SIZE * 3 }, (_, index) => index);
  const started = performance.now();
  await runTableauMutationJob(job, async () => {
    await runPacedMutationBlocks(items, async (item) => {
      if (item === 0) controller.abort();
      return item;
    });
    const pacer = new TableauMutationPacer();
    for (const item of items) await pacer.send(async () => item);
  });
  assert.ok(performance.now() - started < TABLEAU_MUTATION_BLOCK_PAUSE_MS, 'no pause ran after the job stopped');
});

test('stopping a job ends a pause that is already waiting', async () => {
  const { job, controller } = testJob();
  const started = performance.now();
  const run = runTableauMutationJob(job, () => runPacedMutationBlocks(items(), async (item) => item));
  setTimeout(() => controller.abort(), 20);
  assert.equal((await run).length, TABLEAU_MUTATION_BLOCK_SIZE + 1);
  assert.ok(performance.now() - started < TABLEAU_MUTATION_BLOCK_PAUSE_MS, 'the waiting pause ended early');

  function items() { return Array.from({ length: TABLEAU_MUTATION_BLOCK_SIZE + 1 }, (_, index) => index); }
});
