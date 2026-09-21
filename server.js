// V2 loads a configured local plugin as <package-dir>/server (or /index) —
// it does not follow package.json `main` for directory targets (see
// @opencode/plugin/dist/host.js, resolve()). This root entry point re-exports
// the built bundle so the directory form keeps working:
//
//   { "plugins": [{ "package": "/path/to/opencode-auto-memory" }] }
//
// npm-installed packages are unaffected: they resolve by package name, which
// does honour main/exports.
export { default } from "./dist/index.js";