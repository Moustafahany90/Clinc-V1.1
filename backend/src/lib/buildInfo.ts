/** Commit stamped into the image at build time; never read from client input. */
export const BUILD_SHA = process.env.BUILD_SHA ?? 'unknown';
