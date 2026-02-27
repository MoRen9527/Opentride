import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const outDir = path.join(root, ".vscode", ".opencode-proposed-dev")

const rm = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

const ensureDir = (p) => {
  fs.mkdirSync(p, { recursive: true })
}

const copyIfExists = (fromRel, toRel = fromRel) => {
  const from = path.join(root, fromRel)
  const to = path.join(outDir, toRel)
  if (!fs.existsSync(from)) return
  const stat = fs.statSync(from)
  if (stat.isDirectory()) {
    fs.cpSync(from, to, { recursive: true })
  } else {
    ensureDir(path.dirname(to))
    fs.copyFileSync(from, to)
  }
}

rm(outDir)
ensureDir(outDir)

// Copy the minimal runtime surface for the extension host.
copyIfExists("dist")
copyIfExists("media")
copyIfExists("images")
copyIfExists("README.md")

const manifestPath = path.join(root, "package.json")
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
manifest.enabledApiProposals = ["editorInsets"]

fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(manifest, null, 2))

console.log(`Prepared proposed-dev extension at ${outDir}`)
