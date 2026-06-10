export const templateRepo = "https://github.com/chobbledotcom/chobble-template";
export const buildDir = ".build";

export const templateExcludes = [
  ".git",
  ".direnv",
  "node_modules",
  "*.md",
  "test",
  "test-*",
  ".image-cache",
  "images",
  "landing-pages",
  "instagram-posts",
];

export const sourceExcludes = [
  ".*",
  "*.nix",
  "README.md",
  "scripts",
  "node_modules",
  "package*.json",
  "bun.lock",
  "old_site",
  ...(process.env.PLACEHOLDER_IMAGES === "1" ? ["images"] : []),
];
