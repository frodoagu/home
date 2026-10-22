import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DICTS, LANGS } from "./i18n/index.js";
import { headTags, pageHtml, SITE, sitemap } from "./seo.js";

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const jsonLd = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);

describe("search engines", () => {
  it("every language describes itself within the lengths results show", () => {
    for (const id of LANGS) {
      const { title, description, keywords } = DICTS[id].seo;
      expect(title.length, id).toBeLessThanOrEqual(65);
      expect(description.length, id).toBeLessThanOrEqual(165);
      expect(keywords, id).toBeTruthy();
    }
  });

  it("each page is its own canonical and links every other language", () => {
    for (const id of [null, ...LANGS]) {
      const head = headTags(id);
      const url = id ? `${SITE}/${id}/` : `${SITE}/`;
      expect(head).toContain(`<link rel="canonical" href="${url}" />`);
      for (const l of LANGS) expect(head).toContain(`hreflang="${l}" href="${SITE}/${l}/"`);
      expect(head).toContain(`hreflang="x-default" href="${SITE}/"`);
      expect(jsonLd(head)).toMatchObject({ "@type": "WebApplication", name: "Trance Lab", url });
    }
  });

  it("writes one page's head and lang into index.html", () => {
    const html = pageHtml(file("index.html"), "pt");
    expect(html).toContain('<html lang="pt"');
    expect(html).toContain(`<title>${DICTS.pt.seo.title}</title>`);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(() => pageHtml("<html></html>", "pt")).toThrow(/markers/);
  });

  it("the sitemap lists `/` and every language", () => {
    const locs = [...sitemap().matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([`${SITE}/`, ...LANGS.map((l) => `${SITE}/${l}/`)]);
    expect(file("public/robots.txt")).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it("only the sampler is indexed, not the visuals window or the 404", () => {
    expect(file("visuals.html")).toContain('<meta name="robots" content="noindex" />');
    expect(file("public/404.html")).toContain('<meta name="robots" content="noindex" />');
  });
});
