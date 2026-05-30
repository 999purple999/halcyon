// HALCYON - ESLint flat config (ESM, v9+).
// Minimo indispensabile: catch errori semantici comuni senza imporre style
// (prettier gestisce lo style).
export default [
  // Service worker (different globals: self, caches, clients, fetch)
  {
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Promise: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
  {
    files: ['server.js', 'public/**/*.js', 'tests/**/*.js'],
    ignores: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // Browser
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        crypto: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        WebSocket: 'readonly',
        RTCPeerConnection: 'readonly',
        MediaStream: 'readonly',
        AudioContext: 'readonly',
        MediaRecorder: 'readonly',
        Audio: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URLSearchParams: 'readonly',
        Math: 'readonly',
        Date: 'readonly',
        JSON: 'readonly',
        Promise: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        Float32Array: 'readonly',
        Uint8Array: 'readonly',
        // Node
        process: 'readonly',
        Buffer: 'readonly',
        // App globals
        __ar: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
      'no-implicit-globals': 'error',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'public/app.js', // file storico monolitico, refactor a +
      'docs/**',
      'data/**',
      'certs/**',
    ],
  },
];
