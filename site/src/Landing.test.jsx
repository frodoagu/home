import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Landing from "./Landing";
import { AuthProvider } from "./auth/AuthProvider";

function renderLanding() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Landing />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Landing", () => {
  it("muestra el encabezado y las apps públicas", () => {
    renderLanding();
    expect(screen.getByRole("heading", { name: "Agu", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Corriente de Neutro")).toBeInTheDocument();
    expect(screen.getByText("Mandelbrot")).toBeInTheDocument();
  });

  it("muestra la sección privada bloqueada cuando no hay sesión", () => {
    renderLanding();
    expect(screen.getByText("Zona privada")).toBeInTheDocument();
  });

  it("filtra las apps al hacer clic en una categoría", async () => {
    const user = userEvent.setup();
    renderLanding();
    // 'Mate' sólo contiene Mandelbrot; 'Corriente de Neutro' es Oficios.
    await user.click(screen.getByRole("button", { name: /Mate/ }));
    expect(screen.getByText("Mandelbrot")).toBeInTheDocument();
    expect(screen.queryByText("Corriente de Neutro")).not.toBeInTheDocument();
  });
});
