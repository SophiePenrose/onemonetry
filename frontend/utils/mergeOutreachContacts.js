export function outreachContactKey(contact, index = 0) {
  return String(contact?.person_id || contact?.source_id || contact?.linkedin_url || contact?.email || `${contact?.full_name || "contact"}-${index}`);
}

function profile(value) {
  return String(value || "").trim().toLowerCase().replace(/^http:\/\//, "https://")
    .replace("https://www.linkedin.com/", "https://linkedin.com/").split(/[?#]/)[0].replace(/\/$/, "");
}
const yes = value => value === true || value === 1 || ["true", "1", "yes"].includes(String(value).toLowerCase());

// Keep existing selections and stable keys. New saved people require individual
// review; a later discovery must not replace that review or reselect a person.
export function mergeOutreachContacts(draft, incoming, { selectNew = false } = {}) {
  const contacts = draft.contacts.map(contact => ({ ...contact }));
  const selected = new Set(draft.selected_contact_keys);
  for (const candidate of incoming) {
    const email = String(candidate.email || "").trim().toLowerCase();
    const url = profile(candidate.linkedin_url);
    const index = contacts.findIndex((contact, i) => contact.company_number === candidate.company_number
      && (outreachContactKey(contact, i) === outreachContactKey(candidate)
        || (email && email === String(contact.email || "").trim().toLowerCase())
        || (url && url === profile(contact.linkedin_url))));
    if (index < 0) {
      contacts.push(candidate);
      if (selectNew) selected.add(outreachContactKey(candidate, contacts.length - 1));
      continue;
    }
    const existing = contacts[index];
    const key = outreachContactKey(existing, index);
    const merged = { ...candidate, ...existing, person_id: key };
    for (const field of ["email", "linkedin_url", "role", "full_name", "phone"]) {
      if (!merged[field]) merged[field] = candidate[field] || null;
    }
    if (!existing.email && candidate.email) merged.email_status = candidate.email_status || "unknown";
    for (const flag of ["suppressed", "do_not_contact", "do_not_email", "do_not_linkedin", "do_not_call", "phone_dnc"]) {
      if (yes(existing[flag]) || yes(candidate[flag])) merged[flag] = true;
    }
    contacts[index] = merged;
  }
  if (contacts.length > 500) throw new Error("The draft holds up to 500 people. Remove unneeded contacts before adding more.");
  return { ...draft, contacts, selected_contact_keys: [...selected] };
}
