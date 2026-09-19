import { useEffect, useState } from "react";
import PropTypes from "prop-types";

export default function HandoffReviews({ refreshToken, onResolved }) {
  const [handoffs, setHandoffs] = useState([]);
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/outreach/handoffs/pending", { cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("Could not check pending handoffs.")))
      .then(payload => { setHandoffs(payload.handoffs || []); setError(null); })
      .catch(err => { if (err.name !== "AbortError") setError(err.message); });
    return () => controller.abort();
  }, [refreshToken]);
  async function resolve(handoff, outcome) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/outreach/handoffs/${encodeURIComponent(handoff.batch_id)}/reconcile`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outcome, note: notes[handoff.batch_id] || "" }),
      });
      if (!response.ok) throw new Error("Could not record the review. Refresh to check whether this handoff has changed.");
      const result = await response.json();
      setHandoffs(current => current.filter(row => row.batch_id !== handoff.batch_id)); onResolved(result.capacity);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <>
    {error && <div className="outreach-alert outreach-alert-error" role="alert">{error}</div>}
    {handoffs.map(handoff => <section className="outreach-step-card" key={handoff.batch_id}>
      <h2>Check the handoff to {handoff.campaign_name}</h2>
      <p>The import outcome is uncertain. Slots remain reserved. Check this batch in We-Connect, then record what you found. This does not send contacts.</p>
      <label>What you checked in We-Connect <textarea value={notes[handoff.batch_id] || ""} maxLength={2000}
        onChange={event => setNotes(current => ({ ...current, [handoff.batch_id]: event.target.value }))} /></label>
      <div className="outreach-step-actions">
        <button type="button" disabled={busy || (notes[handoff.batch_id] || "").trim().length < 10} onClick={() => resolve(handoff, "present")}>Contacts are present — keep slots used</button>
        <button type="button" disabled={busy || (notes[handoff.batch_id] || "").trim().length < 10} onClick={() => resolve(handoff, "absent")}>Contacts are absent — release slots</button>
      </div>
    </section>)}
  </>;
}
HandoffReviews.propTypes = { refreshToken: PropTypes.number.isRequired, onResolved: PropTypes.func.isRequired };
