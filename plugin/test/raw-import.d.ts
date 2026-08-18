/**
 * Vite (and therefore vitest) serves `import x from "./file?raw"` as the file's text. Declared
 * here rather than by adding Node's ambient types to this project: the plugin runtime has no
 * Node APIs and its tsconfigs restrict `types` deliberately, so `node:fs` must stay unavailable
 * even in tests. This is a build-tool import, not a runtime one.
 */
declare module "*?raw" {
  const contents: string;
  export default contents;
}
