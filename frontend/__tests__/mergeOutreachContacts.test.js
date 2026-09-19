import { expect, it } from "vitest";
import { mergeOutreachContacts } from "../utils/mergeOutreachContacts";

it("adds saved people unchecked and preserves previous selections", () => {
  const draft = { contacts: [{ person_id: "existing", company_number: "00123456", email: "old@example.test" }], selected_contact_keys: ["existing"] };
  const result = mergeOutreachContacts(draft, [{ person_id: "saved-1", company_number: "00123456", email: "new@example.test" }]);
  expect(result.contacts).toHaveLength(2);
  expect(result.selected_contact_keys).toEqual(["existing"]);
  expect(draft.contacts).toHaveLength(1);
});

it("deduplicates Apollo and saved identities without reselecting or clearing stops", () => {
  const draft = { contacts: [{ person_id: "saved-1", full_name: "Synthetic", company_number: "00123456", email: "person@example.test", phone_dnc: true }], selected_contact_keys: [] };
  const result = mergeOutreachContacts(draft, [{ person_id: "apollo-1", company_number: "00123456", email: "PERSON@example.test", linkedin_url: "https://linkedin.com/in/synthetic", phone_dnc: false }], { selectNew: true });
  expect(result.contacts).toHaveLength(1);
  expect(result.contacts[0]).toMatchObject({ person_id: "saved-1", phone_dnc: true, linkedin_url: "https://linkedin.com/in/synthetic" });
  expect(result.selected_contact_keys).toEqual([]);
});

it("keeps distinct company associations and refuses to discard people at the draft limit", () => {
  const draft = { contacts: [{ person_id: "one", company_number: "00123456", email: "person@example.test" }], selected_contact_keys: [] };
  expect(mergeOutreachContacts(draft, [{ person_id: "two", company_number: "00999999", email: "person@example.test" }]).contacts).toHaveLength(2);
  expect(() => mergeOutreachContacts({ contacts: [], selected_contact_keys: [] }, Array.from({ length: 501 }, (_, id) => ({ person_id: String(id) })))).toThrow(/500/);
});
