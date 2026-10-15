/** Structured privacy-policy content; one object per UI language. */
export type PrivacyBlock = { p: string } | { ul: string[] } | { table: { head: string[]; rows: string[][] } };

interface PrivacySection {
  heading: string;
  blocks: PrivacyBlock[];
}

export interface PrivacyDoc {
  title: string;
  effective: string;
  intro: string[];
  sections: PrivacySection[];
  /** Last section; links VITE_CONTACT_URL when the instance sets it, else shows `fallback`. */
  contact: { heading: string; label: string; fallback: string };
}
