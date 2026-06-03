import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AddCompany from "../pages/AddCompany";

function jsonResponse(data, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => data,
  });
}

describe("AddCompany", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn((url) => {
      if (url === "/api/industries") {
        return jsonResponse({ industries: ["Manufacturing", "Software"] });
      }
      if (url === "/api/companies") {
        return jsonResponse({ company: { id: "c-1", name: "Acme Ltd" } });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows validation error when required fields are missing", async () => {
    render(<AddCompany />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/industries", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: "Add Company" }));

    expect(screen.getByText("Company name and industry are required.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("submits normalized payload and notifies parent callback", async () => {
    const onCompanyAdded = vi.fn();
    render(<AddCompany onCompanyAdded={onCompanyAdded} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/industries", expect.any(Object)));

    fireEvent.change(screen.getByPlaceholderText("e.g. Acme Widgets Ltd"), { target: { value: "Acme Ltd" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. Manufacturing"), { target: { value: "Manufacturing" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. 5000000"), { target: { value: "5000000" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. 50"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "FX" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Company" }));

    await waitFor(() => expect(onCompanyAdded).toHaveBeenCalledWith(expect.objectContaining({ name: "Acme Ltd" })));

    const submitCall = fetchMock.mock.calls.find(([url]) => url === "/api/companies");
    expect(submitCall).toBeDefined();

    const payload = JSON.parse(submitCall[1].body);
    expect(payload.turnover).toBe(5000000);
    expect(payload.employee_count).toBe(50);
    expect(payload.product_fit.FX).toEqual(expect.objectContaining({
      eligible: true,
      fit_level: "medium",
    }));

    expect(screen.getByText("Acme Ltd added successfully.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. Acme Widgets Ltd")).toHaveValue("");
  });
});
