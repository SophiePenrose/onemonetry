import React, { useState, useEffect } from "react";
import PropTypes from "prop-types";

export default function NotesPanel({ companyId, initialNotes }) {
  const [notes, setNotes] = useState(initialNotes || "");
  const [saved, setSaved] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setNotes(initialNotes || ""); setSaved(true); }, [initialNotes, companyId]);

  function handleChange(e) {
    setNotes(e.target.value);
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/company/${encodeURIComponent(companyId)}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (res.ok) setSaved(true);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Notes</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!saved && <span style={{ fontSize: 11, color: "#e67e22" }}>Unsaved changes</span>}
          {saved && notes && <span style={{ fontSize: 11, color: "#0a8754" }}>✓ Saved</span>}
          <button
            onClick={handleSave}
            disabled={saving || saved}
            style={{
              padding: "4px 14px", borderRadius: 6, border: "none", fontSize: 12, fontWeight: 600,
              background: saved ? "#f3f4f6" : "#0075EB", color: saved ? "#888" : "#fff",
              cursor: saving || saved ? "default" : "pointer", opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <textarea
        value={notes}
        onChange={handleChange}
        onBlur={() => { if (!saved) handleSave(); }}
        placeholder="Add notes about this company — observations, strategy, reminders…"
        rows={4}
        style={{
          width: "100%", padding: "10px 12px", borderRadius: 6, border: "1px solid #e0e3e8",
          fontSize: 13, resize: "vertical", boxSizing: "border-box", lineHeight: 1.5,
          background: "#fafbfc",
        }}
      />
    </div>
  );
}

NotesPanel.propTypes = {
  companyId: PropTypes.string.isRequired,
  initialNotes: PropTypes.string,
};
