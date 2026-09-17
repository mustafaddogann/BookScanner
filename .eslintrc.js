module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // Leading underscore marks an intentionally unused binding (e.g. `{ [id]: _removed, ...rest }`).
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
  },
  overrides: [
    {
      files: ['jest.setup.js'],
      env: { jest: true },
    },
    {
      files: ['scripts/**/*.js'],
      env: { node: true },
    },
  ],
};
