const webpack = require("webpack");
const MonacoWebpackPlugin = require("monaco-editor-webpack-plugin");
const CircularDependencyPlugin = require("circular-dependency-plugin");

module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      // Resolve WASM and CommonJS
      webpackConfig.resolve.extensions.push(".wasm");
      webpackConfig.experiments = {
        asyncWebAssembly: true,
      };
      webpackConfig.module.rules.forEach((rule) => {
        (rule.oneOf ?? []).forEach((oneOf) => {
          if (oneOf.type === "asset/resource") {
            // Including .cjs here solves `nanoid is not a function`
            oneOf.exclude.push(/\.wasm$/, /\.cjs$/);
          } else if (new RegExp(oneOf.test).test(".d.ts")) {
            // Exclude declaration files from being loaded by babel
            oneOf.exclude = [/\.d\.ts$/];
          }
        });
      });

      webpackConfig.module.rules.push(
        // Fix process error on @lezer/lr
        {
          test: /@lezer\/lr\/dist\/\w+\.js$/,
          resolve: { fullySpecified: false },
        },
        // Raw imports
        {
          test: /\.(d\.ts|raw|rs|py|md)$/,
          type: "asset/source",
        }
      );

      // Resolve node polyfills
      webpackConfig.resolve.fallback = {
        // Mocha
        stream: require.resolve("stream-browserify"),

        // Fix `Module not found: Error: Can't resolve 'perf_hooks'` from typescript
        perf_hooks: false,

        // @metaplex-foundation/js polyfills
        crypto: require.resolve("crypto-browserify"),
        fs: false,
        process: false,
        path: false,
        zlib: false,
      };

      // Plugins
      webpackConfig.plugins.push(
        // Process
        new webpack.ProvidePlugin({
          process: "process/browser",
        }),

        // Monaco
        new MonacoWebpackPlugin(),

        // Circular dependencies
        new CircularDependencyPlugin({
          // Excluding terminal commands because circular imports will be resolved
          // by the time the commands are executed.
          exclude: /node_modules|terminal|sugar|client/,
          // Include all src folder
          include: /src/,
          // Add errors to webpack instead of warnings
          failOnError: true,
          // Allow import cycles that include an asyncronous import,
          // e.g. via import(/* webpackMode: "weak" */ './file.js')
          allowAsyncCycles: false,
          // Set the current working directory for displaying module paths
          cwd: process.cwd(),
        }),

        // Ignore `Critical dependency: the request of a dependency is an expression`
        // from typescript and mocha
        new webpack.ContextReplacementPlugin(/^\.$/, (context) => {
          if (/\/node_modules\/(typescript|mocha)\/lib/.test(context.context)) {
            for (const d of context.dependencies) {
              if (d.critical) d.critical = false;
            }
          }
        })
      );

      // Ignore useless warnings
      webpackConfig.ignoreWarnings = [/Failed to parse source map/];

      return webpackConfig;
    },
  },
};
