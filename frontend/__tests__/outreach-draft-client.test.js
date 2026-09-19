import { describe, it, expect, vi } from "vitest";
import { createOutreachDraftClient } from "../hooks/useOutreachDraft";

const draft = () => ({ selected_company_numbers: ["00123456"], contacts: [], selected_contact_keys: [], campaign_name: "Saved campaign" });
const json = (payload, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => payload });
const initial = () => ({ week_start: "2026-09-14", revision: 3, draft: draft() });

describe("Outreach draft client", () => {
  it("hydrates without saving empty defaults or sending outreach", async () => {
    const fetcher = vi.fn(() => json(initial()));
    const client = createOutreachDraftClient(fetcher);
    await client.start();
    expect(client.snapshot().draft).toEqual(draft());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  });
  it("serializes rapid edits and finishes saving even after the UI unsubscribes", async () => {
    let release;
    const fetcher = vi.fn((_url, options) => {
      if (!options.method) return json(initial());
      if (!release) return new Promise(resolve => { release = resolve; });
      return json({ revision: 5 });
    });
    const client = createOutreachDraftClient(fetcher);
    const unsubscribe = client.subscribe(() => {});
    await client.start();
    client.update(current => ({ ...current, campaign_name: "First edit" }));
    client.update(current => ({ ...current, campaign_name: "Latest edit", selected_company_numbers: ["00888888"] }));
    unsubscribe();
    release(await json({ revision: 4 }));
    await client.retry();
    const writes = fetcher.mock.calls.filter(([, options]) => options.method === "PUT").map(([, options]) => JSON.parse(options.body));
    expect(writes.map(write => write.expected_revision)).toEqual([3, 4]);
    expect(writes[1].draft.campaign_name).toBe("Latest edit");
    expect(writes[1].draft.selected_company_numbers).toEqual(["00888888"]);
    expect(client.snapshot().status).toBe("saved");
    expect(client.hasUnsaved()).toBe(false);
  });
  it("keeps edits on save failure and retries without issuing provider requests", async () => {
    let failed = true;
    const fetcher = vi.fn((_url, options) => !options.method ? json(initial()) : failed ? Promise.reject(new Error("Offline")) : json({ revision: 4 }));
    const client = createOutreachDraftClient(fetcher); await client.start();
    client.update(current => ({ ...current, campaign_name: "Unsaved work" }));
    await client.retry();
    expect(client.snapshot().status).toBe("save_error");
    expect(client.snapshot().draft.campaign_name).toBe("Unsaved work");
    expect(client.hasUnsaved()).toBe(true);
    failed = false; await client.retry();
    expect(client.snapshot().status).toBe("saved");
    expect(fetcher.mock.calls.every(([url]) => url === "/api/outreach/draft")).toBe(true);
  });
  it("does not overwrite a newer tab revision after a conflict", async () => {
    const fetcher = vi.fn((_url, options) => !options.method ? json(initial()) : json({ error: "outreach_draft_conflict" }, 409));
    const client = createOutreachDraftClient(fetcher); await client.start();
    client.update(current => ({ ...current, campaign_name: "Local work" })); await client.retry();
    expect(client.snapshot().status).toBe("conflict");
    expect(client.snapshot().draft.campaign_name).toBe("Local work");
    client.update(current => ({ ...current, campaign_name: "Ignored" })); await client.retry();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("blocks edits after a load failure and never saves empty defaults over an existing draft", async () => {
    const fetcher = vi.fn(() => json({}, 503));
    const client = createOutreachDraftClient(fetcher); await client.start();
    client.update(() => draft()); await client.retry();
    expect(client.snapshot().loaded).toBe(false);
    expect(client.snapshot().status).toBe("load_error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refreshes from the server when a saved draft is reopened, including a new week", async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => json(initial())).mockImplementationOnce(() => json({ ...initial(), week_start: "2026-09-21", revision: 0, draft: { ...draft(), selected_company_numbers: [], campaign_name: "" } }));
    const client = createOutreachDraftClient(fetcher); await client.start(); await client.start();
    expect(client.snapshot().week_start).toBe("2026-09-21");
    expect(client.snapshot().draft.selected_company_numbers).toEqual([]);
  });
});
