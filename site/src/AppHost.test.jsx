import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppHost from "./AppHost";

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/:slug" element={<AppHost />} />
      </Routes>
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
    expect(screen.getByText("No encontré esa app.")).toBeInTheDocument();
  });
});
