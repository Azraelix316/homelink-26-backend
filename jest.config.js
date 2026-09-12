module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  modulePathIgnorePatterns: ['<rootDir>/cdk.out/', '<rootDir>/lib/lambdas/[^/\\\\]+/package.json'],
}
