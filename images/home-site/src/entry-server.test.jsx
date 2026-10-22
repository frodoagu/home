import { describe, it, expect } from "vitest";
import { render } from "./entry-server";

describe("render (prerender)", () => {
  it("la home sale con las apps públicas como links rastreables", () => {
    const html = render("/");
    expect(html).toContain("Corriente de Neutro");
    expect(html).toContain('href="/app/mandelbrot"');
    expect(html).toContain('href="https://psy.agu.com.ar"');
  });

  it("una app sale con su barra y en español", () => {
    expect(render("/app/corriente-neutro")).toContain("Inicio");
  });

  it("una ruta desconocida sale como página de no encontrado", () => {
    expect(render("/nope")).toContain("No encontre esa pagina.");
  });
});
