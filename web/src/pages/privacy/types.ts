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
}
