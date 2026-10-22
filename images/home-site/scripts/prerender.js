// Turns the client build in dist/ into one static HTML file per route, so a
// crawler gets each page's content and <head> without running JS. Runs after
// `vite build --ssr` has bundled src/entry-server.jsx into dist-server/.
//   /            -> dist/index.html
//   /app/<slug>  -> dist/app/<slug>.html   (nginx: try_files $uri.html)
//   unknown      -> dist/404.html          (served with a 404 status)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const server = join(root, "dist-server");

// Production React/Router builds: the dev ones warn about every useLayoutEffect.
process.env.NODE_ENV = "production";
const { render, pages, notFoundPage, headTags, sitemap } = await import(
  pathToFileURL(join(server, "entry-server.js")).href
);

const template = readFileSync(join(dist, "index.html"), "utf8");
for (const marker of ["<!--app-head-->", "<!--app-html-->"]) {
  if (!template.includes(marker)) throw new Error(`dist/index.html has no ${marker}`);
}

function write(file, page) {
  const html = template
    .replace("<!--app-head-->", () => headTags(page))
    .replace("<!--app-html-->", () => render(page.path));
  const out = join(dist, file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`prerendered ${page.path} -> dist/${file}`);
}

for (const page of pages()) {
  write(page.path === "/" ? "index.html" : `${page.path.slice(1)}.html`, page);
}
write("404.html", notFoundPage);
writeFileSync(join(dist, "sitemap.xml"), sitemap(pages()));
rmSync(server, { recursive: true, force: true });
