/**
 * ESLint 扁平配置（flat config）。
 *
 * 仓库是三段式纯 ESM：Node 后端（server）、React 前端（client/src）、脚本与构建配置（scripts、*.config.js）。
 * 三段运行环境不同（Node / 浏览器 + JSX），因此分块配置，而不是 .eslintrc 的 overrides 语法。
 *
 * 分工：ESLint 管「可能出错」（未使用变量、hooks 依赖等），格式交给 Prettier
 * （eslint-config-prettier 放最后，关掉与 Prettier 冲突的格式类规则）。
 */
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

const IGNORES = ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', 'data/**'];

/** 各段共用的语言选项与通用规则 */
const common = {
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  linterOptions: {
    reportUnusedDisableDirectives: true,
  },
  rules: {
    ...js.configs.recommended.rules,
    // 空 catch 是刻意的降级写法（例如「读不到就返回 null」），允许但要求语义上说得通
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  },
};

export default [
  { ignores: IGNORES },

  // ——— Node：后端、脚本、构建配置 ———
  {
    ...common,
    files: ['server/**/*.js', 'scripts/**/*.mjs', '*.config.js', 'client/playwright.config.js', 'client/e2e/**/*.{js,mjs}'],
    languageOptions: { ...common.languageOptions, globals: { ...globals.node } },
  },

  // ——— 浏览器 + React：前端源码 ———
  {
    ...common,
    files: ['client/src/**/*.{js,jsx}'],
    languageOptions: {
      ...common.languageOptions,
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...common.rules,
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // React 17+ 自动 JSX runtime：无需 import React；本项目不使用 prop-types
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },

  prettier,
];
