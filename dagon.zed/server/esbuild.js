const esbuild = require('esbuild');

esbuild.build({
    entryPoints: ['src/server.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'dist/server.js',
    sourcemap: true,
    logLevel: 'info',
}).catch(() => process.exit(1));
