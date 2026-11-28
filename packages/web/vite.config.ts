import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 50,
            },
            {
              name: 'vendor-tanstack',
              test: /[\\/]node_modules[\\/]@tanstack[\\/](?:react-router|router-core|react-query|query-core|react-table|table-core|react-store|store|history)[\\/]/,
              priority: 40,
            },
            {
              name: 'vendor-ui-sdk',
              test: /[\\/]node_modules[\\/]@ui-sdk[\\/](?:core|react)[\\/]/,
              priority: 30,
            },
            {
              name: 'vendor-markdown',
              test: /[\\/]node_modules[\\/](?:@streamdown[\\/]|@shikijs[\\/](?!langs[\\/]|themes[\\/])|streamdown|shiki|parse5|marked|micromark|mdast|hast|rehype|remark|unified|oniguruma|remend|entities|property-information|unist-util-|vfile|trough|zwitch|stringify-entities|character-entities-|comma-separated-tokens|space-separated-tokens|web-namespaces|html-void-elements|ccount|escape-string-regexp|markdown-table|longest-streak|estree-util-|inline-style-parser|style-to-object|trim-lines|bail|extend|is-plain-obj|devlop|decode-named-character-reference|html-url-attributes|@ungap[\\/]structured-clone|regex|tailwind-merge)/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
            {
              name: 'vendor-schema',
              test: /[\\/]node_modules[\\/](?:zod|@orpc)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
    },
  },
});
