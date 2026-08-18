/** @type {import('next').NextConfig} */
const nextConfig = {
  // PM2 on a Windows VM, no Docker: a standalone server bundle is the only
  // deployment shape that does not require a pnpm store on the target host.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  reactStrictMode: true,
  // The contracts package ships raw TypeScript (`main: src/index.ts`).
  transpilePackages: ['@brandlens/contracts'],
  poweredByHeader: false,
  eslint: {
    dirs: ['src'],
  },
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts'],
  },
  webpack: (config) => {
    // @brandlens/contracts is ESM-flavoured TypeScript: its relative imports
    // end in `.js` but the files on disk are `.ts`. Teach the resolver the
    // mapping rather than forking the package for the browser build.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
