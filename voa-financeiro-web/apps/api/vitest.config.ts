import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // O script de build compila `src` para `dist`, entao os testes tambem viram `.js` la. O include
    // e explicito de proposito: sem ele o runner tambem carregaria `dist/**/*.test.js` e cada caso
    // rodaria duas vezes, a segunda contra uma copia possivelmente velha.
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
