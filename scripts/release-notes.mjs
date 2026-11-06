// Prints the CHANGELOG.md section for one version, for use as GitHub release notes.
// Usage: node scripts/release-notes.mjs 1.2.3
import { readFileSync } from 'node:fs';

const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
    console.error('Usage: node scripts/release-notes.mjs <version>');
    process.exit(1);
}

const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
    console.error(`CHANGELOG.md has no "## [${version}]" section.`);
    process.exit(1);
}

let end = lines.findIndex((line, i) => i > start && (line.startsWith('## ') || /^\[[^\]]+\]: /.test(line)));
if (end === -1) end = lines.length;

const notes = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
if (!notes) {
    console.error(`The CHANGELOG.md section for ${version} is empty.`);
    process.exit(1);
}
process.stdout.write(`${notes}\n`);
