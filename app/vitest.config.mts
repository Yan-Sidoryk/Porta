import { defineConfig } from 'vitest/config';

// Only the pure modules are tested here -- the state machine, the cooldown
// maths, the error copy. Anything importing react-native needs a native
// runtime and is verified on a real phone instead.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
