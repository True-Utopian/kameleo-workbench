import { readFile, writeFile } from 'node:fs/promises';
import { calibrateInteraction } from '../dist/interaction/index.js';

const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const input = value('--input'), output = value('--output');
if (!input || !output) { console.error('Usage: node scripts/calibrate-interaction.mjs --input training-traces.json --output model.json [--version name]'); process.exitCode = 2; }
else {
  try {
    const content = await readFile(input, 'utf8'); if (content.length > 64 * 1024 * 1024) throw new Error('Trace file exceeds 64 MiB');
    const parsed = JSON.parse(content), traces = Array.isArray(parsed) ? parsed : parsed.traces;
    if (!Array.isArray(traces)) throw new Error('Expected an array of traces or {traces:[]}');
    const model = calibrateInteraction(traces, { version: value('--version') });
    await writeFile(output, JSON.stringify(model, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ saved: true, sessions: model.trainingSessions.length, participants: model.trainingParticipants.length, version: model.version, note: 'Fitted; held-out validation is still required.' }));
  } catch (error) { console.error(error instanceof SyntaxError ? 'Invalid JSON input' : error instanceof Error ? error.message : 'Calibration failed'); process.exitCode = 1; }
}
