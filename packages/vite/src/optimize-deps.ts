import { esBuildResolver } from './esbuild-resolver';

export interface OptimizeDeps {
  exclude?: string[];
  [key: string]: unknown;
}

export function optimizeDeps(): OptimizeDeps {
  return {
    include: ['ember-welcome-page'],
    esbuildOptions: {
      plugins: [esBuildResolver()],
    },
  };
}
