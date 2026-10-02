import { readFile, writeFile } from 'node:fs/promises';
import { scoreInteraction } from '../dist/interaction/index.js';

const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const modelFile = value('--model'), humanFile = value('--human'), syntheticFile = value('--synthetic'), output = value('--output');
if (!modelFile || !humanFile || !syntheticFile || !output) { console.error('Usage: node scripts/score-interaction.mjs --model model.json --human human-holdout.json --synthetic synthetic-holdout.json --output score.json'); process.exitCode = 2; }
else {
  try {
    const load = async file => { const content = await readFile(file, 'utf8'); if (content.length > 64 * 1024 * 1024) throw new Error('Input exceeds 64 MiB'); return JSON.parse(content); };
    const [model, human, synthetic] = await Promise.all([load(modelFile), load(humanFile), load(syntheticFile)]);
    const report = scoreInteraction(model, Array.isArray(human) ? human : human.traces, Array.isArray(synthetic) ? synthetic : synthetic.traces);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ passed: report.passed, coverage: report.coverage, reasons: report.reasons, score: report.estimate.score }));
    if (!report.passed) process.exitCode = 1;
  } catch (error) { console.error(error instanceof SyntaxError ? 'Invalid JSON input' : error instanceof Error ? error.message : 'Scoring failed'); process.exitCode = 1; }
}
