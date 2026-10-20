// Injected by esbuild --define at build time. Falls back to "dev" when
// running via tsx or any other non-esbuild entrypoint.
declare const __GARDEN_VERSION__: string | undefined;
declare const __GARDEN_COMMIT__: string | undefined;
export const GARDEN_VERSION =
  typeof __GARDEN_VERSION__ !== "undefined" ? __GARDEN_VERSION__ : "dev";
// The build's full commit SHA, for handing to git. The abbreviated
// GARDEN_VERSION resolves through refs before objects, so a tag of that name
// would stand in for the build. Empty outside an esbuild build.
export const GARDEN_COMMIT =
  typeof __GARDEN_COMMIT__ !== "undefined" ? __GARDEN_COMMIT__ : "";
