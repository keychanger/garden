// Injected by esbuild --define at build time. Falls back to "dev" when
// running via tsx or any other non-esbuild entrypoint.
declare const __GARDEN_VERSION__: string | undefined;
export const GARDEN_VERSION =
  typeof __GARDEN_VERSION__ !== "undefined" ? __GARDEN_VERSION__ : "dev";
