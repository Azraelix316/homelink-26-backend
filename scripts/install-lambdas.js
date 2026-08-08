#!/usr/bin/env node
/**
 * Install dependencies for all Lambda functions
 * This script runs npm install in each Lambda function directory
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const lambdasDir = path.join(__dirname, '..', 'lib', 'lambdas');

// Get all Lambda function directories
const lambdaFunctions = fs.readdirSync(lambdasDir).filter(file => {
  const fullPath = path.join(lambdasDir, file);
  return fs.statSync(fullPath).isDirectory() && file !== 'shared';
});

console.log(`Installing dependencies for ${lambdaFunctions.length} Lambda functions...\n`);

let successCount = 0;
let failureCount = 0;

lambdaFunctions.forEach(fn => {
  const lambdaDir = path.join(lambdasDir, fn);
  const packageJsonPath = path.join(lambdaDir, 'package.json');

  // Check if package.json exists
  if (!fs.existsSync(packageJsonPath)) {
    console.warn(`⚠️  Skipping ${fn}: no package.json found`);
    return;
  }

  try {
    console.log(`📦 Installing dependencies for: ${fn}`);
    execSync('npm install --no-save', { cwd: lambdaDir, stdio: 'inherit' });
    successCount++;
    console.log(`✅ ${fn} - dependencies installed\n`);
  } catch (error) {
    failureCount++;
    console.error(`❌ ${fn} - failed to install dependencies`);
    console.error(`   Error: ${error.message}\n`);
  }
});

console.log(`\n========================================`);
console.log(`Installation complete!`);
console.log(`✅ Success: ${successCount}`);
console.log(`❌ Failed: ${failureCount}`);
console.log(`========================================\n`);

if (failureCount > 0) {
  process.exit(1);
}
