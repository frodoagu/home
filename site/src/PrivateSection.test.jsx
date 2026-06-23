import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import PrivateSection from "./PrivateSection";

// useAuth se mockea para controlar el estado de sesión en cada caso.
let authValue;
vi.mock("./auth/AuthProvider", () => ({ useAuth: () => authValue }));

const base = { renderButton: vi.fn(), signOut: vi.fn(), ready: true };

beforeEach(() => {
  authValue = { ...base, user: null, authorized: false };
});

describe("PrivateSection", () => {
  it("sin sesión: muestra el gate e intenta renderizar el botón de Google", () => {
    render(<PrivateSection />);
    expect(screen.getByText("Zona privada")).toBeInTheDocument();
    expect(authValue.renderButton).toHaveBeenCalled();
  });

  it("logueado pero no autorizado: muestra 'Sin acceso'", () => {
    authValue = { ...base, user: { email: "x@y.com", name: "X" }, authorized: false };
    render(<PrivateSection />);
    expect(screen.getByText("Sin acceso")).toBeInTheDocument();
    expect(screen.getByText(/x@y\.com/)).toBeInTheDocument();
  });

  it("autorizado: muestra los enlaces privados", () => {
    authValue = { ...base, user: { email: "ok@a.com", name: "Ok" }, authorized: true };
    render(<PrivateSection />);
    expect(screen.getByText("Traefik")).toBeInTheDocument();
    expect(screen.getByText("Home Assistant")).toBeInTheDocument();
    expect(screen.getByText("ArgoCD")).toBeInTheDocument();
  });

  it("autorizado + filtro 'Papá': sólo enlaces de esa categoría", () => {
    authValue = { ...base, user: { email: "ok@a.com", name: "Ok" }, authorized: true };
    render(<PrivateSection active="Papá" />);
    expect(screen.getByText("Home Assistant")).toBeInTheDocument(); // DevOps + Papá
    expect(screen.queryByText("Traefik")).not.toBeInTheDocument(); // sólo DevOps
  });
});
