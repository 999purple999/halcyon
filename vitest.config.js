// HALCYON - Vitest config per unit test client (JS vanilla).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    coverage: {
      reporter: ['text', 'html'],
      reportsDirectory: 'tests/_artifacts/coverage',
      include: ['public/app.js', 'server.js'],
    },
  },
});
