import { defineConfig } from 'vitest/config';
import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
    base: './',
    plugins: [
        react(),
        tailwindcss(),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    build: {
        outDir: '../src/chorus/static/',
        emptyOutDir: true,
    },
    server: {
        host: true,
        allowedHosts: ['localhost', '127.0.0.1'],
        proxy: {
            '/api/': {
                target: 'http://127.0.0.1:8010',
                changeOrigin: true,
            },
            '/v1/traces': {
                target: 'http://127.0.0.1:8010',
                changeOrigin: true,
            },
        },
    },
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['**/*.test.tsx'],
        setupFiles: ['./tests/setupMocks.ts', './tests/setupTests.ts'],
        typecheck: {
            tsconfig: './tsconfig.test.json',
        },
    },
});
