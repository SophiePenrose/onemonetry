import { useEffect, useSyncExternalStore } from "react";

const emptyDraft = () => ({ selected_company_numbers: [], contacts: [], selected_contact_keys: [], campaign_name: "" });

// Lives beyond the planner component so navigation cannot discard an in-flight save.
// The server revision prevents another tab from silently replacing this draft.
export function createOutreachDraftClient(fetcher = (...args) => fetch(...args)) {
  let state = { draft: emptyDraft(), status: "loading", loaded: false, error: null, week_start: null };
  let revision = 0, generation = 0, savedGeneration = 0, loading = null, saving = null;
  const listeners = new Set();
  function publish(patch) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); }
  async function load() {
    if (loading) return loading;
    if (saving) await saving;
    publish({ status: "loading", error: null });
    loading = (async () => {
      try {
        const response = await fetcher("/api/outreach/draft", { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load your saved draft. Reload to try again.");
        const payload = await response.json();
        if (!Number.isInteger(payload.revision) || !payload.week_start || !payload.draft) throw new Error("The saved draft could not be read.");
        revision = payload.revision; generation = 0; savedGeneration = 0;
        publish({ draft: payload.draft, week_start: payload.week_start, loaded: true, status: "saved", error: null });
      } catch (error) { publish({ status: "load_error", loaded: false, error: error.message }); }
      finally { loading = null; }
    })();
    return loading;
  }
  async function flush() {
    if (saving) return saving;
    if (!state.loaded || state.status === "conflict" || savedGeneration === generation) return;
    publish({ status: "saving", error: null });
    saving = (async () => {
      try {
        while (savedGeneration !== generation) {
          const version = generation;
          const response = await fetcher("/api/outreach/draft", {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ week_start: state.week_start, expected_revision: revision, draft: state.draft }),
          });
          if (!response.ok) {
            if (response.status === 409) {
              const result = await response.json().catch(() => ({}));
              publish({ status: "conflict", error: result.error === "outreach_week_changed"
                ? "A new planning week has started. Reload this week’s draft before continuing."
                : "This draft changed in another tab. Your changes have not been saved. Reload the saved draft before continuing." });
              return;
            }
            throw new Error("Your latest changes have not been saved. Retry before closing this page.");
          }
          const result = await response.json();
          if (!Number.isInteger(result.revision)) throw new Error("Could not confirm the save. Retry before closing this page.");
          revision = result.revision; savedGeneration = version;
        }
        publish({ status: "saved", error: null });
      } catch (error) { publish({ status: "save_error", error: error.message }); }
      finally { saving = null; }
    })();
    return saving;
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => state,
    load,
    start() { if (!loading && !saving && generation === savedGeneration && ["loading", "saved"].includes(state.status)) return load(); },
    update(updater) {
      if (!state.loaded || ["loading", "conflict"].includes(state.status)) return;
      generation += 1;
      publish({ draft: updater(state.draft) });
      if (state.status !== "save_error") void flush();
    },
    retry: flush,
    hasUnsaved: () => generation !== savedGeneration,
  };
}

const workspaceDraft = createOutreachDraftClient();
export default function useOutreachDraft(client = workspaceDraft) {
  const state = useSyncExternalStore(client.subscribe, client.snapshot);
  useEffect(() => { void client.start(); }, [client]);
  useEffect(() => {
    const warnUnsaved = event => {
      if (client.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => window.removeEventListener("beforeunload", warnUnsaved);
  }, [client]);
  return { ...state, updateDraft: client.update, retrySave: client.retry, reloadDraft: client.load };
}
