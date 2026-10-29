import factory from "./src/index.ts";

// Pi derives the extension's display name from the entry path's directory.
// Keeping the entry at the package root makes the extension show up as
// "pi-sandbox" (the repo/clone name) instead of "src".
export default factory;
