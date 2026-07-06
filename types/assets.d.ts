// Ambient declaration for global stylesheet side-effect imports
// (e.g. `import "./globals.css"`). The bundler handles the actual import at
// build time; this only satisfies the type-checker. Image assets are already
// declared by Next via `next/image-types/global`, so we don't redeclare them.
declare module "*.css";
