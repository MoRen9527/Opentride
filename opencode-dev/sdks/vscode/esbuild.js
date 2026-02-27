const esbuild = require("esbuild")
const fs = require("fs")
const path = require("path")

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started")
    })
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`)
        if (location?.file) {
          console.error(
            `    ${location.file}:${location.line ?? 0}:${location.column ?? 0}:`
          )
        }
      })
      console.log("[watch] build finished")
    })
  },
}

async function main() {
  const projectRoot = __dirname
  const entryFile = path.join(projectRoot, "src", "extension.ts")
  const outFile = path.join(projectRoot, "dist", "extension.js")
  fs.mkdirSync(path.dirname(outFile), { recursive: true })

  const ctx = await esbuild.context({
    entryPoints: [entryFile],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: outFile,
    external: ["vscode"],
    logLevel: "silent",
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  })
  if (watch) {
    await ctx.watch()
  } else {
    await ctx.rebuild()
    await ctx.dispose()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
