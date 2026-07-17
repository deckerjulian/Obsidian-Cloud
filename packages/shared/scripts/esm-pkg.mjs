// Mark the ESM output directory as an ES module package so Node-native ESM
// consumers load dist/esm/*.js correctly (the package itself is "commonjs").
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../dist/esm/package.json', import.meta.url), '{ "type": "module" }\n');
