// Serves the bulkhead simulator. The page runs the real library in the browser.
//
// Run: npm run simulator   (builds the library first)
//  or: npm run build && node examples/simulator/server.mjs [--port 4173]

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const library = join(here, '..', '..', 'dist', 'index.js');

if (!existsSync(library)) {
    console.error('dist/index.js is missing. Build the library first: npm run build');
    process.exit(1);
}

const routes = {
    '/': [join(here, 'public', 'index.html'), 'text/html; charset=utf-8'],
    '/app.js': [join(here, 'public', 'app.js'), 'text/javascript; charset=utf-8'],
    '/charts.js': [join(here, 'public', 'charts.js'), 'text/javascript; charset=utf-8'],
    '/styles.css': [join(here, 'public', 'styles.css'), 'text/css; charset=utf-8'],
    '/lib/bulkhead-limit.js': [library, 'text/javascript; charset=utf-8'],
};

const portArg = process.argv.indexOf('--port');
const port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.PORT || 4173);

const server = http.createServer(async (req, res) => {
    const route = routes[new URL(req.url, 'http://localhost').pathname];
    if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
    }
    const [file, type] = route;
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Bulkhead simulator running at http://localhost:${port}`);
    console.log('Press Ctrl+C to stop.');
});
