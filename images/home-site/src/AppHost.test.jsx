import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppHost from "./AppHost";
import { LanguageProvider } from "./i18n/LanguageProvider";

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LanguageProvider initialLanguage="es">
        <Routes>
          <Route path="/app/:slug" element={<AppHost />} />
        </Routes>
      </LanguageProvider>
    </MemoryRouter>,
  );
}

describe("AppHost", () => {
  it("monta la app correspondiente al slug con la barra de Inicio", () => {
    // corriente-neutro usa SVG (sin canvas) → seguro en jsdom.
    renderAt("/app/corriente-neutro");
    expect(screen.getByText("Inicio")).toBeInTheDocument();
    expect(screen.getAllByText(/Corriente de Neutro/i).length).toBeGreaterThan(0);
  });

  it("muestra el fallback para un slug inexistente", () => {
    renderAt("/app/no-existe");
    expect(screen.getByText(/No encont/)).toBeInTheDocument();
  });
});
