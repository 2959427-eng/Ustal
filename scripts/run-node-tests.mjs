import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => `tests/${f}`);
if (!files.length) throw new Error('No test files found');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
