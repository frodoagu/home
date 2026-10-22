import { describe, it, expect } from "vitest";
import { apps } from "./apps/registry";
import { headTags, notFoundPage, pages, sitemap, SITE_URL } from "./seo";

describe("pages", () => {
  it("lista la home y cada app propia, no las de otro subdominio", () => {
    const paths = pages().map((p) => p.path);
    expect(paths[0]).toBe("/");
    for (const app of apps) {
      expect(paths.includes(`/app/${app.slug}`)).toBe(Boolean(app.Component));
    }
  });

  it("cada página tiene título y descripción propios", () => {
    const list = pages();
    for (const p of list) {
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.description.length).toBeLessThanOrEqual(160);
    }
    expect(new Set(list.map((p) => p.title)).size).toBe(list.length);
  });
});

describe("headTags", () => {
  it("emite canonical, Open Graph y JSON-LD válido", () => {
    const page = pages().find((p) => p.path === "/app/mandelbrot");
    const html = headTags(page);
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}/app/mandelbrot" />`);
    expect(html).toContain('<meta property="og:title" content="Mandelbrot · Agu" />');
    const json = html.match(/<script type="application\/ld\+json">(.*)<\/script>/)[1];
    expect(JSON.parse(json)["@type"]).toBe("WebApplication");
  });

  it("escapa el texto y no deja cerrar el script del JSON-LD", () => {
    const html = headTags({
      path: "/x",
      title: 'a "b" <c>',
      description: "d & e",
      jsonLd: { name: "</script><script>alert(1)" },
    });
    expect(html).toContain("<title>a &quot;b&quot; &lt;c&gt;</title>");
    expect(html).toContain('content="d &amp; e"');
    expect(html).not.toContain("</script><script>");
  });

  it("la 404 no se indexa ni declara canonical", () => {
    const html = headTags(notFoundPage);
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).not.toContain("canonical");
  });
});

describe("sitemap", () => {
  it("tiene una URL absoluta por página", () => {
    const xml = sitemap(pages());
    for (const p of pages()) expect(xml).toContain(`<loc>${SITE_URL}${p.path}</loc>`);
    expect(xml.match(/<url>/g)).toHaveLength(pages().length);
  });
});
