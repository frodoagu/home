import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BalancedAudio from "./BalancedAudio";
import { LanguageProvider } from "../i18n/LanguageProvider";

const renderApp = (language = "es") =>
  render(
    <LanguageProvider initialLanguage={language}>
      <BalancedAudio />
    </LanguageProvider>,
  );

const badge = () => screen.getByRole("status");
const snr = () => Number(badge().textContent.match(/-?\d+/)[0]);

describe("BalancedAudio", () => {
  it("starts unbalanced and gains a lot of SNR on a balanced line", async () => {
    renderApp();
    const before = snr();
    const picker = screen.getAllByRole("button", { pressed: false }).find((b) => b.textContent.startsWith("BalanceadoXLR"));
    await userEvent.click(picker);
    expect(snr() - before).toBeGreaterThan(30);
  });

  it("only enables cable faults on a balanced hookup", async () => {
    renderApp();
    const fault = screen.getByRole("button", { name: /Pin 3 cortado/ });
    expect(fault).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /A\/B/ }));
    expect(fault).toBeEnabled();
    const before = snr();
    await userEvent.click(fault);
    expect(snr()).toBeLessThan(before - 20);
  });

  it("silencing every noise source leaves an infinite SNR", () => {
    renderApp();
    const card = screen.getByText("Fuentes de ruido").closest("div").parentElement;
    for (const slider of within(card).getAllByRole("slider")) fireEvent.change(slider, { target: { value: "0" } });
    expect(badge().textContent).toContain("∞");
  });

  it("speaks the other languages", () => {
    renderApp("fr");
    expect(screen.getByText(/Audio symétrique ·/)).toBeInTheDocument();
  });
});
