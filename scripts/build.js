const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { prep } = require('./prepare-dev');

const root = path.resolve(__dirname, '..');
const dev = path.join(root, '.build', 'dev');
const output = path.join(root, '_site');

prep();

console.log('Building site...');

fs.rmSync(output, { recursive: true, force: true });

execSync('npx eleventy', { cwd: dev, stdio: 'inherit' });

execSync(`mv "${path.join(dev, '_site')}" "${output}"`);

console.log(`✓ Built to _site/`);