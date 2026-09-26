/** @type {import('next').NextConfig} */

const nextConfig = {
  reactStrictMode: true,
  // The workspace packages are consumed as source, not as built dist. That is
  // what makes `pnpm dev` reflect an edit to a feature without a rebuild, and
  // it is why the Dockerfile installs first and runs second.
  transpilePackages: [
    '@battle-agents/agent',
    '@battle-agents/api',
    '@battle-agents/core',
    '@battle-agents/db',
    // Added because event-batch reads the batch limits and the buffer from
    // protocol, and a package that is transpiled through one of its consumers
    // still has to be listed if the bundler sees it directly.
    '@battle-agents/protocol',
    // The city page mounts PixiJS and the game client as source, for the same
    // reason the rest are here: so a change to the client is visible from a dev
    // reload rather than after a workspace rebuild.
    '@battle-agents/game-client',
    'pixi.js',
  ],
  // One webpack change, and it is the only one that was needed.
  //
  // Every import in this app carries a .js suffix, which is what the NodeNext
  // module resolution the rest of the monorepo uses. webpack takes that suffix
  // literally and looks for a .js file that does not exist, because the source
  // is .ts — so `next build` failed to resolve every route handler's import
  // while tsc and vitest both passed, because those two read tsconfig and
  // neither reads this file.
  //
  // The `@` alias needs nothing here. Next reads `paths` out of the app's
  // tsconfig by itself; a first attempt added a webpack alias for it, the build
  // still failed, and the alias turned out to be redundant. A comment naming the
  // wrong fix is worse than no comment, so this one names the one that held.
  webpack: (config) => {
    // Every import in this app is written with a .js suffix, which is what the
    // NodeNext module resolution the rest of the monorepo uses. webpack takes
    // that suffix literally and looks for a .js file that does not exist,
    // because the source is .ts. Mapping the extension is what lets one
    // convention hold across tsc, vitest and the bundler.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
  // Plan section 28.1 puts art under `apps/web/public/assets/`, and that path
  // DOES NOT WORK: Next.js reserves `/assets` for its own build pipeline and
  // answers every request beneath it with a 308 to the directory, so every pack
  // vendored there was unreachable from the running app. Measured — a PNG in
  // `public/assets/tiny-swords-cc0/` returned 308, and following it returned 404,
  // while a file at `public/probe.txt` beside it returned 200. The art was on
  // disk, licensed, checked, and unloadable.
  //
  // So the files live in `public/art/`, which Next serves, and this rewrite
  // keeps the URL the plan names. If the rewrite is ever reported as not
  // applying, the honest fallback is to change the URLs rather than to move the
  // files back under a reserved path.
  async rewrites() {
    return [{ source: '/assets/:path*', destination: '/art/:path*' }];
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
