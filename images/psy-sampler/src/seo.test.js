import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("search engines", () => {
  it("the page declares its canonical URL and valid JSON-LD", () => {
    const html = file("index.html");
    expect(html).toContain('<link rel="canonical" href="https://psy.agu.com.ar/" />');
    const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    expect(JSON.parse(json)).toMatchObject({ "@type": "WebApplication", url: "https://psy.agu.com.ar/" });
  });

  it("only the sampler is indexed, not the visuals window or the 404", () => {
    expect(file("visuals.html")).toContain('<meta name="robots" content="noindex" />');
    expect(file("public/404.html")).toContain('<meta name="robots" content="noindex" />');
    const locs = [...file("public/sitemap.xml").matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(["https://psy.agu.com.ar/"]);
    expect(file("public/robots.txt")).toContain("Sitemap: https://psy.agu.com.ar/sitemap.xml");
  });
});
